import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import OpenAI from 'https://esm.sh/openai@4'

const app = new Hono()
const LIMIT = 20

function checkAccess(user: any): boolean {
  const isAdmin = user?.app_metadata?.is_admin === true
  const isRecruiter = user?.app_metadata?.role === 'recruiters'
  return isAdmin || isRecruiter
}

function stripHtml(html: string): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function getEmbedding(text: string): Promise<number[]> {
  const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })
  const result = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 6000),
  })
  return result.data[0].embedding
}

async function extractSkillsFromJd(jdText: string): Promise<string[]> {
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract technical and professional skills from the job description. Return JSON: {"skills": ["React","TypeScript",...]}',
        },
        { role: 'user', content: jdText.slice(0, 4000) },
      ],
      response_format: { type: 'json_object' },
    })
    const parsed = JSON.parse(res.choices[0].message.content ?? '{}')
    return Array.isArray(parsed.skills) ? parsed.skills : []
  } catch {
    return []
  }
}

function computeMatchScore(rawSimilarity: number, userSkills: string[], jdSkills: string[]) {
  if (!jdSkills.length) {
    return { match_score: Math.round(rawSimilarity * 100), matched_skills: [], missing_skills: [] }
  }
  const userLower = (userSkills ?? []).map(s => s.toLowerCase())
  const matched_skills = jdSkills.filter(s => userLower.includes(s.toLowerCase()))
  const missing_skills = jdSkills.filter(s => !userLower.includes(s.toLowerCase()))
  const overlap = matched_skills.length / jdSkills.length
  const match_score = Math.round((rawSimilarity * 0.80 + overlap * 0.20) * 100)
  return { match_score, matched_skills, missing_skills }
}

// ====================================================================
// POST /api/talent — main talent search
// ====================================================================
app.post('/', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await c.req.json().catch(() => ({}))
  const {
    searchQuery = '',
    selectedSkills = [],
    selectedLocation = '',
    selectedWorkPreferences = [],
    selectedLanguages = [],
    minYears,
    maxYears,
    selectedDegree,
    selectedFieldOfStudy,
    currentlyEmployed = false,
    jobSeekingStatus,
    jdMode = 'none',
    selectedJobId,
    jdText = '',
    page = 1,
  } = body

  const limit = LIMIT
  const offset = (page - 1) * limit
  const isSemanticMode = jdMode === 'none' && !!searchQuery.trim()
  const isJdMode = jdMode === 'job' || jdMode === 'text'

  let query = supabaseAdmin
    .from('talent_search_view')
    .select(
      'uuid, first_name, last_name, headline, location, skills, work_preferences, languages, experience, education, image, status, job_seeking_status, experience_years, privacy_lastname, privacy_picture, privacy_contact_details',
      { count: 'exact' }
    )
    .neq('role', 'feed_participant')
    .eq('status', 'Active')

  if (selectedLocation) query = query.ilike('location', `%${selectedLocation}%`)
  if (selectedSkills.length) query = query.overlaps('skills', selectedSkills)
  if (selectedWorkPreferences.length) query = query.overlaps('work_preferences', selectedWorkPreferences)
  if (selectedLanguages.length) {
    query = query.or(selectedLanguages.map((l: string) => `languages.cs.[{"name":"${l}"}]`).join(','))
  }
  if (selectedDegree) query = query.filter('education', 'cs', JSON.stringify([{ degree: selectedDegree }]))
  if (selectedFieldOfStudy) query = query.filter('education', 'cs', JSON.stringify([{ field: selectedFieldOfStudy }]))
  if (currentlyEmployed) query = query.filter('experience', 'cs', '[{"current":true}]')
  if (jobSeekingStatus) query = query.eq('job_seeking_status', jobSeekingStatus)
  if (minYears != null) query = query.gte('experience_years', minYears)
  if (maxYears != null) query = query.lte('experience_years', maxYears)

  let queryEmbedding: number[] | null = null
  let jdSkills: string[] = []
  let similarityMap: Record<string, number> = {}

  // ---- Embedding phase ----
  if (isSemanticMode || isJdMode) {
    if (isJdMode && jdMode === 'job' && selectedJobId) {
      const { data: cached } = await supabaseAdmin
        .from('job_embeddings').select('embedding').eq('job_id', selectedJobId).single()
      if (cached) {
        queryEmbedding = cached.embedding
      } else {
        const { data: job } = await supabaseAdmin
          .from('open_position').select('job_description_html, job_title').eq('job_id', selectedJobId).single()
        if (!job) return c.json({ error: 'Job not found' }, 404)
        const textToEmbed = stripHtml(job.job_description_html) + ' ' + job.job_title
        try {
          queryEmbedding = await getEmbedding(textToEmbed)
          await supabaseAdmin.from('job_embeddings').upsert({ job_id: selectedJobId, embedding: queryEmbedding })
        } catch {
          return c.json({ error: 'Search unavailable' }, 503)
        }
        jdSkills = await extractSkillsFromJd(textToEmbed)
      }
      if (queryEmbedding && !jdSkills.length) {
        const { data: job } = await supabaseAdmin
          .from('open_position').select('job_description_html, job_title').eq('job_id', selectedJobId).single()
        if (job) jdSkills = await extractSkillsFromJd(stripHtml(job.job_description_html) + ' ' + job.job_title)
      }
    } else if (isJdMode && jdMode === 'text') {
      if (!jdText?.trim()) return c.json({ error: 'Empty JD' }, 400)
      try {
        queryEmbedding = await getEmbedding(jdText.slice(0, 6000))
      } catch {
        return c.json({ error: 'Search unavailable' }, 503)
      }
      jdSkills = await extractSkillsFromJd(jdText)
    } else if (isSemanticMode) {
      try {
        queryEmbedding = await getEmbedding(searchQuery)
      } catch {
        return c.json({ error: 'Search unavailable' }, 503)
      }
    }

    if (queryEmbedding) {
      const { data: matches } = await supabaseAdmin.rpc('match_users_by_embedding', {
        query_embedding: queryEmbedding,
        similarity_threshold: 0.15,
        match_count: 200,
      })
      const vectorMatches = matches ?? []

      if (vectorMatches.length === 0) {
        return c.json({
          users: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
          mode: isJdMode ? 'jd' : 'semantic',
        })
      }

      similarityMap = Object.fromEntries(vectorMatches.map((m: any) => [m.user_id, m.similarity]))
      query = query.in('uuid', vectorMatches.map((m: any) => m.user_id))
    }
  }

  // ---- Execute SQL ----
  let results: any[] = []
  let total = 0

  if (!isSemanticMode && !isJdMode) {
    const { data, count, error } = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1)
    if (error) return c.json({ error: error.message }, 500)
    results = data ?? []
    total = count ?? 0
  } else {
    const { data, error } = await query
    if (error) return c.json({ error: error.message }, 500)
    results = data ?? []
    total = results.length
  }

  // ---- Privacy + grant check ----
  const candidateUuids = results.map(u => u.uuid)

  const [grantsResult, pendingResult] = candidateUuids.length
    ? await Promise.all([
        supabaseAdmin
          .from('profile_access_requests')
          .select('candidate_id, approved_fields')
          .eq('recruiter_id', user.id)
          .in('status', ['approved', 'partial'])
          .gte('expires_at', new Date().toISOString())
          .in('candidate_id', candidateUuids),
        supabaseAdmin
          .from('profile_access_requests')
          .select('candidate_id')
          .eq('recruiter_id', user.id)
          .eq('status', 'pending')
          .in('candidate_id', candidateUuids),
      ])
    : [{ data: [] }, { data: [] }]

  const grantMap: Record<string, string[]> = Object.fromEntries(
    (grantsResult.data ?? []).map((g: any) => [g.candidate_id, g.approved_fields ?? []])
  )
  const pendingSet = new Set((pendingResult.data ?? []).map((p: any) => p.candidate_id))

  let mappedResults = results.map(u => {
    const approvedFields: string[] | undefined = grantMap[u.uuid]
    const canSeeName = approvedFields?.includes('last_name') || !u.privacy_lastname
    const canSeePicture = approvedFields?.includes('picture') || !u.privacy_picture
    const hasHiddenDetails = !canSeeName || !canSeePicture

    const matchData = isJdMode
      ? computeMatchScore(similarityMap[u.uuid] ?? 0, u.skills ?? [], jdSkills)
      : null

    return {
      uuid: u.uuid,
      first_name: u.first_name,
      last_name: canSeeName ? u.last_name : null,
      headline: u.headline,
      location: u.location,
      skills: u.skills,
      work_preferences: u.work_preferences,
      languages: u.languages,
      experience: u.experience,
      education: u.education,
      image: u.image,
      image_accessible: canSeePicture,
      has_hidden_details: hasHiddenDetails,
      access_status: approvedFields ? 'approved' : pendingSet.has(u.uuid) ? 'pending' : 'none',
      job_seeking_status: u.job_seeking_status,
      ...(isSemanticMode ? { similarity: similarityMap[u.uuid] ?? 0 } : {}),
      ...(matchData ?? {}),
    }
  })

  // ---- In-memory sort + paginate (semantic/JD only) ----
  if (isSemanticMode || isJdMode) {
    mappedResults = mappedResults.sort((a, b) =>
      (b.match_score ?? b.similarity ?? similarityMap[b.uuid] ?? 0) -
      (a.match_score ?? a.similarity ?? similarityMap[a.uuid] ?? 0)
    )
    total = mappedResults.length
    mappedResults = mappedResults.slice(offset, offset + limit)
  }

  return c.json({
    users: mappedResults,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    mode: isJdMode ? 'jd' : isSemanticMode ? 'semantic' : 'filters',
  })
})

// ====================================================================
// Saved Searches sub-routes
// ====================================================================

app.get('/saved-searches', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data, error } = await supabaseAdmin
    .from('saved_talent_searches')
    .select('id, name, filters, created_at, last_used_at')
    .eq('recruiter_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ searches: data ?? [] })
})

app.post('/saved-searches', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { name, filters } = await c.req.json().catch(() => ({}))
  if (!name?.trim() || !filters) return c.json({ error: 'name and filters are required' }, 400)

  const { data, error } = await supabaseAdmin
    .from('saved_talent_searches')
    .insert({ recruiter_id: user.id, name: name.trim(), filters })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ search: data }, 201)
})

app.delete('/saved-searches/:id', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const id = c.req.param('id')
  const { error } = await supabaseAdmin
    .from('saved_talent_searches')
    .delete()
    .eq('id', id)
    .eq('recruiter_id', user.id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

app.patch('/saved-searches/:id', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const id = c.req.param('id')
  const { error } = await supabaseAdmin
    .from('saved_talent_searches')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .eq('recruiter_id', user.id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default app

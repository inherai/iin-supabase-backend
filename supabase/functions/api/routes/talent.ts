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
  const userLower = (userSkills ?? []).map(s => s.toLowerCase())
  // Cap at 8 skills so a long JD doesn't dilute every candidate's score
  const effectiveJd = jdSkills.slice(0, 8)
  const matched_skills = effectiveJd.filter(s => userLower.includes(s.toLowerCase()))
  const missing_skills = effectiveJd.filter(s => !userLower.includes(s.toLowerCase()))

  // Calibrate cosine similarity: 0.15 (threshold) → 0, 0.45 (excellent) → 1
  const semScore = Math.min(Math.max((rawSimilarity - 0.15) / 0.30, 0), 1)

  let match_score: number
  if (effectiveJd.length === 0) {
    match_score = Math.round(semScore * 100)
  } else {
    // 70 pts max from skills + 30 pts max from semantics → honest spread, missing skills hurt
    const pointsPerSkill = 70 / effectiveJd.length
    match_score = Math.min(Math.round(matched_skills.length * pointsPerSkill + semScore * 30), 98)
  }

  return { match_score, matched_skills, missing_skills }
}

function hasPrivacyAccess(privacyArray: any, viewerRole: string): boolean {
  if (!privacyArray || !Array.isArray(privacyArray)) return false
  return privacyArray.includes(viewerRole)
}

// ====================================================================
// POST /api/talent — main talent search
// ====================================================================
app.post('/', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const viewerRole: string = user.app_metadata?.role || (user.app_metadata?.is_admin === true ? 'admin' : 'guest')

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
    jobSeekingStatuses = [],
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
      'uuid, first_name, raw_last_name, headline, about, location, skills, work_preferences, languages, experience, education, has_image, status, job_seeking_status, experience_years, privacy_contact_details, user_privacy_lastname, user_privacy_picture, raw_email, raw_phone',
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
  if (jobSeekingStatuses.length > 0) query = query.in('job_seeking_status', jobSeekingStatuses)
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
        match_count: 50,
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
    const { data, count, error } = await query.order('created_at', { ascending: false }).limit(50).range(offset, offset + limit - 1)
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
          .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
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

    // Privacy check: null means open/public (same logic as can_view_profile_picture RPC)
    const canSeeName = approvedFields?.includes('last_name') ||
      !u.user_privacy_lastname ||
      hasPrivacyAccess(u.user_privacy_lastname, viewerRole)
    const canSeePicture = approvedFields?.includes('picture') ||
      !u.user_privacy_picture ||
      hasPrivacyAccess(u.user_privacy_picture, viewerRole)
    const canSeeContact = approvedFields?.includes('contact_details') ||
      !u.privacy_contact_details ||
      hasPrivacyAccess(u.privacy_contact_details, viewerRole)

    const hasHiddenDetails = !canSeeContact

    const rawSim = similarityMap[u.uuid] ?? 0
    // Calibrated similarity for sorting in semantic mode (same scale as match_score)
    const calibratedSim = Math.min(Math.max((rawSim - 0.15) / 0.30, 0), 1)

    const matchData = isJdMode
      ? computeMatchScore(rawSim, u.skills ?? [], jdSkills)
      : isSemanticMode
      ? { match_score: Math.min(Math.round(calibratedSim * 100), 98) }
      : null

    return {
      uuid: u.uuid,
      first_name: u.first_name,
      last_name: canSeeName ? (u.raw_last_name ?? null) : null,
      headline: u.headline,
      about: u.about ?? null,
      location: u.location,
      skills: u.skills,
      work_preferences: u.work_preferences,
      languages: u.languages,
      experience: u.experience,
      education: u.education,
      image: u.has_image ? true : null,
      image_accessible: canSeePicture && !!u.has_image,
      contact_details: canSeeContact && (u.raw_email || u.raw_phone)
        ? { email: u.raw_email ?? null, phone: u.raw_phone ?? null }
        : null,
      has_hidden_details: hasHiddenDetails,
      access_status: approvedFields ? 'approved' : pendingSet.has(u.uuid) ? 'pending' : 'none',
      job_seeking_status: u.job_seeking_status,
      experience_years: u.experience_years ?? null,
      ...(matchData ?? {}),
    }
  })

  // ---- In-memory sort + paginate (semantic/JD only) ----
  if (isSemanticMode || isJdMode) {
    mappedResults = mappedResults.sort((a, b) =>
      (b.match_score ?? similarityMap[b.uuid] ?? 0) -
      (a.match_score ?? similarityMap[a.uuid] ?? 0)
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
// Match Explanations
// ====================================================================

app.post('/explanations', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const { candidates, jd_context } = await c.req.json()
  if (!Array.isArray(candidates) || !candidates.length || !jd_context?.trim()) {
    return c.json({ explanations: {} })
  }

  const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })

  const candidateList = candidates.slice(0, 25).map((cand: any) => ({
    uuid: cand.uuid,
    headline: cand.headline ?? null,
    skills: (cand.skills ?? []).join(', ') || null,
    experience_years: cand.experience_years ?? null,
    matched: (cand.matched_skills ?? []).join(', ') || null,
    missing: (cand.missing_skills ?? []).join(', ') || null,
  }))

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a recruiting assistant. For each candidate write one concise sentence (max 20 words) explaining the fit with the job. Be specific — mention skills or experience. Return JSON: {"explanations": {"<uuid>": "<sentence>", ...}}',
        },
        {
          role: 'user',
          content: `Job: ${jd_context.slice(0, 500)}\n\nCandidates:\n${JSON.stringify(candidateList)}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    })
    const parsed = JSON.parse(res.choices[0].message.content ?? '{}')
    return c.json({ explanations: parsed.explanations ?? {} })
  } catch {
    return c.json({ explanations: {} })
  }
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

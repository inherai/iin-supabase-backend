// ⚠️  ADMIN CLIENT usage in this file — bypasses ALL Supabase RLS policies.
// talent_search_view joins the users table directly (raw_last_name, raw_email,
// raw_phone, has_image) — privacy is enforced entirely in application code using
// privacy_* columns and active access grants from profile_access_requests.
// Before adding any new createClient(SERVICE_ROLE_KEY) call here, confirm with
// a second developer that there is no RLS-safe alternative.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import OpenAI from 'https://esm.sh/openai@4'
import {
  checkAccess,
  hasPrivacyAccess,
  stripHtml,
  getEmbedding,
  extractSkillsFromJd,
  computeMatchScore,
  type CategorizedSkills,
} from './_matchHelpers.ts'

const app = new Hono()
const LIMIT = 20

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

  // Guard: require at least one filter/query
  const hasAnyFilter =
    !!searchQuery.trim() ||
    isJdMode ||
    selectedSkills.length > 0 ||
    !!selectedLocation.trim() ||
    selectedWorkPreferences.length > 0 ||
    selectedLanguages.length > 0 ||
    minYears != null ||
    maxYears != null ||
    !!selectedDegree ||
    !!selectedFieldOfStudy ||
    currentlyEmployed ||
    jobSeekingStatuses.length > 0

  if (!hasAnyFilter) {
    return c.json({ users: [], pagination: { page: 1, limit, total: 0, totalPages: 0 }, mode: 'filters' })
  }

  let query = supabaseAdmin
    .from('talent_search_view')
    .select(
      'uuid, first_name, raw_last_name, headline, about, location, skills, work_preferences, languages, experience, education, has_image, status, job_seeking_status, experience_years, privacy_contact_details, user_privacy_lastname, user_privacy_picture, raw_email, raw_phone',
      { count: 'exact' }
    )
    .neq('role', 'feed_participant')
    .eq('status', 'Active')
    .not('raw_email', 'ilike', '%@deleted.local')

  if (selectedLocation) query = query.ilike('location', `%${selectedLocation}%`)
  if (selectedSkills.length) query = query.overlaps('skills', selectedSkills)
  if (selectedWorkPreferences.length) {
    // Case-insensitive: include lowercase and title-case variants to handle DB inconsistency
    const workPrefVariants = [...new Set([
      ...selectedWorkPreferences,
      ...selectedWorkPreferences.map((p: string) => p.toLowerCase()),
      ...selectedWorkPreferences.map((p: string) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()),
    ])]
    query = query.overlaps('work_preferences', workPrefVariants)
  }
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
  let jdSkills: CategorizedSkills = { required: [], preferred: [], nice_to_have: [], required_experience_years: null }
  let similarityMap: Record<string, number> = {}

  // ---- Embedding phase ----
  if (isSemanticMode || isJdMode) {
    if (isJdMode && jdMode === 'job' && selectedJobId) {
      let fetchedJob: { job_description_html: string; job_title: string } | null = null
      const { data: cached } = await supabaseAdmin
        .from('job_embeddings').select('embedding').eq('job_id', selectedJobId).single()
      if (cached) {
        queryEmbedding = cached.embedding
      } else {
        const { data: job } = await supabaseAdmin
          .from('open_position').select('job_description_html, job_title').eq('job_id', selectedJobId).single()
        if (!job) return c.json({ error: 'Job not found' }, 404)
        fetchedJob = job
        const textToEmbed = stripHtml(job.job_description_html) + ' ' + job.job_title
        try {
          queryEmbedding = await getEmbedding(textToEmbed)
          await supabaseAdmin.from('job_embeddings').upsert({ job_id: selectedJobId, embedding: queryEmbedding })
        } catch {
          return c.json({ error: 'Search unavailable' }, 503)
        }
        jdSkills = await extractSkillsFromJd(textToEmbed)
      }
      const hasNoSkills = !jdSkills.required.length && !jdSkills.preferred.length && !jdSkills.nice_to_have.length
      if (queryEmbedding && hasNoSkills) {
        const job = fetchedJob ?? (await supabaseAdmin
          .from('open_position').select('job_description_html, job_title').eq('job_id', selectedJobId).single()).data
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
          .select('candidate_id, approved_fields, status')
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

  const grantMap: Record<string, { approved_fields: string[]; status: string }> = Object.fromEntries(
    (grantsResult.data ?? []).map((g: any) => [g.candidate_id, {
      approved_fields: g.approved_fields ?? [],
      status: g.status,
    }])
  )
  const pendingSet = new Set((pendingResult.data ?? []).map((p: any) => p.candidate_id))

  let mappedResults = results.map(u => {
    const grant = grantMap[u.uuid]
    const approvedFields: string[] | undefined = grant?.approved_fields

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

    // Compute which fields are hidden from this recruiter
    const hiddenFields: string[] = []
    if (!canSeeName && u.user_privacy_lastname && u.raw_last_name) hiddenFields.push('last_name')
    if (!canSeePicture && u.user_privacy_picture && u.has_image) hiddenFields.push('picture')
    if (!canSeeContact && u.privacy_contact_details) hiddenFields.push('contact_details')

    const hasHiddenDetails = hiddenFields.length > 0

    const rawSim = similarityMap[u.uuid] ?? 0
    // Calibrated similarity for sorting in semantic mode (same scale as match_score)
    const calibratedSim = Math.min(Math.max((rawSim - 0.15) / 0.30, 0), 1)

    const matchData = isJdMode
      ? computeMatchScore(rawSim, u.skills ?? [], jdSkills, u.experience_years ?? 0)
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
      hidden_fields: hiddenFields,
      approved_fields: approvedFields ?? [],
      access_status: grant ? grant.status : pendingSet.has(u.uuid) ? 'pending' : 'none',
      job_seeking_status: u.job_seeking_status,
      experience_years: u.experience_years ?? null,
      ...(matchData ?? {}),
    }
  })

  // ---- In-memory sort only (semantic/JD) — return all ≤50, no pagination ----
  if (isSemanticMode || isJdMode) {
    mappedResults = mappedResults.sort((a, b) =>
      (b.match_score ?? similarityMap[b.uuid] ?? 0) -
      (a.match_score ?? similarityMap[a.uuid] ?? 0)
    )
    total = mappedResults.length
  }

  const isVectorMode = isSemanticMode || isJdMode
  return c.json({
    users: mappedResults,
    pagination: isVectorMode
      ? { page: 1, limit: total, total, totalPages: total > 0 ? 1 : 0 }
      : { page, limit, total, totalPages: Math.ceil(total / limit) },
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

// ====================================================================
// Recent Searches sub-routes
// ====================================================================

app.get('/recent-searches', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('recent_talent_searches')
    .select('id, executed_at, filters, search_mode, total, candidate_uuids, candidate_scores')
    .eq('recruiter_id', user.id)
    .gte('executed_at', cutoff)
    .order('executed_at', { ascending: false })
    .limit(5)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ searches: data ?? [] })
})

app.post('/recent-searches', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await c.req.json().catch(() => ({}))
  const { filters, search_mode, total, candidate_uuids, candidate_scores } = body

  if (!filters || !search_mode || total == null || !Array.isArray(candidate_uuids) || !candidate_scores) {
    return c.json({ error: 'filters, search_mode, total, candidate_uuids and candidate_scores are required' }, 400)
  }

  const { data, error } = await supabaseAdmin
    .from('recent_talent_searches')
    .insert({ recruiter_id: user.id, filters, search_mode, total, candidate_uuids, candidate_scores })
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  // Keep only the 5 most recent — delete older ones
  const { data: all } = await supabaseAdmin
    .from('recent_talent_searches')
    .select('id')
    .eq('recruiter_id', user.id)
    .order('executed_at', { ascending: false })

  const idsToKeep = (all ?? []).slice(0, 5).map((r: any) => r.id)
  const idsToDelete = (all ?? []).slice(5).map((r: any) => r.id)
  if (idsToDelete.length > 0) {
    await supabaseAdmin
      .from('recent_talent_searches')
      .delete()
      .in('id', idsToDelete)
  }

  return c.json({ search: data }, 201)
})

app.delete('/recent-searches/:id', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const id = c.req.param('id')
  const { error } = await supabaseAdmin
    .from('recent_talent_searches')
    .delete()
    .eq('id', id)
    .eq('recruiter_id', user.id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// ====================================================================
// POST /api/talent/batch-profiles — fetch live profiles by UUID list
// ====================================================================

app.post('/batch-profiles', async (c) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)

  const viewerRole: string = user.app_metadata?.role || (user.app_metadata?.is_admin === true ? 'admin' : 'guest')

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await c.req.json().catch(() => ({}))
  const { uuids } = body

  if (!Array.isArray(uuids) || uuids.length === 0) {
    return c.json({ users: [] })
  }

  const safeUuids: string[] = uuids.slice(0, 50)

  // Fetch profile data
  const { data: results, error } = await supabaseAdmin
    .from('talent_search_view')
    .select(
      'uuid, first_name, raw_last_name, headline, about, location, skills, work_preferences, languages, experience, education, has_image, status, job_seeking_status, experience_years, privacy_contact_details, user_privacy_lastname, user_privacy_picture, raw_email, raw_phone'
    )
    .in('uuid', safeUuids)
    .neq('role', 'feed_participant')
    .eq('status', 'Active')
    .not('raw_email', 'ilike', '%@deleted.local')

  if (error) return c.json({ error: error.message }, 500)
  const rows = results ?? []

  if (rows.length === 0) return c.json({ users: [] })

  const candidateUuids = rows.map((u: any) => u.uuid)

  // Privacy + access status — same pattern as main search
  const [grantsResult, pendingResult, savedResult] = await Promise.all([
    supabaseAdmin
      .from('profile_access_requests')
      .select('candidate_id, approved_fields, status')
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
    supabaseAdmin
      .from('saved_resources')
      .select('resource_id, id')
      .eq('user_id', user.id)
      .eq('saved_resource_type', 'candidate')
      .in('resource_id', candidateUuids),
  ])

  const grantMap: Record<string, { approved_fields: string[]; status: string }> = Object.fromEntries(
    (grantsResult.data ?? []).map((g: any) => [g.candidate_id, {
      approved_fields: g.approved_fields ?? [],
      status: g.status,
    }])
  )
  const pendingSet = new Set((pendingResult.data ?? []).map((p: any) => p.candidate_id))
  const savedMap: Record<string, string> = Object.fromEntries(
    (savedResult.data ?? []).map((s: any) => [s.resource_id, s.id])
  )

  const mappedResults = rows.map((u: any) => {
    const grant = grantMap[u.uuid]
    const approvedFields: string[] | undefined = grant?.approved_fields

    const canSeeName = approvedFields?.includes('last_name') ||
      !u.user_privacy_lastname ||
      hasPrivacyAccess(u.user_privacy_lastname, viewerRole)
    const canSeePicture = approvedFields?.includes('picture') ||
      !u.user_privacy_picture ||
      hasPrivacyAccess(u.user_privacy_picture, viewerRole)
    const canSeeContact = approvedFields?.includes('contact_details') ||
      !u.privacy_contact_details ||
      hasPrivacyAccess(u.privacy_contact_details, viewerRole)

    const hiddenFields: string[] = []
    if (!canSeeName && u.user_privacy_lastname && u.raw_last_name) hiddenFields.push('last_name')
    if (!canSeePicture && u.user_privacy_picture && u.has_image) hiddenFields.push('picture')
    if (!canSeeContact && u.privacy_contact_details) hiddenFields.push('contact_details')

    const savedId = savedMap[u.uuid]

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
      has_hidden_details: hiddenFields.length > 0,
      hidden_fields: hiddenFields,
      approved_fields: approvedFields ?? [],
      access_status: grant ? grant.status : pendingSet.has(u.uuid) ? 'pending' : 'none',
      job_seeking_status: u.job_seeking_status,
      experience_years: u.experience_years ?? null,
      is_saved: !!savedId,
      saved_id: savedId ?? undefined,
    }
  })

  // Return in the original requested order
  const orderMap = Object.fromEntries(safeUuids.map((id, i) => [id, i]))
  mappedResults.sort((a: any, b: any) => (orderMap[a.uuid] ?? 999) - (orderMap[b.uuid] ?? 999))

  return c.json({ users: mappedResults })
})

export default app

// Recruiters' talent tools: search, saved candidates, projects (pipeline), private notes,
// outreach history, and the jobs of the pages she recruits for.
// Who gets in: members with app role 'recruiters' (and Duallin admins). Which JOBS she can match
// candidates to: only those of company pages where she is owner / recruiter (company_admins).
//
// ⚠️  ADMIN CLIENT usage in this file — bypasses ALL Supabase RLS policies.
// Used only to (a) run talent_search() (service role only: it reads every member), (b) read
// talent_search_view (joins the private users columns), and (c) read this recruiter's own rows in
// profile_access_requests. What a recruiter sees of a candidate is decided in ONE place:
// mapCandidate() in _talentProfiles.ts. Projects, notes and saved candidates are read and written
// in the recruiter's own session (`c.get('supabase')`), under row-level security.
// Before adding any new createClient(SERVICE_ROLE_KEY) call here, confirm with
// a second developer that there is no RLS-safe alternative.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  checkAccess,
  stripHtml,
  getEmbedding,
  extractSkillsFromJd,
  computeMatchScore,
  type CategorizedSkills,
} from './_matchHelpers.ts'
import { filterParams, hasFilterParams, loadCandidates, matchedSkills } from './_talentProfiles.ts'
import { RECRUITING_ROLES, listManagedCompanyIds } from '../lib/companyAccess.ts'

const app = new Hono()
const PAGE_SIZE = 20
/** A job / description is scored against this many of the closest candidates. */
const JD_POOL = 200
const STAGES = ['sourced', 'contacted', 'replied', 'interviewing', 'offer', 'hired', 'not_fit']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const makeAdmin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// Every route here is for recruiters (and Duallin admins).
app.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user || !checkAccess(user)) return c.json({ error: 'Access denied' }, 403)
  await next()
})

// Ids in the path are uuids: anything else is "not found", not a database error.
for (const path of ['/candidates/:id/*', '/candidates/:id', '/projects/:id/*', '/projects/:id', '/project-candidates/:id', '/notes/:id', '/saved-searches/:id', '/recent-searches/:id']) {
  app.use(path, async (c, next) => {
    if (!UUID_RE.test(c.req.param('id') ?? '')) return c.json({ error: 'Not found' }, 404)
    await next()
  })
}

// ── Small in-memory cache (per Edge Function instance) ─────────────────────────
// Paging through a job match re-runs the search: the embedding and the extracted
// requirements of the same text are kept for a while instead of asking OpenAI again.
const CACHE_TTL_MS = 15 * 60 * 1000
const cache = new Map<string, { at: number; value: any }>()
async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = await make()
  if (cache.size > 200) cache.delete(cache.keys().next().value!)
  cache.set(key, { at: Date.now(), value })
  return value
}
async function hashOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ====================================================================
// POST /api/talent — the search
// ====================================================================
app.post('/', async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const admin = makeAdmin()
  const body = await c.req.json().catch(() => ({}))

  const searchQuery = typeof body.searchQuery === 'string' ? body.searchQuery.trim().slice(0, 300) : ''
  const jdMode: 'none' | 'job' | 'text' = body.jdMode === 'job' || body.jdMode === 'text' ? body.jdMode : 'none'
  const jdText = typeof body.jdText === 'string' ? body.jdText.slice(0, 12000) : ''
  const selectedJobId = typeof body.selectedJobId === 'string' ? body.selectedJobId : null
  const sort = ['relevance', 'recent', 'experience'].includes(body.sort) ? body.sort : 'relevance'
  const page = Math.max(1, Math.min(Number(body.page) || 1, 50))
  const filters = filterParams(body)

  const isJd = (jdMode === 'job' && !!selectedJobId) || (jdMode === 'text' && !!jdText.trim())
  const isSemantic = !isJd && !!searchQuery
  const hasAnyFilter = isJd || isSemantic || hasFilterParams(filters)
  const mode = isJd ? 'jd' : isSemantic ? 'semantic' : 'filters'
  if (!hasAnyFilter) {
    return c.json({ users: [], pagination: { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 0 }, mode, jd: null })
  }

  // ---- What to compare with: a job, a pasted description, or free text ----
  let embedding: number[] | null = null
  let jdSkills: CategorizedSkills | null = null
  let jdTitle: string | null = null
  let degraded = false
  try {
    if (isJd && jdMode === 'job') {
      const { data: job } = await admin.from('open_position')
        .select('job_title, job_description_html, job_description, company_id').eq('job_id', selectedJobId).maybeSingle()
      if (!job) return c.json({ error: 'Job not found' }, 404)
      // Only jobs of a page she recruits for (owner / recruiter). A pasted description is always fine.
      if (user.app_metadata?.is_admin !== true) {
        const managed = await listManagedCompanyIds(supabase, user.id, RECRUITING_ROLES)
        if (!job.company_id || !managed.includes(job.company_id)) return c.json({ error: 'Not your page\'s job', code: 'not_your_job' }, 403)
      }
      jdTitle = job.job_title
      const text = `${job.job_title}\n${stripHtml(job.job_description_html || job.job_description || '')}`
      const { data: stored } = await admin.from('job_embeddings').select('embedding').eq('job_id', selectedJobId).maybeSingle()
      embedding = stored?.embedding
        ? (typeof stored.embedding === 'string' ? JSON.parse(stored.embedding) : stored.embedding)
        : await getEmbedding(text)
      if (!stored) await admin.from('job_embeddings').upsert({ job_id: selectedJobId, embedding })
      jdSkills = await cached(`skills:job:${selectedJobId}:${await hashOf(text)}`, () => extractSkillsFromJd(text))
    } else if (isJd) {
      const key = await hashOf(jdText)
      embedding = await cached(`emb:${key}`, () => getEmbedding(jdText))
      jdSkills = await cached(`skills:${key}`, () => extractSkillsFromJd(jdText))
    } else if (isSemantic) {
      embedding = await cached(`emb:q:${searchQuery.toLowerCase()}`, () => getEmbedding(searchQuery))
    }
  } catch (err) {
    console.error('talent: embedding failed', err)
    if (isJd) return c.json({ error: 'Search unavailable', code: 'ai_unavailable' }, 503)
    degraded = true   // free text still matches words in profiles
  }

  const run = (limit: number, offset: number) => admin.rpc('talent_search', {
    p_viewer: user.id,
    p_query: isSemantic ? searchQuery : null,
    p_embedding: embedding,
    ...filters,
    p_sort: sort,
    p_limit: limit,
    p_offset: offset,
  })

  let ids: string[] = []
  let total = 0
  const extra = new Map<string, Record<string, unknown>>()

  if (isJd) {
    // Score the closest candidates against the job's requirements, then page through that order.
    const { data, error } = await run(JD_POOL, 0)
    if (error) return c.json({ error: error.message }, 500)
    const rows = (data ?? []) as any[]
    const scored = rows.map((r) => {
      const m = computeMatchScore(r.similarity ?? 0, r.skills ?? [], jdSkills!, r.experience_years ?? 0)
      return { id: r.candidate_id, m }
    })
    if (sort === 'relevance') scored.sort((a, b) => b.m.match_score - a.m.match_score)
    total = scored.length
    const pageRows = scored.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    ids = pageRows.map((r) => r.id)
    for (const r of pageRows) {
      extra.set(r.id, {
        match_score: r.m.match_score,
        matched_skills: r.m.matched_skills,
        missing_skills: r.m.missing_skills,
        match: {
          required: r.m.required,
          preferred: r.m.preferred,
          experience_years_required: r.m.experience_years_required,
        },
      })
    }
  } else {
    const { data, error } = await run(PAGE_SIZE, (page - 1) * PAGE_SIZE)
    if (error) return c.json({ error: error.message }, 500)
    const rows = (data ?? []) as any[]
    total = rows.length ? Number(rows[0].total_count) : 0
    ids = rows.map((r) => r.candidate_id)
    for (const r of rows) {
      // Free text: how close in meaning (0–1, calibrated like the job match), not a "match %".
      const relevance = r.similarity == null ? null : Math.min(Math.max((r.similarity - 0.15) / 0.3, 0), 1)
      extra.set(r.candidate_id, { relevance, keyword_hit: !!r.keyword_hit })
    }
  }

  try {
    const users = await loadCandidates(admin, supabase, user, ids, (id) => extra.get(id) ?? {})
    // The skills she filtered on, in the candidate's own spelling (highlighted on the card).
    if (!isJd) for (const u of users as any[]) u.matched_skills = matchedSkills(u.skills, filters.p_skills)
    return c.json({
      users,
      pagination: { page, limit: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) },
      mode,
      degraded,
      jd: isJd && jdSkills ? { title: jdTitle, ...jdSkills } : null,
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// GET /api/talent/overview — the opening view: numbers, common skills, newest candidates, her jobs
// ====================================================================
app.get('/overview', async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const admin = makeAdmin()
  const [stats, recent, jobs] = await Promise.all([
    admin.rpc('talent_overview', { p_viewer: user.id }),
    admin.rpc('talent_search', { p_viewer: user.id, p_sort: 'recent', p_limit: 6 }),
    myJobs(supabase, user.id),
  ])
  if (stats.error) return c.json({ error: stats.error.message }, 500)
  try {
    const newest = await loadCandidates(admin, supabase, user, ((recent.data ?? []) as any[]).map((r) => r.candidate_id))
    return c.json({ stats: stats.data, recent: newest, jobs })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// GET /api/talent/candidates/:id — one candidate (the side panel, deep links)
// ====================================================================
app.get('/candidates/:id', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)
  try {
    const [candidate] = await loadCandidates(makeAdmin(), c.get('supabase'), c.get('user'), [id])
    if (!candidate) return c.json({ error: 'Not found' }, 404)
    return c.json({ candidate })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// Saved candidates
// ====================================================================
app.get('/saved', async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const { data, count, error } = await supabase.from('saved_resources')
    .select('saved_resource_id, created_at', { count: 'exact' })
    .eq('user_id', user.id).eq('saved_resource_type', 'candidate')
    .order('created_at', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  if (error) return c.json({ error: error.message }, 500)
  const savedAt = new Map<string, string>((data ?? []).map((s: any) => [s.saved_resource_id, s.created_at]))
  try {
    const users = await loadCandidates(makeAdmin(), supabase, user, [...savedAt.keys()], (id) => ({ saved_at: savedAt.get(id) }))
    const total = count ?? 0
    return c.json({ users, pagination: { page, limit: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// Outreach she sent (and where each stands)
// ====================================================================
app.get('/outreach', async (c) => {
  const user = c.get('user')
  const admin = makeAdmin()
  const { data, error } = await admin.from('profile_access_requests')
    .select('candidate_id, updated_at')
    .eq('recruiter_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(200)
  if (error) return c.json({ error: error.message }, 500)
  try {
    const users = await loadCandidates(admin, c.get('supabase'), user, (data ?? []).map((r: any) => r.candidate_id))
    return c.json({ users })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// Jobs of the pages she recruits for (to match candidates to)
// ====================================================================
async function myJobs(supabase: any, userId: string) {
  const companyIds = await listManagedCompanyIds(supabase, userId, RECRUITING_ROLES)
  if (!companyIds.length) return []
  const { data, error } = await supabase.from('open_position')
    .select('job_id, job_title, company_name, location, created_at, companies(name)')
    .in('company_id', companyIds).eq('status', 'open')
    .order('created_at', { ascending: false }).limit(50)
  if (error) throw new Error(error.message)
  return (data ?? []).map((j: any) => ({
    job_id: j.job_id, job_title: j.job_title, company_name: j.companies?.name ?? j.company_name, location: j.location,
  }))
}

app.get('/my-jobs', async (c) => {
  try {
    return c.json({ jobs: await myJobs(c.get('supabase'), c.get('user').id) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// Projects — her lists of candidates, each with a stage
// ====================================================================
app.get('/projects', async (c) => {
  const supabase = c.get('supabase')
  const [projects, members] = await Promise.all([
    supabase.from('talent_projects').select('id, name, job_id, job_title, archived, created_at, updated_at').order('updated_at', { ascending: false }),
    supabase.from('talent_project_candidates').select('project_id, stage'),
  ])
  if (projects.error) return c.json({ error: projects.error.message }, 500)
  if (members.error) return c.json({ error: members.error.message }, 500)
  const counts = new Map<string, Record<string, number>>()
  for (const m of (members.data ?? []) as any[]) {
    const byStage = counts.get(m.project_id) ?? {}
    byStage[m.stage] = (byStage[m.stage] ?? 0) + 1
    counts.set(m.project_id, byStage)
  }
  return c.json({
    projects: (projects.data ?? []).map((p: any) => {
      const stages = counts.get(p.id) ?? {}
      return { ...p, stage_counts: stages, total: Object.values(stages).reduce((a, b) => a + b, 0) }
    }),
  })
})

const projectFields = (body: any) => {
  const out: Record<string, unknown> = {}
  if (typeof body.name === 'string') out.name = body.name.trim().slice(0, 120)
  if (body.job_id === null || typeof body.job_id === 'string') out.job_id = body.job_id ? String(body.job_id).slice(0, 200) : null
  if (body.job_title === null || typeof body.job_title === 'string') out.job_title = body.job_title ? String(body.job_title).trim().slice(0, 200) : null
  return out
}

app.post('/projects', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const fields = projectFields(body)
  if (!fields.name) return c.json({ error: 'name is required' }, 400)
  const { data, error } = await c.get('supabase').from('talent_projects').insert(fields)
    .select('id, name, job_id, job_title, archived, created_at, updated_at').single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ project: { ...data, stage_counts: {}, total: 0 } }, 201)
})

app.patch('/projects/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const fields = projectFields(body)
  if (fields.name === '') return c.json({ error: 'name is required' }, 400)
  if (typeof body.archived === 'boolean') fields.archived = body.archived
  fields.updated_at = new Date().toISOString()
  const { data, error } = await c.get('supabase').from('talent_projects').update(fields).eq('id', c.req.param('id'))
    .select('id, name, job_id, job_title, archived, created_at, updated_at').maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'Not found' }, 404)
  return c.json({ project: data })
})

app.delete('/projects/:id', async (c) => {
  const { error } = await c.get('supabase').from('talent_projects').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

app.get('/projects/:id/candidates', async (c) => {
  const supabase = c.get('supabase')
  const { data, error } = await supabase.from('talent_project_candidates')
    .select('id, candidate_id, stage, added_at, stage_changed_at')
    .eq('project_id', c.req.param('id'))
    .order('stage_changed_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  const membership = new Map<string, any>((data ?? []).map((m: any) => [m.candidate_id, m]))
  try {
    const users = await loadCandidates(makeAdmin(), supabase, c.get('user'), [...membership.keys()], (id) => {
      const m: any = membership.get(id)
      return { membership: { id: m.id, stage: m.stage, added_at: m.added_at, stage_changed_at: m.stage_changed_at } }
    })
    return c.json({ users })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/projects/:id/candidates', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const candidateId = String(body.candidate_id ?? '')
  if (!UUID_RE.test(candidateId)) return c.json({ error: 'candidate_id is required' }, 400)
  const stage = STAGES.includes(body.stage) ? body.stage : 'sourced'
  const supabase = c.get('supabase')
  const { data, error } = await supabase.from('talent_project_candidates')
    .insert({ project_id: c.req.param('id'), candidate_id: candidateId, stage })
    .select('id, project_id, candidate_id, stage, added_at, stage_changed_at').single()
  if (error) {
    if (error.code === '23505') return c.json({ error: 'Already in this project', code: 'already_in_project' }, 409)
    if (error.code === '42501') return c.json({ error: 'Not allowed' }, 403)
    return c.json({ error: error.message }, 400)
  }
  await supabase.from('talent_projects').update({ updated_at: new Date().toISOString() }).eq('id', c.req.param('id'))
  return c.json({ membership: data }, 201)
})

app.patch('/project-candidates/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!STAGES.includes(body.stage)) return c.json({ error: 'stage is not valid' }, 400)
  const { data, error } = await c.get('supabase').from('talent_project_candidates')
    .update({ stage: body.stage, stage_changed_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .select('id, project_id, candidate_id, stage, added_at, stage_changed_at').maybeSingle()
  if (error) return c.json({ error: error.message }, 400)
  if (!data) return c.json({ error: 'Not found' }, 404)
  return c.json({ membership: data })
})

app.delete('/project-candidates/:id', async (c) => {
  const { error } = await c.get('supabase').from('talent_project_candidates').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

// ====================================================================
// Private notes on a candidate
// ====================================================================
app.get('/candidates/:id/notes', async (c) => {
  const { data, error } = await c.get('supabase').from('talent_notes')
    .select('id, body, created_at').eq('candidate_id', c.req.param('id'))
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ notes: data ?? [] })
})

app.post('/candidates/:id/notes', async (c) => {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text || text.length > 2000) return c.json({ error: 'A note is 1–2000 characters' }, 400)
  const { data, error } = await c.get('supabase').from('talent_notes')
    .insert({ candidate_id: id, body: text }).select('id, body, created_at').single()
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ note: data }, 201)
})

app.delete('/notes/:id', async (c) => {
  const { error } = await c.get('supabase').from('talent_notes').delete().eq('id', c.req.param('id'))
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

// ====================================================================
// Saved searches
// ====================================================================
app.get('/saved-searches', async (c) => {
  const user = c.get('user')
  const { data, error } = await makeAdmin()
    .from('saved_talent_searches')
    .select('id, name, filters, created_at, last_used_at')
    .eq('recruiter_id', user.id)
    .order('created_at', { ascending: false })
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ searches: data ?? [] })
})

app.post('/saved-searches', async (c) => {
  const user = c.get('user')
  const { name, filters } = await c.req.json().catch(() => ({}))
  if (!name?.trim() || !filters || typeof filters !== 'object') return c.json({ error: 'name and filters are required' }, 400)
  const { data, error } = await makeAdmin()
    .from('saved_talent_searches')
    .insert({ recruiter_id: user.id, name: String(name).trim().slice(0, 80), filters })
    .select()
    .single()
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ search: data }, 201)
})

app.delete('/saved-searches/:id', async (c) => {
  const user = c.get('user')
  const { error } = await makeAdmin()
    .from('saved_talent_searches')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('recruiter_id', user.id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

app.patch('/saved-searches/:id', async (c) => {
  const user = c.get('user')
  const { error } = await makeAdmin()
    .from('saved_talent_searches')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .eq('recruiter_id', user.id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// ====================================================================
// Recent searches (the last 5 of the past 14 days; re-run live when opened)
// ====================================================================
app.get('/recent-searches', async (c) => {
  const user = c.get('user')
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await makeAdmin()
    .from('recent_talent_searches')
    .select('id, executed_at, filters, search_mode, total')
    .eq('recruiter_id', user.id)
    .gte('executed_at', cutoff)
    .order('executed_at', { ascending: false })
    .limit(5)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ searches: data ?? [] })
})

app.post('/recent-searches', async (c) => {
  const user = c.get('user')
  const admin = makeAdmin()
  const { filters, search_mode, total } = await c.req.json().catch(() => ({}))
  if (!filters || typeof filters !== 'object' || !['filters', 'semantic', 'jd'].includes(search_mode) || typeof total !== 'number') {
    return c.json({ error: 'filters, search_mode and total are required' }, 400)
  }
  // The same search again moves to the top instead of filling the list with copies.
  const key = JSON.stringify(filters)
  const { data: existing } = await admin.from('recent_talent_searches')
    .select('id, filters').eq('recruiter_id', user.id)
  const same = (existing ?? []).filter((r: any) => JSON.stringify(r.filters) === key).map((r: any) => r.id)
  if (same.length) await admin.from('recent_talent_searches').delete().in('id', same)

  const { data, error } = await admin
    .from('recent_talent_searches')
    .insert({ recruiter_id: user.id, filters, search_mode, total, candidate_uuids: [], candidate_scores: {} })
    .select('id, executed_at, filters, search_mode, total')
    .single()
  if (error) return c.json({ error: error.message }, 500)

  const { data: all } = await admin
    .from('recent_talent_searches')
    .select('id')
    .eq('recruiter_id', user.id)
    .order('executed_at', { ascending: false })
  const idsToDelete = (all ?? []).slice(5).map((r: any) => r.id)
  if (idsToDelete.length > 0) await admin.from('recent_talent_searches').delete().in('id', idsToDelete)

  return c.json({ search: data }, 201)
})

app.delete('/recent-searches/:id', async (c) => {
  const user = c.get('user')
  const { error } = await makeAdmin()
    .from('recent_talent_searches')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('recruiter_id', user.id)
  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default app

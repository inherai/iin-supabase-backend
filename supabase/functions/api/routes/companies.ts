// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { CONTENT_ROLES, getCompanyRole, type CompanyRole } from '../lib/companyAccess.ts'
import { getEntitlement } from '../lib/entitlements.ts'
import { followedCompanyIds, isFollowingCompany, setCompanyFollow } from '../lib/companyFollows.ts'
import { recordCompanyView } from '../lib/companyViews.ts'
import { fetchAcceptedConnectionIds, isUuid } from './_connectionIds.ts'
import { ORG_TYPES, cleanText, freeText, isHttpsUrl, validatePageUpdate } from '../lib/companyPageFields.ts'
import { sendNewClaimAlert } from '../lib/emails/companyPages.ts'

const app = new Hono()

// Only what the client shows. Never `*`: the table also holds import data with third-party
// contact details (source_raw_json) and owner_uuid, which must not reach the browser — and
// members are not granted those columns in the database (secure_companies_step2_safe.sql).
const COMPANY_COLUMNS =
  'id, name, active, description, employee_count_range, founded_on, industries, linkedin_url, ' +
  'locations, logo, phone, specialities, tagline, universal_name, website, created_at, ' +
  'employees, employees_count'
const RANKED_COMPANY_COLUMNS = `${COMPANY_COLUMNS}, open_positions_count, activity_score, latest_job_at`

// The company page (/company/<slug>): the public page fields.
const PAGE_COLUMNS =
  'id, slug, name, name_he, org_type, page_status, verified, logo, cover_image_url, ' +
  'tagline, tagline_he, description, description_he, website, phone, linkedin_url, ' +
  'industries, specialities, locations, employee_count_range, founded_on, ' +
  'cta_type, cta_url, followers_count, employees, employees_count, active, created_at'

const PAGE_ROLES: CompanyRole[] = ['owner', 'content', 'recruiter', 'analyst']
const EMPLOYEES_PREVIEW = 12
const RECENT_ARTICLES = 3

const REPORT_REASONS = ['impersonation', 'wrong_info', 'inappropriate', 'spam', 'other']
const CLAIM_COLUMNS =
  'id, company_id, requested_by, org_name, org_type, website, requester_title, work_email, message, ' +
  'status, granted_role, review_note, reviewed_at, created_at'

// Hosts our storage is served from: logo and cover addresses must be on one of them.
const STORAGE_HOSTS = [new URL(Deno.env.get('SUPABASE_URL') ?? 'https://invalid.local').host, 'api.duallin.com']

const parseCompanyId = (raw: string): number | null => (/^\d{1,9}$/.test(raw) ? parseInt(raw, 10) : null)

// Database refusals → what the client should hear.
function dbErrorResponse(c: any, error: { message: string; code?: string }) {
  if (error.code === '42501') return c.json({ error: 'Not allowed' }, 403)
  if (error.code === '23505') return c.json({ error: 'Already exists', code: 'conflict' }, 409)
  if (error.code === '23503') return c.json({ error: 'Not found' }, 404)
  if (error.code === 'P0001') return c.json({ error: error.message, code: 'refused' }, 409)
  if (error.code === '23514') return c.json({ error: error.message }, 400)
  return c.json({ error: error.message }, 400)
}

const israelFirst = (locations: any) => {
  if (!Array.isArray(locations) || locations.length === 0) return locations || []
  const israel = locations.filter((loc: any) => loc?.country === 'IL')
  return israel.length > 0 ? israel : [locations[0]]
}

// Employee details come from public_users_view by uuid. One `.in()` with every employee of a
// page builds a GET URL the gateway rejects once the biggest companies share a page (that is
// exactly page 1 of sort=members), so the lookup goes out in chunks of 100 ids.
const USERS_CHUNK = 100
async function fetchPublicUsers(
  supabase: any,
  ids: unknown[],
): Promise<{ users: any[]; error: { message: string } | null }> {
  const uniq = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  const chunks: string[][] = []
  for (let i = 0; i < uniq.length; i += USERS_CHUNK) chunks.push(uniq.slice(i, i + USERS_CHUNK))

  const results = await Promise.all(chunks.map((chunk) =>
    supabase
      .from('public_users_view')
      .select('uuid, first_name, last_name, headline, image')
      .in('uuid', chunk)
  ))

  const failed = results.find((r: any) => r.error)
  if (failed) return { users: [], error: failed.error }

  // image arrives as text from the view; the client expects true | null
  const users = results
    .flatMap((r: any) => r.data || [])
    .map((u: any) => ({ ...u, image: u.image === 'true' ? true : null }))
  return { users, error: null }
}

// GET /api/companies/mentionable?search= — managed pages by name, for @mentions in posts and comments
app.get('/mentionable', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const search = (c.req.query('search') || '').trim().slice(0, 60)
  if (!search) return c.json({ pages: [] })

  const { data, error } = await c.get('supabase')
    .from('companies')
    .select('id, name, logo, slug, tagline')
    .eq('page_status', 'claimed')
    .ilike('name', `%${search.replace(/[%_\\]/g, '\\$&')}%`)
    .order('followers_count', { ascending: false })
    .limit(5)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ pages: data || [] })
})

const SEARCH_PAGE_COLUMNS =
  'id, slug, name, name_he, logo, tagline, tagline_he, verified, followers_count, org_type, page_status'
const SEARCH_PAGES_LIMIT = 4

// GET /api/companies/search-pages?q= — organization pages for the site search, by name in
// either language: managed pages first, then by followers. Suspended pages are left out.
app.get('/search-pages', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const q = (c.req.query('q') || '').trim().slice(0, 60)
  if (q.length < 2) return c.json({ pages: [] })

  const supabase = c.get('supabase')
  const pattern = `%${q.replace(/[%_\\]/g, '\\$&')}%`
  // one query per name column: the text never goes inside an or() filter string
  const byColumn = (column: 'name' | 'name_he') => supabase
    .from('companies')
    .select(SEARCH_PAGE_COLUMNS)
    .neq('page_status', 'suspended')
    .ilike(column, pattern)
    .order('page_status', { ascending: true }) // 'claimed' before 'unclaimed'
    .order('followers_count', { ascending: false, nullsFirst: false })
    .limit(SEARCH_PAGES_LIMIT)

  const [english, hebrew] = await Promise.all([byColumn('name'), byColumn('name_he')])
  if (english.error) return c.json({ error: english.error.message }, 500)

  const byId = new Map<number, any>()
  for (const row of [...(english.data || []), ...(hebrew.data || [])]) byId.set(row.id, row)
  const found = [...byId.values()]
    .sort((a, b) =>
      (a.page_status === 'claimed' ? 0 : 1) - (b.page_status === 'claimed' ? 0 : 1) ||
      (b.followers_count ?? 0) - (a.followers_count ?? 0))
    .slice(0, SEARCH_PAGES_LIMIT)

  const following = await followedCompanyIds(supabase, user.id, found.map((page) => page.id))
  return c.json({
    pages: found.map(({ page_status, ...page }) => ({
      ...page,
      is_claimed: page_status === 'claimed',
      is_following: following.has(page.id),
    })),
  })
})

// GET /api/companies - companies list with pagination and search
app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')

  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || c.req.query('limit') || '20')
  const search = c.req.query('search') || ''
  const sort = c.req.query('sort') || 'latest_job'
  const offset = (page - 1) * pageSize

  let query = supabase
    .from('companies_ranked')
    .select(RANKED_COMPANY_COLUMNS, { count: 'exact' })

  if (sort === 'members') {
    query = query
      .order('employees_count', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
  } else {
    query = query
      .order('latest_job_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
  }

  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const { data, error, count } = await query
    .range(offset, offset + pageSize - 1)

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  const companies = data || []

  const allEmployeeIds = [...new Set(
    companies
      .flatMap((company: any) => (Array.isArray(company.employees) ? company.employees : []))
      .filter((id: any) => typeof id === 'string')
  )]

  const { users, error: usersError } = await fetchPublicUsers(supabase, allEmployeeIds)
  if (usersError) {
    return c.json({ error: usersError.message }, 400)
  }
  const usersById = new Map<string, any>(users.map((u: any) => [u.uuid, u]))

  const processedData = companies.map((company: any) => {
    const employeeIds = Array.isArray(company.employees) ? company.employees : []
    const employeesDetails = employeeIds
      .map((employeeId: string) => usersById.get(employeeId))
      .filter(Boolean)

    const nextCompany = {
      ...company,
      employees: employeesDetails,
      open_positions_count: company.open_positions_count ?? 0,
    }

    if (!Array.isArray(company.locations) || company.locations.length === 0) {
      return nextCompany
    }

    const israelLocations = company.locations.filter((loc: any) => loc?.country === 'IL')

    return {
      ...nextCompany,
      locations: israelLocations.length > 0 ? israelLocations : [company.locations[0]]
    }
  })

  c.header('Cache-Control', 'public, max-age=300, s-maxage=900');
  return c.json({
    companies: processedData,
    pagination: {
      page,
      pageSize,
      total: count,
      totalPages: Math.ceil((count || 0) / pageSize)
    }
  })
})

// GET /api/companies/:id - חברה בודדת לפי ID
app.get('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = c.req.param('id')
  const companyIdValue = /^\d+$/.test(companyId) ? parseInt(companyId, 10) : companyId

  const { data: company, error } = await supabase
    .from('companies')
    .select(COMPANY_COLUMNS)
    .eq('id', companyIdValue)
    .single()

  if (error) {
    return c.json({ error: error.message }, 404)
  }

  if (!company) {
    return c.json({ error: 'Company not found' }, 404)
  }

  // שליפת פרטי העובדים
  const employeeIds = Array.isArray(company.employees) ? company.employees : []
  let employeesDetails = []
  const employeesCount = employeeIds.filter((id: any) => id !== null && id !== undefined).length

  if (employeeIds.length > 0) {
    const { users, error: usersError } = await fetchPublicUsers(supabase, employeeIds)
    if (!usersError) employeesDetails = users
  }

  let openPositionsCount = 0
  const { count: positionsCount, error: positionsError } = await supabase
    .from('open_position')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyIdValue)
    .eq('status', 'open')

  if (!positionsError && typeof positionsCount === 'number') {
    openPositionsCount = positionsCount
  }

  // סינון locations לישראל
  let locations = company.locations || []
  if (Array.isArray(locations) && locations.length > 0) {
    const israelLocations = locations.filter((loc: any) => loc?.country === 'IL')
    locations = israelLocations.length > 0 ? israelLocations : [locations[0]]
  }

  c.header('Cache-Control', 'public, max-age=300, s-maxage=900');
  return c.json({
    ...company,
    employees: employeesDetails,
    locations,
    employees_count: employeesCount,
    open_positions_count: openPositionsCount
  })
})

// ==================== COMPANY PAGE ====================

// GET /api/companies/by-slug/:slug — the page (by address, or by id for old links), plus what the viewer may do on it
app.get('/by-slug/:slug', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const slug = c.req.param('slug').toLowerCase()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return c.json({ error: 'Company not found' }, 404)

  // A value of digits only is a company id (links that predate page addresses); a slug is
  // never digits only — the id is appended to such names.
  const byId = parseCompanyId(slug)
  const lookup = supabase.from('companies').select(PAGE_COLUMNS)
  const { data: company, error } = await (byId !== null ? lookup.eq('id', byId) : lookup.eq('slug', slug)).maybeSingle()

  if (error) return c.json({ error: error.message }, 400)
  if (!company) return c.json({ error: 'Company not found' }, 404)

  const employeeIds = (Array.isArray(company.employees) ? company.employees : []).filter(Boolean)
  const [role, isFollowing, positions, articles, people] = await Promise.all([
    getCompanyRole(supabase, user.id, company.id),
    isFollowingCompany(supabase, user.id, company.id),
    supabase.from('open_position').select('id', { count: 'exact', head: true }).eq('company_id', company.id).eq('status', 'open'),
    // the page's latest published articles (and how many there are in all)
    supabase.from('articles').select('id, title, cover_image_url, published_at', { count: 'exact' })
      .eq('company_id', company.id).eq('status', 'published').is('deleted_at', null)
      .order('is_pinned', { ascending: false }).order('published_at', { ascending: false }).limit(RECENT_ARTICLES),
    fetchPublicUsers(supabase, employeeIds.slice(0, EMPLOYEES_PREVIEW)),
  ])

  const isPlatformAdmin = user.app_metadata?.is_admin === true
  // A suspended page is shown only to the people who manage it
  if (company.page_status === 'suspended' && !role && !isPlatformAdmin) {
    return c.json({ error: 'Company not found' }, 404)
  }

  // a look by a member counts toward the page's numbers (its managers and Duallin admins don't)
  if (!role && !isPlatformAdmin) await recordCompanyView(supabase, user.id, company.id)

  // an invitation to follow the page that she hasn't answered (only she can read it)
  let pendingInvite: { inviter: any } | null = null
  if (!isFollowing) {
    const { data: invite } = await supabase.from('company_follow_invites')
      .select('inviter_id').eq('company_id', company.id).eq('invitee_id', user.id).eq('status', 'pending').maybeSingle()
    if (invite) {
      const { data: inviter } = invite.inviter_id
        ? await supabase.from('public_users_view').select('uuid, first_name, last_name').eq('uuid', invite.inviter_id).maybeSingle()
        : { data: null }
      pendingInvite = { inviter: inviter ?? null }
    }
  }

  const canEdit = isPlatformAdmin || (company.page_status !== 'suspended' && role !== null && CONTENT_ROLES.includes(role))
  // the page's recruiters see how many applications wait for them (the database counts only what they may read)
  const newApplications = role === 'owner' || role === 'recruiter'
    ? ((await supabase.rpc('company_new_applications_count', { p_company_id: company.id })).data ?? 0)
    : null
  return c.json({
    ...company,
    employees: people.users,
    employees_count: employeeIds.length,
    locations: israelFirst(company.locations),
    open_positions_count: positions.count ?? 0,
    articles_count: articles.count ?? 0,
    recent_articles: articles.data ?? [],
    viewer: {
      role,
      is_following: isFollowing,
      can_edit: canEdit,
      can_rename: isPlatformAdmin || (canEdit && role === 'owner'),
      can_manage_admins: isPlatformAdmin || role === 'owner',
      new_applications: newApplications,
      pending_invite: pendingInvite,
    },
  })
})

// PATCH /api/companies/:id — a page manager edits the page's fields.
// Who may edit, and which fields, is enforced by the database; this only validates the values.
app.patch('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const body = await c.req.json().catch(() => ({}))

  const checked = validatePageUpdate(body, companyId, STORAGE_HOSTS, new Date().getFullYear())
  if ('error' in checked) return c.json({ error: checked.error }, 400)
  const { updates } = checked

  const { data, error } = await supabase
    .from('companies')
    .update(updates)
    .eq('id', companyId)
    .select(PAGE_COLUMNS)
    .maybeSingle()

  if (error) return dbErrorResponse(c, error)
  // No row back: the page doesn't exist, or the database didn't let her edit it
  if (!data) return c.json({ error: 'Not found or not allowed' }, 403)

  // the employees list is the community's, not part of what was edited
  const { employees: _employees, ...page } = data
  return c.json(page)
})

// GET /api/companies/:id/post-ids — the page's posts, newest first, as ids only.
// The client turns ids into full posts through GET /api/posts?ids=, the same pipeline as the
// feed and search (authors, privacy, reactions) — never a second enrichment path.
app.get('/:id/post-ids', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '10') || 10, 1), 50)
  const before = c.req.query('before')

  let query = supabase
    .from('posts')
    .select('id, sent_at')
    .eq('company_id', companyId)
    .order('sent_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (before) {
    if (Number.isNaN(Date.parse(before))) return c.json({ error: 'Invalid cursor' }, 400)
    query = query.lt('sent_at', before)
  }
  // Recruiters don't see community-only posts anywhere
  if (String(user.app_metadata?.role ?? '').toLowerCase().trim() === 'recruiters') {
    query = query.or('community_members_only.is.null,community_members_only.eq.false')
  }

  const { data, error } = await query
  if (error) return c.json({ error: error.message }, 400)

  const rows = data || []
  const page = rows.slice(0, limit)
  return c.json({
    ids: page.map((p: any) => String(p.id)),
    next_cursor: rows.length > limit ? page[page.length - 1].sent_at : null,
  })
})

// POST /api/companies/:id/job-views/:jobId — she opened one of the page's jobs.
// Always answers 204: whether the look was counted is none of the viewer's concern.
app.post('/:id/job-views/:jobId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  const jobId = Number(c.req.param('jobId'))
  if (companyId === null || !Number.isSafeInteger(jobId) || jobId <= 0) return c.json({ error: 'Invalid id' }, 400)

  if (user.app_metadata?.is_admin !== true) await recordCompanyView(c.get('supabase'), user.id, companyId, jobId)
  return c.body(null, 204)
})

// GET /api/companies/:id/stats?days=7|30|90 — the page's numbers, totals only.
// Who may see them (any manager of the page, when the plan includes them) is decided by the database.
app.get('/:id/stats', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const days = Number(c.req.query('days') || 30)

  const { data, error } = await c.get('supabase').rpc('company_page_stats', { p_company_id: companyId, p_days: days })
  if (error) {
    if (error.code === '42501') {
      const code = error.message === 'not_in_plan' ? 'not_in_plan' : 'forbidden'
      return c.json({ error: error.message, code }, 403)
    }
    return dbErrorResponse(c, error)
  }
  return c.json(data)
})

// ─── Growing the page ─────────────────────────────────────────────────────────
// All of it runs in the member's own session: who may invite whom, the monthly limit, the
// weekly employee alert and who may read what are decided by the database.

const INVITE_ERRORS: Record<string, number> = {
  not_a_connection: 400, already_following: 409, page_not_active: 403,
}

// GET /api/companies/:id/invite-candidates?search= — her connections who don't follow the page
// and weren't invited to it yet, with what is left of this month's invitations.
app.get('/:id/invite-candidates', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const supabase = c.get('supabase')
  const search = (c.req.query('search') || '').trim().toLowerCase().slice(0, 60)

  const invited = await supabase.rpc('company_invited_member_ids', { p_company_id: companyId })
  if (invited.error) return c.json({ error: invited.error.message, code: 'forbidden' }, 403)
  const { ids: connectionIds, error: connError } = await fetchAcceptedConnectionIds(supabase, user.id)
  if (connError) return c.json({ error: connError.message }, 500)

  const excluded = new Set<string>((invited.data || []).map((row: any) => typeof row === 'string' ? row : row.company_invited_member_ids))
  const remaining = connectionIds.filter((id) => !excluded.has(id))
  const followers = new Set<string>()
  for (let i = 0; i < remaining.length; i += 100) {
    const { data } = await supabase.from('article_company_follows').select('follower_uuid')
      .eq('company_id', companyId).in('follower_uuid', remaining.slice(i, i + 100))
    for (const row of data || []) followers.add(row.follower_uuid)
  }
  const candidateIds = remaining.filter((id) => !followers.has(id))

  const people: any[] = []
  for (let i = 0; i < candidateIds.length; i += 100) {
    const { data } = await supabase.from('public_users_view')
      .select('uuid, first_name, last_name, headline, image')
      .in('uuid', candidateIds.slice(i, i + 100))
    people.push(...(data || []))
  }
  const matching = people
    .filter((p) => !search || `${p.first_name ?? ''} ${p.last_name ?? ''}`.toLowerCase().includes(search))
    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))

  // this month's invitations: the same numbers the plan screen shows
  const { data: plan } = await supabase.rpc('entitlements_for', { p_subject_type: 'company', p_subject_id: String(companyId) })
  const quota = (plan || []).find((row: any) => row.feature_key === 'page.follow_invites.monthly')
  return c.json({
    candidates: matching.slice(0, 200),
    total: matching.length,
    invites_left: !quota?.enabled ? 0 : quota.limit_value === null ? null : Math.max(0, quota.limit_value - (quota.used ?? 0)),
  })
})

// POST /api/companies/:id/invites { user_ids } — invite connections to follow the page.
// Each is sent on its own, so one refusal doesn't stop the rest; the answer says what happened.
app.post('/:id/invites', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const userIds: string[] = Array.isArray(body?.user_ids) ? [...new Set<string>(body.user_ids.filter(isUuid))].slice(0, 50) : []
  if (userIds.length === 0) return c.json({ error: 'No one to invite' }, 400)

  const supabase = c.get('supabase')
  const invited: string[] = []
  const refused: Array<{ user_id: string; code: string }> = []
  for (const inviteeId of userIds) {
    const { error } = await supabase.from('company_follow_invites').insert({ company_id: companyId, invitee_id: inviteeId })
    if (!error) { invited.push(inviteeId); continue }
    const code = error.code === '23505' ? 'already_invited'
      : error.message?.startsWith('entitlement_limit_reached') ? 'limit_reached'
      : error.message?.startsWith('entitlement_not_included') ? 'not_in_plan'
      : INVITE_ERRORS[error.message] ? error.message
      : error.code === '42501' ? 'forbidden' : 'failed'
    refused.push({ user_id: inviteeId, code })
    // nothing more can go out this month (or at all): stop asking
    if (code === 'limit_reached' || code === 'not_in_plan' || code === 'forbidden' || code === 'page_not_active') break
  }
  return c.json({ invited, refused }, invited.length === 0 && refused.length > 0 ? 400 : 200)
})

// POST /api/companies/:id/invites/answer { accept } — she answers the page's invitation.
app.post('/:id/invites/answer', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const accept = (await c.req.json().catch(() => ({})))?.accept === true

  // the invitation first: only an open one may be answered (a declined one never turns into a follow)
  const supabase = c.get('supabase')
  const { data, error } = await supabase.from('company_follow_invites')
    .update({ status: accept ? 'accepted' : 'declined' })
    .eq('company_id', companyId).eq('invitee_id', user.id).eq('status', 'pending')
    .select('id')
  if (error) return dbErrorResponse(c, error)
  if (!data || data.length === 0) return c.json({ error: 'No open invitation' }, 404)
  if (accept) {
    const { error: followError } = await setCompanyFollow(supabase, user.id, companyId, true)
    if (followError) return dbErrorResponse(c, followError)
  }
  return c.json({ status: accept ? 'accepted' : 'declined', is_following: accept })
})

// GET /api/companies/:id/employee-alert — how many employees a page post can tell, and when.
app.get('/:id/employee-alert', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const { data, error } = await c.get('supabase').rpc('company_employee_alert_status', { p_company_id: companyId })
  if (error) return c.json({ error: error.message, code: 'forbidden' }, 403)
  return c.json(data)
})

// POST /api/companies/:id/employee-alert { post_id } — tell the page's employees about its new post.
app.post('/:id/employee-alert', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const postId = (await c.req.json().catch(() => ({})))?.post_id
  if (typeof postId !== 'string' || !postId) return c.json({ error: 'post_id is required' }, 400)

  const { data, error } = await c.get('supabase').rpc('notify_page_employees', { p_post_id: postId })
  if (error) {
    const code = ['weekly_limit', 'post_too_old', 'page_not_active', 'not_a_manager'].includes(error.message) ? error.message : 'failed'
    return c.json({ error: error.message, code }, code === 'not_a_manager' ? 403 : 400)
  }
  return c.json({ notified: data ?? 0 })
})

// POST / DELETE /api/companies/:id/follow
app.post('/:id/follow', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const { error } = await setCompanyFollow(c.get('supabase'), user.id, companyId, true)
  if (error) return dbErrorResponse(c, error)
  return c.json({ is_following: true })
})

app.delete('/:id/follow', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const { error } = await setCompanyFollow(c.get('supabase'), user.id, companyId, false)
  if (error) return dbErrorResponse(c, error)
  return c.json({ is_following: false })
})

// ---------- the page's managers ----------
// Row-level security decides everything here: managers see the list, owners change it, a
// page keeps at least one owner. The API adds only the plan's limit on how many.

// GET /api/companies/:id/admins
app.get('/:id/admins', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const { data, error } = await supabase
    .from('company_admins')
    .select('user_id, role, added_by, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })
  if (error) return dbErrorResponse(c, error)

  const rows = data || []
  const isPlatformAdmin = user.app_metadata?.is_admin === true
  if (!isPlatformAdmin && !rows.some((row: any) => row.user_id === user.id)) {
    return c.json({ error: 'Not allowed' }, 403)
  }

  const { users } = await fetchPublicUsers(supabase, rows.map((row: any) => row.user_id))
  const usersById = new Map<string, any>(users.map((u: any) => [u.uuid, u]))
  const maxAdmins = await getEntitlement(supabase, { type: 'company', id: companyId }, 'page.admins.max')

  return c.json({
    admins: rows.map((row: any) => ({ ...row, user: usersById.get(row.user_id) ?? null })),
    limit: maxAdmins.limit,
  })
})

// POST /api/companies/:id/admins — { user_id, role }
app.post('/:id/admins', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.user_id !== 'string' || !PAGE_ROLES.includes(body.role)) {
    return c.json({ error: 'user_id and a valid role are required' }, 400)
  }

  const maxAdmins = await getEntitlement(supabase, { type: 'company', id: companyId }, 'page.admins.max')
  if (!maxAdmins.enabled) return c.json({ error: "This page's plan doesn't include this", code: 'plan' }, 403)
  if (maxAdmins.limit !== null) {
    const { count } = await supabase
      .from('company_admins')
      .select('user_id', { count: 'exact', head: true })
      .eq('company_id', companyId)
    if ((count ?? 0) >= maxAdmins.limit) {
      return c.json({ error: 'The page has reached its number of managers', code: 'plan_limit' }, 403)
    }
  }

  const { data, error } = await supabase
    .from('company_admins')
    .insert({ company_id: companyId, user_id: body.user_id, role: body.role })
    .select('user_id, role, added_by, created_at')
    .single()
  if (error) return dbErrorResponse(c, error)

  return c.json(data, 201)
})

// PATCH /api/companies/:id/admins/:userId — { role }
app.patch('/:id/admins/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (!PAGE_ROLES.includes(body.role)) return c.json({ error: 'A valid role is required' }, 400)

  const { data, error } = await supabase
    .from('company_admins')
    .update({ role: body.role })
    .eq('company_id', companyId)
    .eq('user_id', c.req.param('userId'))
    .select('user_id, role, added_by, created_at')
    .maybeSingle()
  if (error) return dbErrorResponse(c, error)
  if (!data) return c.json({ error: 'Not found or not allowed' }, 403)

  return c.json(data)
})

// DELETE /api/companies/:id/admins/:userId — an owner removes a manager, or a manager leaves
app.delete('/:id/admins/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const { data, error } = await supabase
    .from('company_admins')
    .delete()
    .eq('company_id', companyId)
    .eq('user_id', c.req.param('userId'))
    .select('user_id')
    .maybeSingle()
  if (error) return dbErrorResponse(c, error)
  if (!data) return c.json({ error: 'Not found or not allowed' }, 403)

  return c.json({ success: true })
})

// GET /api/companies/:id/entitlements — what the page's plan allows, with usage (managers only)
app.get('/:id/entitlements', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const { data, error } = await c.get('supabase').rpc('entitlements_for', {
    p_subject_type: 'company',
    p_subject_id: String(companyId),
  })
  if (error) return dbErrorResponse(c, error)
  return c.json({ entitlements: data || [] })
})

// GET /api/companies/:id/history — who changed what on the page (owners only, by the database's rule)
app.get('/:id/history', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const isPlatformAdmin = user.app_metadata?.is_admin === true
  if (!isPlatformAdmin && await getCompanyRole(supabase, user.id, companyId) !== 'owner') {
    return c.json({ error: 'Not allowed' }, 403)
  }

  const { data, error } = await supabase
    .from('company_audit_log')
    .select('id, actor_id, action, details, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return dbErrorResponse(c, error)

  const rows = data || []
  const { users } = await fetchPublicUsers(supabase, rows.map((row: any) => row.actor_id))
  const usersById = new Map<string, any>(users.map((u: any) => [u.uuid, u]))
  return c.json({ history: rows.map((row: any) => ({ ...row, actor: usersById.get(row.actor_id) ?? null })) })
})

// GET /api/companies/:id/claims — requests to manage this page that are still waiting.
// For the page's owners (and Duallin admins), by the database's rule: so an owner knows who
// is asking for her page. Deciding stays with the Duallin team.
app.get('/:id/claims', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const isPlatformAdmin = user.app_metadata?.is_admin === true
  if (!isPlatformAdmin && await getCompanyRole(supabase, user.id, companyId) !== 'owner') {
    return c.json({ error: 'Not allowed' }, 403)
  }

  const { data, error } = await supabase
    .from('company_claims')
    .select('id, requested_by, requester_title, work_email, message, created_at')
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) return dbErrorResponse(c, error)

  const rows = data || []
  const { users } = await fetchPublicUsers(supabase, rows.map((row: any) => row.requested_by))
  const usersById = new Map<string, any>(users.map((u: any) => [u.uuid, u]))
  return c.json({ claims: rows.map((row: any) => ({ ...row, requester: usersById.get(row.requested_by) ?? null })) })
})

// POST /api/companies/:id/report — { reason, details? }
app.post('/:id/report', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseCompanyId(c.req.param('id'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (!REPORT_REASONS.includes(body.reason)) return c.json({ error: 'Invalid reason' }, 400)
  const details = body.details == null || body.details === '' ? null : freeText(body.details, 1000)
  if (body.details && !details) return c.json({ error: 'details is too long (max 1000)' }, 400)

  const { error } = await c.get('supabase')
    .from('company_reports')
    .insert({ company_id: companyId, reason: body.reason, details })
  // the same member already has an open report on this page → nothing more to do
  if (error && error.code !== '23505') return dbErrorResponse(c, error)
  return c.json({ ok: true })
})

// ---------- asking to manage a page ----------

// GET /api/companies/claims/mine — the member's own requests
app.get('/claims/mine', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { data, error } = await c.get('supabase')
    .from('company_claims')
    .select(`${CLAIM_COLUMNS}, company:companies(id, name, slug, logo)`)
    .eq('requested_by', user.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return dbErrorResponse(c, error)
  return c.json({ claims: data || [] })
})

// POST /api/companies/claims — ask to manage an existing page ({ company_id }) or to open a
// page for an organization that isn't listed ({ org_name, org_type, website }).
// A Duallin admin decides; filing is in the member's own name by the database's rule.
app.post('/claims', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))

  const requesterTitle = cleanText(body.requester_title, 120)
  const workEmail = cleanText(body.work_email, 200)?.toLowerCase() ?? null
  if (!requesterTitle || requesterTitle.length < 2) return c.json({ error: 'requester_title is required' }, 400)
  if (!workEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail)) return c.json({ error: 'A valid work_email is required' }, 400)
  const message = body.message == null || body.message === '' ? null : freeText(body.message, 1000)
  if (body.message && !message) return c.json({ error: 'message is too long (max 1000)' }, 400)

  const claim: Record<string, unknown> = { requester_title: requesterTitle, work_email: workEmail, message }
  if (body.company_id != null) {
    const companyId = parseCompanyId(String(body.company_id))
    if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
    claim.company_id = companyId
  } else {
    const orgName = cleanText(body.org_name, 120)
    if (!orgName || orgName.length < 2) return c.json({ error: 'org_name is required' }, 400)
    if (body.org_type != null && !ORG_TYPES.includes(body.org_type)) return c.json({ error: 'Invalid org_type' }, 400)
    const website = body.website == null || body.website === '' ? null : String(body.website).trim()
    if (website && !isHttpsUrl(website)) return c.json({ error: 'website must be an https:// address' }, 400)
    claim.org_name = orgName
    claim.org_type = body.org_type ?? 'company'
    claim.website = website
  }

  const { data, error } = await c.get('supabase')
    .from('company_claims')
    .insert(claim)
    .select(CLAIM_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') return c.json({ error: 'You already have a request waiting for this', code: 'already_pending' }, 409)
    return dbErrorResponse(c, error)
  }

  // The Duallin team is told by e-mail (and in the site, by a database trigger). The request
  // is already saved: a mail problem must not fail it.
  try {
    const supabase = c.get('supabase')
    const [{ data: me }, { data: company }] = await Promise.all([
      supabase.from('users').select('first_name, last_name').eq('uuid', user.id).maybeSingle(),
      data.company_id ? supabase.from('companies').select('name').eq('id', data.company_id).maybeSingle() : Promise.resolve({ data: null }),
    ])
    await sendNewClaimAlert({
      claimId: data.id,
      companyName: company?.name ?? data.org_name ?? '',
      isNewOrganization: !data.company_id,
      requesterName: [me?.first_name, me?.last_name].filter(Boolean).join(' '),
      requesterTitle: data.requester_title,
      workEmail: data.work_email,
      message: data.message ?? null,
    })
  } catch (err) {
    console.error('new claim alert:', (err as Error).message)
  }
  return c.json(data, 201)
})

// DELETE /api/companies/claims/:claimId — withdraw a request that is still waiting
app.delete('/claims/:claimId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const claimId = parseCompanyId(c.req.param('claimId'))
  if (claimId === null) return c.json({ error: 'Invalid request id' }, 400)

  const { data, error } = await c.get('supabase')
    .from('company_claims')
    .delete()
    .eq('id', claimId)
    .eq('requested_by', user.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) return dbErrorResponse(c, error)
  if (!data) return c.json({ error: 'Not found or already decided' }, 404)
  return c.json({ success: true })
})

// GET /api/companies/followed-by/:userId — the pages a member follows ("me" for her own).
// Empty for an anonymous member, by the database's rule.
// (Two path segments on purpose: a single one would be taken for GET /:id above.)
app.get('/followed-by/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const param = c.req.param('userId')
  const target = param === 'me' ? user.id : param
  if (!/^[0-9a-f-]{36}$/i.test(target)) return c.json({ error: 'Invalid user id' }, 400)

  const { data, error } = await c.get('supabase').rpc('followed_companies', { p_user: target })
  if (error) return dbErrorResponse(c, error)
  return c.json({ companies: data || [] })
})

// POST /api/companies/request — user requests a missing company to be added
app.post('/request', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')
  const body = await c.req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) return c.json({ error: 'name is required' }, 400)
  if (name.length > 200) return c.json({ error: 'name too long' }, 400)

  const { error } = await supabase
    .from('company_requests')
    .insert({ requested_name: name, requested_by: user.id, status: 'pending' })

  // 23505 = unique_violation — same user already requested this company name → treat as success
  if (error && error.code !== '23505') return c.json({ error: error.message }, 400)

  return c.json({ ok: true })
})

export default app

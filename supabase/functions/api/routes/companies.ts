// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { CONTENT_ROLES, getCompanyRole, type CompanyRole } from '../lib/companyAccess.ts'
import { getEntitlement } from '../lib/entitlements.ts'
import { isFollowingCompany, setCompanyFollow } from '../lib/companyFollows.ts'
import { ORG_TYPES, cleanText, freeText, isHttpsUrl, validatePageUpdate } from '../lib/companyPageFields.ts'

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
    supabase.from('open_position').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
    supabase.from('articles').select('id', { count: 'exact', head: true })
      .eq('company_id', company.id).eq('status', 'published').is('deleted_at', null),
    fetchPublicUsers(supabase, employeeIds.slice(0, EMPLOYEES_PREVIEW)),
  ])

  const isPlatformAdmin = user.app_metadata?.is_admin === true
  // A suspended page is shown only to the people who manage it
  if (company.page_status === 'suspended' && !role && !isPlatformAdmin) {
    return c.json({ error: 'Company not found' }, 404)
  }

  const canEdit = isPlatformAdmin || (company.page_status !== 'suspended' && role !== null && CONTENT_ROLES.includes(role))
  return c.json({
    ...company,
    employees: people.users,
    employees_count: employeeIds.length,
    locations: israelFirst(company.locations),
    open_positions_count: positions.count ?? 0,
    articles_count: articles.count ?? 0,
    viewer: {
      role,
      is_following: isFollowing,
      can_edit: canEdit,
      can_rename: isPlatformAdmin || (canEdit && role === 'owner'),
      can_manage_admins: isPlatformAdmin || role === 'owner',
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

// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// Only what the client shows. Never `*`: the table also holds import data with third-party
// contact details (source_raw_json) and owner_uuid, which must not reach the browser — and
// members are not granted those columns in the database (secure_companies_step2_safe.sql).
const COMPANY_COLUMNS =
  'id, name, active, description, employee_count_range, founded_on, industries, linkedin_url, ' +
  'locations, logo, phone, specialities, tagline, universal_name, website, created_at, ' +
  'employees, employees_count'
const RANKED_COMPANY_COLUMNS = `${COMPANY_COLUMNS}, open_positions_count, activity_score, latest_job_at`

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

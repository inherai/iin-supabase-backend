// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// GET /api/companies - companies list with pagination and search
app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const supabase = c.get('supabase')

  const page = parseInt(c.req.query('page') || '1')
  const pageSize = parseInt(c.req.query('pageSize') || c.req.query('limit') || '20')
  const search = c.req.query('search') || ''
  const offset = (page - 1) * pageSize

  let query = supabase
    .from('companies_ranked')
    .select('*', { count: 'exact' })
    .order('latest_job_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: true })

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

  let usersById = new Map<string, any>()

  if (allEmployeeIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from('public_users_view') // 1. שינוי שם הטבלה ל-View
      .select('uuid, first_name, last_name, headline, image') // 2. שינוי שדות השם
      .in('uuid', allEmployeeIds)

    if (usersError) {
      return c.json({ error: usersError.message }, 400)
    }

   // 3. המרה בטוחה של ה-image מטקסט לבוליאני (אופציה ב')
    const enrichedUsers = (users || []).map((u: any) => ({
      ...u,
      image: u.image === 'true' ? true : null 
    }))

    usersById = new Map(enrichedUsers.map((u: any) => [u.uuid, u]))
  }

  const processedData = companies.map((company: any) => {
    const employeeIds = Array.isArray(company.employees) ? company.employees : []
    const employeesDetails = employeeIds
      .map((employeeId: string) => usersById.get(employeeId))
      .filter(Boolean)

    const nextCompany = {
      ...company,
      employees: employeesDetails,
      employees_count: employeeIds.filter((id: any) => id !== null && id !== undefined).length,
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
    .select('*')
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
    const { data: users, error: usersError } = await supabase
      .from('public_users_view') // 1. שינוי שם הטבלה ל-View
      .select('uuid, first_name, last_name, headline, image') // 2. שינוי שדות השם
      .in('uuid', employeeIds)

    if (!usersError && users) {
      // 3. המרה בטוחה לבוליאני גם כאן
      employeesDetails = users.map((u: any) => ({
        ...u,
        image: u.image === 'true' ? true : null
      }))
    }
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
    .upsert(
      { requested_name: name, requested_by: user.id, status: 'pending' },
      { onConflict: 'requested_by,lower(requested_name)', ignoreDuplicates: true }
    )

  if (error) return c.json({ error: error.message }, 400)

  return c.json({ ok: true })
})

export default app

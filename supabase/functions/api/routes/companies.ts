// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// GET /api/companies - companies list with pagination and search
app.get('/', async (c) => {
  const supabase = c.get('supabase')

  const page = parseInt(c.req.query('page') || '1')
  const limit = 20
  const search = c.req.query('search') || ''
  const offset = (page - 1) * limit

  let query = supabase
    .from('companies')
    .select('*', { count: 'exact' })

  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const { data, error, count } = await query
    .range(offset, offset + limit - 1)

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
      .from('users')
      .select('uuid, name, headline, image')
      .in('uuid', allEmployeeIds)

    if (usersError) {
      return c.json({ error: usersError.message }, 400)
    }

    usersById = new Map((users || []).map((u: any) => [u.uuid, u]))
  }

  const processedData = companies.map((company: any) => {
    const employeesDetails = (Array.isArray(company.employees) ? company.employees : [])
      .map((employeeId: string) => usersById.get(employeeId))
      .filter(Boolean)

    const nextCompany = {
      ...company,
      employees: employeesDetails
    }

    if (!Array.isArray(company.locations) || company.locations.length === 0) {
      return nextCompany
    }

    const israelLocations = company.locations.filter((loc: any) => loc.country === 'IL')

    return {
      ...nextCompany,
      locations: israelLocations.length > 0 ? israelLocations : [company.locations[0]]
    }
  })

  return c.json({
    companies: processedData,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil((count || 0) / limit)
    }
  })
})

// GET /api/companies/:id - חברה בודדת לפי ID
app.get('/:id', async (c) => {
  const supabase = c.get('supabase')
  const companyId = c.req.param('id')

  const { data: company, error } = await supabase
    .from('companies')
    .select('*')
    .eq('id', companyId)
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

  if (employeeIds.length > 0) {
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('uuid, name, headline, image')
      .in('uuid', employeeIds)

    if (!usersError && users) {
      employeesDetails = users
    }
  }

  // סינון locations לישראל
  let locations = company.locations || []
  if (Array.isArray(locations) && locations.length > 0) {
    const israelLocations = locations.filter((loc: any) => loc.country === 'IL')
    locations = israelLocations.length > 0 ? israelLocations : [locations[0]]
  }

  return c.json({
    ...company,
    employees: employeesDetails,
    locations
  })
})

export default app

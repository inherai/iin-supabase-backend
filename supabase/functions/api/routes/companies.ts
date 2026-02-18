// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// שליפת חברות עם pagination וחיפוש (GET /)
// supabase/functions/api/routes/companies.ts
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

  // שליפת פרטי העובדים לכל חברה
  const processedData = await Promise.all(data?.map(async (company) => {
    // סינון locations
    let filteredLocations = company.locations || []
    if (filteredLocations.length > 0) {
      const israelLocations = filteredLocations.filter((loc: any) => loc.country === 'IL')
      filteredLocations = israelLocations.length > 0 ? israelLocations : [filteredLocations[0]]
    }

    // שליפת פרטי העובדים
    let employeesData = []
    if (company.employees && company.employees.length > 0) {
      const { data: users } = await supabase
        .from('profiles')
        .select('uuid, name, image, headline, role')
        .in('uuid', company.employees)
      
      employeesData = users || []
    }

    return {
      ...company,
      locations: filteredLocations,
      employeesData
    }
  }) || [])

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
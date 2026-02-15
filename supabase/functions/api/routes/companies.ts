// supabase/functions/api/routes/companies.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// שליפת חברות עם pagination וחיפוש (GET /)
app.get('/', async (c) => {
  const supabase = c.get('supabase')
  
  const page = parseInt(c.req.query('page') || '1')
  const limit = 20
  const search = c.req.query('search') || ''
  const offset = (page - 1) * limit

  let query = supabase
    .from('companies')
    .select('*', { count: 'exact' })

  // אם יש חיפוש - מסנן לפי שם החברה
  if (search) {
    query = query.ilike('name', `%${search}%`)
  }

  const { data, error, count } = await query
    .range(offset, offset + limit - 1)

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  return c.json({ 
    companies: data,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil((count || 0) / limit)
    }
  })
})

export default app
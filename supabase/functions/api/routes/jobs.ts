import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const app = new Hono()
const allowedCategories = new Set(['Development', 'QA', 'Data', 'Management', 'Product'])

app.get('/', async (c) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Secrets')
    }

    const supabaseClient = createClient(supabaseUrl, supabaseKey)

    const rawTextSearch = (c.req.query('query') ?? c.req.query('search') ?? '').trim()
    const rawCategory = (c.req.query('category') ?? c.req.query('categories') ?? '').trim()
    const id = c.req.query('id')

    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '25')
    const from = (page - 1) * limit

    let result
    let totalCount = 0

    if (id) {
      const { data, error } = await supabaseClient
        .from('open_position')
        .select('*')
        .eq('job_id', id)
        .single()

      if (error) throw error

      result = data
      totalCount = data ? 1 : 0
    } else {
      const to = from + limit - 1
      const textSearch = rawTextSearch.replace(/[%_(),]/g, ' ').trim()
      const category = rawCategory.trim()

      let query = supabaseClient
        .from('open_position')
        .select('*', { count: 'exact' })
        .not('job_description_html', 'is', null)
        .order('created_at', { ascending: false })

      if (textSearch) {
        query = query.or(`job_title.ilike.%${textSearch}%,company_name.ilike.%${textSearch}%`)
      }

      if (category) {
        if (!allowedCategories.has(category)) {
          return c.json(
            {
              error: `Invalid category. Allowed values: ${Array.from(allowedCategories).join(', ')}`,
              success: false,
            },
            400,
          )
        }
        query = query.contains('categories', [category])
      }

      const { data, count, error } = await query.range(from, to)

      if (error) throw error

      result = data
      totalCount = count || 0
    }

    return c.json({
      data: result,
      meta: {
        page,
        limit,
        total: totalCount,
        has_more: id ? false : (result.length === limit && (from + result.length) < totalCount),
      },
      success: true,
    })
  } catch (error: any) {
    return c.json(
      {
        error: error.message,
        success: false,
      },
      500,
    )
  }
})

export default app

// supabase/functions/api/routes/activity.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// ====================================================================
// GET /api/activity?userId=...&page=1&limit=10
// שליפת פעילויות של משתמש עם pagination
// ====================================================================
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view activities' }, 401)
    }

    const targetUserId = c.req.query('userId')
    
    if (!targetUserId) {
      return c.json({ error: 'userId parameter is required' }, 400)
    }

    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '10')
    const offset = (page - 1) * limit

    // קריאה ל-RPC עם pagination
    const { data: activities, error: fetchError } = await supabase
      .rpc('get_user_monthly_activity', {
        target_user_id: targetUserId,
        limit_val: limit,
        offset_val: offset
      })

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    return c.json({
      activities: activities || [],
      pagination: {
        page,
        limit
      }
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app

// supabase/functions/api/routes/saved.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// ====================================================================
// GET /api/saved-resources?type=post&page=1&limit=10
// שליפת כל השמירות של המשתמש עם התוכן המלא (באמצעות RPC)
// ====================================================================
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const type = c.req.query('type') // 'post' או 'position' (אופציונלי)
    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '10')
    const offset = (page - 1) * limit

    // קריאה ל-RPC function שמחזירה הכל בשאילתה אחת
    const { data: savedItems, error: fetchError } = await supabase
      .rpc('get_saved_resources_with_content', {
        p_user_id: user.id,
        p_type: type || null,
        p_limit: limit,
        p_offset: offset
      })

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    return c.json({
      saved: savedItems || [],
      pagination: {
        page,
        limit
      }
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// GET /api/saved-resources/count?type=post
// החזרת כמות השמירות של המשתמש
// ====================================================================
app.get('/count', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const type = c.req.query('type') // 'post' או 'position' (אופציונלי)

    let query = supabase
      .from('saved_resources')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)

    // אם יש פילטר לפי type
    if (type) {
      query = query.eq('saved_resource_type', type)
    }

    const { count, error: countError } = await query

    if (countError) {
      return c.json({ error: countError.message }, 500)
    }

    return c.json({
      count: count || 0,
      type: type || 'all'
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// POST /api/saved
// שמירת פוסט או משרה
// Body: { saved_resource_type: 'post', saved_resource_id: '123' }
// ====================================================================
app.post('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    const { saved_resource_type, saved_resource_id } = body

    if (!saved_resource_type || !saved_resource_id) {
      return c.json({ 
        error: 'saved_resource_type and saved_resource_id are required' 
      }, 400)
    }

    // בדיקה שה-type תקין
    if (!['post', 'position'].includes(saved_resource_type)) {
      return c.json({ 
        error: 'saved_resource_type must be either "post" or "position"' 
      }, 400)
    }

    const { data, error: insertError } = await supabase
      .from('saved_resources')
      .insert({
        user_id: user.id,
        saved_resource_type,
        saved_resource_id
      })
      .select()
      .single()

    if (insertError) {
      // אם זה כפילות
      if (insertError.code === '23505') {
        return c.json({ error: 'Resource already saved' }, 409)
      }
      return c.json({ error: insertError.message }, 500)
    }

    return c.json({ success: true, saved: data }, 201)

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// DELETE /api/saved-resources/:id
// מחיקת שמירה לפי ID של השמירה
// ====================================================================
app.delete('/:id', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const savedId = c.req.param('id')

    const { error: deleteError } = await supabase
      .from('saved_resources')
      .delete()
      .eq('id', savedId)
      .eq('user_id', user.id)

    if (deleteError) {
      return c.json({ error: deleteError.message }, 500)
    }

    return c.json({ success: true })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app

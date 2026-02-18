// supabase/functions/api/routes/saved.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// ====================================================================
// GET /api/saved?type=post&page=1&limit=10
// שליפת כל השמירות של המשתמש עם התוכן המלא
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

    let query = supabase
      .from('saved_resources')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    // אם יש פילטר לפי type
    if (type) {
      query = query.eq('saved_resource_type', type)
    }

    const { data: savedItems, error: fetchError } = await query

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    // עכשיו נשלוף את התוכן המלא
    const enrichedItems = await Promise.all(
      (savedItems || []).map(async (item) => {
        let resourceData = null

        if (item.saved_resource_type === 'post') {
          // שליפת הפוסט
          const { data: post } = await supabase
            .from('posts')
            .select('*')
            .eq('id', item.saved_resource_id)
            .single()
          
          resourceData = post
        } else if (item.saved_resource_type === 'position') {
          // שליפת המשרה
          const { data: position } = await supabase
            .from('positions')
            .select('*')
            .eq('id', item.saved_resource_id)
            .single()
          
          resourceData = position
        }

        return {
          id: item.id,
          saved_resource_type: item.saved_resource_type,
          saved_resource_id: item.saved_resource_id,
          created_at: item.created_at,
          resource: resourceData // התוכן המלא
        }
      })
    )

    return c.json({
      saved: enrichedItems,
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
// DELETE /api/saved/:id
// מחיקת שמירה לפי ID
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
      .eq('user_id', user.id) // וידוא שזה שייך למשתמש

    if (deleteError) {
      return c.json({ error: deleteError.message }, 500)
    }

    return c.json({ success: true })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// DELETE /api/saved/resource
// מחיקת שמירה לפי type ו-id של המשאב
// Body: { saved_resource_type: 'post', saved_resource_id: '123' }
// ====================================================================
app.delete('/resource', async (c) => {
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

    const { error: deleteError } = await supabase
      .from('saved_resources')
      .delete()
      .eq('user_id', user.id)
      .eq('saved_resource_type', saved_resource_type)
      .eq('saved_resource_id', saved_resource_id)

    if (deleteError) {
      return c.json({ error: deleteError.message }, 500)
    }

    return c.json({ success: true })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// GET /api/saved/check?type=post&id=123
// בדיקה אם משאב מסוים נשמר
// ====================================================================
app.get('/check', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const type = c.req.query('type')
    const resourceId = c.req.query('id')

    if (!type || !resourceId) {
      return c.json({ error: 'type and id are required' }, 400)
    }

    const { data, error: fetchError } = await supabase
      .from('saved_resources')
      .select('id')
      .eq('user_id', user.id)
      .eq('saved_resource_type', type)
      .eq('saved_resource_id', resourceId)
      .maybeSingle()

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    return c.json({ 
      isSaved: !!data,
      savedId: data?.id || null
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app

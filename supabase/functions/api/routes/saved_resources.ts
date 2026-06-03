// supabase/functions/api/routes/saved.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

// ====================================================================
// GET /api/saved-resources?type=post&page=1&limit=10
// ====================================================================
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const type = c.req.query('type')
    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '10')
    const offset = (page - 1) * limit

    // Candidate type requires a custom handler — RPC doesn't know how to resolve profiles
    if (type === 'candidate') {
      // ⚠️  ADMIN CLIENT — bypasses ALL Supabase RLS policies.
      // Used here to read talent_search_view (which joins users directly) and to
      // check active access grants. Entitlement is verified below: only fields
      // covered by an approved grant or by the candidate's own privacy settings
      // are returned. Consult a second developer before adding new queries here.
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )

      const { data: saved, error: savedError } = await supabaseAdmin
        .from('saved_resources')
        .select('id, saved_resource_id, created_at')
        .eq('user_id', user.id)
        .eq('saved_resource_type', 'candidate')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (savedError) return c.json({ error: savedError.message }, 500)

      const uuids = (saved ?? []).map((s: any) => s.saved_resource_id)

      let profiles: any[] = []
      if (uuids.length) {
        const [profileResult, grantResult] = await Promise.all([
          supabaseAdmin
            .from('talent_search_view')
            .select('uuid, first_name, raw_last_name, headline, location, skills, has_image, status, job_seeking_status, user_privacy_lastname, user_privacy_picture')
            .in('uuid', uuids)
            .eq('status', 'Active')
            .neq('role', 'feed_participant'),
          // Fetch active grants so privacy can be overridden
          supabaseAdmin
            .from('profile_access_requests')
            .select('candidate_id, approved_fields')
            .eq('recruiter_id', user.id)
            .in('candidate_id', uuids)
            .in('status', ['approved', 'partial'])
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        ])

        const grantMap: Record<string, string[]> = Object.fromEntries(
          (grantResult.data ?? []).map((g: any) => [g.candidate_id, g.approved_fields ?? []])
        )
        const savedMap = Object.fromEntries((saved ?? []).map((s: any) => [s.saved_resource_id, s.id]))
        const viewerRole: string = user.app_metadata?.role || 'guest'
        const hasPrivacyAccess = (arr: any) => !arr || !Array.isArray(arr) || arr.includes(viewerRole)

        profiles = (profileResult.data ?? []).map((p: any) => {
          const approvedFields: string[] = grantMap[p.uuid] ?? []
          const canSeeLastName = approvedFields.includes('last_name') || hasPrivacyAccess(p.user_privacy_lastname)
          const canSeePicture = approvedFields.includes('picture') || hasPrivacyAccess(p.user_privacy_picture)
          return {
            uuid: p.uuid,
            first_name: p.first_name,
            last_name: canSeeLastName ? p.raw_last_name : null,
            headline: p.headline,
            location: p.location,
            skills: p.skills,
            status: p.status,
            job_seeking_status: p.job_seeking_status,
            image: canSeePicture ? p.has_image : false,
            image_accessible: canSeePicture,
            has_hidden_details: false,
            access_status: approvedFields.length > 0 ? 'approved' : 'none',
            approved_fields: approvedFields,
            saved_id: savedMap[p.uuid],
          }
        })
      }

      return c.json({ saved: profiles, pagination: { page, limit } })
    }

    // Default: use existing RPC for post/position
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
      pagination: { page, limit }
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
    if (!['post', 'position', 'candidate'].includes(saved_resource_type)) {
      return c.json({
        error: 'saved_resource_type must be "post", "position", or "candidate"'
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

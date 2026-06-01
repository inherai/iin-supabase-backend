import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

// POST /api/profile-access-request
// Minimal implementation: creates a pending request. Phase 2 will add approval flow.
app.post('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const isAdmin = user.app_metadata?.is_admin === true
  const isRecruiter = user.app_metadata?.role === 'recruiters'
  if (!isAdmin && !isRecruiter) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const body = await c.req.json().catch(() => ({}))
  const { candidate_id, requested_fields, message } = body

  if (!candidate_id || !Array.isArray(requested_fields) || requested_fields.length === 0) {
    return c.json({ error: 'candidate_id and requested_fields are required' }, 400)
  }

  // Don't overwrite an existing approved/partial grant
  const { data: existing } = await supabaseAdmin
    .from('profile_access_requests')
    .select('status')
    .eq('recruiter_id', user.id)
    .eq('candidate_id', candidate_id)
    .single()

  if (existing && ['approved', 'partial'].includes(existing.status)) {
    return c.json({ success: true, status: existing.status })
  }

  const { error } = await supabaseAdmin
    .from('profile_access_requests')
    .upsert(
      {
        recruiter_id: user.id,
        candidate_id,
        requested_fields,
        message: message || null,
        status: 'pending',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'recruiter_id,candidate_id' }
    )

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, status: 'pending' })
})

export default app

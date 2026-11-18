import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

const ALLOWED_FIELDS = ['last_name', 'picture', 'contact_details']
const MESSAGE_MAX = 1500
const OUTREACH_COOLDOWN_DAYS = 90   // same as _talentProfiles.ts
const DAILY_LIMIT = 40
const DAY_MS = 24 * 60 * 60 * 1000

// ⚠️  ADMIN CLIENT — bypasses ALL Supabase RLS policies.
// Grant management must always run as admin because candidates and recruiters
// each own only their side of the row. Verify entitlement in application code
// before adding any new queries here. Consult a second developer before
// introducing new admin-client usage.
function makeAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
}

// GET /api/profile-access-request
// Candidate views their incoming requests, active grants, and history
app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Recruiters don't have incoming requests — they send them
  const isRecruiter = user.app_metadata?.role === 'recruiters'
  const isAdmin = user.app_metadata?.is_admin === true
  if (isRecruiter && !isAdmin) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = makeAdmin()

  // Fetch all statuses — split client-side into pending / active / history
  const { data: requests, error } = await supabaseAdmin
    .from('profile_access_requests')
    .select('*')
    .eq('candidate_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  if (!requests || requests.length === 0) return c.json({ pending: [], active: [], history: [] })

  // Enrich with recruiter profile data
  const recruiterIds = [...new Set(requests.map((r: any) => r.recruiter_id))]
  const { data: profiles } = await supabaseAdmin
    .from('public_users_view')
    .select('uuid, first_name, last_name, headline, image, experience')
    .in('uuid', recruiterIds)

  const profileMap: Record<string, any> = Object.fromEntries(
    (profiles ?? []).map((p: any) => [p.uuid, p])
  )

  const enrich = (r: any) => {
    const profile = profileMap[r.recruiter_id]
    const currentRole = profile?.experience?.find((e: any) => e.current)
    return {
      ...r,
      recruiter: profile ? {
        uuid: profile.uuid,
        first_name: profile.first_name,
        last_name: profile.last_name,
        headline: profile.headline,
        image: !!profile.image,
        current_company: (currentRole?.company as any)?.name ?? null,
      } : null,
    }
  }

  const now = new Date().toISOString()
  const pending = requests
    .filter((r: any) => r.status === 'pending')
    .map(enrich)
  const active = requests
    .filter((r: any) => ['approved', 'partial'].includes(r.status) && (!r.expires_at || r.expires_at > now))
    .map(enrich)
  const history = requests
    .filter((r: any) =>
      ['rejected', 'revoked'].includes(r.status) ||
      (['approved', 'partial'].includes(r.status) && r.expires_at && r.expires_at <= now)
    )
    .map(enrich)

  return c.json({ pending, active, history })
})

// GET /api/profile-access-request/sent
// Recruiter polls the statuses of requests they've sent
app.get('/sent', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const isAdmin = user.app_metadata?.is_admin === true
  const isRecruiter = user.app_metadata?.role === 'recruiters'
  if (!isAdmin && !isRecruiter) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = makeAdmin()

  const { data: requests, error } = await supabaseAdmin
    .from('profile_access_requests')
    .select('id, candidate_id, status, approved_fields, updated_at')
    .eq('recruiter_id', user.id)
    .order('updated_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(requests ?? [])
})

// POST /api/profile-access-request
// Recruiter reaches out to a candidate: a message, what it is about, and (optionally) which
// hidden details she asks to see. If the candidate accepts, they can also talk in chat
// (can_message in the database). Declined or withdrawn → no new request for OUTREACH_COOLDOWN_DAYS.
app.post('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const isAdmin = user.app_metadata?.is_admin === true
  const isRecruiter = user.app_metadata?.role === 'recruiters'
  if (!isAdmin && !isRecruiter) return c.json({ error: 'Access denied' }, 403)

  const supabaseAdmin = makeAdmin()

  const body = await c.req.json().catch(() => ({}))
  const { candidate_id } = body
  const requested_fields: string[] = Array.isArray(body.requested_fields)
    ? [...new Set<string>(body.requested_fields.filter((f: unknown) => typeof f === 'string' && ALLOWED_FIELDS.includes(f)))]
    : []
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const context_title = typeof body.context_title === 'string' ? body.context_title.trim().slice(0, 200) : ''

  if (!candidate_id || typeof candidate_id !== 'string' || candidate_id === user.id) {
    return c.json({ error: 'candidate_id is required' }, 400)
  }
  if (!message) return c.json({ error: 'A message is required', code: 'message_required' }, 400)
  if (message.length > MESSAGE_MAX) return c.json({ error: 'The message is too long', code: 'message_too_long' }, 400)

  const { data: existing } = await supabaseAdmin
    .from('profile_access_requests')
    .select('status, expires_at, updated_at, created_at')
    .eq('recruiter_id', user.id)
    .eq('candidate_id', candidate_id)
    .maybeSingle()

  if (existing) {
    const now = Date.now()
    const active = ['approved', 'partial'].includes(existing.status) &&
      (!existing.expires_at || new Date(existing.expires_at).getTime() > now)
    if (active) return c.json({ success: true, status: existing.status })
    if (existing.status === 'pending') {
      // still waiting for her: the recruiter's latest wording replaces the earlier one
      const { error: updateError } = await supabaseAdmin
        .from('profile_access_requests')
        .update({ message, context_title: context_title || null, requested_fields, updated_at: new Date().toISOString() })
        .eq('recruiter_id', user.id)
        .eq('candidate_id', candidate_id)
        .eq('status', 'pending')
      if (updateError) return c.json({ error: updateError.message }, 500)
      return c.json({ success: true, status: 'pending' })
    }
    if (['rejected', 'revoked'].includes(existing.status)) {
      const retryAt = new Date(existing.updated_at ?? existing.created_at).getTime() + OUTREACH_COOLDOWN_DAYS * DAY_MS
      if (retryAt > now) {
        return c.json({ error: 'She declined recently', code: 'cooldown', retry_at: new Date(retryAt).toISOString() }, 429)
      }
    }
    // an approval that expired, or a decline from long ago: a new request replaces it
  }

  // A recruiter sends at most DAILY_LIMIT requests a day.
  const { count: today } = await supabaseAdmin
    .from('profile_access_requests')
    .select('id', { count: 'exact', head: true })
    .eq('recruiter_id', user.id)
    .gte('created_at', new Date(Date.now() - DAY_MS).toISOString())
  if ((today ?? 0) >= DAILY_LIMIT) {
    return c.json({ error: 'Daily limit reached', code: 'daily_limit' }, 429)
  }

  const { data: candidate } = await supabaseAdmin
    .from('users')
    .select('uuid, role, status, is_anonymous')
    .eq('uuid', candidate_id)
    .maybeSingle()
  if (!candidate || candidate.status !== 'Active' || candidate.is_anonymous || ['recruiters', 'feed_participant'].includes(candidate.role)) {
    return c.json({ error: 'Not found' }, 404)
  }

  const { error } = await supabaseAdmin
    .from('profile_access_requests')
    .upsert(
      {
        recruiter_id: user.id,
        candidate_id,
        requested_fields,
        approved_fields: null,
        message,
        context_title: context_title || null,
        status: 'pending',
        expires_at: null,
        revoked_at: null,
        viewed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'recruiter_id,candidate_id' }
    )

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true, status: 'pending' })
})

// PUT /api/profile-access-request/:id
// Candidate approves (with field selection), rejects, or edits an active grant
app.put('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { id } = c.req.param()
  const body = await c.req.json().catch(() => ({}))
  const { approved_fields, status } = body

  const supabaseAdmin = makeAdmin()

  // Verify this request belongs to this candidate
  const { data: request } = await supabaseAdmin
    .from('profile_access_requests')
    .select('id, status, requested_fields, expires_at')
    .eq('id', id)
    .eq('candidate_id', user.id)
    .single()

  if (!request) return c.json({ error: 'Not found' }, 404)

  // Allow editing pending, partial, and approved grants
  if (!['pending', 'partial', 'approved'].includes(request.status)) {
    return c.json({ error: 'Cannot update this request' }, 400)
  }

  const updates: Record<string, any> = { updated_at: new Date().toISOString() }

  if (status === 'rejected') {
    updates.status = 'rejected'
  } else if (Array.isArray(approved_fields) && (approved_fields.length > 0 || status === 'approved')) {
    // She shares only what was asked for. An outreach that asked for nothing is accepted as is
    // (it opens a conversation — can_message in the database).
    const requestedFields: string[] = request.requested_fields ?? []
    const granted = approved_fields.filter((f: unknown) => typeof f === 'string' && requestedFields.includes(f as string))
    if (requestedFields.length > 0 && granted.length === 0) {
      return c.json({ error: 'Provide approved_fields or status=rejected' }, 400)
    }
    const isAll = requestedFields.every((f: string) => granted.includes(f))
    updates.status = isAll ? 'approved' : 'partial'
    updates.approved_fields = granted
    // Only reset expires_at when transitioning from pending — keep existing expiry when editing an active grant
    if (request.status === 'pending') {
      updates.expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    }
  } else {
    return c.json({ error: 'Provide approved_fields or status=rejected' }, 400)
  }

  const { error } = await supabaseAdmin
    .from('profile_access_requests')
    .update(updates)
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

// DELETE /api/profile-access-request/:id
// Candidate revokes an active grant
app.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const { id } = c.req.param()
  const supabaseAdmin = makeAdmin()

  // Verify ownership (must be the candidate)
  const { data: request } = await supabaseAdmin
    .from('profile_access_requests')
    .select('id')
    .eq('id', id)
    .eq('candidate_id', user.id)
    .single()

  if (!request) return c.json({ error: 'Not found' }, 404)

  const { error } = await supabaseAdmin
    .from('profile_access_requests')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ success: true })
})

export default app

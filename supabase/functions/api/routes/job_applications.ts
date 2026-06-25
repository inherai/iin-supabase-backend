import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const app = new Hono()

function parseJobId(str: string): number | null {
  const n = parseInt(str, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// POST /api/job-applications/:jobId/click
// Records that the user clicked Apply. Does NOT downgrade status from 'applied' to 'clicked'.
app.post('/:jobId/click', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized', success: false }, 401)

  const jobId = parseJobId(c.req.param('jobId'))
  if (!jobId) return c.json({ error: 'Invalid job ID', success: false }, 400)

  const supabase = adminClient()

  const { data: job } = await supabase
    .from('open_position')
    .select('job_id')
    .eq('job_id', jobId)
    .maybeSingle()
  if (!job) return c.json({ error: 'Job not found', success: false }, 404)

  const now = new Date().toISOString()

  // Check existing status — never downgrade 'applied' back to 'clicked'
  const { data: existing } = await supabase
    .from('job_applications')
    .select('status')
    .eq('user_id', user.id)
    .eq('job_id', jobId)
    .maybeSingle()

  if (existing?.status === 'applied') {
    await supabase
      .from('job_applications')
      .update({ apply_clicked_at: now, updated_at: now })
      .eq('user_id', user.id)
      .eq('job_id', jobId)
  } else {
    const { error } = await supabase
      .from('job_applications')
      .upsert(
        { user_id: user.id, job_id: jobId, status: 'clicked', apply_clicked_at: now, updated_at: now },
        { onConflict: 'user_id,job_id' },
      )
    if (error) {
      console.error('[job-applications/click] upsert error:', JSON.stringify(error))
      return c.json({ error: 'Failed to record click', detail: error.message, code: error.code, success: false }, 500)
    }
  }

  return c.json({ success: true })
})

// PUT /api/job-applications/:jobId
// Marks the application as 'applied'. Preserves the original applied_at timestamp.
app.put('/:jobId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized', success: false }, 401)

  const jobId = parseJobId(c.req.param('jobId'))
  if (!jobId) return c.json({ error: 'Invalid job ID', success: false }, 400)

  let body: { status?: string }
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body', success: false }, 400) }
  if (body?.status !== 'applied') return c.json({ error: 'Only status "applied" is supported', success: false }, 400)

  const supabase = adminClient()

  const { data: job } = await supabase
    .from('open_position')
    .select('job_id')
    .eq('job_id', jobId)
    .maybeSingle()
  if (!job) return c.json({ error: 'Job not found', success: false }, 404)

  const now = new Date().toISOString()

  // Preserve original applied_at if it already exists
  const { data: existing } = await supabase
    .from('job_applications')
    .select('applied_at')
    .eq('user_id', user.id)
    .eq('job_id', jobId)
    .maybeSingle()

  const appliedAt = existing?.applied_at ?? now

  const { data: upserted, error } = await supabase
    .from('job_applications')
    .upsert(
      { user_id: user.id, job_id: jobId, status: 'applied', applied_at: appliedAt, updated_at: now },
      { onConflict: 'user_id,job_id' },
    )
    .select('applied_at')
    .single()

  if (error) return c.json({ error: 'Failed to update application', success: false }, 500)

  return c.json({ success: true, applied_at: upserted?.applied_at ?? appliedAt })
})

// DELETE /api/job-applications/:jobId
// Removes the application record for the current user + job.
app.delete('/:jobId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized', success: false }, 401)

  const jobId = parseJobId(c.req.param('jobId'))
  if (!jobId) return c.json({ error: 'Invalid job ID', success: false }, 400)

  const supabase = adminClient()

  const { error } = await supabase
    .from('job_applications')
    .delete()
    .eq('user_id', user.id)
    .eq('job_id', jobId)

  if (error) return c.json({ error: 'Failed to delete application', success: false }, 500)

  return c.json({ success: true })
})

export default app

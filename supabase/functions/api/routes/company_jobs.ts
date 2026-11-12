// supabase/functions/api/routes/company_jobs.ts
// Jobs a company publishes on its page, and applications made inside Duallin.
//
// Everything here runs in the member's own session — no service role. The database decides:
//   * who may publish / edit / close a job (the page's owner or recruiter) and what a job may
//     contain (open_position_guard)
//   * what an application must contain (the job's own form), and who reads it: the candidate,
//     that page's owners / recruiters, and Duallin admins for support — who can read but not
//     change anything (job_submissions rules)
//   * the company's side of an application (its stage) is a separate table the candidate cannot
//     read: she is shown only that her application was sent (job_submission_reviews rules)
//   * who may read a resume file (the job-resumes bucket rules)
// See migrations/add_company_jobs_safe.sql. The checks in this file are for clear answers.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { RECRUITING_ROLES, getCompanyRole } from '../lib/companyAccess.ts'
import { SUBMISSION_STAGES, validateJobInput, validateSubmissionInput } from '../lib/jobFields.ts'
import { sendNewJobAlert } from '../lib/emails/companyPages.ts'

const app = new Hono()

const RESUME_BUCKET = 'job-resumes'
const RESUME_LINK_SECONDS = 120

// What the page's recruiters see of a job (never `*`: the row also holds import data).
const JOB_COLUMNS =
  'id, job_id, company_id, job_title, location, location_region, work_schedule, seniority_level, salary_range, ' +
  'categories, job_description, source, status, apply_method, apply_link, apply_form, created_at, closed_at, views_count'
// What the candidate sent. The company's stage is never part of it.
const SUBMISSION_COLUMNS =
  'id, job_id, company_id, user_id, full_name, email, phone, note, answers, resume_path, created_at'
// ...and, for the page's recruiters, with the company's side.
const RECRUITER_SUBMISSION_COLUMNS = `${SUBMISSION_COLUMNS}, job_submission_reviews(stage, changed_at)`

// The company's side arrives embedded (an object, or a one-row list); no row means "new".
const reviewOf = (row: any): { stage: string; changed_at: string | null } | null => {
  const review = Array.isArray(row?.job_submission_reviews) ? row.job_submission_reviews[0] : row?.job_submission_reviews
  return review ?? null
}
const withStage = (row: any) => {
  const { job_submission_reviews: _review, ...submission } = row
  const review = reviewOf(row)
  return { ...submission, stage: review?.stage ?? 'new', stage_changed_at: review?.changed_at ?? null }
}

const parseId = (raw: string): number | null => (/^\d{1,15}$/.test(raw) ? parseInt(raw, 10) : null)

// The database's short refusals → what the client should hear.
const REFUSALS: Record<string, { status: 403 | 409; message: string }> = {
  plan_limit: { status: 409, message: 'The page has reached the number of open jobs its plan allows' },
  plan_internal_applications: { status: 403, message: 'The page\'s plan does not include applications inside Duallin' },
  not_accepting: { status: 409, message: 'This job does not take applications inside Duallin' },
  job_closed: { status: 409, message: 'This job is closed' },
  resume_required: { status: 409, message: 'This job requires a resume file' },
  answer_required: { status: 409, message: 'A required question was not answered' },
}
function dbErrorResponse(c: any, error: { message: string; code?: string }) {
  if (error.code === 'P0001') {
    const known = REFUSALS[error.message]
    return known
      ? c.json({ error: known.message, code: error.message }, known.status)
      : c.json({ error: error.message, code: 'refused' }, 409)
  }
  if (error.code === '42501') return c.json({ error: 'Not allowed' }, 403)
  if (error.code === '23505') return c.json({ error: 'Already exists', code: 'already_applied' }, 409)
  if (error.code === '23503') return c.json({ error: 'Not found' }, 404)
  return c.json({ error: error.message }, 400)
}

const isRecruiter = async (c: any, companyId: number): Promise<boolean> => {
  const user = c.get('user')
  if (user.app_metadata?.is_admin === true) return true
  const role = await getCompanyRole(c.get('supabase'), user.id, companyId)
  return role !== null && RECRUITING_ROLES.includes(role)
}

// ─────────────────────────────────────────────────────────── the page's recruiters

// GET /api/company-jobs/company/:companyId — every job of the page (its own and imported ones),
// with how many applications each has.
app.get('/company/:companyId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseId(c.req.param('companyId'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)
  if (!(await isRecruiter(c, companyId))) return c.json({ error: 'Not allowed' }, 403)

  const supabase = c.get('supabase')
  const [jobs, submissions] = await Promise.all([
    supabase.from('open_position').select(JOB_COLUMNS).eq('company_id', companyId)
      .order('created_at', { ascending: false }).limit(500),
    supabase.from('job_submissions').select('job_id, job_submission_reviews(stage)').eq('company_id', companyId).limit(5000),
  ])
  if (jobs.error) return dbErrorResponse(c, jobs.error)

  const counts = new Map<number, { total: number; fresh: number }>()
  for (const row of submissions.data || []) {
    const entry = counts.get(row.job_id) ?? { total: 0, fresh: 0 }
    entry.total++
    if ((reviewOf(row)?.stage ?? 'new') === 'new') entry.fresh++
    counts.set(row.job_id, entry)
  }
  return c.json({
    jobs: (jobs.data || []).map((job: any) => ({
      ...job,
      applications_count: counts.get(job.id)?.total ?? 0,
      new_applications_count: counts.get(job.id)?.fresh ?? 0,
    })),
  })
})

// POST /api/company-jobs/company/:companyId — publish a job. It is on the board at once;
// the Duallin team is told (a bell by a database trigger, an e-mail from here).
app.post('/company/:companyId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const companyId = parseId(c.req.param('companyId'))
  if (companyId === null) return c.json({ error: 'Invalid company id' }, 400)

  const checked = validateJobInput(await c.req.json().catch(() => ({})), false)
  if ('error' in checked) return c.json({ error: checked.error }, 400)
  const { status: _status, ...values } = checked.values   // a new job is always open

  const supabase = c.get('supabase')
  const { data, error } = await supabase
    .from('open_position')
    .insert({ ...values, company_id: companyId })
    .select(JOB_COLUMNS)
    .single()
  if (error) return dbErrorResponse(c, error)

  // The job is already published: a mail problem must not fail it.
  try {
    const [{ data: me }, { data: company }] = await Promise.all([
      supabase.from('users').select('first_name, last_name').eq('uuid', user.id).maybeSingle(),
      supabase.from('companies').select('name, slug').eq('id', companyId).maybeSingle(),
    ])
    await sendNewJobAlert({
      jobRowId: data.id,
      jobId: data.job_id,
      title: data.job_title,
      companyName: company?.name ?? '',
      companySlug: company?.slug ?? String(companyId),
      publisherName: [me?.first_name, me?.last_name].filter(Boolean).join(' '),
      applyMethod: data.apply_method,
    })
  } catch (err) {
    console.error('new job alert:', (err as Error).message)
  }
  return c.json({ ...data, applications_count: 0, new_applications_count: 0 }, 201)
})

// PATCH /api/company-jobs/:id — edit a job the page published, or close / reopen it.
// On an imported job only { status: 'closed' } has any effect. A Duallin admin may also set
// 'removed' (and bring a job back).
app.patch('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'Invalid job id' }, 400)

  const checked = validateJobInput(await c.req.json().catch(() => ({})), true)
  if ('error' in checked) return c.json({ error: checked.error }, 400)

  const { data, error } = await c.get('supabase')
    .from('open_position')
    .update(checked.values)
    .eq('id', id)
    .select(JOB_COLUMNS)
    .maybeSingle()
  if (error) return dbErrorResponse(c, error)
  // No row back: the job doesn't exist, or the database didn't let her change it
  if (!data) return c.json({ error: 'Not found or not allowed' }, 403)
  return c.json(data)
})

// GET /api/company-jobs/:id/submissions — the applications to one job, newest first.
app.get('/:id/submissions', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const id = parseId(c.req.param('id'))
  if (id === null) return c.json({ error: 'Invalid job id' }, 400)

  const supabase = c.get('supabase')
  const { data: job } = await supabase.from('open_position').select('id, company_id, job_title').eq('id', id).maybeSingle()
  if (!job?.company_id) return c.json({ error: 'Job not found' }, 404)
  // the page's owners / recruiters — and Duallin admins, who read for support only
  if (!(await isRecruiter(c, job.company_id))) return c.json({ error: 'Not allowed' }, 403)

  const { data, error } = await supabase
    .from('job_submissions')
    .select(RECRUITER_SUBMISSION_COLUMNS)
    .eq('job_id', id)
    .order('created_at', { ascending: false })
    .limit(1000)
  if (error) return dbErrorResponse(c, error)
  return c.json({ job: { id: job.id, job_title: job.job_title }, submissions: (data || []).map(withStage) })
})

// PATCH /api/company-jobs/submissions/:subId — { stage }: the company's side of an application,
// the only thing it changes. The database lets only the page's owners / recruiters write it.
app.patch('/submissions/:subId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const subId = parseId(c.req.param('subId'))
  if (subId === null) return c.json({ error: 'Invalid application id' }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (!SUBMISSION_STAGES.includes(body.stage)) return c.json({ error: 'stage is not valid' }, 400)

  const reviews = () => c.get('supabase').from('job_submission_reviews')
  const columns = 'submission_id, stage, changed_at'
  // Change the stage if the company already set one; otherwise set the first one. (Not an
  // upsert: members may change only the stage, never which application it belongs to.)
  let { data, error } = await reviews().update({ stage: body.stage }).eq('submission_id', subId).select(columns).maybeSingle()
  if (!error && !data) {
    ;({ data, error } = await reviews().insert({ submission_id: subId, stage: body.stage }).select(columns).single())
    if (error?.code === '23505') {   // set by someone else a moment ago
      ;({ data, error } = await reviews().update({ stage: body.stage }).eq('submission_id', subId).select(columns).maybeSingle())
    }
  }
  if (error) return dbErrorResponse(c, error)
  if (!data) return c.json({ error: 'Not found or not allowed' }, 403)
  return c.json({ id: subId, stage: data.stage, stage_changed_at: data.changed_at })
})

// GET /api/company-jobs/submissions/:subId/resume — a short-lived link to the resume file.
// Works for whoever the database lets read the application and the file: the candidate
// herself, the page's owners / recruiters, and Duallin admins.
app.get('/submissions/:subId/resume', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const subId = parseId(c.req.param('subId'))
  if (subId === null) return c.json({ error: 'Invalid application id' }, 400)

  const supabase = c.get('supabase')
  const { data: submission } = await supabase.from('job_submissions').select('resume_path').eq('id', subId).maybeSingle()
  if (!submission) return c.json({ error: 'Not found' }, 404)
  if (!submission.resume_path) return c.json({ error: 'This application has no resume file' }, 404)

  const { data, error } = await supabase.storage.from(RESUME_BUCKET).createSignedUrl(submission.resume_path, RESUME_LINK_SECONDS)
  if (error || !data?.signedUrl) return c.json({ error: 'The file is not available' }, 404)
  return c.json({ url: data.signedUrl, expires_in_seconds: RESUME_LINK_SECONDS })
})

// ─────────────────────────────────────────────────────────── the candidate

// GET /api/company-jobs/mine — the jobs she applied to: through Duallin (with what she sent)
// and by an outside link (her own "I applied" mark). Read in her own session; the company's
// side of an application is not part of it.
app.get('/mine', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const JOB = 'id, job_id, job_title, company_name, company_id, status, source, apply_method, companies(name, logo, slug)'

  const [tracked, sent] = await Promise.all([
    supabase.from('job_applications').select(`job_id, applied_at, open_position(${JOB})`)
      .eq('user_id', user.id).eq('status', 'applied').order('applied_at', { ascending: false }).limit(500),
    supabase.from('job_submissions').select(`${SUBMISSION_COLUMNS}, open_position(${JOB})`)
      .eq('user_id', user.id).limit(500),
  ])
  if (tracked.error) return dbErrorResponse(c, tracked.error)
  if (sent.error) return dbErrorResponse(c, sent.error)

  const shape = (job: any) => job && ({
    row_id: job.id, job_id: job.job_id, title: job.job_title, status: job.status,
    company_id: job.company_id, company_name: job.companies?.name ?? job.company_name,
    company_slug: job.companies?.slug ?? null, company_logo: job.companies?.logo ?? null,
    in_duallin: job.source === 'Duallin' && job.apply_method === 'internal',
  })
  const byJob = new Map<number, any>()
  for (const row of (tracked.data || []) as any[]) {
    if (row.open_position) byJob.set(row.job_id, { job: shape(row.open_position), applied_at: row.applied_at, submission: null })
  }
  for (const row of (sent.data || []) as any[]) {
    const { open_position: job, ...submission } = row
    const entry = byJob.get(row.job_id) ?? { job: shape(job), applied_at: row.created_at, submission: null }
    byJob.set(row.job_id, { ...entry, submission })
  }
  const applications = [...byJob.values()].filter((a) => a.job)
    .sort((a, b) => String(b.applied_at ?? '').localeCompare(String(a.applied_at ?? '')))
  return c.json({ applications })
})

// These take the job's public id (open_position.job_id), the one the jobs board uses.

const findJob = (supabase: any, jobId: string) =>
  supabase.from('open_position')
    .select('id, job_id, company_id, source, status, apply_method, apply_form')
    .eq('job_id', jobId)
    .maybeSingle()

// GET /api/company-jobs/job/:jobId/application — how this job takes applications, and hers if she applied.
app.get('/job/:jobId/application', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (parseId(c.req.param('jobId')) === null) return c.json({ error: 'Invalid job id' }, 400)

  const supabase = c.get('supabase')
  const { data: job } = await findJob(supabase, c.req.param('jobId'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const internal = job.source === 'Duallin' && job.apply_method === 'internal'
  const { data: application } = internal
    ? await supabase.from('job_submissions').select(SUBMISSION_COLUMNS).eq('job_id', job.id).eq('user_id', user.id).maybeSingle()
    : { data: null }
  return c.json({
    job: {
      row_id: job.id, status: job.status,
      apply_method: internal ? 'internal' : 'external',
      apply_form: internal ? job.apply_form : null,
    },
    application: application ?? null,
  })
})

// POST /api/company-jobs/job/:jobId/application — apply inside Duallin. She sends what she
// wants the company to have: { full_name, email, phone?, note?, answers?, resume_path? }.
app.post('/job/:jobId/application', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (parseId(c.req.param('jobId')) === null) return c.json({ error: 'Invalid job id' }, 400)

  const checked = validateSubmissionInput(await c.req.json().catch(() => ({})))
  if ('error' in checked) return c.json({ error: checked.error }, 400)

  const supabase = c.get('supabase')
  const { data: job } = await findJob(supabase, c.req.param('jobId'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const { data, error } = await supabase
    .from('job_submissions')
    .insert({ ...checked.values, job_id: job.id })
    .select(SUBMISSION_COLUMNS)
    .single()
  if (error) return dbErrorResponse(c, error)
  return c.json(data, 201)
})

// DELETE /api/company-jobs/job/:jobId/application — withdraw: the application and its file are removed.
app.delete('/job/:jobId/application', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (parseId(c.req.param('jobId')) === null) return c.json({ error: 'Invalid job id' }, 400)

  const supabase = c.get('supabase')
  const { data: job } = await findJob(supabase, c.req.param('jobId'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const { data, error } = await supabase
    .from('job_submissions')
    .delete()
    .eq('job_id', job.id)
    .eq('user_id', user.id)
    .select('id, resume_path')
  if (error) return dbErrorResponse(c, error)
  if (!data?.length) return c.json({ error: 'No application to withdraw' }, 404)

  const files = data.map((row: any) => row.resume_path).filter(Boolean)
  if (files.length) {
    const { error: removeError } = await supabase.storage.from(RESUME_BUCKET).remove(files)
    if (removeError) console.error('resume file left behind:', removeError.message)
  }
  return c.json({ success: true })
})

export default app

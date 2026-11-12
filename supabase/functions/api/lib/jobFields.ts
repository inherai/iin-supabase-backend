// What a company may write in a job it publishes, and what a candidate may write in an
// application — checked here for a clear answer to the client. The database enforces the same
// rules again (migrations/add_company_jobs_safe.sql): a manager can write to her page's jobs
// around this API, so this file is for good messages, not for safety.
import { cleanText, isHttpsUrl } from './companyPageFields.ts'

export const JOB_REGIONS = ['center', 'sharon', 'north', 'jerusalem', 'south', 'nationwide']
export const JOB_SCHEDULES = ['Full Time', 'Part Time', 'Internship']
export const JOB_CATEGORIES = ['Development', 'QA', 'Data', 'Management', 'Product']
export const RESUME_MODES = ['required', 'optional', 'none']
export const SUBMISSION_STAGES = ['new', 'reviewed', 'contacted', 'rejected', 'hired']
export const MAX_QUESTIONS = 5
const DESCRIPTION_MIN = 30
const DESCRIPTION_MAX = 8000

export interface ApplyForm {
  resume: string
  note: boolean
  questions: { text: string; required: boolean }[]
}
export type JobInputResult = { values: Record<string, unknown> } | { error: string }

/** The form a job asks candidates to fill, in its fixed shape — or null when it is not valid. */
export function cleanApplyForm(raw: any): ApplyForm | null {
  const form = raw ?? {}
  if (typeof form !== 'object' || Array.isArray(form)) return null
  const resume = form.resume ?? 'optional'
  if (!RESUME_MODES.includes(resume)) return null
  const list = form.questions ?? []
  if (!Array.isArray(list) || list.length > MAX_QUESTIONS) return null
  const questions: ApplyForm['questions'] = []
  for (const q of list) {
    const text = cleanText(q?.text, 200)
    if (!text || text.length < 3) return null
    questions.push({ text, required: q?.required === true })
  }
  return { resume, note: form.note !== false, questions }
}

/**
 * The fields of a job from a request body. With `partial` only the fields present are checked
 * (an edit); otherwise the required ones must all be there (a new job).
 */
export function validateJobInput(body: any, partial: boolean): JobInputResult {
  const values: Record<string, unknown> = {}
  const has = (key: string) => body?.[key] !== undefined

  if (!partial || has('job_title')) {
    const title = cleanText(body?.job_title, 150)
    if (!title || title.length < 3) return { error: 'job_title: 3 to 150 characters, no markup' }
    values.job_title = title
  }
  if (!partial || has('location')) {
    const location = cleanText(body?.location, 120)
    if (!location || location.length < 2) return { error: 'location: 2 to 120 characters, no markup' }
    values.location = location
  }
  if (!partial || has('job_description')) {
    const text = typeof body?.job_description === 'string' ? body.job_description.trim() : ''
    if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX || /[<>]/.test(text)) {
      return { error: `job_description: ${DESCRIPTION_MIN} to ${DESCRIPTION_MAX} characters of plain text (no < or >)` }
    }
    values.job_description = text
  }
  if (has('location_region')) {
    if (body.location_region !== null && !JOB_REGIONS.includes(body.location_region)) return { error: 'location_region is not valid' }
    values.location_region = body.location_region
  }
  if (has('work_schedule')) {
    if (body.work_schedule !== null && !JOB_SCHEDULES.includes(body.work_schedule)) return { error: 'work_schedule is not valid' }
    values.work_schedule = body.work_schedule
  }
  if (has('seniority_level')) {
    const years = body.seniority_level
    if (years !== null && !(Number.isInteger(years) && years >= 0 && years <= 30)) return { error: 'seniority_level: years of experience, 0 to 30' }
    values.seniority_level = years === null ? null : String(years)
  }
  if (has('salary_range')) {
    const salary = body.salary_range === null || body.salary_range === '' ? null : cleanText(body.salary_range, 80)
    if (body.salary_range !== null && body.salary_range !== '' && !salary) return { error: 'salary_range: up to 80 characters, no markup' }
    values.salary_range = salary
  }
  if (has('categories')) {
    const list = body.categories
    if (!Array.isArray(list) || list.length > 2 || list.some((c: unknown) => !JOB_CATEGORIES.includes(c as string))) return { error: 'categories: up to 2 known categories' }
    values.categories = [...new Set(list)]
  }

  // how candidates apply: both parts are sent together
  if (!partial || has('apply_method')) {
    if (body?.apply_method === 'internal') {
      const form = cleanApplyForm(body.apply_form)
      if (!form) return { error: `apply_form: resume is required / optional / none, and up to ${MAX_QUESTIONS} questions of 3 to 200 characters` }
      values.apply_method = 'internal'
      values.apply_form = form
      values.apply_link = null
    } else if (body?.apply_method === 'external') {
      if (typeof body.apply_link !== 'string' || !isHttpsUrl(body.apply_link.trim())) return { error: 'apply_link must be an https address' }
      values.apply_method = 'external'
      values.apply_link = body.apply_link.trim()
      values.apply_form = null
    } else {
      return { error: 'apply_method is internal or external' }
    }
  }

  if (has('status')) {
    if (!['open', 'closed', 'removed'].includes(body.status)) return { error: 'status is not valid' }
    values.status = body.status
  }
  if (Object.keys(values).length === 0) return { error: 'Nothing to save' }
  return { values }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[0-9+() .-]+$/

/** A candidate's application from a request body (the job's own form is enforced by the database). */
export function validateSubmissionInput(body: any): JobInputResult {
  const fullName = cleanText(body?.full_name, 120)
  if (!fullName || fullName.length < 2) return { error: 'full_name: 2 to 120 characters' }
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email) || email.length > 200) return { error: 'email is not valid' }
  const phone = typeof body?.phone === 'string' && body.phone.trim() ? body.phone.trim() : null
  if (phone && (phone.length > 40 || !PHONE_RE.test(phone))) return { error: 'phone is not valid' }
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null
  if (note && note.length > 2000) return { error: 'note: up to 2000 characters' }
  const answers = body?.answers ?? []
  if (!Array.isArray(answers) || answers.length > MAX_QUESTIONS
      || answers.some((a: any) => typeof a?.id !== 'string' || typeof a?.answer !== 'string' || a.answer.length > 1000)) {
    return { error: 'answers are not valid' }
  }
  const resumePath = body?.resume_path ?? null
  if (resumePath !== null && (typeof resumePath !== 'string' || resumePath.length > 300)) return { error: 'resume_path is not valid' }
  return {
    values: {
      full_name: fullName, email, phone, note, resume_path: resumePath,
      answers: answers.map((a: any) => ({ id: a.id, answer: a.answer.trim() })),
    },
  }
}

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { cleanApplyForm, validateJobInput, validateSubmissionInput } from './jobFields.ts'

const DESCRIPTION = 'We are looking for an engineer who enjoys working in a team.'
const job = (extra: Record<string, unknown> = {}) => ({
  job_title: 'Backend Engineer', location: 'Tel Aviv', job_description: DESCRIPTION,
  apply_method: 'external', apply_link: 'https://example.com/apply', ...extra,
})
const values = (r: any) => { assert('values' in r, JSON.stringify(r)); return r.values }
const refused = (r: any) => assert('error' in r, `expected a refusal, got ${JSON.stringify(r)}`)

Deno.test('a new job needs its required fields; an edit checks only what was sent', () => {
  assertEquals(values(validateJobInput(job(), false)).job_title, 'Backend Engineer')
  refused(validateJobInput({ ...job(), job_title: undefined }, false))
  refused(validateJobInput({ ...job(), job_description: 'too short' }, false))
  assertEquals(values(validateJobInput({ location: ' Haifa ' }, true)), { location: 'Haifa' })
  assertEquals(values(validateJobInput({ status: 'closed' }, true)), { status: 'closed' })
  refused(validateJobInput({}, true))
  refused(validateJobInput({ status: 'deleted' }, true))
})

Deno.test('markup is refused everywhere', () => {
  refused(validateJobInput(job({ job_title: 'Engineer <b>now</b>' }), false))
  refused(validateJobInput(job({ job_description: DESCRIPTION + ' <script>alert(1)</script>' }), false))
  refused(validateJobInput(job({ location: '<img>' }), false))
  refused(validateJobInput(job({ salary_range: '<20k' }), false))
})

Deno.test('how candidates apply', () => {
  const external = values(validateJobInput(job(), false))
  assertEquals([external.apply_method, external.apply_link, external.apply_form], ['external', 'https://example.com/apply', null])
  refused(validateJobInput(job({ apply_link: 'http://example.com' }), false))
  refused(validateJobInput(job({ apply_link: 'javascript:alert(1)' }), false))
  refused(validateJobInput(job({ apply_method: 'email' }), false))
  const internal = values(validateJobInput(job({ apply_method: 'internal', apply_form: { resume: 'required', questions: [{ text: ' Years? ', required: true }] } }), false))
  assertEquals(internal.apply_link, null)
  assertEquals(internal.apply_form, { resume: 'required', note: true, questions: [{ text: 'Years?', required: true }] })
  // an inside-Duallin job with no form given gets the default one
  assertEquals(values(validateJobInput(job({ apply_method: 'internal' }), false)).apply_form, { resume: 'optional', note: true, questions: [] })
})

Deno.test('the application form: resume mode and up to 5 plain questions', () => {
  assertEquals(cleanApplyForm({ resume: 'none', note: false }), { resume: 'none', note: false, questions: [] })
  assertEquals(cleanApplyForm({ resume: 'always' }), null)
  assertEquals(cleanApplyForm({ questions: Array(6).fill({ text: 'Why us?' }) }), null)
  assertEquals(cleanApplyForm({ questions: [{ text: 'a?' }] }), null)
  assertEquals(cleanApplyForm({ questions: [{ text: 'Is <this> ok?' }] }), null)
  assertEquals(cleanApplyForm([]), null)
})

Deno.test('optional job details', () => {
  const v = values(validateJobInput(job({ location_region: 'center', work_schedule: 'Part Time', seniority_level: 3, salary_range: '', categories: ['QA', 'QA'] }), false))
  assertEquals([v.location_region, v.work_schedule, v.seniority_level, v.salary_range, v.categories], ['center', 'Part Time', '3', null, ['QA']])
  refused(validateJobInput(job({ location_region: 'moon' }), false))
  refused(validateJobInput(job({ work_schedule: 'Sometimes' }), false))
  refused(validateJobInput(job({ seniority_level: '3' }), false))
  refused(validateJobInput(job({ categories: ['Development', 'QA', 'Data'] }), false))
  refused(validateJobInput(job({ categories: ['Sales'] }), false))
})

Deno.test('an application', () => {
  const v = values(validateSubmissionInput({ full_name: ' Dana Levi ', email: ' Dana@Example.com ', phone: '050-1234567', note: ' hi ', answers: [{ id: 'q1', answer: ' 5 ' }], resume_path: '12/abc/cv.pdf' }))
  assertEquals(v, { full_name: 'Dana Levi', email: 'dana@example.com', phone: '050-1234567', note: 'hi', resume_path: '12/abc/cv.pdf', answers: [{ id: 'q1', answer: '5' }] })
  assertEquals(values(validateSubmissionInput({ full_name: 'Dana', email: 'd@e.co' })).answers, [])
  refused(validateSubmissionInput({ full_name: 'D', email: 'd@e.co' }))
  refused(validateSubmissionInput({ full_name: 'Dana <b>', email: 'd@e.co' }))
  refused(validateSubmissionInput({ full_name: 'Dana', email: 'not an email' }))
  refused(validateSubmissionInput({ full_name: 'Dana', email: 'd@e.co', phone: 'call me' }))
  refused(validateSubmissionInput({ full_name: 'Dana', email: 'd@e.co', answers: [{ id: 'q1' }] }))
  refused(validateSubmissionInput({ full_name: 'Dana', email: 'd@e.co', note: 'x'.repeat(2001) }))
})

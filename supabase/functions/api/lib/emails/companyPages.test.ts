import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { APPLICATIONS_EMAIL_GAP_HOURS, recentlyMailedPages, renderNewApplications, renderNewJobAlert } from './companyPages.ts'

Deno.test('pages e-mailed recently are read from the ref keys of those e-mails', () => {
  assertEquals([...recentlyMailedPages(['12:340', '12:355', '7:9', null, '', 'x:1', '0:4'])].sort(), [12, 7])
  assert(APPLICATIONS_EMAIL_GAP_HOURS >= 1)
})

Deno.test('the recruiters\' e-mail says how many, links to the inbox, and carries no candidate details', () => {
  const one = renderNewApplications(1, 'Acme <Ltd>', 'acme-ltd', null)
  assert(one.includes('התקבלה מועמדות חדשה') && one.includes('A new application arrived'))
  assert(one.includes('/company/acme-ltd/admin?section=jobs'))
  assert(one.includes('Acme &lt;Ltd&gt;') && !one.includes('Acme <Ltd>'))
  const many = renderNewApplications(37, 'Acme', 'acme', 'https://x.example/u')
  assert(many.includes('התקבלו 37 מועמדויות חדשות') && many.includes('37 new applications arrived'))
})

Deno.test('the team alert about a new job escapes what the company wrote', () => {
  const html = renderNewJobAlert({ jobRowId: 5, jobId: '900000000000005', title: 'Dev <script>', companyName: 'Acme', companySlug: 'acme', publisherName: 'Dana', applyMethod: 'internal' })
  assert(html.includes('Dev &lt;script&gt;') && !html.includes('<script>'))
  assert(html.includes('/careers?job=900000000000005') && html.includes('בתוך דואולין'))
})

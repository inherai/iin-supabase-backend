import { assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { renderTalentAlert } from './talentAlerts.ts'
import { renderAccessReply } from './service.ts'
import { filterParams, hasFilterParams } from '../../routes/_talentProfiles.ts'

Deno.test('the saved-search e-mail counts, links each search, and escapes its name', () => {
  const html = renderTalentAlert([
    { searchId: 's-1', name: 'React <בני ברק>', count: 4 },
    { searchId: 's-2', name: 'QA', count: 1 },
  ], null)
  assert(html.includes('5 מועמדות חדשות מתאימות') && html.includes('5 new candidates match'))
  assert(html.includes('/talent?saved=s-1') && html.includes('/talent?saved=s-2'))
  assert(html.includes('React &lt;בני ברק&gt;') && !html.includes('React <בני'))
  assert(html.includes('4 מועמדות חדשות') && html.includes('מועמדת חדשה אחת'))
})

Deno.test('a free-text or job search is not e-mailed; old saved searches still read', () => {
  assert(!hasFilterParams(filterParams({ searchQuery: 'data' })))
  assert(hasFilterParams(filterParams({ selectedDegree: "Bachelor's" })))
  assert(filterParams({ selectedDegree: "Bachelor's" }).p_degree_levels.join() === 'bachelor')
  assert(filterParams({ selectedDegrees: ['master', 'bachelor', 'master', 'nope'] }).p_degree_levels.join() === 'master,bachelor')
  assert(filterParams({ minYears: '99' }).p_min_years === null)
})

Deno.test('an accepted outreach sends the recruiter to the conversation', () => {
  const html = renderAccessReply('approved', 'רחל', 'cand-1', null)
  assert(html.includes('/innercircle/messages?partnerId=cand-1') && html.includes('אישרה את הפנייה שלך'))
  const no = renderAccessReply('rejected', 'רחל', 'cand-1', null)
  assert(!no.includes('רחל') && no.includes('/talent'))
})

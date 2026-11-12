// deno test supabase/functions/api/lib/companyPageFields.test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { cleanText, freeText, isHttpsUrl, isOwnMediaUrl, namedList, validatePageUpdate } from './companyPageFields.ts'

const HOSTS = ['proj.supabase.co', 'api.duallin.com']
const YEAR = 2026
const validate = (body: unknown, companyId = 42) => validatePageUpdate(body, companyId, HOSTS, YEAR)
const updatesOf = (body: unknown, companyId = 42) => {
  const result = validate(body, companyId)
  assert('updates' in result, `expected the update to be accepted, got: ${JSON.stringify(result)}`)
  return result.updates
}
const errorOf = (body: unknown, companyId = 42) => {
  const result = validate(body, companyId)
  assert('error' in result, `expected the update to be refused, got: ${JSON.stringify(result)}`)
  return result.error
}

Deno.test('text fields: trimmed, emptied to null, markup refused', () => {
  assertEquals(updatesOf({ tagline: '  We build things  ' }), { tagline: 'We build things' })
  assertEquals(updatesOf({ tagline: '   ', description: null }), { tagline: null, description: null })
  assertEquals(updatesOf({ description: 'First line\nSecond & more "quoted"' }), { description: 'First line\nSecond & more "quoted"' })
  for (const bad of ['<script>alert(1)</script>', 'a <b>bold</b> word', 'img src=x onerror=1>', '5 > 3']) {
    assert(errorOf({ description: bad }).includes('plain text'), bad)
  }
  assert(errorOf({ tagline: 5 }).includes('must be text'))
  assert(errorOf({ name_he: ['x'] }).includes('must be text'))
})

Deno.test('text fields: length limits at the boundary', () => {
  assertEquals(Object.keys(updatesOf({ description: 'a'.repeat(6000) })), ['description'])
  assert(errorOf({ description: 'a'.repeat(6001) }).includes('too long'))
  assertEquals(Object.keys(updatesOf({ tagline: 'a'.repeat(220) })), ['tagline'])
  assert(errorOf({ tagline: 'a'.repeat(221) }).includes('too long'))
  assert(errorOf({ phone: '1'.repeat(41) }).includes('too long'))
})

Deno.test('name: required when sent, never emptied', () => {
  assertEquals(updatesOf({ name: ' Acme ' }), { name: 'Acme' })
  assertEquals(errorOf({ name: '  ' }), 'name is required')
  assertEquals(errorOf({ name: null }), 'name is required')
})

Deno.test('links: https only', () => {
  assertEquals(updatesOf({ website: ' https://example.com/a?b=1 ' }), { website: 'https://example.com/a?b=1' })
  assertEquals(updatesOf({ website: '', linkedin_url: null }), { website: null, linkedin_url: null })
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'http://example.com', 'example.com', 'data:text/html,x',
    'https://x.com/"onmouseover="alert(1)', 'https://x.com/<script>', 'https://x.com/a b', '//example.com', ' javascript:alert(1)',
  ]) {
    assert(errorOf({ website: bad }).includes('https://'), bad)
    assert(!isHttpsUrl(bad), bad)
  }
  assert(errorOf({ website: 'https://e.co/' + 'a'.repeat(500) }).includes('https://'))
  assert(errorOf({ linkedin_url: 42 }).includes('must be text'))
})

Deno.test('call-to-action: type and address must agree', () => {
  assertEquals(updatesOf({ cta_type: 'website', cta_url: 'https://example.com' }), { cta_type: 'website', cta_url: 'https://example.com' })
  assertEquals(updatesOf({ cta_type: 'contact', cta_url: 'mailto:hi@example.com' }), { cta_type: 'contact', cta_url: 'mailto:hi@example.com' })
  assertEquals(updatesOf({ cta_type: 'jobs', cta_url: 'https://ignored.example' }), { cta_type: 'jobs', cta_url: null })
  assertEquals(updatesOf({ cta_type: null }), { cta_type: null, cta_url: null })
  assert(errorOf({ cta_type: 'website', cta_url: 'mailto:hi@example.com' }).includes('cta_url'))
  assert(errorOf({ cta_type: 'contact', cta_url: 'javascript:alert(1)' }).includes('cta_url'))
  assert(errorOf({ cta_type: 'contact', cta_url: 'mailto:a@b.c"><script>' }).includes('cta_url'))
  assert(errorOf({ cta_type: 'website' }).includes('cta_url'))
  assertEquals(errorOf({ cta_type: 'download' }), 'Invalid cta_type')
})

Deno.test('logo and cover: only files in this page\'s own folder on our storage', () => {
  const ok = 'https://proj.supabase.co/storage/v1/object/public/company-media/42/logo-1700000000000.jpg'
  assertEquals(updatesOf({ logo: ok }), { logo: ok })
  assertEquals(updatesOf({ cover_image_url: 'https://api.duallin.com/storage/v1/object/public/company-media/42/cover-1.webp' }),
    { cover_image_url: 'https://api.duallin.com/storage/v1/object/public/company-media/42/cover-1.webp' })
  assertEquals(updatesOf({ logo: null, cover_image_url: '' }), { logo: null, cover_image_url: null })
  for (const bad of [
    'https://evil.example/logo.png',
    'https://evil.example/storage/v1/object/public/company-media/42/logo.png',          // right path, wrong host
    'https://proj.supabase.co/storage/v1/object/public/company-media/43/logo.png',      // another page's folder
    'https://proj.supabase.co/storage/v1/object/public/company-media/420/logo.png',     // id that merely starts the same
    'https://proj.supabase.co/storage/v1/object/public/company-media/42/../43/logo.png',
    'https://proj.supabase.co/storage/v1/object/public/company-media/42/sub/logo.png',
    'https://proj.supabase.co/storage/v1/object/public/company-media/42/',
    'https://proj.supabase.co/storage/v1/object/public/company-media/42/logo.png?x=1',
    'https://proj.supabase.co/storage/v1/object/public/company-media/42/logo.png#x',
    'https://proj.supabase.co/storage/v1/object/public/other-bucket/42/logo.png',
    'http://proj.supabase.co/storage/v1/object/public/company-media/42/logo.png',
    'https://proj.supabase.co.evil.example/storage/v1/object/public/company-media/42/logo.png',
    'https://user@proj.supabase.co.evil.example/storage/v1/object/public/company-media/42/logo.png',
    'javascript:alert(1)', 'not a url',
  ]) {
    assert(errorOf({ logo: bad }).includes('uploaded image'), bad)
    assert(!isOwnMediaUrl(bad, 42, HOSTS), bad)
  }
  assert(errorOf({ logo: 7 }).includes('uploaded image'))
  // the same address is not valid for a different page
  assert(errorOf({ logo: ok }, 7).includes('uploaded image'))
})

Deno.test('industries and specialities: names, de-duplicated, capped', () => {
  assertEquals(updatesOf({ industries: ['Software', { name: ' Fintech ' }, 'software'] }), { industries: [{ name: 'Software' }, { name: 'Fintech' }] })
  assertEquals(updatesOf({ specialities: [] }), { specialities: [] })
  assertEquals(updatesOf({ industries: null }), { industries: [] })
  assertEquals(namedList(Array.from({ length: 10 }, (_, i) => `i${i}`), 10)?.length, 10)
  assert(errorOf({ industries: Array.from({ length: 11 }, (_, i) => `i${i}`) }).includes('industries'))
  assert(errorOf({ specialities: Array.from({ length: 101 }, (_, i) => `s${i}`) }).includes('specialities'))
  for (const bad of ['not a list', { name: 'x' }, [''], [{ name: '' }], [{}], [null], [5], ['<b>x</b>'], ['a'.repeat(61)]]) {
    assert(errorOf({ industries: bad }).includes('industries'), JSON.stringify(bad))
  }
})

Deno.test('size and founding year', () => {
  assertEquals(updatesOf({ employee_count_range: { start: 11, end: 50 } }), { employee_count_range: { start: 11, end: 50 } })
  assertEquals(updatesOf({ employee_count_range: { start: '1000' } }), { employee_count_range: { start: 1000 } })
  assertEquals(updatesOf({ employee_count_range: null, founded_on: null }), { employee_count_range: null, founded_on: null })
  for (const bad of [{ start: 0 }, { start: 50, end: 11 }, { start: 1.5 }, { end: 5 }, {}, 'x', [1, 2], { start: 'abc' }, { start: 2_000_000 }]) {
    assertEquals(errorOf({ employee_count_range: bad }), 'Invalid employee_count_range', JSON.stringify(bad))
  }
  assertEquals(updatesOf({ founded_on: { year: 2020 } }), { founded_on: { year: 2020 } })
  assertEquals(updatesOf({ founded_on: { year: YEAR } }), { founded_on: { year: YEAR } })
  for (const bad of [{ year: YEAR + 1 }, { year: 1799 }, { year: 'soon' }, {}, 2020, '2020']) {
    assertEquals(errorOf({ founded_on: bad }), 'Invalid founded_on year', JSON.stringify(bad))
  }
})

Deno.test('org type', () => {
  assertEquals(updatesOf({ org_type: 'nonprofit' }), { org_type: 'nonprofit' })
  assertEquals(errorOf({ org_type: 'government' }), 'Invalid org_type')
  assertEquals(errorOf({ org_type: null }), 'Invalid org_type')
})

Deno.test('only what was sent is touched; fields a manager may not set are ignored', () => {
  assertEquals(updatesOf({ tagline: 'x' }), { tagline: 'x' })
  // protected or unknown fields never make it into the update
  const updates = updatesOf({
    tagline: 'x', verified: true, page_status: 'claimed', owner_uuid: 'abc', slug: 'other', employees: [], followers_count: 9999,
    import_name: 'x', source_raw_json: {}, id: 1, locations: [{ city: 'x', country: 'IL' }], __proto__: { verified: true },
  })
  assertEquals(updates, { tagline: 'x' })
  for (const empty of [{}, null, undefined, [], 'text', 5, { verified: true }]) {
    assertEquals(errorOf(empty), 'Nothing to update', JSON.stringify(empty))
  }
})

Deno.test('cleanText refuses markup, freeText allows any characters', () => {
  assertEquals(cleanText('  Head of Marketing ', 120), 'Head of Marketing')
  assertEquals(cleanText('a<b', 120), null)
  assertEquals(cleanText('', 120), null)
  assertEquals(cleanText('a'.repeat(121), 120), null)
  assertEquals(cleanText(5, 120), null)
  assertEquals(freeText(' revenue > 5M & growing <fast> ', 1000), 'revenue > 5M & growing <fast>')
  assertEquals(freeText('a'.repeat(1001), 1000), null)
  assertEquals(freeText('   ', 1000), null)
})

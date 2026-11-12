// What a page manager may save on her page — the value checks, as pure functions so they can
// be tested without a server (companyPageFields.test.ts).
//
// The database enforces the same rules on whatever a member writes
// (harden_company_page_fields_safe.sql); this layer exists to give a clear message first.
// Limits are sized against the imported data: the longest imported description is ~5,000
// characters, a few pages list up to 72 specialities and 10 industries.

export const ORG_TYPES = ['company', 'nonprofit', 'public', 'education', 'other']

/** Text fields and their length limits. */
export const EDITABLE_TEXT: Record<string, number> = {
  name: 120, name_he: 120, tagline: 220, tagline_he: 220, description: 6000, description_he: 6000,
  phone: 40,
}
export const EDITABLE_URLS = ['website', 'linkedin_url']
export const MAX_INDUSTRIES = 10
export const MAX_SPECIALITIES = 100
const MAX_LIST_NAME = 60

export const isHttpsUrl = (v: string): boolean => /^https:\/\/[^\s<>"]+$/i.test(v) && v.length <= 500

/** Trimmed text of 1..max characters without markup characters, or null. */
export const cleanText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[<>]/.test(value)
    ? value.trim()
    : null

/** Free text that is only ever shown as text (a message, report details): any characters, 1..max. */
export const freeText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null

/**
 * Logo and cover are files the page's managers uploaded to the company-media bucket, under
 * the page's own folder (storage rules allow nobody else to write there). Any other address
 * is refused, so a page can't point its logo at someone else's server.
 */
export function isOwnMediaUrl(value: string, companyId: number, storageHosts: string[]): boolean {
  try {
    const url = new URL(value)
    const prefix = `/storage/v1/object/public/company-media/${companyId}/`
    return url.protocol === 'https:' && storageHosts.includes(url.host) &&
      url.pathname.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(url.pathname.slice(prefix.length)) &&
      !url.search && !url.hash && value.length <= 500
  } catch {
    return false
  }
}

/** [{ name }] lists (industries, specialities): trimmed, de-duplicated, capped. null = invalid. */
export function namedList(value: unknown, maxItems: number): { name: string }[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null
  const names: string[] = []
  for (const item of value) {
    const name = cleanText(typeof item === 'string' ? item : item?.name, MAX_LIST_NAME)
    if (!name) return null
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
  }
  return names.map((name) => ({ name }))
}

export type PageUpdateResult = { updates: Record<string, unknown> } | { error: string }

/**
 * Turns a PATCH body into the columns to update. Only fields present in the body are
 * touched, so values the manager didn't change (imported ones, in whatever shape they
 * arrived) stay exactly as they are.
 */
// deno-lint-ignore no-explicit-any
export function validatePageUpdate(body: any, companyId: number, storageHosts: string[], thisYear: number): PageUpdateResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Nothing to update' }
  const updates: Record<string, unknown> = {}

  for (const [field, max] of Object.entries(EDITABLE_TEXT)) {
    if (!(field in body)) continue
    const value = body[field]
    if (value !== null && typeof value !== 'string') return { error: `${field} must be text` }
    const text = typeof value === 'string' ? value.trim() : ''
    if (text.length > max) return { error: `${field} is too long (max ${max})` }
    if (/[<>]/.test(text)) return { error: `${field} must be plain text` }
    if (field === 'name' && !text) return { error: 'name is required' }
    updates[field] = text || null
  }

  for (const field of EDITABLE_URLS) {
    if (!(field in body)) continue
    const raw = body[field]
    if (raw !== null && typeof raw !== 'string') return { error: `${field} must be text` }
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value && !isHttpsUrl(value)) return { error: `${field} must be an https:// address` }
    updates[field] = value || null
  }

  if ('org_type' in body) {
    if (!ORG_TYPES.includes(body.org_type)) return { error: 'Invalid org_type' }
    updates.org_type = body.org_type
  }

  if ('cta_type' in body || 'cta_url' in body) {
    const type = body.cta_type ?? null
    const url = typeof body.cta_url === 'string' ? body.cta_url.trim() : ''
    if (type === null || type === 'jobs') {
      updates.cta_type = type
      updates.cta_url = null
    } else if (type === 'website' || type === 'contact') {
      const ok = isHttpsUrl(url) || (type === 'contact' && /^mailto:[^\s@<>"]+@[^\s@<>"]+$/i.test(url) && url.length <= 500)
      if (!ok) return { error: 'cta_url must be an https:// address (or mailto: for contact)' }
      updates.cta_type = type
      updates.cta_url = url
    } else {
      return { error: 'Invalid cta_type' }
    }
  }

  // Images: a file in this page's own storage folder, or null to remove.
  for (const field of ['logo', 'cover_image_url']) {
    if (!(field in body)) continue
    const value = body[field]
    if (value === null || value === '') { updates[field] = null; continue }
    if (typeof value !== 'string' || !isOwnMediaUrl(value, companyId, storageHosts)) {
      return { error: `${field} must be an uploaded image of this page` }
    }
    updates[field] = value
  }

  if ('industries' in body) {
    const list = namedList(body.industries ?? [], MAX_INDUSTRIES)
    if (!list) return { error: `industries: up to ${MAX_INDUSTRIES} names of at most ${MAX_LIST_NAME} characters` }
    updates.industries = list
  }
  if ('specialities' in body) {
    const list = namedList(body.specialities ?? [], MAX_SPECIALITIES)
    if (!list) return { error: `specialities: up to ${MAX_SPECIALITIES} names of at most ${MAX_LIST_NAME} characters` }
    updates.specialities = list
  }

  if ('employee_count_range' in body) {
    const range = body.employee_count_range
    if (range === null) {
      updates.employee_count_range = null
    } else {
      const start = Number(range?.start)
      const end = range?.end == null ? null : Number(range.end)
      const ok = Number.isInteger(start) && start >= 1 && start <= 1_000_000 &&
        (end === null || (Number.isInteger(end) && end >= start && end <= 10_000_000))
      if (!ok) return { error: 'Invalid employee_count_range' }
      updates.employee_count_range = end === null ? { start } : { start, end }
    }
  }

  if ('founded_on' in body) {
    const year = body.founded_on === null ? null : Number(body.founded_on?.year)
    if (year !== null && !(Number.isInteger(year) && year >= 1800 && year <= thisYear)) {
      return { error: 'Invalid founded_on year' }
    }
    updates.founded_on = year === null ? null : { year }
  }

  if (Object.keys(updates).length === 0) return { error: 'Nothing to update' }
  return { updates }
}

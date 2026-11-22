// What a recruiter sees of a candidate — the ONE place that decides it, for search, saved
// candidates, projects and outreach alike.
//
// Profiles are read from talent_search_view with the admin client (it joins the private users
// columns: last name, e-mail, phone). Privacy is enforced here: a hidden field is returned only
// when the candidate's own privacy settings show it to recruiters, or she approved this recruiter's
// request for it (and the approval has not expired).
//
// The recruiter's own data (saved candidates, projects, notes) is read in HER session (`supabase`),
// so row-level security keeps it hers.
import { SKILL_ALIASES, SYMBOL_LANGS, hasPrivacyAccess, normalizeSkill } from './_matchHelpers.ts'

export const PROFILE_COLUMNS =
  'uuid, first_name, raw_last_name, headline, about, location, skills, work_preferences, languages, ' +
  'experience, education, certifications, has_image, job_seeking_status, experience_years, created_at, ' +
  'privacy_contact_details, user_privacy_lastname, user_privacy_picture, raw_email, raw_phone'

/** Outreach declined or withdrawn: the recruiter may ask again only after this many days. */
export const OUTREACH_COOLDOWN_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export type AccessStatus = 'none' | 'pending' | 'partial' | 'approved' | 'expired' | 'declined'

interface RequestRow {
  id: string
  candidate_id: string
  status: string
  requested_fields: string[] | null
  approved_fields: string[] | null
  expires_at: string | null
  updated_at: string | null
  created_at: string | null
  message: string | null
  context_title: string | null
  contact_accepted_at: string | null
}

export interface RecruiterContext {
  requests: Map<string, RequestRow>
  saved: Map<string, string>                                   // candidate → saved_resources.id
  projects: Map<string, { membership_id: string; project_id: string; stage: string }[]>
  notes: Map<string, number>
}

export function viewerRoleOf(user: any): string {
  return user.app_metadata?.role || (user.app_metadata?.is_admin === true ? 'admin' : 'guest')
}

/** Everything about the recruiter's relation to these candidates, in one round. */
/** Ids go in the query string (`.in(...)`): keep each request well under the URL length limit. */
const CHUNK = 80
export function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

export async function loadRecruiterContext(admin: any, supabase: any, recruiterId: string, uuids: string[]): Promise<RecruiterContext> {
  const ctx: RecruiterContext = { requests: new Map(), saved: new Map(), projects: new Map(), notes: new Map() }
  for (const part of chunks(uuids)) await loadContextPart(admin, supabase, recruiterId, part, ctx)
  return ctx
}

async function loadContextPart(admin: any, supabase: any, recruiterId: string, uuids: string[], ctx: RecruiterContext) {
  const [requests, saved, projects, notes] = await Promise.all([
    admin.from('profile_access_requests')
      .select('id, candidate_id, status, requested_fields, approved_fields, expires_at, updated_at, created_at, message, context_title, contact_accepted_at')
      .eq('recruiter_id', recruiterId).in('candidate_id', uuids),
    supabase.from('saved_resources').select('id, saved_resource_id')
      .eq('user_id', recruiterId).eq('saved_resource_type', 'candidate').in('saved_resource_id', uuids),
    supabase.from('talent_project_candidates').select('id, project_id, candidate_id, stage').in('candidate_id', uuids),
    supabase.from('talent_notes').select('candidate_id').in('candidate_id', uuids),
  ])
  for (const r of (requests.data ?? []) as RequestRow[]) ctx.requests.set(r.candidate_id, r)
  for (const s of (saved.data ?? []) as any[]) ctx.saved.set(s.saved_resource_id, s.id)
  for (const p of (projects.data ?? []) as any[]) {
    const list = ctx.projects.get(p.candidate_id) ?? []
    list.push({ membership_id: p.id, project_id: p.project_id, stage: p.stage })
    ctx.projects.set(p.candidate_id, list)
  }
  for (const n of (notes.data ?? []) as any[]) ctx.notes.set(n.candidate_id, (ctx.notes.get(n.candidate_id) ?? 0) + 1)
}

/** Where this recruiter stands with this candidate. */
export function accessOf(request: RequestRow | undefined, now = Date.now()) {
  if (!request) return { status: 'none' as AccessStatus, approved: [] as string[], retryAt: null as string | null }
  const s = request.status
  if (s === 'approved' || s === 'partial') {
    const expired = request.expires_at != null && new Date(request.expires_at).getTime() <= now
    return { status: (expired ? 'expired' : s) as AccessStatus, approved: expired ? [] : (request.approved_fields ?? []), retryAt: null }
  }
  if (s === 'pending') return { status: 'pending' as AccessStatus, approved: [], retryAt: null }
  // rejected / revoked
  const since = new Date(request.updated_at ?? request.created_at ?? 0).getTime()
  const retry = since + OUTREACH_COOLDOWN_DAYS * DAY_MS
  return retry > now
    ? { status: 'declined' as AccessStatus, approved: [], retryAt: new Date(retry).toISOString() }
    : { status: 'none' as AccessStatus, approved: [], retryAt: null }
}

// ── Experience: how long she worked, from the periods she reported ─────────────────────────
// Overlapping jobs count once. The profile form asks for years only: a start without a month
// counts from January, an end without a month to December, so the total is rounded UP, and is
// shown in whole years ("approx"). With months on every date it is exact (years + months).
// The same rule runs in the database (talent_experience_years) for the years filter and sort.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** { year, month | null } from "2021", "2021-03", "2021-03-01", "03/2021", "Mar 2021". */
export function parseYearMonth(raw: unknown): { year: number; month: number | null } | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const s = String(raw).trim().toLowerCase()
  const year = s.match(/(19|20)\d{2}/)?.[0]
  if (!year) return null
  let month: number | null = null
  const iso = s.match(/^(\d{4})-(\d{1,2})/)
  const slash = s.match(/^(\d{1,2})[/.](\d{4})/)
  const named = MONTHS.findIndex((m) => s.includes(m))
  if (iso) month = Number(iso[2])
  else if (slash) month = Number(slash[1])
  else if (named >= 0) month = named + 1
  if (month !== null && (month < 1 || month > 12)) month = null
  return { year: Number(year), month }
}

export function experienceSpan(experience: unknown, now = new Date()): { months: number; approx: boolean; years: number } {
  const list = Array.isArray(experience) ? experience : []
  const nowIdx = now.getFullYear() * 12 + now.getMonth()
  let approx = false
  const ranges: [number, number][] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const start = parseYearMonth((e as any).startDate)
    if (!start) continue
    const current = (e as any).current === true || (e as any).current === 'true'
    const end = current ? null : parseYearMonth((e as any).endDate)
    if (!current && !end) continue
    const from = start.year * 12 + (start.month ?? 1) - 1
    const to = Math.min(end ? end.year * 12 + (end.month ?? 12) - 1 : nowIdx, nowIdx)
    if (to < from) continue
    ranges.push([from, to])
    if (start.month === null || (end && end.month === null)) approx = true
  }
  ranges.sort((a, b) => a[0] - b[0])
  let months = 0
  let curFrom = -1
  let curTo = -2
  for (const [a, b] of ranges) {
    if (a > curTo + 1) { months += curTo >= curFrom ? curTo - curFrom + 1 : 0; curFrom = a; curTo = b }
    else curTo = Math.max(curTo, b)
  }
  months += curTo >= curFrom ? curTo - curFrom + 1 : 0
  return { months, approx, years: approx ? Math.ceil(months / 12) : Math.floor(months / 12) }
}

const lower = (list: unknown): string[] => (Array.isArray(list) ? list.map((s) => String(s).toLowerCase()) : [])

export function mapCandidate(u: any, viewerRole: string, ctx: RecruiterContext, extra: Record<string, unknown> = {}) {
  const request = ctx.requests.get(u.uuid)
  const access = accessOf(request)
  const approved = access.approved

  // Fail-closed: missing/non-array/empty privacy_* means "not shared with anyone"
  // (matches EditPrivacyDialog.tsx's own interpretation — see hasPrivacyAccess in _matchHelpers.ts).
  const canSeeName = approved.includes('last_name') || hasPrivacyAccess(u.user_privacy_lastname, viewerRole)
  const canSeePicture = approved.includes('picture') || hasPrivacyAccess(u.user_privacy_picture, viewerRole)
  const canSeeContact = approved.includes('contact_details') || hasPrivacyAccess(u.privacy_contact_details, viewerRole)

  const hiddenFields: string[] = []
  if (!canSeeName && u.user_privacy_lastname && u.raw_last_name) hiddenFields.push('last_name')
  if (!canSeePicture && u.user_privacy_picture && u.has_image) hiddenFields.push('picture')
  if (!canSeeContact && u.privacy_contact_details && (u.raw_email || u.raw_phone)) hiddenFields.push('contact_details')

  const savedId = ctx.saved.get(u.uuid)
  return {
    uuid: u.uuid,
    first_name: u.first_name,
    last_name: canSeeName ? (u.raw_last_name ?? null) : null,
    headline: u.headline ?? null,
    about: u.about ?? null,
    location: u.location ?? null,
    skills: u.skills ?? [],
    work_preferences: u.work_preferences ?? [],
    languages: Array.isArray(u.languages) ? u.languages : [],
    experience: Array.isArray(u.experience) ? u.experience : [],
    education: Array.isArray(u.education) ? u.education : [],
    certifications: Array.isArray(u.certifications) ? u.certifications : [],
    image_accessible: canSeePicture && !!u.has_image,
    contact_details: canSeeContact && (u.raw_email || u.raw_phone)
      ? { email: u.raw_email ?? null, phone: u.raw_phone ?? null }
      : null,
    hidden_fields: hiddenFields,
    approved_fields: approved,
    access_status: access.status,
    access_retry_at: access.retryAt,
    // She accepted contact once (can_message in the database), until she revokes or declines.
    can_message: !!request?.contact_accepted_at && request.status !== 'rejected' && request.status !== 'revoked',
    outreach: request
      ? { id: request.id, message: request.message, context_title: request.context_title, sent_at: request.updated_at ?? request.created_at }
      : null,
    job_seeking_status: u.job_seeking_status ?? null,
    ...(() => {
      const span = experienceSpan(u.experience)
      return { experience_years: span.years, experience_months: span.months, experience_approx: span.approx }
    })(),
    joined_at: u.created_at ?? null,
    is_saved: !!savedId,
    saved_id: savedId ?? null,
    projects: ctx.projects.get(u.uuid) ?? [],
    notes_count: ctx.notes.get(u.uuid) ?? 0,
    ...extra,
  }
}

/** experience[].company is stored as a company id: replace it with { id, name, logo, website, slug }. */
async function enrichCompanies(admin: any, rows: any[]) {
  const ids = new Set<number>()
  for (const u of rows) for (const e of Array.isArray(u.experience) ? u.experience : []) {
    const id = typeof e?.company === 'number' ? e.company : typeof e?.company === 'string' && /^\d{1,9}$/.test(e.company) ? Number(e.company) : null
    if (id !== null) ids.add(id)
  }
  if (!ids.size) return
  const found = await Promise.all(chunks([...ids]).map((part) =>
    admin.from('companies').select('id, name, logo, website, slug').in('id', part)))
  const byId = new Map(found.flatMap((r: any) => r.data ?? []).map((c: any) => [c.id, c]))
  for (const u of rows) {
    if (!Array.isArray(u.experience)) continue
    u.experience = u.experience.map((e: any) => {
      const id = typeof e?.company === 'number' ? e.company : typeof e?.company === 'string' && /^\d{1,9}$/.test(e.company) ? Number(e.company) : null
      return id !== null && byId.has(id) ? { ...e, company: byId.get(id) } : e
    })
  }
}

/** Searchable members only — the same rule as talent_search() in the database. */
export function profilesQuery(admin: any, uuids: string[]) {
  return admin.from('talent_search_view').select(PROFILE_COLUMNS)
    .in('uuid', uuids)
    .not('role', 'in', '(feed_participant,recruiters)')
    .eq('status', 'Active')
    .not('is_anonymous', 'is', true)   // null counts as not anonymous, as in talent_search()
    .not('raw_email', 'ilike', '%@deleted.local')
}

/**
 * Candidates whose "open to work" status this recruiter must not see: those who chose "quiet",
 * and those who work now at one of her companies (talent_hidden_seeking). null when the check
 * failed — then no status is shown at all.
 */
export async function hiddenSeekingIds(admin: any, viewerId: string, uuids: string[]): Promise<Set<string> | null> {
  const results = await Promise.all(chunks(uuids).map((part) =>
    admin.rpc('talent_hidden_seeking', { p_viewer: viewerId, p_ids: part })))
  const failed = results.find((r: any) => r.error)
  if (failed) {
    console.error('talent_hidden_seeking failed:', failed.error.message)
    return null
  }
  return new Set(results.flatMap((r: any) => r.data ?? [])
    .map((x: any) => typeof x === 'string' ? x : x?.talent_hidden_seeking))
}

/** Profiles for these ids, mapped, in the given order (missing / no longer searchable ones dropped). */
export async function loadCandidates(
  admin: any, supabase: any, user: any, uuids: string[],
  extraFor: (uuid: string) => Record<string, unknown> = () => ({}),
) {
  if (!uuids.length) return []
  const [profiles, hidden, ctx] = await Promise.all([
    Promise.all(chunks(uuids).map((part) => profilesQuery(admin, part))),
    hiddenSeekingIds(admin, user.id, uuids),
    loadRecruiterContext(admin, supabase, user.id, uuids),
  ])
  const failed = profiles.find((r: any) => r.error)
  if (failed) throw new Error(failed.error.message)
  await enrichCompanies(admin, profiles.flatMap((r: any) => r.data ?? []))
  for (const r of profiles) for (const u of (r as any).data ?? []) if (!hidden || hidden.has(u.uuid)) u.job_seeking_status = null
  const role = viewerRoleOf(user)
  const byId = new Map(profiles.flatMap((r: any) => r.data ?? []).map((u: any) => [u.uuid, u]))
  return uuids.filter((id) => byId.has(id)).map((id) => mapCandidate(byId.get(id), role, ctx, extraFor(id)))
}

/** The candidate's skills that answer the chosen ones (any of their variants), in her own spelling. */
export function matchedSkills(candidateSkills: unknown, groups: string[]): string[] {
  const wanted = new Set(groups.flatMap((g) => g.split('|')))
  return (Array.isArray(candidateSkills) ? candidateSkills : []).filter((s) => wanted.has(squash(String(s))))
}

// ── Search filters → talent_search() parameters ────────────────────────────────
// Shared by the search (talent.ts) and the saved-search e-mail (lib/emails/talentAlerts.ts).

// Saved searches from before talent v2 stored the degree's English name.
const LEGACY_DEGREES: Record<string, string> = { "Bachelor's": 'bachelor', "Master's": 'master', MBA: 'mba', PhD: 'phd' }
const DEGREE_LEVELS = ['certificate', 'practical_engineer', 'bachelor', 'master', 'mba', 'phd']

const strings = (v: unknown, max = 30): string[] =>
  Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map((s: string) => s.trim().slice(0, 100)).slice(0, max) : []
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 60 ? Math.floor(n) : null
}
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/** Education levels: any of them. Searches saved before multi-select carry one `selectedDegree`. */
function degreeLevels(body: any): string[] {
  const list = Array.isArray(body.selectedDegrees) ? body.selectedDegrees : body.selectedDegree ? [body.selectedDegree] : []
  return [...new Set(list.map((d: unknown) => LEGACY_DEGREES[d as string] ?? d).filter((d: unknown) => DEGREE_LEVELS.includes(d as string)))] as string[]
}

// Every chosen value goes to the database with its variants, joined by "|" (talent_variants()):
// the same written form the database compares (talent_squash), other spellings of a skill
// ("React" → "reactjs"), and its translation (Hebrew ↔ English) when the API has one.
export const squash = (s: string) => s.toLowerCase().trim().replace(/[\s._/-]+/g, '').replace(/\|/g, '')

function skillSpellings(term: string): string[] {
  const forms = new Set<string>([squash(term)])
  const canonical = normalizeSkill(term)
  forms.add(squash(canonical))
  for (const [alias, to] of Object.entries(SKILL_ALIASES)) if (to === canonical) forms.add(alias)
  for (const [symbol, to] of Object.entries(SYMBOL_LANGS)) if (to === canonical) forms.add(squash(symbol))
  return [...forms].filter(Boolean)
}

function variants(term: string, translations: Record<string, string>, spellings: (t: string) => string[]): string {
  const forms = new Set(spellings(term))
  const other = translations[term]
  if (other) for (const f of spellings(other)) forms.add(f)
  return [...forms].filter(Boolean).join('|')
}
const plain = (t: string) => [squash(t)]

/** The values worth translating for this search (sent to translateTerms in one call). */
export function filterTerms(body: any): string[] {
  const city = text(body.selectedLocation, 120)?.split(',')[0].trim()
  return [
    ...strings(body.selectedSkills), ...strings(body.selectedLanguages), ...strings(body.selectedWorkPreferences),
    ...(city ? [city] : []), ...(text(body.selectedFieldOfStudy, 120) ? [text(body.selectedFieldOfStudy, 120)!] : []),
  ]
}

/** The sidebar filters (not the free text, not the job match). `translations`: filterTerms → other language. */
export function filterParams(body: any, translations: Record<string, string> = {}) {
  const city = text(body.selectedLocation, 120)?.split(',')[0].trim() ?? null
  const field = text(body.selectedFieldOfStudy, 120)
  return {
    p_skills: strings(body.selectedSkills).map((t) => variants(t, translations, skillSpellings)),
    p_skills_all: body.skillsMatch !== 'any',
    p_location: text(body.selectedLocation, 120),
    p_location_alt: city ? translations[city] ?? null : null,
    p_field_alt: field ? translations[field] ?? null : null,
    p_work_prefs: strings(body.selectedWorkPreferences).map((t) => variants(t, translations, plain)),
    p_languages: strings(body.selectedLanguages).map((t) => variants(t, translations, plain)),
    p_min_years: intOrNull(body.minYears),
    p_max_years: intOrNull(body.maxYears),
    p_degree_levels: degreeLevels(body),
    p_field: text(body.selectedFieldOfStudy, 120),
    p_currently_employed: body.currentlyEmployed === true,
    p_seeking: strings(body.jobSeekingStatuses).filter((s) => s === 'active' || s === 'open'),
  }
}

/** The sidebar filters as she chose them (her own words, no variants) — for talent_events. */
export function searchLogFilters(body: any) {
  const out: Record<string, unknown> = {
    skills: strings(body.selectedSkills),
    location: text(body.selectedLocation, 120),
    work_prefs: strings(body.selectedWorkPreferences),
    languages: strings(body.selectedLanguages),
    min_years: intOrNull(body.minYears),
    max_years: intOrNull(body.maxYears),
    degrees: degreeLevels(body),
    field: text(body.selectedFieldOfStudy, 120),
    currently_employed: body.currentlyEmployed === true || null,
    seeking: strings(body.jobSeekingStatuses).filter((s) => s === 'active' || s === 'open'),
  }
  for (const k of Object.keys(out)) {
    const v = out[k]
    if (v == null || (Array.isArray(v) && v.length === 0)) delete out[k]
  }
  return out
}

/** Does this search use any sidebar filter at all? */
export function hasFilterParams(f: ReturnType<typeof filterParams>): boolean {
  return f.p_skills.length > 0 || !!f.p_location || f.p_work_prefs.length > 0 || f.p_languages.length > 0 ||
    f.p_min_years != null || f.p_max_years != null || f.p_degree_levels.length > 0 || !!f.p_field ||
    f.p_currently_employed || f.p_seeking.length > 0
}

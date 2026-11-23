// Emails that get recruiters to START using /talent and keep them coming back (agreed 2026-11-22).
// None of them needs the recruiter to have done anything first; numbers follow lib/poolNumbers.ts
// (shown only above a minimum, rounded, never lower than before).
//
//   recruiter_ready     · day 0      — her access is ready: the pool in numbers + ready-made searches
//   recruiter_who       · day 3      — who is on duallin: working now, the most common roles (only if she hasn't searched)
//   recruiter_personal  · day 7      — "what role are you hiring for?" — answered by email to the team (only if she still hasn't searched)
//   recruiter_guide_1…4 · day 10, 17, 24, 31 — a short hiring guide, one episode a week
//   recruiter_give      · day 14     — the community listens to recruiters: a tip, "ask a recruiter", a role; once more after 60 days without a post
//   recruiter_monthly   · monthly    — what's new in the pool, to a recruiter who hasn't used talent for 30 days
//
// Day 0 is when recruiter_ready went out. Category 'recruiter_updates' (recruiters only, on / off,
// within the nice-to-know cap of 1 a day / 4 a week — so two due on the same day go out a day apart).
// Recruiter copy is gender-neutral (product rule for recruiters).
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { outOfTime } from './runClock.ts'
import { isGenericSkill, poolNumbers, shownFigure, shownLabel, skillName, type Counted, type PoolNumbers } from '../poolNumbers.ts'

export const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
export const DAY = 24 * 3600 * 1000
export type JobResult = { sent: number; attempts: number }
export const none: JobResult = { sent: 0, attempts: 0 }
export const CATEGORY = 'recruiter_updates'
type L = 'he' | 'en'

const ACTIVATION_KINDS = ['recruiter_ready', 'recruiter_who', 'recruiter_personal', 'recruiter_guide_1', 'recruiter_guide_2',
  'recruiter_guide_3', 'recruiter_guide_4', 'recruiter_give', 'recruiter_monthly']

// ───────────────────────── who and what ─────────────────────────

export interface Recruiter { uuid: string; email: string; first_name: string | null }

/** Recruiters who can get email: app role 'recruiters', finished onboarding. */
export async function activeRecruiters(): Promise<Recruiter[]> {
  const { data, error } = await adminClient().from('users').select('uuid, email, first_name')
    .eq('role', 'recruiters').eq('status', 'Active').not('email', 'is', null).limit(2000)
  if (error) throw new Error(error.message)
  return (data ?? []) as Recruiter[]
}

/** The uuids of every member with app role 'recruiters' — to keep them out of the community emails. */
export async function recruiterIds(): Promise<Set<string>> {
  const { data } = await adminClient().from('users').select('uuid').eq('role', 'recruiters').limit(5000)
  return new Set((data ?? []).map((r) => r.uuid))
}

/** When each of these kinds was handled for each recruiter (sent, or skipped because she turned it off). */
export async function handled(kinds: string[], ids: string[]): Promise<Map<string, Map<string, { at: number; ref: string | null }[]>>> {
  const out = new Map<string, Map<string, { at: number; ref: string | null }[]>>()
  if (!ids.length) return out
  const { data } = await adminClient().from('email_log').select('user_id, kind, ref_key, created_at')
    .in('kind', kinds).in('user_id', ids).in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped']).limit(10000)
  for (const r of data ?? []) {
    const byKind = out.get(r.user_id) ?? new Map()
    byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), { at: Date.parse(r.created_at), ref: r.ref_key }])
    out.set(r.user_id, byKind)
  }
  return out
}

/** Recruiters who ever searched the pool (recorded searches, the recent list, or a saved search). */
async function searchedEver(ids: string[]): Promise<Set<string>> {
  const db = adminClient()
  const [ev, recent, saved] = await Promise.all([
    db.from('talent_events').select('recruiter_id').eq('kind', 'search').in('recruiter_id', ids).limit(5000),
    db.from('recent_talent_searches').select('recruiter_id').in('recruiter_id', ids).limit(5000),
    db.from('saved_talent_searches').select('recruiter_id').in('recruiter_id', ids).limit(5000),
  ])
  return new Set([...(ev.data ?? []), ...(recent.data ?? []), ...(saved.data ?? [])].map((r: any) => r.recruiter_id))
}

/** Her last use of /talent: a search or a candidate opened, an outreach, a project touched. */
export async function lastTalentUse(ids: string[]): Promise<Map<string, number>> {
  const db = adminClient()
  const [ev, req, proj] = await Promise.all([
    db.from('talent_events').select('recruiter_id, created_at').in('recruiter_id', ids).order('created_at', { ascending: false }).limit(5000),
    db.from('profile_access_requests').select('recruiter_id, created_at').in('recruiter_id', ids).limit(5000),
    db.from('talent_projects').select('recruiter_id, updated_at').in('recruiter_id', ids).limit(5000),
  ])
  const out = new Map<string, number>()
  const note = (id: string, at: string | null) => { if (at) out.set(id, Math.max(out.get(id) ?? 0, Date.parse(at))) }
  for (const r of ev.data ?? []) note(r.recruiter_id, r.created_at)
  for (const r of req.data ?? []) note(r.recruiter_id, r.created_at)
  for (const r of proj.data ?? []) note(r.recruiter_id, r.updated_at)
  return out
}

/** Sends one recruiter email and keeps the job's counts the way the other jobs do. */
export async function sendTo(r: Recruiter, o: { kind: string; refKey: string; subject: Bi; html: (unsub: string | null) => string; category?: string }, counts: JobResult) {
  counts.attempts++
  const res = await sendEmail({
    kind: o.kind, category: o.category ?? CATEGORY, to: r.email, userId: r.uuid, refKey: o.refKey,
    subject: `${o.subject.he} | ${o.subject.en}`,
    html: ({ unsubscribeUrl }) => o.html(unsubscribeUrl),
  })
  if (res.status === 'deferred') counts.attempts--
  if (res.status === 'sent') counts.sent++
  return res
}

// ───────────────────────── layout parts ─────────────────────────

const F = 'font-family:Arial,sans-serif;'
/** Latin terms inside a Hebrew line keep their own direction (C# would show as #C). */
export const ltr = (s: string) => s.replace(/[A-Za-z#.][A-Za-z0-9#.+\/ -]*[A-Za-z0-9#+]/g, (m) => `<span dir="ltr">${m}</span>`)
export const both = (f: (l: L) => string): Bi => ({ he: f('he'), en: f('en') })

/** Rows: a linked title and a small line under it. `title` / `sub` are plain text, escaped here. */
export function list(rows: { title: Bi; sub: Bi; href: string }[], lang: L): string {
  const rtl = lang === 'he'
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? 'rtl' : 'ltr'}" style="margin:4px 0 10px;">` +
    rows.map((r) => `<tr><td style="padding:8px 0;border-top:1px solid #ece7ef;${F}font-size:14px;text-align:${rtl ? 'right' : 'left'};">
      <a href="${esc(r.href)}" style="color:#3d1240;font-weight:700;text-decoration:none;"><span dir="auto">${esc(r.title[lang])}</span> ${rtl ? '←' : '→'}</a><br>
      <span style="color:#6b5a78;font-size:13px;">${rtl ? ltr(esc(r.sub.he)) : esc(r.sub.en)}</span></td></tr>`).join('') + '</table>'
}

/** Number tiles. */
export function stats(items: { n: string; label: Bi }[], lang: L): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${lang === 'he' ? 'rtl' : 'ltr'}" style="margin:6px 0 12px;"><tr>` +
    items.map((s) => `<td style="padding:10px 6px;text-align:center;background:#faf6fc;border:1px solid #ece7ef;border-radius:8px;${F}">
      <div style="font-size:22px;font-weight:700;color:#3d1240;" dir="ltr">${esc(s.n)}</div>
      <div style="font-size:12px;color:#6b5a78;">${esc(s.label[lang])}</div></td>`).join('<td width="8"></td>') + '</tr></table>'
}

/** A highlighted fact and what it means. `fact` / `meaning` may hold simple markup (written here, not by members). */
export function facts(rows: { fact: Bi; meaning: Bi }[], lang: L): string {
  const rtl = lang === 'he'
  return rows.map((r) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? 'rtl' : 'ltr'}" style="margin:0 0 10px;">
    <tr><td style="padding:10px 12px;${F}text-align:${rtl ? 'right' : 'left'};border-${rtl ? 'right' : 'left'}:3px solid #8a4f8f;background:#faf6fc;">
      <div style="font-size:14px;font-weight:700;color:#3d1240;">${rtl ? ltr(r.fact.he) : r.fact.en}</div>
      <div style="font-size:13px;color:#4a3a55;line-height:1.55;margin-top:3px;">${rtl ? ltr(r.meaning.he) : r.meaning.en}</div>
    </td></tr>
  </table>`).join('')
}

export const layout = (body: string, preheader: Bi, unsubscribeUrl: string | null, reason?: Bi) => renderLayout({
  preheader,
  body,
  reason: reason ?? { he: 'קיבלת את המייל כי יש לך גישה לכלי הגיוס של דואולין.', en: 'You received this because you have access to duallin\'s recruiting tools.' },
  unsubscribeUrl,
})

const talentUrl = (params: Record<string, string> = {}) => {
  const q = new URLSearchParams(params).toString()
  return `${APP_URL()}/talent${q ? `?${q}` : ''}`
}
const first = (r: Recruiter) => (r.first_name ?? '').trim()

// ───────────────────────── A · access ready ─────────────────────────

export function renderReady(r: Recruiter, p: PoolNumbers, unsub: string | null): { subject: Bi; html: string } | null {
  const pool = shownFigure(p.pool)
  if (!pool) return null
  const tiles = [{ n: pool, label: { he: 'נשות הייטק', en: 'women in tech' } }]
  if (p.employed_pct) tiles.push({ n: `${p.employed_pct}%`, label: { he: 'מבעלות ניסיון — עובדות היום בהייטק', en: 'of those with experience work in tech today' } })
  const week = shownFigure(p.new_7d)
  if (week) tiles.push({ n: week, label: { he: 'הצטרפו בשבוע האחרון', en: 'joined last week' } })

  // Ready-made searches, one click each: the biggest skills. Not who is looking: few have answered that yet
  // (it's new), so the count looks small next to the pool — same as the /talent hero.
  const ready: { title: Bi; sub: Bi; href: string }[] = []
  for (const s of p.top_skills.filter((x) => !isGenericSkill(x.label) && x.count >= 300)) {
    if (ready.length >= 4) break
    const name = skillName(s.label)
    ready.push({ title: { he: name, en: name }, sub: { he: `${shownLabel(s.count, 'he')} מועמדות`, en: `${shownLabel(s.count, 'en')} candidates` }, href: talentUrl({ skills: name }) })
  }

  const name = first(r)
  const body = biColumns(both((l) => (l === 'he'
    ? heading(name ? `${esc(name)}, הגישה שלך לטאלנט מוכנה` : 'הגישה שלך לטאלנט מוכנה') +
      paragraph('בדואולין נמצאות נשות הייטק מהקהילה החרדית — מפתחות, בודקות, אנליסטיות ועוד. אפשר לחפש לפי כישורים, ניסיון, מיקום וזמינות, ולפנות ישירות.')
    : heading(name ? `${esc(name)}, your Talent access is ready` : 'Your Talent access is ready') +
      paragraph('duallin is home to women in tech from the Orthodox community — developers, testers, analysts and more. Search by skills, experience, location and availability, and reach out directly.')) +
    stats(tiles, l) +
    (ready.length ? paragraph(l === 'he' ? '<b>חיפושים מוכנים — לחיצה אחת:</b>' : '<b>Ready-made searches — one click:</b>') + list(ready, l) : '')))
    + button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, talentUrl())
  const poolHe = shownLabel(p.pool, 'he')!
  const poolEn = shownLabel(p.pool, 'en')!
  return {
    subject: { he: `הגישה שלך לטאלנט מוכנה — ${poolHe} נשות הייטק`, en: `Your Talent access is ready — ${poolEn} women in tech` },
    html: layout(body,
      { he: ready.length ? `חיפושים מוכנים: ${ready.map((x) => x.title.he).join(', ')}` : `${poolHe} נשות הייטק`, en: ready.length ? `Ready searches: ${ready.map((x) => x.title.en).join(', ')}` : `${poolEn} women in tech` },
      unsub, { he: 'קיבלת את המייל כי קיבלת גישה לכלי הגיוס של דואולין.', en: 'You received this because you were given access to duallin\'s recruiting tools.' }),
  }
}

// ───────────────────────── B · who is here ─────────────────────────

export function renderWho(p: PoolNumbers, unsub: string | null): { subject: Bi; html: string } | null {
  const pct = p.employed_pct
  if (!pct) return null
  const roles = p.top_titles.filter((t) => t.count >= 100).slice(0, 3).map((t) => ({
    title: { he: t.label, en: t.label },
    sub: { he: `${shownLabel(t.count, 'he')} בתפקיד הזה היום`, en: `${shownLabel(t.count, 'en')} in this role today` },
    href: talentUrl({ q: t.label }),
  }))
  const body = biColumns(both((l) => (l === 'he'
    ? heading('מי נמצאת בדואולין') +
      paragraph(`${pct}% מהמועמדות שמילאו ניסיון בפרופיל עובדות היום בהייטק — כולל כאלה שלא מחפשות באופן פעיל ולא יגיעו דרך מודעת דרושים.${roles.length ? ' התפקידים הנפוצים:' : ''}`)
    : heading('Who is on duallin') +
      paragraph(`${pct}% of the candidates with work experience on their profile work in tech today — including people who are not actively looking and won't answer a job ad.${roles.length ? ' The most common roles:' : ''}`)) +
    (roles.length ? list(roles, l) : '') +
    paragraph(l === 'he'
      ? 'מועמדת שמחפשת עבודה מסומנת בכרטיס שלה — רק מגייסים רואים את זה. פנייה לוקחת דקה: כמה מילים על התפקיד, וכשהיא מאשרת נפתחת שיחה.'
      : 'A candidate who is looking is marked on her card — only recruiters see it. Reaching out takes a minute: a few words about the role, and when she accepts, a conversation opens.')))
    + button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, talentUrl())
  return {
    subject: { he: `מי נמצאת בדואולין: ${pct}% עובדות היום בהייטק`, en: `Who is on duallin: ${pct}% work in tech today` },
    html: layout(body, { he: roles.length ? roles.map((x) => x.title.he).join(', ') : 'מי נמצאת בדואולין', en: roles.length ? roles.map((x) => x.title.en).join(', ') : 'Who is on duallin' }, unsub),
  }
}

// ───────────────────────── C · personal ─────────────────────────

export function renderPersonal(r: Recruiter, unsub: string | null): { subject: Bi; html: string } {
  const name = first(r)
  const body = biColumns({
    he: heading('על איזה תפקיד מגייסים עכשיו?') +
      (name ? paragraph(`שלום ${esc(name)},`) : '') +
      paragraph('ראינו שעוד לא יצא לך לחפש בדואולין. אם יש תפקיד פתוח — אפשר פשוט להשיב למייל הזה עם שם התפקיד וכמה דרישות, ונחזור עם רשימה קצרה של מועמדות מתאימות מהמאגר.') +
      paragraph('ואם החיפוש לא היה ברור או שחסר משהו — נשמח לשמוע גם את זה.') +
      paragraph('צוות דואולין'),
    en: heading('What role are you hiring for now?') +
      (name ? paragraph(`Hi ${esc(name)},`) : '') +
      paragraph('We noticed you haven\'t searched on duallin yet. If you have an open role, just reply to this email with the title and a few requirements, and we\'ll come back with a short list of matching candidates.') +
      paragraph('And if search wasn\'t clear or something is missing, we\'d love to hear that too.') +
      paragraph('The duallin team'),
  }) + button({ he: 'או לחפש בעצמך', en: 'Or search yourself' }, talentUrl())
  return {
    subject: { he: 'על איזה תפקיד מגייסים עכשיו?', en: 'What role are you hiring for?' },
    html: layout(body, { he: 'משיבים עם שם התפקיד — ונחזור עם רשימה קצרה', en: 'Reply with the role — we\'ll send a short list' }, unsub),
  }
}

// ───────────────────────── the hiring guide ─────────────────────────

/** Members' city as written, Hebrew and English spellings joined. */
const CITY_ALIASES: Record<string, string> = {
  'jerusalem': 'jerusalem', 'ירושלים': 'jerusalem', 'bnei brak': 'bnei brak', 'בני ברק': 'bnei brak',
  'tel aviv': 'tel aviv', 'תל אביב': 'tel aviv', 'beit shemesh': 'beit shemesh', 'בית שמש': 'beit shemesh',
  'modiin illit': 'modiin illit', 'מודיעין עילית': 'modiin illit', 'elad': 'elad', 'אלעד': 'elad',
}
const CITY_NAMES: Record<string, Bi> = {
  'jerusalem': { he: 'ירושלים', en: 'Jerusalem' }, 'bnei brak': { he: 'בני ברק', en: 'Bnei Brak' },
  'tel aviv': { he: 'תל אביב', en: 'Tel Aviv' }, 'beit shemesh': { he: 'בית שמש', en: 'Beit Shemesh' },
  'modiin illit': { he: 'מודיעין עילית', en: 'Modiin Illit' }, 'elad': { he: 'אלעד', en: 'Elad' },
}
const sumBy = (rows: Counted[], key: (label: string) => string | null) => {
  const out = new Map<string, number>()
  for (const r of rows) { const k = key(r.label); if (k) out.set(k, (out.get(k) ?? 0) + r.count) }
  return [...out].sort((a, b) => b[1] - a[1])
}
/** "almost 3×" / "5×": how many times bigger, said only when it's clearly bigger. */
const times = (a: number, b: number): Bi | null => {
  if (!b || a / b < 1.5) return null
  const x = a / b
  const whole = Math.round(x)
  return Math.abs(x - whole) < 0.15 ? { he: `פי ${whole}`, en: `${whole}×` } : { he: `כמעט פי ${Math.ceil(x)}`, en: `almost ${Math.ceil(x)}×` }
}

export function guideEpisode(n: number, p: PoolNumbers): { subject: Bi; preheader: Bi; body: string } | null {
  if (n === 1) {
    const prefs = sumBy(p.work_prefs, (l) => l.toLowerCase())
    const count = (k: string) => prefs.find(([x]) => x === k)?.[1] ?? 0
    const cities = sumBy(p.cities, (l) => CITY_ALIASES[l.toLowerCase()] ?? null)
    const rows: { fact: Bi; meaning: Bi }[] = []
    const hybridVsRemote = times(count('hybrid'), count('remote'))
    if (prefs[0]?.[0] === 'hybrid' && hybridVsRemote) {
      rows.push({
        fact: { he: `היברידי היא הבחירה הנפוצה ביותר — ${hybridVsRemote.he} מעבודה מרחוק`, en: `Hybrid is the top choice — ${hybridVsRemote.en} fully remote` },
        meaning: { he: 'משרה שמציעה ימים מהבית מקבלת יותר תשובות. כדאי לכתוב את זה כבר בפנייה הראשונה.', en: 'A role with days from home gets more answers. Say it in the first message.' },
      })
    }
    if (cities.length >= 2) {
      const [[c1, n1], [c2, n2]] = cities
      const ratio = times(n1, n2)
      if (ratio && CITY_NAMES[c1] && CITY_NAMES[c2]) {
        rows.push({
          fact: { he: `${CITY_NAMES[c1].he} היא המרכז הגדול — ${ratio.he} מ${CITY_NAMES[c2].he}`, en: `${CITY_NAMES[c1].en} is the biggest hub — ${ratio.en} ${CITY_NAMES[c2].en}` },
          meaning: { he: `משרד או ימי עבודה ב${CITY_NAMES[c1].he} פותחים חלק גדול מהמאגר. כדאי לציין את המיקום כבר בפנייה.`, en: `An office or work days in ${CITY_NAMES[c1].en} open a large part of the pool. Mention the location in the first message.` },
        })
      }
    }
    const top3 = prefs.slice(0, 3).map(([k]) => k)
    if (top3.includes('flexible')) {
      rows.push({
        fact: { he: 'גמישות בשעות — בין שלוש ההעדפות המובילות', en: 'Flexible hours — among the top three preferences' },
        meaning: { he: 'שעות סיום מוקדמות או יום קצר באמצע השבוע הן יתרון אמיתי — לא הטבה שולית.', en: 'An early finish or a short midweek day is a real advantage — not a small perk.' },
      })
    }
    if (!rows.length) return null
    return {
      subject: { he: 'מדריך גיוס #1: איך הן רוצות לעבוד', en: 'Hiring guide #1: how they want to work' },
      preheader: { he: 'היברידי, מיקום ושעות — ומה זה אומר למשרה שלך', en: 'Hybrid, location and hours — and what it means for your role' },
      body: biColumns(both((l) => (l === 'he'
        ? heading('איך הן רוצות לעבוד') + paragraph('מה שחברות דואולין סימנו בהעדפות העבודה שלהן — ומה זה אומר למשרה שלך:')
        : heading('How they want to work') + paragraph('What duallin members marked in their work preferences — and what it means for your role:')) +
        facts(rows, l) + paragraph(l === 'he' ? '<b>בפרק הבא:</b> איך כותבים פנייה ראשונה שמקבלת תשובה.' : '<b>Next:</b> how to write a first message that gets an answer.')))
        + button({ he: 'לחיפוש לפי העדפות עבודה', en: 'Search by work preferences' }, talentUrl()),
    }
  }
  if (n === 2) {
    const rows = [
      { fact: { he: 'נושא ברור', en: 'A clear subject' }, meaning: { he: 'שם התפקיד והחברה בשורת הנושא של הפנייה. "QA Automation בחברת X" עובד יותר טוב מ"הזדמנות מעניינת".', en: 'The role and the company in the outreach subject. "QA Automation at X" works better than "An interesting opportunity".' } },
      { fact: { he: 'למה דווקא היא', en: 'Why her' }, meaning: { he: 'משפט אחד על משהו מהפרופיל שלה — פרויקט, כישור, מאמר שכתבה. כך רואים שזו לא הודעה המונית.', en: 'One sentence about something on her profile — a project, a skill, an article she wrote. It shows this isn\'t a mass message.' } },
      { fact: { he: 'מה חשוב לה, מראש', en: 'What matters to her, up front' }, meaning: { he: 'היברידי, שעות, מיקום. אם זה בפנייה, היא לא צריכה לשאול — וקל לה יותר לאשר.', en: 'Hybrid, hours, location. If it\'s in the message, she doesn\'t need to ask — and it\'s easier to say yes.' } },
      { fact: { he: 'לבקש רק מה שצריך', en: 'Ask only for what you need' }, meaning: { he: 'אפשר לפנות בלי לבקש פרטי קשר. הפנייה פותחת שיחה כשהיא מאשרת, ואת הפרטים אפשר לבקש אחר כך.', en: 'You can reach out without asking for contact details. Her yes opens a conversation, and details can come later.' } },
    ]
    return {
      subject: { he: 'מדריך גיוס #2: פנייה שמקבלת תשובה', en: 'Hiring guide #2: an outreach that gets an answer' },
      preheader: { he: 'ארבעה דברים שעושים את ההבדל', en: 'Four things that make the difference' },
      body: biColumns(both((l) => (l === 'he'
        ? heading('פנייה שמקבלת תשובה') + paragraph('בדואולין המועמדת מחליטה אם לפתוח שיחה. ארבעה דברים שעוזרים לה להגיד כן:')
        : heading('An outreach that gets an answer') + paragraph('On duallin, the candidate decides whether to open a conversation. Four things that help her say yes:')) +
        facts(rows, l) + paragraph(l === 'he' ? '<b>בפרק הבא:</b> מה חשוב להן בסביבת העבודה.' : '<b>Next:</b> what matters to them at work.')))
        + button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, talentUrl()),
    }
  }
  if (n === 3) {
    const rows = [
      { fact: { he: 'בהירות לפני הכל', en: 'Clarity first' }, meaning: { he: 'שעות, ימים מהבית, אופי הצוות והמשרד. ככל שהתמונה ברורה יותר בשלב מוקדם, התהליך קצר יותר.', en: 'Hours, days from home, the team and the office. The clearer the picture early on, the shorter the process.' } },
      { fact: { he: 'אינטרנט מסונן', en: 'Filtered internet' }, meaning: { he: 'חלק מהמועמדות עובדות עם סינון אינטרנט. כדאי לוודא מראש שכלי העבודה, המייל וחיבור ה-VPN עובדים דרכו.', en: 'Some candidates work with filtered internet. Check early that your tools, email and VPN work through it.' } },
      { fact: { he: 'לשאול אותן', en: 'Ask them' }, meaning: { he: 'הקהילה פתוחה לשאלות. שאלה קצרה בפיד — מה חשוב לכן במקום עבודה? — מביאה תשובות אמיתיות, ומכירה אותך לקהילה.', en: 'The community is open to questions. A short post — what matters to you in a workplace? — brings real answers and introduces you to the community.' } },
    ]
    return {
      subject: { he: 'מדריך גיוס #3: מה חשוב להן בסביבת העבודה', en: 'Hiring guide #3: what matters to them at work' },
      preheader: { he: 'בהירות, סינון אינטרנט, ולשאול אותן', en: 'Clarity, filtered internet, and asking them' },
      body: biColumns(both((l) => (l === 'he'
        ? heading('מה חשוב להן בסביבת העבודה') + paragraph('שלושה דברים מעשיים שעוזרים לתהליך לעבור חלק:')
        : heading('What matters to them at work') + paragraph('Three practical things that help the process run smoothly:')) +
        facts(rows, l) + paragraph(l === 'he' ? '<b>בפרק הבא:</b> עונת הבוגרות — מתי מגייסים ג\'וניוריות.' : '<b>Next:</b> graduation season — when to hire juniors.')))
        + button({ he: 'לכתיבת פוסט בקהילה', en: 'Post in the community' }, `${APP_URL()}/`),
    }
  }
  if (n === 4) {
    const rows = [
      { fact: { he: 'הקיץ הוא עונת הבוגרות', en: 'Summer is graduation season' }, meaning: { he: 'מסלולי ההייטק בסמינרים מסיימים בדרך כלל בקיץ, ומחזור שלם של ג\'וניוריות יוצא לשוק העבודה בבת אחת.', en: 'Seminary tech tracks usually finish in summer, and a whole class of juniors enters the job market at once.' } },
      { fact: { he: 'מוקדם זה יתרון', en: 'Early is an advantage' }, meaning: { he: 'מי שמתחיל לחפש באביב פוגש את הבוגרות לפני כולם. שמירת חיפוש עכשיו מביאה את המצטרפות החדשות במייל כל שבוע.', en: 'Starting in spring means meeting graduates before everyone else. Save a search now and new members arrive by email every week.' } },
      { fact: { he: 'פרויקט הגמר מספר הרבה', en: 'The final project says a lot' }, meaning: { he: 'אצל ג\'וניורית, הפרויקטים בפרופיל הם הניסיון. כדאי להסתכל עליהם ולהזכיר אותם בפנייה.', en: 'For a junior, the projects on her profile are the experience. Look at them and mention them in the outreach.' } },
    ]
    return {
      subject: { he: 'מדריך גיוס #4: עונת הבוגרות', en: 'Hiring guide #4: graduation season' },
      preheader: { he: 'מתי ואיך מגייסים ג\'וניוריות', en: 'When and how to hire juniors' },
      body: biColumns(both((l) => (l === 'he'
        ? heading('עונת הבוגרות') + paragraph('אם יש אצלכם מקום לג\'וניוריות — כך כדאי לתכנן:')
        : heading('Graduation season') + paragraph('If you have room for juniors — here\'s how to plan:')) +
        facts(rows, l)))
        + button({ he: 'לשמירת חיפוש', en: 'Save a search' }, talentUrl()),
    }
  }
  return null
}

// ───────────────────────── give to the community ─────────────────────────

export function renderGive(unsub: string | null): { subject: Bi; html: string } {
  const ideas = [
    { fact: { he: 'טיפ אחד מהשטח', en: 'One tip from the field' }, meaning: { he: 'מה עושה קורות חיים טובים בעיניך, או מה שאלת בראיון האחרון. פוסט קצר מספיק.', en: 'What makes a good CV for you, or what you asked in your last interview. A short post is enough.' } },
    { fact: { he: '"שאלו מגייסת" — שעה אחת', en: '"Ask a recruiter" — one hour' }, meaning: { he: 'חברות שואלות בתגובות ומקבלות תשובות ממך. משיבים למייל הזה ונכין את הפוסט יחד.', en: 'Members ask in the comments and you answer. Reply to this email and we\'ll set it up together.' } },
    { fact: { he: 'משרה פתוחה', en: 'An open role' }, meaning: { he: 'משרה שמתפרסמת בקהילה מגיעה גם לחברות שלא מחפשות — ולחברות שלהן.', en: 'A role posted in the community reaches people who aren\'t looking — and their friends.' } },
  ]
  const body = biColumns(both((l) => (l === 'he'
    ? heading('הקהילה מקשיבה למגייסות') + paragraph('בכל חודש מאות חברות כותבות ומגיבות בקהילה. מגייסת שמוכרת שם מקבלת יותר תשובות לפניות — כי כבר יודעים מי היא. שלוש דרכים קלות להתחיל:')
    : heading('The community listens to recruiters') + paragraph('Every month, hundreds of members post and comment. A recruiter they know gets more answers to outreach — they already know who you are. Three easy ways to start:')) +
    facts(ideas, l)))
    + button({ he: 'לכתיבת פוסט', en: 'Write a post' }, `${APP_URL()}/`)
  return {
    subject: { he: 'הקהילה מקשיבה למגייסות', en: 'The community listens to recruiters' },
    html: layout(body, { he: 'טיפ, "שאלו מגייסת" או משרה', en: 'A tip, "ask a recruiter" or a role' }, unsub),
  }
}

// ───────────────────────── monthly: what's new in the pool ─────────────────────────

export function renderMonthly(p: PoolNumbers, unsub: string | null): { subject: Bi; html: string } | null {
  const newHe = shownLabel(p.new_30d, 'he')
  const newEn = shownLabel(p.new_30d, 'en')
  // a quiet month: no email (a small number would do the opposite)
  if (!newHe || !newEn || p.new_30d < 150) return null
  const tiles = [{ n: shownFigure(p.new_30d)!, label: { he: 'הצטרפו ב-30 הימים האחרונים', en: 'joined in the last 30 days' } }]
  const pool = shownFigure(p.pool)
  if (pool) tiles.push({ n: pool, label: { he: 'במאגר בסך הכל', en: 'in the pool' } })
  const fields = p.new_skills_30d.filter((s) => !isGenericSkill(s.label) && s.count >= 100).slice(0, 3).map((s) => {
    const name = skillName(s.label)
    return { title: { he: name, en: name }, sub: { he: `${shownLabel(s.count, 'he')} חדשות`, en: `${shownLabel(s.count, 'en')} new` }, href: talentUrl({ skills: name }) }
  })
  const body = biColumns(both((l) => (l === 'he' ? heading('מה חדש במאגר') : heading('What\'s new in the pool')) + stats(tiles, l) +
    (fields.length ? paragraph(l === 'he' ? '<b>התחומים עם הכי הרבה מצטרפות:</b>' : '<b>Fields with the most new members:</b>') + list(fields, l) : '')))
    + button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, talentUrl())
  return {
    subject: { he: `${newHe} נשות הייטק הצטרפו בחודש האחרון`, en: `${newEn} women in tech joined in the last month` },
    html: layout(body, { he: fields.length ? `הכי הרבה ב-${fields.map((f) => f.title.he).join(', ')}` : 'מה חדש במאגר', en: fields.length ? `Most in ${fields.map((f) => f.title.en).join(', ')}` : 'What\'s new in the pool' }, unsub),
  }
}

// ───────────────────────── the job ─────────────────────────

const GUIDE_DAYS = [10, 17, 24, 31]

/** One pass over the recruiters: each gets the next email of the sequence that is due for her. */
export async function recruiterActivationJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const recruiters = await activeRecruiters()
  if (!recruiters.length) return none
  const ids = recruiters.map((r) => r.uuid)
  const [done, searched, lastUse, posted] = await Promise.all([
    handled(ACTIVATION_KINDS, ids), searchedEver(ids), lastTalentUse(ids), recentPosters(recruiters, now),
  ])
  const p = await poolNumbers()
  const t = now.getTime()
  const counts: JobResult = { sent: 0, attempts: 0 }
  const month = now.toISOString().slice(0, 7)

  for (const r of recruiters) {
    if (counts.attempts >= budget || outOfTime()) break
    const mine = done.get(r.uuid) ?? new Map()
    const at = (kind: string) => Math.max(0, ...((mine.get(kind) ?? []).map((x: { at: number }) => x.at)))
    const has = (kind: string) => (mine.get(kind) ?? []).length > 0
    const ready = at('recruiter_ready')
    const since = (ms: number) => ready && t - ready >= ms

    // One email per pass; the cap in sendEmail spaces them a day apart anyway.
    if (!has('recruiter_ready')) {
      const m = renderReady(r, p, null)
      if (m) await sendTo(r, { kind: 'recruiter_ready', refKey: 'ready', subject: m.subject, html: (u) => renderReady(r, p, u)!.html }, counts)
      continue
    }
    if (!searched.has(r.uuid) && !has('recruiter_who') && since(3 * DAY)) {
      const m = renderWho(p, null)
      if (m) { await sendTo(r, { kind: 'recruiter_who', refKey: 'who', subject: m.subject, html: (u) => renderWho(p, u)!.html }, counts); continue }
    }
    if (!searched.has(r.uuid) && has('recruiter_who') && !has('recruiter_personal') && t - at('recruiter_who') >= 4 * DAY) {
      const m = renderPersonal(r, null)
      await sendTo(r, { kind: 'recruiter_personal', refKey: 'personal', subject: m.subject, html: (u) => renderPersonal(r, u).html }, counts)
      continue
    }
    const nextGuide = GUIDE_DAYS.findIndex((_, i) => !has(`recruiter_guide_${i + 1}`))
    if (nextGuide >= 0 && since(GUIDE_DAYS[nextGuide] * DAY) && (nextGuide === 0 || t - at(`recruiter_guide_${nextGuide}`) >= 6 * DAY)) {
      const ep = guideEpisode(nextGuide + 1, p)
      if (ep) {
        await sendTo(r, { kind: `recruiter_guide_${nextGuide + 1}`, refKey: `guide_${nextGuide + 1}`, subject: ep.subject, html: (u) => layout(ep.body, ep.preheader, u) }, counts)
        continue
      }
    }
    // twice at most: day 14, and once more after 60 days in which she didn't post
    const gives = (mine.get('recruiter_give') ?? []).length
    if (since(14 * DAY) && (gives === 0 || (gives === 1 && t - at('recruiter_give') >= 60 * DAY && !posted.has(r.uuid)))) {
      await sendTo(r, { kind: 'recruiter_give', refKey: `give:${gives + 1}`, subject: renderGive(null).subject, html: (u) => renderGive(u).html }, counts)
      continue
    }
    const quiet = t - (lastUse.get(r.uuid) ?? 0) >= 30 * DAY
    const monthlyDone = (mine.get('recruiter_monthly') ?? []).some((x: { ref: string | null }) => x.ref === month)
    if (quiet && since(30 * DAY) && !monthlyDone) {
      const m = renderMonthly(p, null)
      if (m) await sendTo(r, { kind: 'recruiter_monthly', refKey: month, subject: m.subject, html: (u) => renderMonthly(p, u)!.html }, counts)
    }
  }
  return counts
}

/** Members (here: recruiters) who posted in the community in the last 60 days. Posts are keyed by e-mail. */
async function recentPosters(rs: Recruiter[], now: Date): Promise<Set<string>> {
  const byEmail = new Map(rs.map((r) => [r.email.toLowerCase(), r.uuid]))
  const { data } = await adminClient().from('posts').select('sender')
    .in('sender', [...byEmail.keys()]).gte('sent_at', new Date(now.getTime() - 60 * DAY).toISOString()).limit(1000)
  return new Set((data ?? []).map((p) => byEmail.get(String(p.sender).toLowerCase())).filter(Boolean) as string[])
}

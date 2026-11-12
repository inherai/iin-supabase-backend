// Profile tips — for an active member whose profile is under 70% (decided 2026-11-12).
// The small "your profile is N% complete" line in other emails says *that* something is missing;
// this one says *what* is missing for her, and *why* it matters on duallin.
//   * Who: Active members (role 'community', not anonymous), at least 10 days after joining (the
//     welcome / first days are over), active on the site in the last 30 days (quiet members get the
//     come-back email instead), profile strength under 70% — recomputed right before sending.
//   * When: email 1; email 2 at least 10 days later; email 3 (the last) at least 30 days after that.
//     Stops for good once she reaches 70%, or after email 3.
//   * What: short — her 2–3 missing parts that would raise her profile the most (from
//     calculateProfileStrength), each with what it adds in points and one line on why it matters.
//     The one figure (88%) comes from the site's own guide / onboarding (he.json onboarding.photo.*).
// Category 'onboarding' ("Getting started — reminders to finish signing up and profile tips"):
// capped (at most one nice-to-know email a day), and she can turn it off.
import { adminClient, getFrequencies } from '../emailPrefs.ts'
import { cappedNow, sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { calculateProfileStrength } from '../../routes/_scoreHelpers.ts'
import { inChunks, lastActive } from './activityJobs.ts'
import { outOfTime } from './runClock.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
const BRAND = '#4b154c'
const INK = '#1d1d1f'
const INK_2 = '#4a4a50'
const INK_3 = '#86838b'
const LINE = '#ede0f0'
const SOFT = '#faf5fb'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

export const TARGET_PCT = 70 // 'Strong' (מבוססת) — also where personal invitations unlock
const AFTER_JOINING_DAYS = 10
const ACTIVE_WITHIN_DAYS = 30
const GAP_DAYS = { 2: 10, 3: 30 } as const
const MAX_TIPS = 3
const SENT = ['sent', 'delivered', 'bounced', 'complained', 'skipped']

type TipKey = 'experience' | 'skills' | 'photo' | 'about' | 'headline' | 'education' | 'certifications' | 'location'
interface TipCopy { title: Bi; why: Bi }

// One short reason per tip — why it matters, not how to do it (2026-11-12: "tips, not a guide").
// `partial` = she started this part (e.g. roles without descriptions); otherwise it's missing.
const TIPS: Record<TipKey, { missing: TipCopy; partial?: TipCopy }> = {
  experience: {
    missing: {
      title: { he: 'ניסיון או פרויקט', en: 'Experience or a project' },
      why: { he: 'הדבר הראשון שבודקים בפרופיל, וכך נוכל להציע לך עמיתות מהחברה שלך.', en: 'The first thing people check, and how we can suggest colleagues from your company.' },
    },
    partial: {
      title: { he: 'תיאור לתפקידים שלך', en: 'Descriptions for your roles' },
      why: { he: 'שיבינו מה עשית בפועל, לא רק מה הייתה הכותרת.', en: 'So people see what you actually did, not just the title.' },
    },
  },
  skills: {
    missing: {
      title: { he: 'כישורים', en: 'Skills' },
      why: { he: 'מגייסות מחפשות לפי כישורים - כך הן מוצאות אותך.', en: 'Recruiters search by skills - that is how they find you.' },
    },
    partial: {
      title: { he: 'עוד כמה כישורים (6+)', en: 'A few more skills (6+)' },
      why: { he: 'כל כישור הוא עוד מילת חיפוש שמובילה אלייך.', en: 'Every skill is another search term that leads to you.' },
    },
  },
  photo: {
    missing: {
      title: { he: 'תמונת פרופיל', en: 'Profile photo' },
      why: { he: '88% מהמגייסים מדלגים על פרופיל בלי תמונה. באישור הרב גואלמן שליט"א, ורק מי שבחרת רואה אותה.', en: '88% of recruiters skip profiles without a photo. Approved by HaRav Goelman shlit"a, and only those you choose see it.' },
    },
  },
  about: {
    missing: {
      title: { he: 'כמה מילים עלייך', en: 'A few words about you' },
      why: { he: 'זה מה שגורם לעמיתה או למגייסת לפנות דווקא אלייך.', en: 'This is what makes a colleague or recruiter reach out to you.' },
    },
    partial: {
      title: { he: 'עוד כמה משפטים באודות', en: 'A few more sentences in your About' },
      why: { he: 'כמה משפטים כנים עלייך עושים את ההבדל.', en: 'A few honest sentences about you make the difference.' },
    },
  },
  headline: {
    missing: {
      title: { he: 'כותרת מקצועית', en: 'Professional headline' },
      why: { he: 'מופיעה מתחת לשמך בכל מקום, ולרוב זה הדבר היחיד שקוראים.', en: "It shows under your name everywhere, and it's often all people read." },
    },
  },
  education: {
    missing: {
      title: { he: 'השכלה והכשרה', en: 'Education and training' },
      why: { he: 'גם בוטקמפ או קורס מקצועי נחשבים.', en: 'Bootcamps and professional courses count too.' },
    },
  },
  certifications: {
    missing: {
      title: { he: 'תעודות והסמכות', en: 'Certifications' },
      why: { he: 'מראות שאת מתעדכנת בתחום.', en: 'They show you keep up with your field.' },
    },
  },
  location: {
    missing: {
      title: { he: 'מיקום', en: 'Location' },
      why: { he: 'חלק מהמגייסות מסננות לפי מיקום.', en: 'Some recruiters filter by location.' },
    },
  },
}

export interface Tip { key: TipKey; partial: boolean; points: number }
export interface ProfileTipsContent { pct: number; tips: Tip[] }

/** The missing parts that would raise her profile the most (connections aren't edited on the profile). */
export function pickTips(items: Array<{ key: string; score: number; weight: number }>): Tip[] {
  return items
    .filter((i) => i.key in TIPS && i.score < 1)
    .map((i) => ({ key: i.key as TipKey, partial: i.score > 0 && !!TIPS[i.key as TipKey].partial, points: Math.round(i.weight * (1 - i.score) * 100) }))
    .filter((t) => t.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_TIPS)
}

// The point of it all, before any tip (2026-11-12): her quality and visibility in front of recruiters
// AND colleagues — backed by recent published research (named in the small source line):
//   * InterviewPal data study (Aug 2025, 4,289 reviews by 312 recruiters / hiring managers): the first
//     scan of a candidate averages 11.2 seconds.
//   * MyPerfectResume "Networking Nation" (Aug 2025, nationally representative US survey): 54% of workers
//     got their current job through a personal or professional connection.
// (Not used: "70–80% of jobs are filled through connections" — widely quoted, no solid source found.)
const WHY: Bi = {
  he: 'מגייסים מחליטים אם להמשיך לקרוא תוך 11 שניות בממוצע. ו-54% מהעובדים הגיעו לעבודה הנוכחית שלהם דרך היכרות אישית או מקצועית - בדיוק הקשרים שאת בונה כאן, בדואולין.',
  en: 'Recruiters decide whether to keep reading within 11 seconds on average. And 54% of workers got their current job through a personal or professional connection - exactly the connections you build here, on duallin.',
}
/** The slogan — its own framed line under the research, across both columns. */
const SLOGAN: Bi = { he: 'הכול מתחיל בפרופיל שלך', en: 'It all starts with your profile' }
const SOURCES = 'InterviewPal 2025 · MyPerfectResume 2025'

const STAGE = {
  1: {
    heading: (n: string, k: number): Bi => ({ he: n ? `${n}, ${k} דברים קטנים לפרופיל חזק יותר` : `${k} דברים קטנים לפרופיל חזק יותר`, en: n ? `${n}, ${k} small things for a stronger profile` : `${k} small things for a stronger profile` }),
    lead: (pct: number): Bi => ({ he: `הפרופיל שלך מלא ב-${pct}%. אלה יקפיצו אותו הכי הרבה:`, en: `Your profile is ${pct}% complete. These will lift it the most:` }),
  },
  2: {
    heading: (n: string): Bi => ({ he: n ? `${n}, כמה דקות לפרופיל חזק יותר` : 'כמה דקות לפרופיל חזק יותר', en: n ? `${n}, a few minutes to a stronger profile` : 'A few minutes to a stronger profile' }),
    lead: (pct: number): Bi => ({ he: `הפרופיל שלך מלא ב-${pct}%. אפשר להתחיל מאחד מאלה:`, en: `Your profile is ${pct}% complete. You can start with one of these:` }),
  },
  3: {
    heading: (n: string): Bi => ({ he: n ? `${n}, עוד צעד קטן` : 'עוד צעד קטן', en: n ? `${n}, one more small step` : 'One more small step' }),
    lead: (pct: number): Bi => ({ he: `הפרופיל שלך מלא ב-${pct}%. נשאר רק:`, en: `Your profile is ${pct}% complete. All that's left:` }),
  },
} as const
export type Stage = keyof typeof STAGE

export function profileTipsSubject(stage: Stage, firstName: string, c: ProfileTipsContent): string {
  const n = firstName.trim()
  if (stage === 1) return n
    ? `${n}, ${c.tips.length} דברים קטנים לפרופיל חזק יותר | ${c.tips.length} small things for a stronger profile`
    : `${c.tips.length} דברים קטנים לפרופיל חזק יותר | ${c.tips.length} small things for a stronger profile`
  if (stage === 2) return `הפרופיל שלך מלא ב-${c.pct}% | Your profile is ${c.pct}% complete`
  const after = c.pct + c.tips.reduce((s, t) => s + t.points, 0)
  return after >= TARGET_PCT
    ? `עוד ${TARGET_PCT - c.pct}% לפרופיל מבוסס | ${TARGET_PCT - c.pct}% more to a strong profile`
    : `עוד צעד קטן לפרופיל חזק יותר | One more small step to a stronger profile`
}

/** Progress bar. */
function bar(pct: number): string {
  const p = Math.max(0, Math.min(100, pct))
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 4px;"><tr><td dir="rtl">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LINE};border-radius:999px;"><tr>
        <td width="${p}%" style="height:8px;line-height:8px;font-size:0;background:${BRAND};border-radius:999px;">&nbsp;</td>
        <td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td>
      </tr></table>
    </td></tr>
  </table>`
}

function tipRow(t: Tip, i: number): string {
  const c = (t.partial ? TIPS[t.key].partial : undefined) ?? TIPS[t.key].missing
  const pill = `<span style="font-family:${FONT};font-size:12px;font-weight:700;color:${BRAND};white-space:nowrap;" dir="ltr">+${t.points}%</span>`
  const line = (title: string, why: string, size: string) =>
    `<div style="font-family:${FONT};font-size:${size};line-height:1.5;color:${INK_2};"><b style="color:${INK};">${title}</b> ${pill}<br>${why}</div>`
  return `<tr><td style="padding:10px 0;${i ? `border-top:1px solid ${LINE};` : ''}">${biColumns({
    he: line(c.title.he, c.why.he, '14px'),
    en: line(c.title.en, c.why.en, '13px'),
  }, { tight: true })}</td></tr>`
}

export function renderProfileTips(stage: Stage, firstName: string, c: ProfileTipsContent, unsubscribeUrl: string | null): string {
  const s = STAGE[stage]
  // dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
  const n = firstName.trim() ? `<span dir="auto">${esc(firstName.trim())}</span>` : ''
  const h = s.heading(n, c.tips.length)
  const lead = s.lead(c.pct)
  const source = `<div style="font-family:${FONT};font-size:11px;color:${INK_3};margin:-6px 0 10px;" dir="ltr">${SOURCES}</div>`
  const body =
    biColumns({
      he: heading(h.he) + paragraph(WHY.he) + source,
      en: heading(h.en) + paragraph(WHY.en) + source,
    }) +
    // the slogan stands apart, so the eye lands on it and reads back up to the research
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 14px;"><tr>
      <td align="center" style="padding:14px 16px;background:${SOFT};border-top:2px solid ${BRAND};border-bottom:2px solid ${BRAND};">
        <div style="font-family:${FONT};font-size:21px;font-weight:800;color:${BRAND};line-height:1.3;white-space:nowrap;" dir="rtl">${SLOGAN.he}</div>
        <div style="font-family:${FONT};font-size:13px;font-weight:600;color:${INK_3};margin-top:2px;white-space:nowrap;" dir="ltr">${SLOGAN.en}</div>
      </td></tr></table>` +
    biColumns({ he: paragraph(`<b>${lead.he}</b>`), en: paragraph(`<b>${lead.en}</b>`) }, { tight: true }) +
    bar(c.pct) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 0;background:${SOFT};border:1px solid ${LINE};border-radius:12px;"><tr><td style="padding:4px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${c.tips.map(tipRow).join('')}</table>
    </td></tr></table>` +
    button({ he: 'להשלמת הפרופיל', en: 'Complete your profile' }, `${APP_URL()}/profile`)
  return renderLayout({
    preheader: { he: 'כמה דקות, ופרופיל שמוצאים', en: 'A few minutes, and a profile people find' },
    body,
    reason: { he: 'קיבלת את המייל הזה כי את חברה בדואולין.', en: "You received this email because you're a duallin member." },
    unsubscribeUrl,
  })
}

/** Which email (if any) is due, given when each one went out (ms). */
export function dueProfileTips(sent: { 1?: number; 2?: number; 3?: number }, now = Date.now()): Stage | null {
  if (sent[3]) return null
  if (sent[2]) return now - sent[2] >= GAP_DAYS[3] * DAY ? 3 : null
  if (sent[1]) return now - sent[1] >= GAP_DAYS[2] * DAY ? 2 : null
  return 1
}

/** PostgREST returns at most 1000 rows per request — page through. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

/** Israel-time hour. */
const israelHour = (now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(now))

/** Runs a few times a day: send each member the profile-tips email that is due, up to `budget` sends. */
export async function profileTipsJob(budget: number, now = new Date()): Promise<{ sent: number; attempts: number }> {
  const hour = israelHour(now)
  if (budget <= 0 || hour < 10 || hour >= 20) return { sent: 0, attempts: 0 } // daytime only
  const db = adminClient()
  const t = now.getTime()
  const joinedBefore = new Date(t - AFTER_JOINING_DAYS * DAY).toISOString()

  // The cached strength only narrows the list; each email recomputes it before sending.
  const candidates = await fetchAll<{ uuid: string; email: string | null; first_name: string | null; activated_at: string | null; created_at: string }>((f, to) =>
    db.from('users').select('uuid, email, first_name, activated_at, created_at')
      .eq('status', 'Active').eq('role', 'community').not('is_anonymous', 'is', true)
      .lt('profile_strength_cache', TARGET_PCT).lte('created_at', joinedBefore)
      .order('uuid').range(f, to))
  const joined = candidates.filter((m) => m.email && (m.activated_at ?? m.created_at) <= joinedBefore)
  if (!joined.length) return { sent: 0, attempts: 0 }
  const ids = joined.map((m) => m.uuid)

  const [active, logs, freqs, capped] = await Promise.all([
    lastActive(ids),
    inChunks<{ user_id: string; kind: string; created_at: string }>(ids, (c) => db.from('email_log').select('user_id, kind, created_at')
      .in('kind', ['profile_tips_1', 'profile_tips_2', 'profile_tips_3']).in('status', SENT).in('user_id', c)),
    getFrequencies(ids, 'onboarding'),
    cappedNow(ids),
  ])
  const history = new Map<string, { 1?: number; 2?: number; 3?: number }>()
  for (const l of logs) {
    const h = history.get(l.user_id) ?? {}
    const stage = Number(l.kind.slice(-1)) as Stage
    h[stage] = Math.max(h[stage] ?? 0, Date.parse(l.created_at))
    history.set(l.user_id, h)
  }
  const activeSince = t - ACTIVE_WITHIN_DAYS * DAY
  const due = joined
    .filter((m) => (active.get(m.uuid) ?? 0) > activeSince && freqs.get(m.uuid) !== 'off' && !capped.has(m.uuid))
    .map((m) => ({ m, stage: dueProfileTips(history.get(m.uuid) ?? {}, t) }))
    .filter((x): x is { m: typeof joined[number]; stage: Stage } => x.stage !== null)
    .sort((a, b) => (active.get(b.m.uuid) ?? 0) - (active.get(a.m.uuid) ?? 0)) // most recently active first

  let attempts = 0
  let sent = 0
  for (const { m, stage } of due) {
    if (attempts >= budget || outOfTime()) break
    const strength = await calculateProfileStrength(db, m.uuid).catch(() => null)
    if (!strength || strength.percentage >= TARGET_PCT) continue // done since the cache was written
    const tips = pickTips(strength.items)
    if (!tips.length) continue
    const content: ProfileTipsContent = { pct: strength.percentage, tips }
    const name = (m.first_name ?? '').trim()
    attempts++
    const r = await sendEmail({
      kind: `profile_tips_${stage}`,
      category: 'onboarding',
      to: m.email!,
      userId: m.uuid,
      refKey: `stage:${stage}`,
      subject: profileTipsSubject(stage, name, content),
      html: ({ unsubscribeUrl }) => renderProfileTips(stage, name, content, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts-- // held by the per-member cap — doesn't use the hour's budget
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// B1–B3 · Reminders to finish signing up — for a member still in status 'onboarding'.
// Time-based (the system initiates them), so they respect the send window (hours / Shabbat).
// Cadence decided with the product owner (2026-11-04): day 1, 3, 7, and a last one at day 30, then stop.
//   * Each member gets only the reminder that fits how long ago she signed up — someone who
//     signed up months ago gets ONE email (the last reminder), never the ones she "missed".
//   * At least 2 days between two reminders to the same person.
//   * No reminders for sign-ups older than 6 months (stale addresses hurt sender reputation).
//   * At most 60 per hourly run, so the backlog at launch (~300) goes out over a few hours.
// Stops by itself: finishing onboarding changes her status, and the job only looks at 'onboarding'.
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const HOUR = 3600 * 1000
const MAX_AGE_DAYS = 180
const MIN_GAP_HOURS = 48
const PER_RUN = 60

interface Stage {
  n: 1 | 2 | 3 | 4
  afterHours: number
  subject: Bi
  heading: (name: Bi) => Bi
  text: Bi
  preheader: Bi
  /** Show live community numbers — shows she'd be joining something alive and growing. */
  stats?: boolean
  /** Small line after the button. */
  footnote?: Bi
}

// Stage copy. Lines from the site where it has them (onboarding.welcome.bannerHighlight / bannerBody).
const STAGES: Stage[] = [
  {
    n: 1, afterHours: 24,
    subject: { he: 'נשארו רק כמה צעדים', en: 'Just a few steps left' },
    heading: (nm) => ({ he: nm.he ? `${nm.he}, נשארו רק כמה צעדים` : 'נשארו רק כמה צעדים', en: nm.en ? `${nm.en}, just a few steps left` : 'Just a few steps left' }),
    text: { he: 'כמה רגעים להתחיל - ועולם שלם של קשרים.', en: 'A few moments to set up - a lifetime of connections.' },
    preheader: { he: 'ההרשמה שלך לדואולין מחכה לך', en: 'Your duallin sign-up is waiting for you' },
  },
  {
    n: 2, afterHours: 72,
    subject: { he: 'הפרופיל שלך כמעט מוכן', en: 'Your profile is almost ready' },
    heading: () => ({ he: 'הפרופיל שלך כמעט מוכן', en: 'Your profile is almost ready' }),
    text: { he: 'פרופיל מלא מציב אותך על המפה: האנשים הנכונים, המשרות הנכונות, וקהילה שבאמת מבינה אותך.', en: 'A complete profile puts you on the map: the right people, the right jobs, and a community that truly gets you.' },
    preheader: { he: 'עוד כמה דקות ואת בפנים', en: "A few more minutes and you're in" },
  },
  {
    n: 3, afterHours: 7 * 24,
    subject: { he: 'הקהילה מחכה לך', en: 'The community is waiting for you' },
    heading: () => ({ he: 'הקהילה מחכה לך', en: 'The community is waiting for you' }),
    text: { he: 'נשות מקצוע חרדיות כבר משתפות, מתחברות ומוצאות הזדמנויות. חסרים רק כמה פרטים כדי שתצטרפי אליהן.', en: 'Orthodox women in tech are already sharing, connecting and finding opportunities. Only a few details are missing for you to join them.' },
    preheader: { he: 'כמה פרטים ואת חלק מהקהילה', en: "A few details and you're part of the community" },
    stats: true,
  },
  {
    // Also the one email for members stuck for months: she may not remember us, so it says
    // what duallin is, what's waiting, and that she can simply reply for help.
    n: 4, afterHours: 30 * 24,
    subject: { he: 'שמרנו לך מקום בדואולין', en: "We've saved your place at duallin" },
    heading: () => ({ he: 'התחלת להצטרף לדואולין - ושמרנו לך את המקום', en: 'You started joining duallin - we saved your place' }),
    text: {
      he: 'לפני זמן מה התחלת להירשם לדואולין, הרשת המקצועית של נשות הייטק חרדיות, ולא הספקת לסיים. מאז המערכת התפתחה מאוד, ונשמח מאוד שתתני לנו הזדמנות נוספת.',
      en: "A while ago you started signing up for duallin, the professional network for Orthodox women in tech, but didn't get to finish. The platform has grown a lot since then, and we'd love for you to give us another try.",
    },
    preheader: { he: 'המערכת התפתחה מאוד מאז - נשמח שתנסי שוב', en: "We've grown a lot since - we'd love for you to try again" },
    stats: true,
    footnote: { he: 'זו התזכורת האחרונה שנשלח בנושא.', en: "This is the last reminder we'll send about it." },
  },
]

const kindOf = (n: number) => `onboarding_reminder_${n}`

const BRAND = '#4b154c'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
// Same rule as the jobs page (routes/jobs.ts VISIBLE_JOBS_FILTER).
const VISIBLE_JOBS_FILTER = 'company_id.not.is.null,apply_link.is.null,apply_link.not.ilike.%linkedin.com%'

export interface CommunityStats { activityLast30d: number; jobs: number; articles: number }

/**
 * Live numbers, read once per run. Members are NOT shown as a number (product decision,
 * 2026-11-04) — the email says "thousands of members" instead.
 * Open jobs, not "new this month": imports rewrite created_at.
 * Activity = feed posts + comments + likes in the last 30 days (same filters as the activity score).
 */
export async function communityStats(): Promise<CommunityStats | null> {
  const db = adminClient()
  const since = new Date(Date.now() - 30 * 24 * HOUR).toISOString()
  const [p, cm, lk, j, a] = await Promise.all([
    db.from('posts').select('id', { count: 'exact', head: true }).not('post_type', 'is', null).neq('post_type', 'email').gte('sent_at', since),
    db.from('comments').select('id, posts!inner(post_type)', { count: 'exact', head: true }).not('posts.post_type', 'is', null).neq('posts.post_type', 'email').gte('created_at', since),
    db.from('likes').select('id', { count: 'exact', head: true }).gte('created_at', since),
    db.from('open_position').select('id', { count: 'exact', head: true }).not('job_description_html', 'is', null).or(VISIBLE_JOBS_FILTER),
    db.from('articles').select('id', { count: 'exact', head: true }).eq('status', 'published').is('deleted_at', null),
  ])
  if (p.error || cm.error || lk.error || j.error || a.error) return null
  return { activityLast30d: (p.count ?? 0) + (cm.count ?? 0) + (lk.count ?? 0), jobs: j.count ?? 0, articles: a.count ?? 0 }
}

/** Rounded down with "+" (2,779 → 2,700+, 533 → 500+, 73 → 70+): reads cleanly, always true. */
export function roundDownPlus(n: number): string {
  const step = n >= 1000 ? 100 : n >= 100 ? 50 : n >= 20 ? 10 : 0
  if (!step) return n.toLocaleString('en-US')
  const r = Math.floor(n / step) * step
  return r === n ? r.toLocaleString('en-US') : `${r.toLocaleString('en-US')}+`
}

function statsRow(st: CommunityStats): string {
  // [number, label, relative width] — the activity tile has the longest label, so it gets more room
  const tiles: Array<[number, Bi, number]> = ([
    [st.activityLast30d, { he: 'פוסטים, תגובות ולייקים החודש', en: 'posts, comments & likes this month' }, 1.5],
    [st.jobs, { he: 'משרות פתוחות', en: 'open jobs' }, 1],
    [st.articles, { he: 'מאמרים', en: 'articles' }, 1],
  ] as Array<[number, Bi, number]>).filter(([n]) => n > 0)
  if (!tiles.length) return ''
  const intro = biColumns({
    he: paragraph('<b>אלפי חברות כבר בקהילה.</b> הנה מה שמחכה לך שם:'),
    en: paragraph("<b>Thousands of members are already in.</b> Here's what's waiting for you:"),
  }, { tight: true })
  const totalWeight = tiles.reduce((sum, [, , wt]) => sum + wt, 0)
  return `<div style="height:14px"></div>${intro}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="margin:8px 0 6px;background:#faf5fb;border:1px solid ${LINE};border-radius:10px;"><tr>${
    tiles.map(([n, l, wt], i) => `<td width="${Math.floor((100 * wt) / totalWeight)}%" align="center" valign="top" style="padding:14px 6px;${i ? `border-right:1px solid ${LINE};` : ''}">
      <div style="font-family:${FONT};font-size:22px;font-weight:800;color:${BRAND};line-height:1.2;" dir="ltr">${roundDownPlus(n)}</div>
      <div style="font-family:${FONT};font-size:12.5px;color:#4a4a50;margin-top:2px;" dir="rtl">${l.he}</div>
      <div style="font-family:${FONT};font-size:11.5px;color:#86838b;" dir="ltr">${l.en}</div>
    </td>`).join('')
  }</tr></table>`
}

export function renderOnboardingReminder(stage: Stage, firstName: string, unsubscribeUrl: string | null, stats: CommunityStats | null = null): string {
  // dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
  const nm = firstName.trim() ? `<span dir="auto">${esc(firstName.trim())}</span>` : ''
  const h = stage.heading({ he: nm, en: nm })
  const body =
    biColumns({ he: heading(h.he) + paragraph(stage.text.he), en: heading(h.en) + paragraph(stage.text.en) }) +
    (stage.stats && stats ? statsRow(stats) : '') +
    button({ he: 'להשלמת ההרשמה', en: 'Finish signing up' }, `${APP_URL()}/onboarding`) +
    // Replies go to contact@ (EMAIL_REPLY_TO), so "just reply" really reaches the team.
    `<div style="height:14px"></div>` +
    biColumns({
      he: paragraph('נתקלת בבעיה בהרשמה, או שמשהו לא היה ברור? פשוט השיבי למייל הזה ונעזור לך.') + (stage.footnote ? paragraph(stage.footnote.he) : ''),
      en: paragraph("Ran into a problem signing up, or something wasn't clear? Just reply to this email and we'll help.") + (stage.footnote ? paragraph(stage.footnote.en) : ''),
    }, { tight: true })
  return renderLayout({
    preheader: stage.preheader,
    body,
    reason: { he: 'קיבלת את המייל הזה כי נרשמת לדואולין.', en: 'You received this email because you signed up for duallin.' },
    unsubscribeUrl,
    // Settings need a finished sign-up (the site sends her back to /onboarding); the stop link works without logging in.
    hideSettingsLink: true,
  })
}

/** The reminder that fits her sign-up age now, or null. */
export function dueStage(signedUpAt: Date, now = new Date()): Stage | null {
  const ageH = (now.getTime() - signedUpAt.getTime()) / HOUR
  if (ageH > MAX_AGE_DAYS * 24) return null
  return [...STAGES].reverse().find((s) => ageH >= s.afterHours) ?? null
}

/** Hourly: send each member still in onboarding the one reminder that is due for her. */
export async function onboardingRemindersJob(now = new Date()): Promise<number> {
  const db = adminClient()
  const oldest = new Date(now.getTime() - MAX_AGE_DAYS * 24 * HOUR).toISOString()
  const youngest = new Date(now.getTime() - STAGES[0].afterHours * HOUR).toISOString()

  const { data: users, error } = await db.from('users')
    .select('uuid, email, first_name, created_at')
    .eq('status', 'onboarding').not('email', 'is', null)
    .gte('created_at', oldest).lte('created_at', youngest)
    .order('created_at', { ascending: false }) // newest sign-ups first: most likely to come back
    .limit(2000)
  if (error) throw new Error(error.message)
  if (!users?.length) return 0

  // What each one already got (sent, or skipped because she turned it off — don't retry those).
  const { data: logs } = await db.from('email_log')
    .select('user_id, kind, created_at')
    .in('kind', STAGES.map((s) => kindOf(s.n)))
    .gte('created_at', oldest)
    .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const history = new Map<string, { maxStage: number; lastAt: number }>()
  for (const l of logs ?? []) {
    if (!l.user_id) continue
    const n = Number(String(l.kind).split('_').pop())
    const at = new Date(l.created_at).getTime()
    const h = history.get(l.user_id) ?? { maxStage: 0, lastAt: 0 }
    history.set(l.user_id, { maxStage: Math.max(h.maxStage, n), lastAt: Math.max(h.lastAt, at) })
  }

  const stats = await communityStats()
  let attempts = 0
  let sent = 0
  for (const u of users) {
    if (attempts >= PER_RUN) break
    const stage = dueStage(new Date(u.created_at), now)
    if (!stage) continue
    const h = history.get(u.uuid)
    if (h && h.maxStage >= stage.n) continue
    if (h && now.getTime() - h.lastAt < MIN_GAP_HOURS * HOUR) continue

    attempts++
    const name = (u.first_name ?? '').trim()
    const r = await sendEmail({
      kind: kindOf(stage.n),
      category: 'onboarding',
      to: u.email,
      userId: u.uuid,
      refKey: 'signup',
      subject: `${stage.subject.he} | ${stage.subject.en}`,
      html: ({ unsubscribeUrl }) => renderOnboardingReminder(stage, name, unsubscribeUrl, stats),
    })
    if (r.status === 'sent') sent++
  }
  return sent
}

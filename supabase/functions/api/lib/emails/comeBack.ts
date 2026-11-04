// G2 · "Come back" — for an Active member who hasn't been active for a while (user_activity.last_active_at).
// Time-based (the system initiates it), so it respects the send window (hours / Shabbat).
//   * Email 1 after 21 days without activity; email 2 (the last) after 45 days, and at least
//     24 days after email 1.
//   * After email 2: a monthly "this month on duallin" email (fresh numbers + new articles),
//     every 30 days; after 6 more months without coming back, every 90 days (decided 2026-11-04 —
//     persistence like LinkedIn, but always with fresh content; the slower pace protects Gmail reputation).
//   * A quiet period is keyed by her last_active_at: if she comes back and later goes quiet again,
//     a new period starts with email 1.
//   * Members asleep since before tracking began (no user_activity row) count from sign-up.
//   * Personal lines first (requests / unread messages / notifications — counts only, never content),
//     then the live community numbers shared with the sign-up reminders.
// Its own category ('come_back') so a member can turn just this off.
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { communityStats, statsRow, type CommunityStats } from './onboardingReminders.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
const FIRST_AFTER_DAYS = 21
const SECOND_AFTER_DAYS = 45
const MIN_GAP_DAYS = 24
const MONTHLY_GAP_DAYS = 30
const QUARTERLY_GAP_DAYS = 90
/** Quiet this long (45 + ~6 months) → monthly becomes quarterly. */
const QUARTERLY_AFTER_DAYS = SECOND_AFTER_DAYS + 180
const BRAND = '#4b154c'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

export interface Waiting { requests: number; messages: number; notifications: number }

const STAGE = {
  1: {
    subject: { he: 'זה מה שחיכה לך בדואולין', en: "Here's what's waiting for you on duallin" },
    preheader: { he: 'מזמן לא ראינו אותך - הקהילה ממשיכה לצמוח', en: "We haven't seen you in a while - the community keeps growing" },
    heading: (nm: string): Bi => ({ he: nm ? `${nm}, מזמן לא ראינו אותך` : 'מזמן לא ראינו אותך', en: nm ? `${nm}, we haven't seen you in a while` : "We haven't seen you in a while" }),
    footnote: null as Bi | null,
  },
  2: {
    subject: { he: 'הקהילה שלך עדיין כאן', en: 'Your community is still here' },
    preheader: { he: 'כמה דברים עדיין מחכים לך', en: 'A few things are still waiting for you' },
    heading: (nm: string): Bi => ({ he: nm ? `${nm}, הקהילה שלך עדיין כאן` : 'הקהילה שלך עדיין כאן', en: nm ? `${nm}, your community is still here` : 'Your community is still here' }),
    // No "we won't email you again": a monthly community email follows (planned, 2026-11-04).
    footnote: { he: 'כשתרצי לחזור, אנחנו כאן.', en: "Whenever you want to come back, we're here." } as Bi | null,
  },
  monthly: {
    subject: { he: 'החודש בדואולין', en: 'This month on duallin' },
    preheader: { he: 'מה חדש בקהילה החודש', en: "What's new in the community this month" },
    heading: (nm: string): Bi => ({ he: nm ? `${nm}, הנה מה שקרה החודש בדואולין` : 'הנה מה שקרה החודש בדואולין', en: nm ? `${nm}, here's what happened on duallin this month` : "Here's what happened on duallin this month" }),
    footnote: null as Bi | null,
  },
} as const
type Stage = keyof typeof STAGE

export interface NewArticle { id: string | number; title: string }

function articlesList(list: NewArticle[]): string {
  if (!list.length) return ''
  const items = list.map((a) => `<tr><td style="padding:8px 0;border-top:1px solid ${LINE};" dir="auto">
      <a href="${APP_URL()}/articles/article/${encodeURIComponent(String(a.id))}" style="font-family:${FONT};font-size:14px;font-weight:600;color:${BRAND};text-decoration:none;">${esc(a.title)}</a>
    </td></tr>`).join('')
  return `<div style="height:10px"></div>${biColumns({ he: paragraph('<b>מאמרים חדשים מהקהילה:</b>'), en: paragraph('<b>New articles from the community:</b>') }, { tight: true })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 6px;">${items}</table>`
}

function waitingRows(w: Waiting): string {
  const rows: Array<[number, Bi]> = ([
    [w.requests, { he: w.requests === 1 ? 'בקשת חיבור אחת מחכה לך' : `${w.requests} בקשות חיבור מחכות לך`, en: w.requests === 1 ? '1 connection request is waiting' : `${w.requests} connection requests are waiting` }],
    [w.messages, { he: w.messages === 1 ? 'הודעה אחת שלא קראת' : `${w.messages} הודעות שלא קראת`, en: w.messages === 1 ? '1 unread message' : `${w.messages} unread messages` }],
    [w.notifications, { he: w.notifications === 1 ? 'התראה אחת חדשה' : `${w.notifications} התראות חדשות`, en: w.notifications === 1 ? '1 new notification' : `${w.notifications} new notifications` }],
  ] as Array<[number, Bi]>).filter(([n]) => n > 0)
  if (!rows.length) return ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 4px;">${rows.map(([n, l]) =>
    `<tr><td style="padding:8px 0;border-top:1px solid ${LINE};">${biColumns({
      he: `<span style="font-family:${FONT};font-size:14px;color:#1d1d1f;"><b style="color:${BRAND};">●</b>&nbsp; ${l.he}</span>`,
      en: `<span style="font-family:${FONT};font-size:14px;color:#1d1d1f;"><b style="color:${BRAND};">●</b>&nbsp; ${l.en}</span>`,
    }, { tight: true })}</td></tr>`).join('')}</table>`
}

export function renderComeBack(stage: Stage, firstName: string, waiting: Waiting, stats: CommunityStats | null, unsubscribeUrl: string | null, articles: NewArticle[] = []): string {
  const s = STAGE[stage]
  // dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
  const nm = firstName.trim() ? `<span dir="auto">${esc(firstName.trim())}</span>` : ''
  const h = s.heading(nm)
  const personal = waitingRows(waiting)
  const lead: Bi = stage === 'monthly'
    ? (personal
      ? { he: 'כמה דברים מחכים לך, וזה מה שקרה בקהילה:', en: "A few things are waiting for you, and here's what happened in the community:" }
      : { he: 'זה מה שקרה בקהילה בחודש האחרון:', en: "Here's what happened in the community this past month:" })
    : personal
      ? { he: 'בזמן שלא היית, כמה דברים חיכו לך:', en: 'While you were away, a few things were waiting for you:' }
      : { he: 'בזמן שלא היית, הקהילה המשיכה לצמוח.', en: 'While you were away, the community kept growing.' }
  const body =
    biColumns({ he: heading(h.he) + paragraph(lead.he), en: heading(h.en) + paragraph(lead.en) }) +
    personal +
    (stats ? statsRow(stats, { intro: false }) : '') +
    (stage === 'monthly' ? articlesList(articles) : '') +
    button({ he: 'לחזור לדואולין', en: 'Back to duallin' }, `${APP_URL()}/`) +
    (s.footnote ? `<div style="height:14px"></div>${biColumns({ he: paragraph(s.footnote.he), en: paragraph(s.footnote.en) }, { tight: true })}` : '')
  return renderLayout({
    preheader: s.preheader,
    body,
    reason: { he: 'קיבלת את המייל הזה כי את חברה בדואולין.', en: "You received this email because you're a duallin member." },
    unsubscribeUrl,
  })
}

export interface ComeBackSent { first?: number; second?: number; lastMonthly?: number }

/** Which email (if any) is due in this quiet period, given when each one went out (ms). */
export function dueComeBack(quietSince: Date, sent: ComeBackSent, now = new Date()): Stage | null {
  const quietDays = (now.getTime() - quietSince.getTime()) / DAY
  if (sent.second) {
    const last = Math.max(sent.second, sent.lastMonthly ?? 0)
    const gap = quietDays >= QUARTERLY_AFTER_DAYS ? QUARTERLY_GAP_DAYS : MONTHLY_GAP_DAYS
    return now.getTime() - last >= gap * DAY ? 'monthly' : null
  }
  if (sent.first) {
    return quietDays >= SECOND_AFTER_DAYS && now.getTime() - sent.first >= MIN_GAP_DAYS * DAY ? 2 : null
  }
  return quietDays >= FIRST_AFTER_DAYS ? 1 : null
}

/** Up to 3 articles published in the last 30 days, newest first (read once per run). */
async function newArticles(now: Date): Promise<NewArticle[]> {
  const { data } = await adminClient().from('articles').select('id, title')
    .eq('status', 'published').is('deleted_at', null)
    .gte('published_at', new Date(now.getTime() - 30 * DAY).toISOString())
    .order('published_at', { ascending: false }).limit(3)
  return (data ?? []).filter((a) => a.title) as NewArticle[]
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

async function waitingFor(userId: string): Promise<Waiting> {
  const db = adminClient()
  const [req, convs, notif] = await Promise.all([
    db.from('connections').select('id', { count: 'exact', head: true }).eq('receiver_id', userId).eq('status', 'pending'),
    db.from('conversations').select('id').or(`user1_id.eq.${userId},user2_id.eq.${userId}`).limit(500),
    db.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false),
  ])
  let messages = 0
  const ids = (convs.data ?? []).map((c) => c.id)
  if (ids.length) {
    const { count } = await db.from('messages').select('id', { count: 'exact', head: true })
      .in('conversation_id', ids.slice(0, 200)).eq('is_read', false).neq('sender_id', userId)
    messages = count ?? 0
  }
  return { requests: req.count ?? 0, messages, notifications: notif.count ?? 0 }
}

/** Hourly: send each quiet member the come-back email that is due, up to `budget` sends. */
export async function comeBackJob(budget: number, now = new Date()): Promise<{ sent: number; attempts: number }> {
  if (budget <= 0) return { sent: 0, attempts: 0 }
  const db = adminClient()
  const cutoff = new Date(now.getTime() - FIRST_AFTER_DAYS * DAY).toISOString()

  const [members, activity] = await Promise.all([
    fetchAll<{ uuid: string; email: string | null; first_name: string | null; created_at: string }>((f, t) =>
      db.from('users').select('uuid, email, first_name, created_at').eq('status', 'Active').lte('created_at', cutoff).order('uuid').range(f, t)),
    fetchAll<{ user_id: string; last_active_at: string | null }>((f, t) =>
      db.from('user_activity').select('user_id, last_active_at').order('user_id').range(f, t)),
  ])
  const lastActive = new Map(activity.map((a) => [a.user_id, a.last_active_at]))

  // Quiet members, most recently active first (the likeliest to come back).
  const quiet = members
    .filter((m) => m.email)
    .map((m) => {
      const la = lastActive.get(m.uuid)
      return { ...m, quietSince: new Date(la ?? m.created_at), period: la ? `quiet:${la.slice(0, 10)}` : 'quiet:never' }
    })
    .filter((m) => m.quietSince.toISOString() <= cutoff)
    .sort((a, b) => b.quietSince.getTime() - a.quietSince.getTime())
  if (!quiet.length) return { sent: 0, attempts: 0 }

  // What each got in its current quiet period (skipped counts too: she turned it off, don't retry).
  const logs = await fetchAll<{ user_id: string; kind: string; ref_key: string; created_at: string }>((f, t) =>
    db.from('email_log').select('user_id, kind, ref_key, created_at')
      .in('kind', ['come_back_1', 'come_back_2', 'come_back_monthly'])
      .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
      .order('id').range(f, t))
  const history = new Map<string, ComeBackSent>()
  for (const l of logs) {
    // monthly ref_key = "<period>|<YYYY-MM>"; the others = "<period>"
    const key = `${l.user_id}|${String(l.ref_key).split('|')[0]}`
    const h = history.get(key) ?? {}
    const at = new Date(l.created_at).getTime()
    if (l.kind === 'come_back_1') h.first = at
    if (l.kind === 'come_back_2') h.second = at
    if (l.kind === 'come_back_monthly') h.lastMonthly = Math.max(h.lastMonthly ?? 0, at)
    history.set(key, h)
  }

  const stats = await communityStats()
  const articles = await newArticles(now)
  let attempts = 0
  let sent = 0
  for (const m of quiet) {
    if (attempts >= budget) break
    const stage = dueComeBack(m.quietSince, history.get(`${m.uuid}|${m.period}`) ?? {}, now)
    if (!stage) continue
    attempts++
    const waiting = await waitingFor(m.uuid).catch(() => ({ requests: 0, messages: 0, notifications: 0 }))
    const name = (m.first_name ?? '').trim()
    const s = STAGE[stage]
    const r = await sendEmail({
      kind: `come_back_${stage}`,
      category: 'come_back',
      to: m.email!,
      userId: m.uuid,
      refKey: stage === 'monthly' ? `${m.period}|${now.toISOString().slice(0, 7)}` : m.period,
      subject: `${s.subject.he} | ${s.subject.en}`,
      html: ({ unsubscribeUrl }) => renderComeBack(stage, name, waiting, stats, unsubscribeUrl, articles),
    })
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// G2 · "Come back" — for an Active member who hasn't been active for a while (user_activity.last_active_at).
// Time-based (the system initiates it), so it respects the send window (hours / Shabbat).
//   * Email 1 after 21 days without activity; email 2 (the last) after 45 days, and at least
//     24 days after email 1.
//   * After email 2 she keeps getting the weekly community email (every member gets it), which
//     replaced the monthly email (decided 2026-11-04).
//   * A quiet period is keyed by her last_active_at: if she comes back and later goes quiet again,
//     a new period starts with email 1.
//   * Members asleep since before tracking began (no user_activity row) count from sign-up.
//   * Something personal for everyone (2026-11-06), short enough not to overwhelm:
//       - counts: unread messages, notifications by kind (comments, replies, mentions… then "and N more")
//       - people: the first 3 who sent her a connection request (most mutual connections first);
//         with no requests, 3 members she may know — friends of friends, or (no connections yet)
//         colleagues from her current / past company or her field (the inner-circle people search)
//       - one post the community talked about this week
//       - a profile nudge when her profile is under 70%, so we can suggest the right people
//     The community numbers only show when there's no post to show.
// Its own category ('come_back') so a member can turn just this off.
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { block, LINK, mutualLine, nudgeLine, postCard, row, titleRow, type Person } from './activity.ts'
import { inChunks, lastActive, people, plain } from './activityJobs.ts'
import { communityStats, statsRow, type CommunityStats } from './onboardingReminders.ts'
import { outOfTime } from './runClock.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
const FIRST_AFTER_DAYS = 21
const SECOND_AFTER_DAYS = 45
const MIN_GAP_DAYS = 24
const BRAND = '#4b154c'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

/** Unread notifications by kind. Connection requests aren't here — they have their own line. */
export interface NotificationCounts { comments: number; replies: number; mentions: number; accepted: number; follows: number; other: number }
export interface Waiting { requests: number; messages: number; notifications: NotificationCounts }

const NO_NOTIFICATIONS: NotificationCounts = { comments: 0, replies: 0, mentions: 0, accepted: 0, follows: 0, other: 0 }
const KIND_OF: Record<string, Exclude<keyof NotificationCounts, 'other'>> = {
  POST_COMMENT: 'comments', ARTICLE_COMMENT: 'comments',
  REPLY: 'replies', ARTICLE_REPLY: 'replies',
  MENTION: 'mentions', ARTICLE_MENTION: 'mentions',
  CONN_ACCEPT: 'accepted',
  FOLLOW: 'follows',
}
// At most this many named kinds; the rest of the notifications go into one "and N more" line.
const MAX_KIND_LINES = 3

/** Someone to show: a request waiting for her, or a member she may know (with why). */
export interface ShownPerson extends Person { reason?: Bi | null }
export interface PeopleBlock { kind: 'requests' | 'suggestions'; people: ShownPerson[]; total: number }
export interface Standout { id: string; author: { name: string; avatarUrl: string }; text: string; likes: number; comments: number }
export interface ComeBackContent {
  waiting: Waiting
  people: PeopleBlock | null
  standout: Standout | null
  /** Members who joined since she was last here. */
  newMembers: number
  profilePct: number | null
  stats: CommunityStats | null
}

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
    // No "we won't email you again": the weekly community email keeps coming (2026-11-04).
    footnote: { he: 'כשתרצי לחזור, אנחנו כאן.', en: "Whenever you want to come back, we're here." } as Bi | null,
  },
} as const
type Stage = keyof typeof STAGE

/** Named lines for the kinds that matter most (in this order), then one line for everything else. */
function notificationRows(n: NotificationCounts, afterOtherLines: boolean): Array<[number, Bi]> {
  const named: Array<[number, Bi]> = ([
    [n.comments, { he: n.comments === 1 ? 'תגובה אחת על מה שפרסמת' : `${n.comments} תגובות על מה שפרסמת`, en: n.comments === 1 ? '1 comment on what you posted' : `${n.comments} comments on what you posted` }],
    [n.replies, { he: n.replies === 1 ? 'תשובה אחת לתגובה שלך' : `${n.replies} תשובות לתגובות שלך`, en: n.replies === 1 ? '1 reply to your comment' : `${n.replies} replies to your comments` }],
    [n.mentions, { he: n.mentions === 1 ? 'הזכירו אותך פעם אחת' : `הזכירו אותך ${n.mentions} פעמים`, en: n.mentions === 1 ? 'You were mentioned once' : `You were mentioned ${n.mentions} times` }],
    [n.accepted, { he: n.accepted === 1 ? 'חברה אחת אישרה את בקשת החיבור שלך' : `${n.accepted} חברות אישרו את בקשת החיבור שלך`, en: n.accepted === 1 ? '1 member accepted your connection request' : `${n.accepted} members accepted your connection request` }],
    [n.follows, { he: n.follows === 1 ? 'חברה אחת התחילה לעקוב אחרייך' : `${n.follows} חברות התחילו לעקוב אחרייך`, en: n.follows === 1 ? '1 member started following you' : `${n.follows} members started following you` }],
  ] as Array<[number, Bi]>).filter(([c]) => c > 0)
  const shown = named.slice(0, MAX_KIND_LINES)
  const rest = n.other + named.slice(MAX_KIND_LINES).reduce((sum, [c]) => sum + c, 0)
  if (rest > 0) {
    // "and N more" only when it follows other lines; alone it is just "N new notifications".
    const more = afterOtherLines || shown.length > 0
    shown.push([rest, more
      ? { he: rest === 1 ? 'ועוד התראה אחת' : `ועוד ${rest} התראות`, en: rest === 1 ? 'and 1 more notification' : `and ${rest} more notifications` }
      : { he: rest === 1 ? 'התראה אחת חדשה' : `${rest} התראות חדשות`, en: rest === 1 ? '1 new notification' : `${rest} new notifications` }])
  }
  return shown
}

function waitingRows(w: Waiting, requestsShownAsPeople: boolean): string {
  const rows: Array<[number, Bi]> = ([
    [requestsShownAsPeople ? 0 : w.requests, { he: w.requests === 1 ? 'בקשת חיבור אחת מחכה לך' : `${w.requests} בקשות חיבור מחכות לך`, en: w.requests === 1 ? '1 connection request is waiting' : `${w.requests} connection requests are waiting` }],
    [w.messages, { he: w.messages === 1 ? 'הודעה אחת שלא קראת' : `${w.messages} הודעות שלא קראת`, en: w.messages === 1 ? '1 unread message' : `${w.messages} unread messages` }],
  ] as Array<[number, Bi]>).filter(([n]) => n > 0)
  rows.push(...notificationRows(w.notifications, rows.length > 0))
  if (!rows.length) return ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 4px;">${rows.map(([n, l]) =>
    `<tr><td style="padding:8px 0;border-top:1px solid ${LINE};">${biColumns({
      he: `<span style="font-family:${FONT};font-size:14px;color:#1d1d1f;"><b style="color:${BRAND};">●</b>&nbsp; ${l.he}</span>`,
      en: `<span style="font-family:${FONT};font-size:14px;color:#1d1d1f;"><b style="color:${BRAND};">●</b>&nbsp; ${l.en}</span>`,
    }, { tight: true })}</td></tr>`).join('')}</table>`
}

export function renderComeBack(stage: Stage, firstName: string, c: ComeBackContent, unsubscribeUrl: string | null): string {
  const s = STAGE[stage]
  // dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
  const nm = firstName.trim() ? `<span dir="auto">${esc(firstName.trim())}</span>` : ''
  const h = s.heading(nm)
  const requests = c.people?.kind === 'requests' ? c.people : null
  const counts = waitingRows(c.waiting, !!requests)
  const lead: Bi = counts || requests
    ? { he: 'בזמן שלא היית, כמה דברים חיכו לך:', en: 'While you were away, a few things were waiting for you:' }
    : c.newMembers >= 5
      ? { he: `מאז שלא היית הצטרפו ${c.newMembers} חברות חדשות לקהילה.`, en: `${c.newMembers} new members joined the community since you were last here.` }
      : { he: 'בזמן שלא היית, הקהילה המשיכה לצמוח.', en: 'While you were away, the community kept growing.' }

  let peopleBlock = ''
  if (requests) {
    peopleBlock = block('connection-request', { he: 'בקשות חיבור', en: 'Connection requests' }, requests.total,
      requests.people.map((p) => row(p, { headline: p.headline, sub: mutualLine(p) })),
      `${APP_URL()}/innercircle/requests`, (k) => ({ he: `ועוד ${k} בקשות מחכות לך`, en: `and ${k} more requests waiting` }))
  } else if (c.people) {
    peopleBlock = block('connection-request', { he: 'חברות שאולי תכירי', en: 'People you may know' }, c.people.total,
      c.people.people.map((p) => row(p, { headline: p.headline, sub: mutualLine(p) ?? p.reason ?? null })),
      `${APP_URL()}/innercircle/connections`, () => ({ he: 'לעוד הצעות באתר', en: 'More suggestions on the site' }), { showCount: false })
  }
  const standout = c.standout
    ? `<div style="height:8px"></div>${titleRow('comment', { he: 'דיברו על זה השבוע', en: 'Talked about this week' }, null)}` +
      postCard(c.standout.text, c.standout.author, { likes: c.standout.likes, comments: c.standout.comments }, LINK.post(c.standout.id))
    : ''
  const body =
    biColumns({ he: heading(h.he) + paragraph(lead.he), en: heading(h.en) + paragraph(lead.en) }) +
    counts + peopleBlock + standout +
    (!c.standout && c.stats ? statsRow(c.stats, { intro: false }) : '') +
    button({ he: 'לחזור לדואולין', en: 'Back to duallin' }, `${APP_URL()}/`) +
    (s.footnote ? `<div style="height:14px"></div>${biColumns({ he: paragraph(s.footnote.he), en: paragraph(s.footnote.en) }, { tight: true })}` : '') +
    (c.profilePct !== null && c.profilePct < 70 ? nudgeLine({ kind: 'profile', pct: c.profilePct }) : '')
  return renderLayout({
    preheader: s.preheader,
    body,
    reason: { he: 'קיבלת את המייל הזה כי את חברה בדואולין.', en: "You received this email because you're a duallin member." },
    unsubscribeUrl,
  })
}

export interface ComeBackSent { first?: number; second?: number }

/** Which email (if any) is due in this quiet period, given when each one went out (ms). */
export function dueComeBack(quietSince: Date, sent: ComeBackSent, now = new Date()): Stage | null {
  const quietDays = (now.getTime() - quietSince.getTime()) / DAY
  // After email 2 the weekly community email (sent to every member) carries on (decided 2026-11-04).
  if (sent.second) return null
  if (sent.first) {
    return quietDays >= SECOND_AFTER_DAYS && now.getTime() - sent.first >= MIN_GAP_DAYS * DAY ? 2 : null
  }
  return quietDays >= FIRST_AFTER_DAYS ? 1 : null
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
  const [req, convs, notifs] = await Promise.all([
    db.from('connections').select('id', { count: 'exact', head: true }).eq('receiver_id', userId).eq('status', 'pending'),
    db.from('conversations').select('id').or(`user1_id.eq.${userId},user2_id.eq.${userId}`).limit(500),
    // Every pending request also has a CONN_REQ notification — count it once, as a request.
    db.from('notifications').select('type').eq('user_id', userId).eq('is_read', false).neq('type', 'CONN_REQ').limit(1000),
  ])
  let messages = 0
  const ids = (convs.data ?? []).map((c) => c.id)
  if (ids.length) {
    const { count } = await db.from('messages').select('id', { count: 'exact', head: true })
      .in('conversation_id', ids.slice(0, 200)).eq('is_read', false).neq('sender_id', userId)
    messages = count ?? 0
  }
  const notifications = { ...NO_NOTIFICATIONS }
  for (const { type } of notifs.data ?? []) notifications[KIND_OF[type] ?? 'other']++
  return { requests: req.count ?? 0, messages, notifications }
}

const AVATAR = () => `${APP_URL()}/email/avatar-default.png`
const SOMEONE = (): Person => ({ name: 'חברה בדואולין', avatarUrl: AVATAR() })
const MIN_PEOPLE = 2 // a "people" block with a single face looks thin — skip it

/** The first requests waiting for her, most mutual connections first (the likeliest she knows). */
async function requestPeople(userId: string, total: number): Promise<PeopleBlock | null> {
  if (!total) return null
  const db = adminClient()
  const { data } = await db.from('connections').select('requester_id').eq('receiver_id', userId).eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(10)
  const ids: string[] = (data ?? []).map((r) => r.requester_id).filter(Boolean)
  if (!ids.length) return null
  const mutual = new Map<string, number>()
  await Promise.all(ids.map(async (id) => {
    // Same function the profile page uses; `count` = total mutual connections.
    const { data: m } = await db.rpc('get_mutual_connections', { p_viewer_id: userId, p_target_id: id, p_limit: 1 }).then((r) => r, () => ({ data: null }))
    mutual.set(id, Number((m as any[] | null)?.[0]?.count ?? 0))
  }))
  const top = ids.sort((a, b) => (mutual.get(b) ?? 0) - (mutual.get(a) ?? 0)).slice(0, 3)
  const names = await people(top)
  return { kind: 'requests', total, people: top.map((id) => ({ ...(names.get(id) ?? SOMEONE()), mutual: mutual.get(id) ?? 0 })) }
}

/**
 * Members she may know, active ones first:
 *   1. friends of friends (the profile page's suggestions, by shared connections)
 *   2. with too few of those (e.g. no connections yet): the inner-circle people search —
 *      the same company (now or before), then the same field. That search already hides
 *      anonymous / deleted members and her own connections.
 */
async function suggestedPeople(userId: string): Promise<PeopleBlock | null> {
  const db = adminClient()
  const reasons = new Map<string, Bi | null>() // null: the mutual-connections line says why
  const mutual = new Map<string, number>()
  const { data: fof } = await db.rpc('get_suggested_users_for_profile', { p_viewer_id: userId, p_target_id: userId, p_limit: 10, p_offset: 0 }).then((r) => r, () => ({ data: null }))
  for (const x of (fof ?? []) as any[]) {
    if (x.uuid === userId || (x.mutual_with_target_count ?? 0) < 1) continue
    reasons.set(x.uuid, null)
    mutual.set(x.uuid, Number(x.mutual_with_target_count))
  }
  if (reasons.size < 3) {
    const { data: me, error } = await db.from('people_search_index').select('current_companies, past_companies, job_functions').eq('user_uuid', userId).maybeSingle()
    if (error) console.error('[come-back] people index:', error.message)
    const companies = [...((me?.current_companies ?? []) as Array<{ key: string; name: string }>), ...((me?.past_companies ?? []) as Array<{ key: string; name: string }>)]
      .filter((co, i, all) => co?.key && all.findIndex((o) => o.key === co.key) === i).slice(0, 3)
    const searches: Array<[Record<string, unknown>, Bi]> = companies.map((co) => {
      const name = `<span dir="auto">${esc(co.name)}</span>`
      return [{ p_company_key: co.key, p_company_scope: 'any' }, { he: `גם היא מ-${name}`, en: `Also from ${name}` }] as [Record<string, unknown>, Bi]
    })
    if (me?.job_functions?.length) searches.push([{ p_functions: me.job_functions }, { he: 'מאותו תחום כמוך', en: 'Works in your field' }])
    for (const [args, reason] of searches) {
      if (reasons.size >= 10) break
      const { data } = await db.rpc('search_people', { p_viewer_id: userId, p_limit: 10, ...args }).then((r) => r, () => ({ data: null }))
      for (const x of (data ?? []) as any[]) {
        if (x.user_uuid === userId || reasons.has(x.user_uuid)) continue
        reasons.set(x.user_uuid, reason)
        mutual.set(x.user_uuid, Number(x.mutual_count ?? 0))
      }
    }
  }
  const ids = [...reasons.keys()]
  if (ids.length < MIN_PEOPLE) return null
  const [active, rows] = await Promise.all([
    lastActive(ids),
    inChunks<{ uuid: string; status: string }>(ids, (c) => db.from('users').select('uuid, status').in('uuid', c)),
  ])
  const ok = new Set(rows.filter((u) => u.status === 'Active').map((u) => u.uuid))
  const monthAgo = Date.now() - 30 * DAY
  const shown = ids.filter((id) => ok.has(id))
    .map((id, i) => ({ id, i, recent: (active.get(id) ?? 0) > monthAgo }))
    .sort((a, b) => Number(b.recent) - Number(a.recent) || a.i - b.i) // active first, then by match
    .slice(0, 3).map((x) => x.id)
  if (shown.length < MIN_PEOPLE) return null
  const names = await people(shown)
  return {
    kind: 'suggestions', total: ok.size,
    people: shown.map((id) => ({ ...(names.get(id) ?? SOMEONE()), mutual: mutual.get(id) ?? 0, reason: reasons.get(id) ?? null })),
  }
}

/** This week's most talked-about posts (comments weigh 3, likes 1), one per author, anonymous authors left out. */
async function standoutPosts(): Promise<Array<Standout & { authorId: string }>> {
  const db = adminClient()
  const { data: posts } = await db.from('posts').select('id, posted_by_uuid, message, post_type')
    .not('post_type', 'is', null).neq('post_type', 'email').neq('post_type', 'question').not('posted_by_uuid', 'is', null)
    .gte('sent_at', new Date(Date.now() - 7 * DAY).toISOString()).limit(2000)
  const ids = (posts ?? []).map((p) => String(p.id))
  if (!ids.length) return []
  const [cRows, lRows, authors] = await Promise.all([
    inChunks<{ post_id: string }>(ids, (c) => db.from('comments').select('post_id').in('post_id', c).limit(10000)),
    inChunks<{ target_id: string }>(ids, (c) => db.from('likes').select('target_id').eq('target_type', 'post').in('target_id', c).limit(20000)),
    inChunks<{ uuid: string; is_anonymous: boolean | null }>((posts ?? []).map((p) => p.posted_by_uuid), (c) => db.from('users').select('uuid, is_anonymous').in('uuid', c)),
  ])
  const cc = new Map<string, number>(); for (const r of cRows) cc.set(String(r.post_id), (cc.get(String(r.post_id)) ?? 0) + 1)
  const lc = new Map<string, number>(); for (const r of lRows) lc.set(String(r.target_id), (lc.get(String(r.target_id)) ?? 0) + 1)
  const anon = new Set(authors.filter((u) => u.is_anonymous).map((u) => u.uuid))
  const score = (p: any) => (cc.get(String(p.id)) ?? 0) * 3 + (lc.get(String(p.id)) ?? 0)
  const seen = new Set<string>()
  const top = (posts ?? []).filter((p) => !anon.has(p.posted_by_uuid) && score(p) >= 3 && plain(p.message))
    .sort((a, b) => score(b) - score(a))
    .filter((p) => !seen.has(p.posted_by_uuid) && seen.add(p.posted_by_uuid)).slice(0, 3)
  const names = await people(top.map((p) => p.posted_by_uuid))
  return top.map((p) => ({
    id: String(p.id), authorId: p.posted_by_uuid, author: names.get(p.posted_by_uuid) ?? SOMEONE(), text: plain(p.message),
    likes: lc.get(String(p.id)) ?? 0, comments: cc.get(String(p.id)) ?? 0,
  }))
}

/** Hourly: send each quiet member the come-back email that is due, up to `budget` sends. */
export async function comeBackJob(budget: number, now = new Date()): Promise<{ sent: number; attempts: number }> {
  if (budget <= 0) return { sent: 0, attempts: 0 }
  const db = adminClient()
  const cutoff = new Date(now.getTime() - FIRST_AFTER_DAYS * DAY).toISOString()

  const [members, activity] = await Promise.all([
    fetchAll<{ uuid: string; email: string | null; first_name: string | null; created_at: string; profile_strength_cache: number | null }>((f, t) =>
      db.from('users').select('uuid, email, first_name, created_at, profile_strength_cache').eq('status', 'Active').lte('created_at', cutoff).order('uuid').range(f, t)),
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
      .in('kind', ['come_back_1', 'come_back_2'])
      .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
      .order('id').range(f, t))
  const history = new Map<string, ComeBackSent>()
  for (const l of logs) {
    const key = `${l.user_id}|${l.ref_key}`
    const h = history.get(key) ?? {}
    const at = new Date(l.created_at).getTime()
    if (l.kind === 'come_back_1') h.first = at
    if (l.kind === 'come_back_2') h.second = at
    history.set(key, h)
  }

  const stats = await communityStats()
  let standouts: Array<Standout & { authorId: string }> | null = null // read on the first send only
  let attempts = 0
  let sent = 0
  for (const m of quiet) {
    if (attempts >= budget || outOfTime()) break
    const stage = dueComeBack(m.quietSince, history.get(`${m.uuid}|${m.period}`) ?? {}, now)
    if (!stage) continue
    attempts++
    const waiting = await waitingFor(m.uuid).catch(() => ({ requests: 0, messages: 0, notifications: { ...NO_NOTIFICATIONS } }))
    standouts ??= await standoutPosts().catch(() => [])
    const [peopleBlock, joined] = await Promise.all([
      (waiting.requests ? requestPeople(m.uuid, waiting.requests) : suggestedPeople(m.uuid)).catch(() => null),
      db.from('users').select('uuid', { count: 'exact', head: true }).eq('status', 'Active').gte('activated_at', m.quietSince.toISOString()),
    ])
    const content: ComeBackContent = {
      waiting,
      people: peopleBlock,
      standout: standouts.find((p) => p.authorId !== m.uuid) ?? null,
      newMembers: joined.count ?? 0,
      profilePct: m.profile_strength_cache,
      stats,
    }
    const name = (m.first_name ?? '').trim()
    const s = STAGE[stage]
    const r = await sendEmail({
      kind: `come_back_${stage}`,
      category: 'come_back',
      to: m.email!,
      userId: m.uuid,
      refKey: m.period,
      subject: `${s.subject.he} | ${s.subject.en}`,
      html: ({ unsubscribeUrl }) => renderComeBack(stage, name, content, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts-- // held by the per-member cap — doesn't use the hour's budget
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

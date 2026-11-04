// Activity emails — the hourly jobs that read the data and send the templates in activity.ts.
// Built to be light on the database: each job runs a few broad, time-bounded queries for
// everyone at once (e.g. "requests from the last 7 days"), groups in memory, and only then
// does a little per-recipient work for the few members who actually get an email this hour.
//
// What counts as "new" for a member = after the previous email of the same kind (its ref_key
// stores the cut-off time) and after she was last active on the site (she already saw it there).
// Names follow the site's rules (routes/profile.ts /feed): anonymous → "אנונימית",
// last name only if privacy_lastname allows members. Photos: our default avatar (decided 2026-11-04).
import { adminClient, getFrequency } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import {
  networkSubject, renderContentDigest, renderFirstPost, renderNetworkUpdate, renderPeopleYouMayKnow,
  renderPostViews, renderRequestReminder, renderWeeklyCommunity,
  type ContentDigest, type NetworkUpdate, type Nudge, type Person, type WeeklyCommunity,
} from './activity.ts'
import { communityStats } from './onboardingReminders.ts'

type JobResult = { sent: number; attempts: number }
const none: JobResult = { sent: 0, attempts: 0 }
const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const AVATAR = () => `${APP_URL()}/email/avatar-default.png`
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const LOOKBACK = 7 * DAY
const SENT = ['sent', 'delivered', 'bounced', 'complained']

// ───────────────────────── shared helpers ─────────────────────────

/** Israel-time hour and weekday (0 = Sunday). */
function israelNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((x) => [x.type, x.value]))
  return { hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}

/** `.in()` in chunks, so a long id list never makes a too-long URL. */
async function inChunks<T>(ids: string[], q: (chunk: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = []
  const uniq = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < uniq.length; i += 150) {
    const { data } = await q(uniq.slice(i, i + 150))
    out.push(...(data ?? []))
  }
  return out
}

/** PostgREST returns at most 1000 rows — page through (with a hard stop, to stay light). */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, max = 10000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

interface Member { uuid: string; email: string; first_name: string | null; status: string; profile_strength_cache: number | null }

async function members(ids: string[]): Promise<Map<string, Member>> {
  const rows = await inChunks<Member>(ids, (c) => adminClient().from('users')
    .select('uuid, email, first_name, status, profile_strength_cache').in('uuid', c))
  return new Map(rows.map((r) => [r.uuid, r]))
}

/** People as the site shows them to a member (anonymity + last-name privacy). */
async function people(ids: string[]): Promise<Map<string, Person>> {
  const rows = await inChunks<{ uuid: string; first_name: string | null; last_name: string | null; headline: string | null; is_anonymous: boolean | null; privacy_lastname: string[] | null }>(
    ids, (c) => adminClient().from('users').select('uuid, first_name, last_name, headline, is_anonymous, privacy_lastname').in('uuid', c))
  return new Map(rows.map((u) => {
    if (u.is_anonymous === true) return [u.uuid, { name: 'אנונימית', avatarUrl: AVATAR(), headline: null }]
    const last = Array.isArray(u.privacy_lastname) && u.privacy_lastname.includes('community') ? u.last_name : null
    return [u.uuid, { name: [u.first_name, last].filter(Boolean).join(' ').trim() || 'חברה בדואולין', avatarUrl: AVATAR(), headline: u.headline }]
  }))
}

async function lastActive(ids: string[]): Promise<Map<string, number>> {
  const rows = await inChunks<{ user_id: string; last_active_at: string | null }>(ids, (c) => adminClient().from('user_activity').select('user_id, last_active_at').in('user_id', c))
  return new Map(rows.filter((r) => r.last_active_at).map((r) => [r.user_id, new Date(r.last_active_at!).getTime()]))
}

/** The latest email of `kind` per member: when it went out + the cut-off stored in ref_key ("upto:<iso>"). */
async function lastSent(kind: string, ids: string[]): Promise<Map<string, { at: number; upto: number }>> {
  const rows = await inChunks<{ user_id: string; ref_key: string | null; created_at: string }>(ids, (c) => adminClient().from('email_log')
    .select('user_id, ref_key, created_at').eq('kind', kind).in('status', SENT).in('user_id', c)
    .gte('created_at', new Date(Date.now() - 30 * DAY).toISOString()))
  const m = new Map<string, { at: number; upto: number }>()
  for (const r of rows) {
    const at = new Date(r.created_at).getTime()
    const upto = r.ref_key?.startsWith('upto:') ? new Date(r.ref_key.slice(5)).getTime() : at
    const prev = m.get(r.user_id)
    if (!prev || at > prev.at) m.set(r.user_id, { at, upto })
  }
  return m
}

/** Plain text from a post/comment (tags removed, mention markup "@[Name](id)" → "@Name"). */
const plain = (s: string | null | undefined) =>
  (s ?? '').replace(/@\[([^\]]+)\]\([^)]*\)/g, '@$1').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/** The one small nudge that fits her (cheap: uses what's already loaded). */
function nudgeFor(m: Member, pendingRequests = 0, lastPostAt?: number): Nudge {
  if ((m.profile_strength_cache ?? 100) < 70) return { kind: 'profile', pct: m.profile_strength_cache ?? 0 }
  if (pendingRequests > 0) return { kind: 'requests', count: pendingRequests }
  if (!lastPostAt || Date.now() - lastPostAt > 14 * DAY) return { kind: 'post' }
  return null
}

// ───────────────────────── B · network update (hourly) ─────────────────────────
// Recruiter requests (15 min), unread messages (60 min), mentions (15 min), connection requests
// (15 min), accepted requests. One email per member, at most every 4 hours — except a recruiter
// request, which never waits. 'network' frequency 'daily' → only in the 19:00 run.

const NETWORK_SPACING = 4 * HOUR

export async function networkJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const t = now.getTime()
  const since = new Date(t - LOOKBACK).toISOString()
  const by15 = new Date(t - 15 * MIN).toISOString()
  const by60 = new Date(t - 60 * MIN).toISOString()

  const [recruiters, unread, mentions, requests, accepted] = await Promise.all([
    db.from('profile_access_requests').select('candidate_id, recruiter_id, created_at').eq('status', 'pending').gte('created_at', since).lte('created_at', by15).limit(2000),
    db.from('messages').select('conversation_id, sender_id, created_at').eq('is_read', false).gte('created_at', since).lte('created_at', by60).limit(5000),
    db.from('notifications').select('user_id, actor_id, target_id, type, created_at').in('type', ['MENTION', 'ARTICLE_MENTION']).eq('is_read', false).gte('created_at', since).lte('created_at', by15).limit(3000),
    db.from('connections').select('receiver_id, requester_id, created_at').eq('status', 'pending').gte('created_at', since).lte('created_at', by15).limit(3000),
    db.from('notifications').select('user_id, actor_id, created_at').eq('type', 'CONN_ACCEPT').eq('is_read', false).gte('created_at', since).lte('created_at', by15).limit(3000),
  ])

  // Messages → recipient = the other participant of the conversation.
  const convIds = [...new Set((unread.data ?? []).map((m) => m.conversation_id))]
  const convs = await inChunks<{ id: string; user1_id: string; user2_id: string }>(convIds, (c) => db.from('conversations').select('id, user1_id, user2_id').in('id', c))
  const convMap = new Map(convs.map((c) => [c.id, c]))

  type Item = { at: number; actor: string; extra?: string }
  type Bucket = { recruiters: Item[]; messages: Item[]; mentions: Item[]; requests: Item[]; accepted: Item[] }
  const buckets = new Map<string, Bucket>()
  const add = (uid: string | null | undefined, k: keyof Bucket, it: Item) => {
    if (!uid) return
    const b = buckets.get(uid) ?? { recruiters: [], messages: [], mentions: [], requests: [], accepted: [] }
    b[k].push(it)
    buckets.set(uid, b)
  }
  for (const r of recruiters.data ?? []) add(r.candidate_id, 'recruiters', { at: Date.parse(r.created_at), actor: r.recruiter_id })
  for (const m of unread.data ?? []) {
    const c = convMap.get(m.conversation_id)
    if (!c) continue
    add(c.user1_id === m.sender_id ? c.user2_id : c.user1_id, 'messages', { at: Date.parse(m.created_at), actor: m.sender_id })
  }
  for (const n of mentions.data ?? []) add(n.user_id, 'mentions', { at: Date.parse(n.created_at), actor: n.actor_id, extra: `${n.type}|${n.target_id}` })
  for (const r of requests.data ?? []) add(r.receiver_id, 'requests', { at: Date.parse(r.created_at), actor: r.requester_id })
  for (const a of accepted.data ?? []) add(a.user_id, 'accepted', { at: Date.parse(a.created_at), actor: a.actor_id })
  if (!buckets.size) return none

  const recipientIds = [...buckets.keys()]
  const [mem, seen, prev] = await Promise.all([members(recipientIds), lastActive(recipientIds), lastSent('network_update', recipientIds)])
  const isEvening = israelNow(now).hour === 19

  // Decide who gets an email this hour (no more queries per member yet).
  const due: Array<{ uid: string; b: Bucket }> = []
  for (const [uid, b] of buckets) {
    const m = mem.get(uid)
    if (!m?.email || m.status !== 'Active') continue
    const p = prev.get(uid)
    const after = Math.max(p?.upto ?? 0, seen.get(uid) ?? 0) // already emailed, or she was on the site since
    const fresh = (xs: Item[]) => xs.filter((x) => x.at > after)
    const f: Bucket = {
      recruiters: b.recruiters.filter((x) => x.at > (p?.upto ?? 0)), // recruiter: even if she was on the site
      messages: fresh(b.messages), mentions: fresh(b.mentions), requests: fresh(b.requests), accepted: fresh(b.accepted),
    }
    const any = f.recruiters.length + f.messages.length + f.mentions.length + f.requests.length + f.accepted.length
    if (!any) continue
    if (!f.recruiters.length && p && t - p.at < NETWORK_SPACING) continue // spacing; a recruiter request doesn't wait
    due.push({ uid, b: f })
  }
  // Recruiter requests first, then the rest.
  due.sort((a, b) => b.b.recruiters.length - a.b.recruiters.length)

  let attempts = 0
  let sent = 0
  for (const { uid, b } of due) {
    if (attempts >= budget) break
    const m = mem.get(uid)!
    const [netFreq, recFreq] = await Promise.all([getFrequency(uid, 'network'), getFrequency(uid, 'recruiting')])
    if (recFreq === 'off') b.recruiters = []
    if (netFreq === 'off' || (netFreq === 'daily' && !isEvening)) { b.messages = []; b.mentions = []; b.requests = []; b.accepted = [] }
    if (!b.recruiters.length && !b.messages.length && !b.mentions.length && !b.requests.length && !b.accepted.length) continue

    // Names + a little per-email detail, only for what is shown (3 per block).
    const byConv = new Map<string, number>()
    for (const x of b.messages) byConv.set(x.actor, (byConv.get(x.actor) ?? 0) + 1)
    const msgSenders = [...byConv.entries()].sort((x, y) => y[1] - x[1])
    const show = {
      recruiters: [...new Set(b.recruiters.map((x) => x.actor))].slice(0, 3),
      messages: msgSenders.slice(0, 3).map(([a]) => a),
      mentions: b.mentions.sort((x, y) => y.at - x.at).slice(0, 3),
      requests: [...new Set(b.requests.map((x) => x.actor))],
      accepted: [...new Set(b.accepted.map((x) => x.actor))].slice(0, 3),
    }
    // Requests: most mutual connections first (the likeliest she knows).
    const mutual = new Map<string, number>()
    await Promise.all(show.requests.slice(0, 10).map(async (a) => {
      // Same function the profile page uses; `count` = total mutual connections.
      const { data } = await db.rpc('get_mutual_connections', { p_viewer_id: uid, p_target_id: a, p_limit: 1 }).then((r) => r, () => ({ data: null }))
      mutual.set(a, Number((data as any[] | null)?.[0]?.count ?? 0))
    }))
    const reqShown = show.requests.sort((x, y) => (mutual.get(y) ?? 0) - (mutual.get(x) ?? 0)).slice(0, 3)
    const names = await people([...show.recruiters, ...show.messages, ...show.mentions.map((x) => x.actor), ...reqShown, ...show.accepted])
    const P = (id: string): Person => names.get(id) ?? { name: 'חברה בדואולין', avatarUrl: AVATAR() }

    // Mention text: the post / comment / article she was mentioned in.
    const mentionText = new Map<string, string>()
    const postIds = show.mentions.filter((x) => x.extra?.startsWith('MENTION|')).map((x) => x.extra!.split('|')[1])
    const artIds = show.mentions.filter((x) => x.extra?.startsWith('ARTICLE_MENTION|')).map((x) => x.extra!.split('|')[1])
    if (postIds.length) {
      const { data: cms } = await db.from('comments').select('post_id, posted_by_uuid, message, created_at').in('post_id', postIds).order('created_at', { ascending: false }).limit(50)
      const { data: pts } = await db.from('posts').select('id, message, posted_by_uuid').in('id', postIds)
      for (const x of show.mentions) {
        const pid = x.extra!.split('|')[1]
        const c = (cms ?? []).find((c) => String(c.post_id) === pid && c.posted_by_uuid === x.actor)
        const p = (pts ?? []).find((p) => String(p.id) === pid)
        mentionText.set(`${x.actor}|${pid}`, plain(c?.message ?? p?.message))
      }
    }
    if (artIds.length) {
      const { data: arts } = await db.from('articles').select('id, title').in('id', artIds)
      for (const x of show.mentions) {
        const aid = x.extra!.split('|')[1]
        const a = (arts ?? []).find((a) => String(a.id) === aid)
        if (a) mentionText.set(`${x.actor}|${aid}`, a.title)
      }
    }

    const update: NetworkUpdate = {
      firstName: (m.first_name ?? '').trim(),
      recruiters: show.recruiters.map(P),
      messages: msgSenders.slice(0, 3).map(([a, n]) => ({ from: P(a), count: n })),
      messagesTotal: msgSenders.length,
      mentions: show.mentions.map((x) => {
        const [type, id] = x.extra!.split('|')
        const text = mentionText.get(`${x.actor}|${id}`) ?? ''
        return { by: P(x.actor), where: type === 'ARTICLE_MENTION' ? 'article' as const : 'post' as const, text }
      }),
      mentionsTotal: b.mentions.length,
      requests: reqShown.map((a) => ({ ...P(a), mutual: mutual.get(a) ?? 0 })),
      requestsTotal: show.requests.length,
      accepted: show.accepted.map(P),
      acceptedTotal: new Set(b.accepted.map((x) => x.actor)).size,
    }
    const upto = new Date(Math.max(...[...b.recruiters, ...b.messages, ...b.mentions, ...b.requests, ...b.accepted].map((x) => x.at))).toISOString()
    const onlyRecruiter = !b.messages.length && !b.mentions.length && !b.requests.length && !b.accepted.length

    attempts++
    const r = await sendEmail({
      kind: 'network_update',
      category: onlyRecruiter ? 'recruiting' : 'network',
      to: m.email,
      userId: uid,
      refKey: `upto:${upto}`,
      subject: networkSubject(update),
      html: ({ unsubscribeUrl }) => renderNetworkUpdate(update, nudgeFor(m), unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── B · a request still pending after 5 days (once) ─────────────────────────

export async function requestReminderJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const t = now.getTime()
  const { data: pending } = await db.from('connections').select('id, receiver_id, requester_id, created_at')
    .eq('status', 'pending').gte('created_at', new Date(t - 7 * DAY).toISOString()).lte('created_at', new Date(t - 5 * DAY).toISOString()).limit(3000)
  if (!pending?.length) return none
  const { data: done } = await db.from('email_log').select('user_id').eq('kind', 'request_reminder').in('status', SENT)
    .gte('created_at', new Date(t - 10 * DAY).toISOString())
  const reminded = new Set((done ?? []).map((r) => r.user_id))

  const byReceiver = new Map<string, string[]>()
  for (const p of pending) if (!reminded.has(p.receiver_id)) byReceiver.set(p.receiver_id, [...(byReceiver.get(p.receiver_id) ?? []), p.requester_id])
  if (!byReceiver.size) return none
  const mem = await members([...byReceiver.keys()])

  let attempts = 0
  let sent = 0
  for (const [uid, requesters] of byReceiver) {
    if (attempts >= budget) break
    const m = mem.get(uid)
    if (!m?.email || m.status !== 'Active') continue
    const names = await people(requesters.slice(0, 3))
    const shown = requesters.slice(0, 3).map((a) => names.get(a) ?? { name: 'חברה בדואולין', avatarUrl: AVATAR() })
    attempts++
    const r = await sendEmail({
      kind: 'request_reminder', category: 'network', to: m.email, userId: uid,
      refKey: `week:${new Date(t).toISOString().slice(0, 10)}`,
      subject: requesters.length === 1 ? `${shown[0].name} עדיין מחכה לתשובה ממך | ${shown[0].name} is still waiting for your reply` : `${requesters.length} בקשות חיבור מחכות לך | ${requesters.length} connection requests are waiting`,
      html: ({ unsubscribeUrl }) => renderRequestReminder((m.first_name ?? '').trim(), shown, requesters.length, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C · comments & likes on her posts (19:00) ─────────────────────────
// Only if worth it: at least 1 comment/reply, or at least 5 new likes. Not about what she already
// saw on the site. 'content_activity' daily → every evening; weekly → Sunday evening only.

const MIN_LIKES = 5

export async function contentDigestJob(budget: number, now = new Date()): Promise<JobResult> {
  const { hour, weekday } = israelNow(now)
  if (budget <= 0 || hour < 19) return none // the evening runs (19:00, and 20:00/21:00 to finish)
  const db = adminClient()
  const t = now.getTime()
  const since = new Date(t - LOOKBACK).toISOString()

  // Comments on posts (with the post's author) and likes on posts — two queries for everyone.
  const [cms, lks] = await Promise.all([
    db.from('comments').select('id, post_id, posted_by_uuid, message, parent_comment_id, created_at, posts!inner(posted_by_uuid, message)')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(5000),
    db.from('likes').select('target_id, user_id, created_at').eq('target_type', 'post').gte('created_at', since).limit(10000),
  ])
  type C = { by: string; kind: 'comment' | 'reply'; text: string; at: number }
  const byAuthor = new Map<string, { comments: C[]; likes: Map<string, { likers: Array<{ by: string; at: number }> }> }>()
  const slot = (uid: string) => byAuthor.get(uid) ?? (byAuthor.set(uid, { comments: [], likes: new Map() }), byAuthor.get(uid)!)
  const postText = new Map<string, string>()
  const parentAuthor = new Map<string, string>()
  for (const c of (cms.data ?? []) as any[]) parentAuthor.set(String(c.id), c.posted_by_uuid)
  for (const c of (cms.data ?? []) as any[]) {
    const author = c.posts?.posted_by_uuid
    postText.set(String(c.post_id), plain(c.posts?.message))
    const target = c.parent_comment_id ? parentAuthor.get(String(c.parent_comment_id)) : author
    if (!target || target === c.posted_by_uuid) continue
    slot(target).comments.push({ by: c.posted_by_uuid, kind: c.parent_comment_id ? 'reply' : 'comment', text: plain(c.message), at: Date.parse(c.created_at) })
  }
  const likedPosts = [...new Set((lks.data ?? []).map((l) => String(l.target_id)))]
  const posts = await inChunks<{ id: string; posted_by_uuid: string; message: string }>(likedPosts, (c) => db.from('posts').select('id, posted_by_uuid, message').in('id', c))
  const postAuthor = new Map(posts.map((p) => [String(p.id), p.posted_by_uuid]))
  for (const p of posts) postText.set(String(p.id), plain(p.message))
  for (const l of lks.data ?? []) {
    const author = postAuthor.get(String(l.target_id))
    if (!author || author === l.user_id) continue
    const s = slot(author)
    const e = s.likes.get(String(l.target_id)) ?? { likers: [] }
    e.likers.push({ by: l.user_id, at: Date.parse(l.created_at) })
    s.likes.set(String(l.target_id), e)
  }
  if (!byAuthor.size) return none

  const ids = [...byAuthor.keys()]
  const [mem, seen, prev] = await Promise.all([members(ids), lastActive(ids), lastSent('content_digest', ids)])

  let attempts = 0
  let sent = 0
  for (const [uid, s] of byAuthor) {
    if (attempts >= budget) break
    const m = mem.get(uid)
    if (!m?.email || m.status !== 'Active') continue
    const p = prev.get(uid)
    if (p && t - p.at < 20 * HOUR) continue // one a day at most
    const after = Math.max(p?.upto ?? 0, seen.get(uid) ?? 0)
    const comments = s.comments.filter((c) => c.at > after).sort((a, b) => (a.kind === 'reply' ? -1 : 0) - (b.kind === 'reply' ? -1 : 0) || b.at - a.at)
    const likes = [...s.likes.entries()].map(([pid, e]) => ({ pid, likers: e.likers.filter((x) => x.at > after) })).filter((x) => x.likers.length)
    const likeTotal = likes.reduce((n, x) => n + x.likers.length, 0)
    if (!comments.length && likeTotal < MIN_LIKES) continue // not worth an email (yet — it accumulates)

    const freq = await getFrequency(uid, 'content_activity')
    if (freq === 'off' || (freq === 'weekly' && weekday !== 0)) continue

    likes.sort((a, b) => b.likers.length - a.likers.length)
    const names = await people([...comments.slice(0, 3).map((c) => c.by), ...likes.slice(0, 2).map((l) => l.likers[0].by)])
    const N = (id: string) => names.get(id) ?? { name: 'חברה בדואולין', avatarUrl: AVATAR() }
    const digest: ContentDigest = {
      firstName: (m.first_name ?? '').trim(),
      comments: comments.slice(0, 3).map((c) => ({ by: N(c.by), kind: c.kind, text: c.text })),
      commentsTotal: comments.length,
      likes: likeTotal >= MIN_LIKES ? likes.slice(0, 2).map((l) => ({ postText: postText.get(l.pid) ?? '', firstLiker: N(l.likers[0].by).name, others: l.likers.length - 1 })) : [],
      likedPostsTotal: likes.length,
    }
    const upto = new Date(Math.max(...comments.map((c) => c.at), ...likes.flatMap((l) => l.likers.map((x) => x.at)))).toISOString()
    attempts++
    const r = await sendEmail({
      kind: 'content_digest', category: 'content_activity', to: m.email, userId: uid, refKey: `upto:${upto}`,
      subject: comments.length
        ? `${digest.comments[0].by.name} הגיבה על מה שכתבת | ${digest.comments[0].by.name} commented on your post`
        : `${digest.likes[0]?.firstLiker} ואחרות אהבו את הפוסט שלך | ${digest.likes[0]?.firstLiker} and others liked your post`,
      html: ({ unsubscribeUrl }) => renderContentDigest(digest, nudgeFor(m), unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C · post views (3 days after) and first post ─────────────────────────

const MIN_VIEWS = 30
const MIN_VIEWS_FIRST_POST = 10

export async function postViewsJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const t = now.getTime()
  // Posts published 3–4 days ago (first posts: 1–2 days ago).
  const { data: posts } = await db.from('posts').select('id, posted_by_uuid, message, sent_at, post_type')
    .not('post_type', 'is', null).neq('post_type', 'email').not('posted_by_uuid', 'is', null)
    .gte('sent_at', new Date(t - 4 * DAY).toISOString()).lte('sent_at', new Date(t - 1 * DAY).toISOString()).limit(2000)
  if (!posts?.length) return none

  const authors = [...new Set(posts.map((p) => p.posted_by_uuid))]
  const [mem, prevViews, prevFirst, counts] = await Promise.all([
    members(authors), lastSent('post_views', authors), lastSent('first_post', authors),
    // How many posts each author ever wrote (first post = exactly 1).
    inChunks<{ posted_by_uuid: string }>(authors, (c) => db.from('posts').select('posted_by_uuid').in('posted_by_uuid', c).not('post_type', 'is', null).neq('post_type', 'email').limit(5000)),
  ])
  const postCount = new Map<string, number>()
  for (const r of counts) postCount.set(r.posted_by_uuid, (postCount.get(r.posted_by_uuid) ?? 0) + 1)

  let attempts = 0
  let sent = 0
  for (const p of posts) {
    if (attempts >= budget) break
    const m = mem.get(p.posted_by_uuid)
    if (!m?.email || m.status !== 'Active') continue
    const age = t - Date.parse(p.sent_at)
    const isFirst = postCount.get(p.posted_by_uuid) === 1
    if (isFirst ? prevFirst.has(m.uuid) : (age < 3 * DAY || (prevViews.get(m.uuid) && t - prevViews.get(m.uuid)!.at < 7 * DAY))) continue

    const [{ count: views }, { count: likes }, { count: comments }] = await Promise.all([
      db.from('post_impressions').select('id', { count: 'exact', head: true }).eq('post_id', String(p.id)),
      db.from('likes').select('id', { count: 'exact', head: true }).eq('target_type', 'post').eq('target_id', p.id),
      db.from('comments').select('id', { count: 'exact', head: true }).eq('post_id', p.id),
    ])
    const v = views ?? 0
    if (v < (isFirst ? MIN_VIEWS_FIRST_POST : MIN_VIEWS)) continue
    const post = { text: plain(p.message), views: v, likes: likes ?? 0, comments: comments ?? 0 }
    attempts++
    const r = await sendEmail({
      kind: isFirst ? 'first_post' : 'post_views', category: 'content_activity', to: m.email, userId: m.uuid, refKey: `post:${p.id}`,
      subject: isFirst ? 'פרסמת את הפוסט הראשון שלך! | You published your first post!' : `הפוסט שלך נצפה ${v} פעמים | Your post was seen ${v} times`,
      html: ({ unsubscribeUrl }) => isFirst
        ? renderFirstPost((m.first_name ?? '').trim(), post, unsubscribeUrl)
        // No "write another" right after a post — the nudge only if her last post is 14+ days old (it isn't here).
        : renderPostViews((m.first_name ?? '').trim(), post, (m.profile_strength_cache ?? 100) < 70 ? { kind: 'profile', pct: m.profile_strength_cache ?? 0 } : null, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C · people you may know (Monday from 12:00, every 2 weeks) ─────────────────────────
// Only members active in the last 30 days, only with 3+ suggestions that have 2+ mutual connections.

export async function peopleJob(budget: number, now = new Date()): Promise<JobResult> {
  const { hour, weekday } = israelNow(now)
  if (budget <= 0 || weekday !== 1 || hour < 12) return none
  const db = adminClient()
  const t = now.getTime()
  const active = await fetchAll<{ user_id: string }>((f, to) => db.from('user_activity').select('user_id')
    .gte('last_active_at', new Date(t - 30 * DAY).toISOString()).order('user_id').range(f, to))
  const ids = active.map((a) => a.user_id)
  if (!ids.length) return none
  const today = `date:${now.toISOString().slice(0, 10)}`
  const [mem, prev, checked] = await Promise.all([
    members(ids), lastSent('people_suggestions', ids),
    // Members already checked today without enough suggestions — don't recompute them every hour.
    inChunks<{ user_id: string }>(ids, (c) => db.from('email_log').select('user_id').eq('kind', 'people_suggestions').eq('ref_key', today).eq('status', 'skipped').in('user_id', c)),
  ])
  const skipToday = new Set(checked.map((r) => r.user_id))
  const MAX_CHECKS = 300 // the suggestion function is the expensive part — bound it per run

  let attempts = 0
  let sent = 0
  let checks = 0
  for (const uid of ids) {
    if (attempts >= budget || checks >= MAX_CHECKS) break
    const m = mem.get(uid)
    if (!m?.email || m.status !== 'Active' || skipToday.has(uid)) continue
    const p = prev.get(uid)
    if (p && t - p.at < 6 * DAY) continue
    const freq = await getFrequency(uid, 'people_suggestions')
    if (freq === 'off' || (freq !== 'weekly' && p && t - p.at < 13 * DAY)) continue
    checks++
    // Same function the profile page uses: second-degree members, ranked by shared connections.
    const { data: sugg } = await db.rpc('get_suggested_users_for_profile', { p_viewer_id: uid, p_target_id: uid, p_limit: 10, p_offset: 0 }).then((r) => r, () => ({ data: null }))
    const list = ((sugg ?? []) as any[]).filter((s) => s.uuid !== uid && (s.mutual_with_target_count ?? 0) >= 2)
    if (list.length < 3) {
      await db.from('email_log').insert({ kind: 'people_suggestions', category: 'people_suggestions', email: m.email, user_id: uid, ref_key: today, status: 'skipped', skip_reason: 'too_few_suggestions' })
      continue
    }
    const total = Number(list[0]?.count ?? list.length)
    const names = await people(list.slice(0, 3).map((s) => s.uuid))
    const shown = list.slice(0, 3).map((s) => ({ ...(names.get(s.uuid) ?? { name: 'חברה בדואולין', avatarUrl: AVATAR() }), mutual: s.mutual_with_target_count ?? 0 }))
    attempts++
    const r = await sendEmail({
      kind: 'people_suggestions', category: 'people_suggestions', to: m.email, userId: uid, refKey: `date:${now.toISOString().slice(0, 10)}`,
      subject: 'אולי את מכירה אותן? | Do you know them?',
      html: ({ unsubscribeUrl }) => renderPeopleYouMayKnow((m.first_name ?? '').trim(), shown, Math.max(total, shown.length), nudgeFor(m), unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C · the week in the community (Wednesday from 10:00) ─────────────────────────
// For every Active member (decided 2026-11-04). For quiet members it replaces the old monthly email;
// the per-member cap keeps it from piling on top of a come-back email the same day.
// Built once per run; sent over Wednesday–Thursday as the hourly budget allows.

export async function weeklyCommunityJob(budget: number, now = new Date()): Promise<JobResult> {
  const { hour, weekday } = israelNow(now)
  if (budget <= 0 || !((weekday === 3 && hour >= 10) || weekday === 4)) return none
  const db = adminClient()
  const t = now.getTime()
  const weekKey = `week:${new Date(t - (weekday - 3) * DAY).toISOString().slice(0, 10)}`
  const since7 = new Date(t - 7 * DAY).toISOString()

  const all = await fetchAll<{ uuid: string }>((f, to) => db.from('users').select('uuid')
    .eq('status', 'Active').order('uuid').range(f, to))
  const ids = all.map((a) => a.uuid)
  if (!ids.length) return none
  const already = await inChunks<{ user_id: string }>(ids, (c) => db.from('email_log').select('user_id').eq('kind', 'weekly_community').eq('ref_key', weekKey).in('user_id', c))
  const done = new Set(already.map((r) => r.user_id))
  const todo = ids.filter((id) => !done.has(id))
  if (!todo.length) return none

  // The content — read once.
  const { data: weekPosts } = await db.from('posts').select('id, posted_by_uuid, message, post_type, sent_at')
    .not('post_type', 'is', null).neq('post_type', 'email').not('posted_by_uuid', 'is', null).gte('sent_at', since7).limit(2000)
  const pids = (weekPosts ?? []).map((p) => String(p.id))
  const [cRows, lRows] = await Promise.all([
    inChunks<{ post_id: string }>(pids, (c) => db.from('comments').select('post_id').in('post_id', c).limit(10000)),
    inChunks<{ target_id: string }>(pids, (c) => db.from('likes').select('target_id').eq('target_type', 'post').in('target_id', c).limit(20000)),
  ])
  const cc = new Map<string, number>(); for (const r of cRows) cc.set(String(r.post_id), (cc.get(String(r.post_id)) ?? 0) + 1)
  const lc = new Map<string, number>(); for (const r of lRows) lc.set(String(r.target_id), (lc.get(String(r.target_id)) ?? 0) + 1)
  const authorIds = [...new Set((weekPosts ?? []).map((p) => p.posted_by_uuid))]
  const anon = new Set((await inChunks<{ uuid: string; is_anonymous: boolean | null }>(authorIds, (c) => db.from('users').select('uuid, is_anonymous').in('uuid', c))).filter((u) => u.is_anonymous).map((u) => u.uuid))
  const visible = (weekPosts ?? []).filter((p) => !anon.has(p.posted_by_uuid))
  const score = (p: any) => (cc.get(String(p.id)) ?? 0) * 3 + (lc.get(String(p.id)) ?? 0)
  const seenAuthor = new Set<string>()
  const top = visible.filter((p) => p.post_type !== 'question' && score(p) >= 3).sort((a, b) => score(b) - score(a))
    .filter((p) => !seenAuthor.has(p.posted_by_uuid) && seenAuthor.add(p.posted_by_uuid)).slice(0, 4)
  const questions = visible.filter((p) => p.post_type === 'question' && (cc.get(String(p.id)) ?? 0) <= 1 &&
    t - Date.parse(p.sent_at) >= DAY && t - Date.parse(p.sent_at) <= 5 * DAY).slice(0, 3)
  const { data: arts } = await db.from('articles').select('id, title').eq('status', 'published').is('deleted_at', null).gte('published_at', since7).order('published_at', { ascending: false }).limit(3)
  const { count: newMembers } = await db.from('users').select('uuid', { count: 'exact', head: true }).eq('status', 'Active').gte('activated_at', since7)
  const stats = await communityStats()
  const names = await people([...top, ...questions].map((p) => p.posted_by_uuid))
  const N = (id: string) => names.get(id) ?? { name: 'חברה בדואולין', avatarUrl: AVATAR() }
  if (!top.length && !questions.length && !(arts ?? []).length) return none // nothing worth a weekly email

  const [mem, prev] = await Promise.all([members(todo), lastSent('weekly_community', todo)])
  let attempts = 0
  let sent = 0
  for (const uid of todo) {
    if (attempts >= budget) break
    const m = mem.get(uid)
    if (!m?.email || m.status !== 'Active') continue
    const freq = await getFrequency(uid, 'community')
    if (freq === 'off') continue
    const p = prev.get(uid)
    if (freq === 'biweekly' && p && t - p.at < 13 * DAY) continue
    const w: WeeklyCommunity = {
      firstName: (m.first_name ?? '').trim(),
      questions: questions.filter((q) => q.posted_by_uuid !== uid).slice(0, 2).map((q) => ({ author: N(q.posted_by_uuid), text: plain(q.message) })),
      topPosts: top.filter((p) => p.posted_by_uuid !== uid).slice(0, 3).map((p) => ({ author: N(p.posted_by_uuid), text: plain(p.message), likes: lc.get(String(p.id)) ?? 0, comments: cc.get(String(p.id)) ?? 0 })),
      articles: (arts ?? []).filter((a) => a.title),
      newMembers: newMembers ?? 0,
      stats,
    }
    attempts++
    const r = await sendEmail({
      kind: 'weekly_community', category: 'community', to: m.email, userId: uid, refKey: weekKey,
      subject: 'זה מה שקרה השבוע בדואולין | This week on duallin',
      html: ({ unsubscribeUrl }) => renderWeeklyCommunity(w, nudgeFor(m), unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

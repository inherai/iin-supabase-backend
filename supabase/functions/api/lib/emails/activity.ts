// Activity emails (email plan, groups D, E, G) — templates.
// Tiers agreed with the product owner (2026-11-04):
//   B · personal & important (no daily cap, spaced): recruiter request, unread messages, mentions,
//       connection requests (+ accepted), one reminder for a request still pending after 5 days.
//   C · nice-to-know (at most 1/day, 4/week): comments & likes on her posts, post views,
//       first post, people you may know, the week in the community.
// Rules for every email:
//   * one main button to the exact place + at most one small nudge that fits her state;
//   * each kind of item in its own framed block with the site's icon, a title and a count;
//   * at most 3 items per block, then "and N more on duallin" (never a huge email);
//   * people with their real photo when her privacy allows it (signed link), else our default avatar;
//   * icons = the site's own (public/email/icons, rendered from the same icon components);
//   * describe only what happened — never guess intent (a comment is not "a question for you").
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { statsRow, type CommunityStats } from './onboardingReminders.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const BRAND = '#4b154c'
const INK = '#1d1d1f'
const INK_2 = '#4a4a50'
const INK_3 = '#86838b'
const LINE = '#ede0f0'
const SOFT = '#faf5fb'
/** Section header bar in the weekly email — a light tint of the brand purple. */
const HEADER_TINT = '#f7eff8'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
const MAX_PER_BLOCK = 3
const MEMBER_REASON: Bi = { he: 'קיבלת את המייל הזה כי את חברה בדואולין.', en: "You received this email because you're a duallin member." }

export type IconName =
  | 'like' | 'comment' | 'reply' | 'mention' | 'connection-request' | 'connection-accepted'
  | 'messages' | 'recruiter' | 'views' | 'question' | 'article'
const icon = (name: IconName, size = 28) =>
  `<img src="${APP_URL()}/email/icons/${name}.png" width="${size}" height="${size}" alt="" style="display:block;border:0;">`

// dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
const nm = (s: string) => (s.trim() ? `<span dir="auto">${esc(s.trim())}</span>` : '')
const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return esc(t.length > max ? `${t.slice(0, max - 1)}…` : t)
}
const plural = (n: number, one: Bi, many: (n: number) => Bi): Bi => (n === 1 ? one : many(n))

export interface Person { name: string; avatarUrl: string; headline?: string | null; mutual?: number }

export const mutualLine = (p: Person): Bi | null =>
  p.mutual ? plural(p.mutual, { he: 'חיבור משותף אחד', en: '1 mutual connection' }, (k) => ({ he: `${k} חיבורים משותפים`, en: `${k} mutual connections` })) : null

/** One row: photo, name (+ what she did), headline / quote, small line. */
export function row(p: { name: string; avatarUrl: string }, opts: { action?: Bi; headline?: string | null; quote?: string | null; sub?: Bi | null }): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};">
    <table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" width="100%"><tr>
      <td width="44" valign="top" style="padding-left:10px;"><img src="${p.avatarUrl}" width="40" height="40" alt="" style="display:block;border-radius:50%;border:0;object-fit:cover;"></td>
      <td valign="top">
        <div style="font-family:${FONT};font-size:14px;color:${INK};" dir="rtl"><b dir="auto">${esc(p.name)}</b>${opts.action ? ` <span style="color:${INK_2};">${opts.action.he}</span>` : ''}</div>
        ${opts.action ? `<div style="font-family:${FONT};font-size:12px;color:${INK_3};" dir="ltr">${opts.action.en}</div>` : ''}
        ${opts.headline ? `<div style="font-family:${FONT};font-size:12.5px;color:${INK_2};text-align:right;" dir="auto">${cut(opts.headline, 70)}</div>` : ''}
        ${opts.quote ? `<div style="font-family:${FONT};font-size:13.5px;line-height:1.5;color:${INK};margin-top:4px;padding:6px 10px;background:#fff;border-right:3px solid ${LINE};text-align:right;" dir="auto">"${cut(opts.quote, 80)}"</div>` : ''}
        ${opts.sub ? `<div style="font-family:${FONT};font-size:12px;color:${INK_3};margin-top:2px;"><span dir="rtl">${opts.sub.he}</span> · <span dir="ltr">${opts.sub.en}</span></div>` : ''}
      </td></tr></table></td></tr>`
}

/** Title line: icon + Hebrew on the right, English on the left (like the bilingual columns). */
export function titleRow(i: IconName, t: Bi, count: number | null): string {
  const c = count === null ? '' : ` (${count})`
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>
    <td valign="middle" width="30" style="padding-left:8px;">${icon(i, 22)}</td>
    <td valign="middle" style="font-family:${FONT};font-size:15px;font-weight:800;color:${INK};text-align:right;" dir="rtl">${t.he}${c}</td>
    <td valign="middle" style="font-family:${FONT};font-size:13px;font-weight:600;color:${INK_3};text-align:left;" dir="ltr">${t.en}${c}</td>
  </tr></table>`
}

/** A framed block: icon + title + count, up to 3 rows, then "and N more". */
export function block(i: IconName, title: Bi, total: number, rows: string[], moreUrl: string, more: (n: number) => Bi, opts: { showCount?: boolean } = {}): string {
  const extra = total - Math.min(rows.length, MAX_PER_BLOCK)
  const moreLine = extra > 0
    ? `<tr><td style="padding:10px 0 2px;border-top:1px solid ${LINE};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>
        <td style="font-family:${FONT};font-size:13px;text-align:right;" dir="rtl"><a href="${moreUrl}" style="color:${BRAND};font-weight:700;text-decoration:none;">${more(extra).he}</a></td>
        <td style="font-family:${FONT};font-size:13px;text-align:left;" dir="ltr"><a href="${moreUrl}" style="color:${BRAND};text-decoration:none;">${more(extra).en}</a></td>
      </tr></table></td></tr>`
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;background:${SOFT};border:1px solid ${LINE};border-radius:12px;"><tr><td style="padding:12px 14px 6px;">
    ${titleRow(i, title, opts.showCount === false ? null : total)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${rows.slice(0, MAX_PER_BLOCK).join('')}${moreLine}</table>
  </td></tr></table>`
}

/** A post with its first words and counts (site icons, no emoji). */
export function postCard(text: string, author?: { name: string; avatarUrl: string } | null, counts?: { likes?: number; comments?: number; views?: number }, link?: string): string {
  const stat = (i: IconName, n?: number) => (n ? `<td style="padding-left:12px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-left:4px;">${icon(i, 16)}</td><td style="font-family:${FONT};font-size:12.5px;color:${INK_2};">${n.toLocaleString('en-US')}</td></tr></table></td>` : '')
  const stats = counts ? stat('views', counts.views) + stat('like', counts.likes) + stat('comment', counts.comments) : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background:#fff;border:1px solid ${LINE};border-radius:10px;"><tr><td style="padding:12px 14px;">
    ${author ? `<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin-bottom:6px;"><tr><td style="padding-left:8px;"><img src="${author.avatarUrl}" width="28" height="28" alt="" style="display:block;border-radius:50%;border:0;"></td><td style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};" dir="auto">${esc(author.name)}</td></tr></table>` : ''}
    <div style="font-family:${FONT};font-size:14px;line-height:1.55;color:${INK};text-align:right;" dir="auto">${link ? `<a href="${link}" style="color:${INK};text-decoration:none;">${cut(text, 140)}</a>` : cut(text, 140)}</div>
    ${stats ? `<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin-top:8px;"><tr>${stats}</tr></table>` : ''}
  </td></tr></table>`
}

// ───────────── the one small nudge (state-based) ─────────────

export type Nudge =
  | { kind: 'profile'; pct: number }
  | { kind: 'invites'; left: number }
  | { kind: 'requests'; count: number }
  | { kind: 'post' }
  | null

export function nudgeLine(n: Nudge): string {
  if (!n) return ''
  const a = (href: string, t: string) => `<a href="${href}" style="color:${BRAND};font-weight:700;">${t}</a>`
  let line: Bi
  if (n.kind === 'profile') {
    line = { he: `הפרופיל שלך מלא ב-${n.pct}%. ${a(`${APP_URL()}/profile`, 'להשלמת הפרופיל')}`, en: `Your profile is ${n.pct}% complete. ${a(`${APP_URL()}/profile`, 'Complete your profile')}` }
  } else if (n.kind === 'invites') {
    const u = `${APP_URL()}/innercircle/sent-invitations`
    line = n.left === 1
      ? { he: `יש לך הזמנה אחת לעמיתה השבוע. ${a(u, 'להזמנת עמיתה')}`, en: `You have 1 invitation this week. ${a(u, 'Invite a colleague')}` }
      : { he: `יש לך ${n.left} הזמנות לעמיתות השבוע. ${a(u, 'להזמנת עמיתה')}`, en: `You have ${n.left} invitations this week. ${a(u, 'Invite a colleague')}` }
  } else if (n.kind === 'requests') {
    const u = `${APP_URL()}/innercircle/requests`
    line = n.count === 1
      ? { he: `בקשת חיבור אחת מחכה לך. ${a(u, 'לבקשות')}`, en: `1 connection request is waiting. ${a(u, 'See requests')}` }
      : { he: `${n.count} בקשות חיבור מחכות לך. ${a(u, 'לבקשות')}`, en: `${n.count} connection requests are waiting. ${a(u, 'See requests')}` }
  } else {
    line = { he: `יש לך משהו מהשבוע שתרצי לשתף? ${a(`${APP_URL()}/`, 'לכתיבת פוסט')}`, en: `Anything from your week you'd like to share? ${a(`${APP_URL()}/`, 'Write a post')}` }
  }
  return `<div style="height:16px"></div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px dashed ${LINE};"><tr><td style="padding-top:12px;">${biColumns({ he: paragraph(line.he), en: paragraph(line.en) }, { tight: true })}</td></tr></table>`
}

const layout = (h: Bi, lead: Bi | null, rest: string, cta: { label: Bi; url: string }, nudge: Nudge, preheader: Bi, unsubscribeUrl: string | null) =>
  renderLayout({
    preheader,
    body: biColumns({ he: heading(h.he) + (lead ? paragraph(lead.he) : ''), en: heading(h.en) + (lead ? paragraph(lead.en) : '') }) +
      rest + button(cta.label, cta.url) + nudgeLine(nudge),
    reason: MEMBER_REASON,
    unsubscribeUrl,
  })

const URL = {
  requests: () => `${APP_URL()}/innercircle/requests`,
  messages: () => `${APP_URL()}/innercircle/messages`,
  connections: () => `${APP_URL()}/innercircle/connections`,
  recruiters: () => `${APP_URL()}/innercircle/recruiter-pending`,
  feed: () => `${APP_URL()}/`,
}

// ───────────── B · network update ─────────────

export interface NetworkUpdate {
  firstName: string
  recruiters: Array<Person>
  messages: Array<{ from: Person; count: number }>
  messagesTotal: number              // conversations with unread messages
  mentions: Array<{ by: Person; where: 'post' | 'comment' | 'article'; text: string }>
  mentionsTotal: number
  requests: Person[]
  requestsTotal: number
  accepted: Person[]
  acceptedTotal: number
}

/** Subject from the most important item: recruiter > message > mention > request > accepted. */
export function networkSubject(u: NetworkUpdate): string {
  if (u.recruiters.length) return `${u.recruiters[0].name} מבקשת לראות פרטים מהפרופיל שלך | ${u.recruiters[0].name} asked to see your profile details`
  if (u.messagesTotal === 1) return `${u.messages[0].from.name} שלחה לך הודעה | ${u.messages[0].from.name} sent you a message`
  if (u.messagesTotal > 1) return `יש לך הודעות חדשות מ-${u.messagesTotal} חברות | New messages from ${u.messagesTotal} members`
  if (u.mentions.length) return `${u.mentions[0].by.name} תייגה אותך | ${u.mentions[0].by.name} mentioned you`
  if (u.requestsTotal === 1) return `${u.requests[0].name} רוצה להתחבר איתך | ${u.requests[0].name} wants to connect`
  if (u.requestsTotal > 1) return `${u.requestsTotal} בקשות חיבור חדשות | ${u.requestsTotal} new connection requests`
  return `${u.accepted[0]?.name ?? ''} אישרה את בקשת החיבור שלך | ${u.accepted[0]?.name ?? ''} accepted your request`
}

export function renderNetworkUpdate(u: NetworkUpdate, nudge: Nudge, unsubscribeUrl: string | null): string {
  const n = nm(u.firstName)
  let rest = ''
  if (u.recruiters.length) {
    rest += block('recruiter', { he: 'פניות ממגייסות', en: 'Recruiter requests' }, u.recruiters.length,
      u.recruiters.map((p) => row(p, { action: { he: 'מבקשת לראות פרטים מהפרופיל שלך', en: 'asked to see details from your profile' }, headline: p.headline })),
      URL.recruiters(), (k) => ({ he: `ועוד ${k} פניות באתר`, en: `and ${k} more on duallin` }))
  }
  if (u.messages.length) {
    rest += block('messages', { he: 'הודעות שלא קראת', en: 'Unread messages' }, u.messagesTotal,
      u.messages.map((m) => row(m.from, { sub: plural(m.count, { he: 'הודעה חדשה', en: '1 new message' }, (k) => ({ he: `${k} הודעות חדשות`, en: `${k} new messages` })) })),
      URL.messages(), (k) => ({ he: `ועוד ${k} שיחות עם הודעות חדשות`, en: `and ${k} more conversations` }))
  }
  if (u.mentions.length) {
    const where = (w: string): Bi => (w === 'comment' ? { he: 'תייגה אותך בתגובה', en: 'mentioned you in a comment' } : w === 'article' ? { he: 'תייגה אותך במאמר', en: 'mentioned you in an article' } : { he: 'תייגה אותך בפוסט', en: 'mentioned you in a post' })
    rest += block('mention', { he: 'תיוגים', en: 'Mentions' }, u.mentionsTotal,
      u.mentions.map((m) => row(m.by, { action: where(m.where), quote: m.text })),
      URL.feed(), (k) => ({ he: `ועוד ${k} תיוגים באתר`, en: `and ${k} more on duallin` }))
  }
  if (u.requests.length) {
    rest += block('connection-request', { he: 'בקשות חיבור', en: 'Connection requests' }, u.requestsTotal,
      u.requests.map((p) => row(p, { headline: p.headline, sub: mutualLine(p) })),
      URL.requests(), (k) => ({ he: `ועוד ${k} בקשות מחכות לך`, en: `and ${k} more requests waiting` }))
  }
  if (u.accepted.length) {
    rest += block('connection-accepted', { he: 'אישרו את בקשת החיבור שלך', en: 'Accepted your request' }, u.acceptedTotal,
      u.accepted.map((p) => row(p, { headline: p.headline })),
      URL.connections(), (k) => ({ he: `ועוד ${k} באתר`, en: `and ${k} more` }))
  }
  // The button goes where the most important item is.
  const cta = u.recruiters.length ? { label: { he: 'לצפייה בפנייה', en: 'View request' }, url: URL.recruiters() }
    : u.messages.length ? { label: { he: 'לקריאת ההודעות', en: 'Read messages' }, url: URL.messages() }
    : u.mentions.length ? { label: { he: 'לצפייה בתיוג', en: 'See the mention' }, url: URL.feed() }
    : u.requests.length ? { label: { he: 'לבקשות החיבור', en: 'See requests' }, url: URL.requests() }
    : { label: { he: 'לרשת שלך', en: 'Your network' }, url: URL.connections() }
  return layout(
    { he: n ? `${n}, יש לך עדכונים בדואולין` : 'יש לך עדכונים בדואולין', en: n ? `${n}, you have updates on duallin` : 'You have updates on duallin' },
    null, rest, cta, nudge, { he: 'מה חדש אצלך בדואולין', en: "What's new for you on duallin" }, unsubscribeUrl)
}

// ───────────── B · a request still pending after 5 days (once) ─────────────

export function renderRequestReminder(firstName: string, requests: Person[], total: number, unsubscribeUrl: string | null): string {
  const n = nm(firstName)
  return layout(
    { he: n ? `${n}, ${total === 1 ? 'בקשת חיבור מחכה לך' : `${total} בקשות חיבור מחכות לך`}` : 'בקשות חיבור מחכות לך',
      en: n ? `${n}, ${total === 1 ? 'a connection request is waiting' : `${total} connection requests are waiting`}` : 'Connection requests are waiting' },
    { he: 'כל חיבור מרחיב את הרשת שלך - ואת ההזדמנויות שמגיעות דרכה.', en: 'Every connection widens your network - and the opportunities that come through it.' },
    block('connection-request', { he: 'בקשות חיבור', en: 'Connection requests' }, total,
      requests.map((p) => row(p, { headline: p.headline, sub: mutualLine(p) })),
      URL.requests(), (k) => ({ he: `ועוד ${k} בקשות מחכות לך`, en: `and ${k} more requests waiting` })),
    { label: { he: 'לבקשות החיבור', en: 'See requests' }, url: URL.requests() },
    null, { he: 'עדיין לא ענית', en: "You haven't replied yet" }, unsubscribeUrl)
}

// ───────────── C · comments & likes on her posts (evening, only if worth it) ─────────────

export interface ContentDigest {
  firstName: string
  comments: Array<{ by: Person; kind: 'comment' | 'reply'; text: string }>
  commentsTotal: number
  /** Per post: one liker's name + how many others. At most 2 posts shown. */
  likes: Array<{ postText: string; firstLiker: string; others: number }>
  likedPostsTotal: number
}

export function renderContentDigest(d: ContentDigest, nudge: Nudge, unsubscribeUrl: string | null): string {
  const n = nm(d.firstName)
  let rest = ''
  if (d.comments.length) {
    const action = (k: string): Bi => (k === 'reply' ? { he: 'ענתה לתגובה שלך', en: 'replied to your comment' } : { he: 'הגיבה לפוסט שלך', en: 'commented on your post' })
    rest += block('comment', { he: 'תגובות חדשות', en: 'New comments' }, d.commentsTotal,
      d.comments.map((c) => row(c.by, { action: action(c.kind), quote: c.text })),
      URL.feed(), (k) => ({ he: `ועוד ${k} תגובות באתר`, en: `and ${k} more comments on duallin` }))
  }
  if (d.likes.length) {
    rest += block('like', { he: 'אהבו את מה שכתבת', en: 'Liked what you wrote' }, d.likedPostsTotal,
      d.likes.slice(0, 2).map((l) => `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};">
        <div style="font-family:${FONT};font-size:14px;color:${INK};" dir="rtl"><b dir="auto">${esc(l.firstLiker)}</b>${l.others ? ` ו-${l.others} נוספות` : ''} אהבו את הפוסט שלך</div>
        <div style="font-family:${FONT};font-size:12px;color:${INK_3};" dir="ltr"><span dir="auto">${esc(l.firstLiker)}</span>${l.others ? ` and ${l.others} others` : ''} liked your post</div>
        <div style="font-family:${FONT};font-size:13px;color:${INK_2};margin-top:4px;text-align:right;" dir="auto">"${cut(l.postText, 80)}"</div></td></tr>`),
      URL.feed(), (k) => ({ he: `ועוד ${k} פוסטים עם לייקים חדשים`, en: `and ${k} more posts with new likes` }), { showCount: false })
  }
  return layout(
    { he: n ? `${n}, חברות הגיבו על מה שכתבת` : 'חברות הגיבו על מה שכתבת', en: n ? `${n}, members responded to what you wrote` : 'Members responded to what you wrote' },
    null, rest,
    { label: { he: 'לצפייה בתגובות', en: 'See the comments' }, url: URL.feed() },
    nudge, { he: 'פעילות חדשה על הפוסטים שלך', en: 'New activity on your posts' }, unsubscribeUrl)
}

// ───────────── C · "your post was seen N times" (3 days after posting) ─────────────

export function renderPostViews(firstName: string, post: { text: string; views: number; likes: number; comments: number }, nudge: Nudge, unsubscribeUrl: string | null): string {
  const n = nm(firstName)
  return layout(
    { he: `הפוסט שלך נצפה ${post.views.toLocaleString('en-US')} פעמים`, en: `Your post was seen ${post.views.toLocaleString('en-US')} times` },
    { he: `${n ? `${n}, ` : ''}מה שכתבת הגיע לחברות בקהילה. תודה ששיתפת.`, en: `${n ? `${n}, ` : ''}what you wrote reached members of the community. Thank you for sharing.` },
    postCard(post.text, null, { views: post.views, likes: post.likes, comments: post.comments }, URL.feed()),
    { label: { he: 'לצפייה בפוסט', en: 'See your post' }, url: URL.feed() },
    nudge, { he: `${post.views} צפיות בפוסט שלך`, en: `${post.views} views on your post` }, unsubscribeUrl)
}

// ───────────── C · first post celebration ─────────────

export function renderFirstPost(firstName: string, post: { text: string; views: number; likes: number; comments: number }, unsubscribeUrl: string | null): string {
  const n = nm(firstName)
  return layout(
    { he: `${n ? `${n}, ` : ''}פרסמת את הפוסט הראשון שלך!`, en: `${n ? `${n}, ` : ''}you published your first post!` },
    { he: `הוא כבר נצפה ${post.views} פעמים. הקהילה שמחה לשמוע ממך.`, en: `It has already been seen ${post.views} times. The community is glad to hear from you.` },
    postCard(post.text, null, { views: post.views, likes: post.likes, comments: post.comments }, URL.feed()),
    { label: { he: 'לצפייה בפוסט', en: 'See your post' }, url: URL.feed() },
    null, { he: 'הפוסט הראשון שלך כבר נקרא', en: 'Your first post is being read' }, unsubscribeUrl)
}

// ───────────── C · people you may know (every 2 weeks) ─────────────

export function renderPeopleYouMayKnow(firstName: string, people: Person[], total: number, nudge: Nudge, unsubscribeUrl: string | null): string {
  const n = nm(firstName)
  return layout(
    { he: n ? `${n}, אולי את מכירה אותן?` : 'אולי את מכירה אותן?', en: n ? `${n}, do you know them?` : 'Do you know them?' },
    { he: 'חברות בקהילה שיש לך איתן חיבורים משותפים.', en: 'Members you share connections with.' },
    block('connection-request', { he: 'אנשים שאולי תכירי', en: 'People you may know' }, total,
      people.map((p) => row(p, { headline: p.headline, sub: mutualLine(p) })),
      URL.connections(), (k) => ({ he: `ועוד ${k} הצעות באתר`, en: `and ${k} more suggestions` })),
    { label: { he: 'לכל ההצעות', en: 'See all suggestions' }, url: URL.connections() },
    nudge, { he: 'חברות שאולי תכירי', en: 'People you may know' }, unsubscribeUrl)
}

// ───────────── C · the week in the community (active members) ─────────────

export interface WeeklyCommunity {
  firstName: string
  /** Personal part (2026-11-05): what her own connections shared this week. */
  network: {
    hasConnections: boolean
    milestones: Array<{ author: { name: string; avatarUrl: string }; text: string; likes: number; comments: number }>
    posts: Array<{ author: { name: string; avatarUrl: string }; text: string; likes: number; comments: number }>
  }
  /** Only posts the author marked as "question" (post_type = 'question'), with at most 1 comment. */
  questions: Array<{ author: { name: string; avatarUrl: string }; text: string }>
  topPosts: Array<{ author: { name: string; avatarUrl: string }; text: string; likes: number; comments: number }>
  articles: Array<{ id: string | number; title: string }>
  newMembers: number
  stats: CommunityStats | null
}

export function renderWeeklyCommunity(w: WeeklyCommunity, nudge: Nudge, unsubscribeUrl: string | null): string {
  const n = nm(w.firstName)
  // One clear frame per section: a tinted header bar (icon + title), then plain rows separated by
  // thin lines — no card inside a card, so the eye sees where each part starts and ends.
  const frame = (i: IconName, t: Bi, inner: string, footer = '') =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 0;border:1px solid ${LINE};border-radius:12px;border-collapse:separate;overflow:hidden;">
      <tr><td style="background:${HEADER_TINT};padding:10px 14px;border-bottom:1px solid ${LINE};border-radius:12px 12px 0 0;">${titleRow(i, t, null)}</td></tr>
      <tr><td style="padding:2px 14px 4px;background:#fff;">${inner}</td></tr>
      ${footer ? `<tr><td style="padding:8px 14px 12px;background:#fff;border-radius:0 0 12px 12px;">${footer}</td></tr>` : ''}
    </table>`
  const postRow = (p: { author: { name: string; avatarUrl: string }; text: string; likes?: number; comments?: number }, first: boolean, extra = '') => {
    const stat = (i: IconName, v?: number) => (v ? `<td style="padding-left:12px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-left:4px;">${icon(i, 14)}</td><td style="font-family:${FONT};font-size:12px;color:${INK_3};">${v}</td></tr></table></td>` : '')
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="${first ? '' : `border-top:1px solid ${LINE};`}"><tr>
      <td width="40" valign="top" style="padding:12px 0 12px 10px;"><img src="${p.author.avatarUrl}" width="32" height="32" alt="" style="display:block;border-radius:50%;border:0;"></td>
      <td valign="top" style="padding:12px 0;">
        <div style="font-family:${FONT};font-size:13px;font-weight:700;color:${INK};text-align:right;" dir="auto">${esc(p.author.name)}</div>
        <div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${INK_2};margin-top:2px;text-align:right;" dir="auto"><a href="${URL.feed()}" style="color:${INK_2};text-decoration:none;">${cut(p.text, 120)}</a></div>
        ${(p.likes || p.comments) ? `<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin-top:6px;"><tr>${stat('like', p.likes)}${stat('comment', p.comments)}</tr></table>` : ''}
        ${extra}
      </td></tr></table>`
  }
  const link2 = (href: string, t: Bi) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl"><tr>
      <td style="font-family:${FONT};font-size:13px;text-align:right;" dir="rtl"><a href="${href}" style="color:${BRAND};font-weight:700;">${t.he}</a></td>
      <td style="font-family:${FONT};font-size:13px;text-align:left;" dir="ltr"><a href="${href}" style="color:${BRAND};">${t.en}</a></td>
    </tr></table>`

  let rest = ''
  // 1. From your network — people she knows are what makes the email worth opening.
  const net = w.network
  const netItems = [
    ...net.milestones.slice(0, 1).map((m) => ({ ...m, milestone: true })),
    ...net.posts.map((p) => ({ ...p, milestone: false })),
  ].slice(0, 2)
  if (netItems.length) {
    rest += frame('connection-accepted', { he: 'מהרשת שלך', en: 'From your network' },
      netItems.map((p, i) => postRow(p, i === 0, p.milestone
        ? `<div style="margin-top:6px;font-family:${FONT};font-size:12.5px;" dir="rtl"><a href="${URL.feed()}" style="color:${BRAND};font-weight:700;">שיתפה אבן דרך - ברכי אותה</a> <span style="color:${INK_3};" dir="ltr">· Congratulate her</span></div>`
        : '')).join(''))
  } else if (!net.hasConnections) {
    rest += frame('connection-accepted', { he: 'מהרשת שלך', en: 'From your network' },
      `<div style="padding:10px 0;">${biColumns({
        he: paragraph(`עוד אין לך חיבורים בדואולין. <a href="${URL.connections()}" style="color:${BRAND};font-weight:700;">התחברי לעמיתות</a> כדי לראות כאן מה הן משתפות.`),
        en: paragraph(`No connections yet. <a href="${URL.connections()}" style="color:${BRAND};font-weight:700;">Connect with colleagues</a> to see what they share here.`),
      }, { tight: true })}</div>`)
  }
  // 2. A question waiting for an answer
  if (w.questions.length) {
    rest += frame('question', { he: 'שאלה שמחכה לתשובה', en: 'A question waiting for an answer' },
      postRow(w.questions[0], true),
      link2(URL.feed(), { he: 'אולי את יודעת את התשובה?', en: 'Maybe you know the answer?' }))
  }
  // 3. Talked about this week
  if (w.topPosts.length) {
    rest += frame('comment', { he: 'דיברו על זה השבוע', en: 'Talked about this week' },
      w.topPosts.slice(0, 2).map((p, i) => postRow(p, i === 0)).join(''))
  }
  // 4. New articles
  if (w.articles.length) {
    rest += frame('article', { he: 'מאמרים חדשים', en: 'New articles' },
      w.articles.slice(0, 2).map((a, i) => `<div style="padding:10px 0;${i ? `border-top:1px solid ${LINE};` : ''}text-align:right;" dir="auto"><a href="${APP_URL()}/articles/article/${encodeURIComponent(String(a.id))}" style="font-family:${FONT};font-size:14px;font-weight:600;color:${BRAND};text-decoration:none;">${esc(a.title)}</a></div>`).join(''))
  }
  if (w.stats) rest += `<div style="height:6px"></div>${statsRow(w.stats, { intro: false })}`
  const joined: Bi | null = w.newMembers >= 5
    ? { he: `השבוע הצטרפו ${w.newMembers} חברות חדשות לקהילה.`, en: `${w.newMembers} new members joined the community this week.` }
    : null
  return layout(
    { he: n ? `${n}, זה מה שקרה השבוע בדואולין` : 'זה מה שקרה השבוע בדואולין', en: n ? `${n}, this week on duallin` : 'This week on duallin' },
    joined, rest,
    { label: { he: 'לקהילה', en: 'Go to the community' }, url: URL.feed() },
    nudge, { he: 'שאלות, דיונים ומאמרים מהשבוע', en: 'Questions, discussions and articles from the week' }, unsubscribeUrl)
}

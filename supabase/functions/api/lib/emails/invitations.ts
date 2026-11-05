// Invitation emails (email plan, group C + A3). All time-based → they respect the send window.
//   C1 · invites_unlocked  — once, when a member passes the invite gate (same rule as POST /invite).
//        invites_reminder_1 — 14 days later if she hasn't sent an invitation since.
//        invites_reminder_2 — 30 days after reminder 1, same condition. Then it stops for good.
//        Decided 2026-11-04: the user fears nagging, so the cadence decays and stops by itself;
//        "worked" = she sent an invitation after the email (not opens). Members who already
//        invited someone before get a thank-you ("invites_thanks") instead of "unlocked", then the
//        same two reminders if they don't invite again.
//   C2 · invitee_joined — to the inviter, when the colleague she invited finishes onboarding.
//   A3 · invite_reminder — to the invitee (not a member), 3 days after the invitation, once,
//        while it's still pending and not expired (invitations expire after 7 days).
import { adminClient, normalizeEmail } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { countInvitesThisWeek, effectiveLimit, getInviteQuota } from '../../routes/invite.ts'
import { outOfTime } from './runClock.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
const BRAND = '#4b154c'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

const REMINDER_1_AFTER_DAYS = 14
const REMINDER_2_AFTER_DAYS = 30
const INVITEE_REMINDER_AFTER_DAYS = 3
const JOINED_LOOKBACK_DAYS = 3

type JobResult = { sent: number; attempts: number }
const none: JobResult = { sent: 0, attempts: 0 }

// dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
const nameSpan = (n: string) => (n.trim() ? `<span dir="auto">${esc(n.trim())}</span>` : '')
const fullName = (u: { first_name?: string | null; last_name?: string | null } | null) =>
  [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim()

function quotaBox(left: number): string {
  if (left <= 0) return ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="margin:16px 0 6px;background:#faf5fb;border:1px solid ${LINE};border-radius:10px;"><tr>
    <td align="center" style="padding:14px 8px;">
      <div style="font-family:${FONT};font-size:26px;font-weight:800;color:${BRAND};line-height:1.2;">${left}</div>
      <div style="font-family:${FONT};font-size:13px;color:#4a4a50;margin-top:2px;" dir="rtl">${left === 1 ? 'הזמנה אישית זמינה לך השבוע' : 'הזמנות אישיות זמינות לך השבוע'}</div>
      <div style="font-family:${FONT};font-size:12px;color:#86838b;" dir="ltr">${left === 1 ? 'personal invitation available this week' : 'personal invitations available this week'}</div>
    </td></tr></table>`
}

// ───────────────────────── C1 · invitations unlocked + 2 reminders ─────────────────────────

const UNLOCK_STAGES = {
  invites_unlocked: {
    subject: { he: 'נפתחו לך הזמנות אישיות לעמיתות', en: 'You can now invite colleagues' },
    preheader: { he: 'את יכולה להזמין לדואולין נשים שאת מכירה מהתחום', en: 'Invite women you know from the field to duallin' },
    heading: (n: string): Bi => ({ he: n ? `${n}, נפתחו לך הזמנות אישיות` : 'נפתחו לך הזמנות אישיות', en: n ? `${n}, your invitations are open` : 'Your invitations are open' }),
    text: {
      he: 'הפרופיל והפעילות שלך פתחו לך אפשרות להזמין לדואולין עמיתות שאת מכירה ומעריכה. כל הזמנה היא אישית, וכך הקהילה נשארת מהימנה.',
      en: 'Your profile and activity have unlocked personal invitations: you can invite colleagues you know and trust. Every invitation is personal - that is how the community stays trusted.',
    },
  },
  invites_thanks: {
    subject: { he: 'תודה שאת מגדלת את הקהילה', en: 'Thank you for growing the community' },
    preheader: { he: 'יש לך הזמנות זמינות השבוע', en: 'You have invitations available this week' },
    heading: (n: string): Bi => ({ he: n ? `${n}, תודה שאת מגדלת את הקהילה` : 'תודה שאת מגדלת את הקהילה', en: n ? `${n}, thank you for growing the community` : 'Thank you for growing the community' }),
    text: {
      he: 'כבר הזמנת עמיתות לדואולין - תודה. ההזמנות שלך מתחדשות בכל שבוע, ויש עוד נשים שיכולות להרוויח מהקהילה ולתרום לה.',
      en: "You've already invited colleagues to duallin - thank you. Your invitations renew every week, and there are more women who could gain from the community and add to it.",
    },
  },
  invites_reminder_1: {
    subject: { he: 'יש עמיתה שהיית רוצה לראות בדואולין?', en: 'A colleague you would like to see on duallin?' },
    preheader: { he: 'ההזמנות שלך עדיין מחכות', en: 'Your invitations are still waiting' },
    heading: (): Bi => ({ he: 'יש עמיתה שהיית רוצה לראות כאן?', en: 'A colleague you would like to see here?' }),
    text: {
      he: 'חברה מהעבודה, מהלימודים או מהקורס - מישהי שתרוויח מהקהילה ותתרום לה. הזמנה אישית ממך היא הדרך הכי טובה להצטרף.',
      en: 'A friend from work, from your studies or a course - someone who would gain from the community and add to it. A personal invitation from you is the best way in.',
    },
  },
  invites_reminder_2: {
    subject: { he: 'ההזמנות שלך עדיין זמינות', en: 'Your invitations are still available' },
    preheader: { he: 'תזכורת אחרונה בנושא', en: 'A last reminder about it' },
    heading: (): Bi => ({ he: 'ההזמנות שלך עדיין זמינות', en: 'Your invitations are still available' }),
    text: {
      he: 'זו התזכורת האחרונה שנשלח בנושא. ההזמנות נשארות זמינות לך בכל שבוע, מתי שתרצי.',
      en: "This is the last reminder we'll send about it. Your invitations stay available every week, whenever you want.",
    },
  },
} as const
type UnlockKind = keyof typeof UNLOCK_STAGES

// Why inviting matters — in every invitation email (product owner, 2026-11-04: grow as much as possible).
const GROW: Bi = { he: 'ככל שיותר נשות מקצוע מצטרפות, הקהילה מועילה יותר לכולן: יותר קשרים, יותר הזדמנויות ויותר ידע.', en: 'The more professional women join, the more useful the community is for everyone: more connections, more opportunities and more knowledge.' }

export function renderInvitesEmail(kind: UnlockKind, firstName: string, left: number, unsubscribeUrl: string | null): string {
  const s = UNLOCK_STAGES[kind]
  const h = s.heading(nameSpan(firstName))
  const body =
    biColumns({ he: heading(h.he) + paragraph(s.text.he) + paragraph(GROW.he), en: heading(h.en) + paragraph(s.text.en) + paragraph(GROW.en) }) +
    quotaBox(left) +
    button({ he: 'להזמנת עמיתה', en: 'Invite a colleague' }, `${APP_URL()}/innercircle/sent-invitations`)
  return renderLayout({
    preheader: s.preheader,
    body,
    reason: { he: 'קיבלת את המייל הזה כי את חברה בדואולין.', en: "You received this email because you're a duallin member." },
    unsubscribeUrl,
  })
}

/** Which invitations email is due, given what she already got and whether she invited since. */
export function dueInvitesEmail(
  sent: { unlockedAt?: number; reminder1At?: number; reminder2?: boolean },
  invitedSinceUnlock: boolean,
  now = Date.now(),
): UnlockKind | null {
  if (!sent.unlockedAt) return 'invites_unlocked'
  if (invitedSinceUnlock || sent.reminder2) return null
  if (!sent.reminder1At) return now - sent.unlockedAt >= REMINDER_1_AFTER_DAYS * DAY ? 'invites_reminder_1' : null
  return now - sent.reminder1At >= REMINDER_2_AFTER_DAYS * DAY ? 'invites_reminder_2' : null
}

export async function invitesUnlockedJob(budget: number): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  // Candidates from the cached scores (cheap); the real gate is re-checked before sending.
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString()
  const { data: members, error } = await db.from('users')
    .select('uuid, email, first_name')
    .eq('status', 'Active').lte('created_at', weekAgo)
    .gte('profile_strength_cache', 70).gte('activity_score_cache', 31)
    .limit(1000)
  if (error) throw new Error(error.message)
  if (!members?.length) return none

  const kinds = Object.keys(UNLOCK_STAGES) // includes invites_thanks
  const { data: logs } = await db.from('email_log').select('user_id, kind, created_at')
    .in('kind', kinds).in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped']).limit(5000)
  const history = new Map<string, { unlockedAt?: number; reminder1At?: number; reminder2?: boolean }>()
  for (const l of logs ?? []) {
    if (!l.user_id) continue
    const h = history.get(l.user_id) ?? {}
    const at = new Date(l.created_at).getTime()
    if (l.kind === 'invites_unlocked' || l.kind === 'invites_thanks') h.unlockedAt = at
    if (l.kind === 'invites_reminder_1') h.reminder1At = at
    if (l.kind === 'invites_reminder_2') h.reminder2 = true
    history.set(l.user_id, h)
  }

  // Members who already invited someone don't need "your invitations are open" (many passed the
  // gate long before this email existed). Paged: PostgREST returns at most 1000 rows per request.
  const inviters = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error: invErr } = await db.from('invites').select('inviter_id').order('id').range(from, from + 999)
    if (invErr) throw new Error(invErr.message)
    for (const r of data ?? []) if (r.inviter_id) inviters.add(r.inviter_id)
    if (!data || data.length < 1000) break
  }

  let attempts = 0
  let sent = 0
  for (const m of members) {
    if (attempts >= budget || outOfTime()) break
    if (!m.email) continue
    const h = history.get(m.uuid) ?? {}
    // Time first (no queries); only a reminder that is due needs "did she invite since?".
    const due = dueInvitesEmail(h, false)
    if (!due) continue
    // Already invited before this email existed → a thank-you, not "your invitations are open".
    const kind: UnlockKind = due === 'invites_unlocked' && inviters.has(m.uuid) ? 'invites_thanks' : due
    if (kind === 'invites_reminder_1' || kind === 'invites_reminder_2') {
      const { count } = await db.from('invites').select('id', { count: 'exact', head: true })
        .eq('inviter_id', m.uuid).gte('created_at', new Date(h.unlockedAt!).toISOString())
      if ((count ?? 0) > 0) continue // she invited — the email did its job, no more reminders
    }

    // Same gate as POST /invite (fresh scores, admin grants), and what's left this week.
    const quota = await getInviteQuota(db, { id: m.uuid, email: m.email }).catch(() => null)
    if (!quota || quota.gateFailure) continue
    const used = (await countInvitesThisWeek(db, m.uuid))?.count ?? 0
    const left = quota.unlimited ? 0 : Math.max(0, effectiveLimit(quota) - used)
    if (!quota.unlimited && left === 0) continue // nothing to invite with right now; try next hour

    attempts++
    const s = UNLOCK_STAGES[kind]
    const name = (m.first_name ?? '').trim()
    const r = await sendEmail({
      kind,
      category: 'invitations',
      to: m.email,
      userId: m.uuid,
      refKey: 'v1',
      subject: `${s.subject.he} | ${s.subject.en}`,
      html: ({ unsubscribeUrl }) => renderInvitesEmail(kind, name, left, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts-- // held by the per-member cap — doesn't use the hour's budget
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C2 · the colleague you invited joined ─────────────────────────

export function renderInviteeJoined(inviterFirstName: string, inviteeName: string, inviteeId: string, unsubscribeUrl: string | null): string {
  const n = nameSpan(inviterFirstName)
  const who = nameSpan(inviteeName) || 'העמיתה שהזמנת'
  const whoEn = nameSpan(inviteeName) || 'The colleague you invited'
  const body =
    biColumns({
      he: heading(`${who} הצטרפה לדואולין`) + paragraph(`${n ? `${n}, ` : ''}בזכות ההזמנה שלך יש לקהילה חברה חדשה. זה רגע טוב לברך אותה ולהתחבר.`),
      en: heading(`${whoEn} joined duallin`) + paragraph(`${n ? `${n}, ` : ''}thanks to your invitation the community has a new member. A good moment to welcome her and connect.`),
    }) +
    button({ he: 'לפרופיל שלה', en: 'See her profile' }, `${APP_URL()}/profile/${encodeURIComponent(inviteeId)}`) +
    // The best moment to invite one more: her invitation just worked.
    `<div style="height:14px"></div>` +
    biColumns({
      he: paragraph(`יש עוד מישהי שהיית רוצה לראות כאן? <a href="${APP_URL()}/innercircle/sent-invitations" style="color:${BRAND};font-weight:700;">להזמנת עמיתה נוספת</a>`),
      en: paragraph(`Someone else you'd like to see here? <a href="${APP_URL()}/innercircle/sent-invitations" style="color:${BRAND};font-weight:700;">Invite another colleague</a>`),
    }, { tight: true })
  return renderLayout({
    preheader: { he: 'ההזמנה שלך הצליחה', en: 'Your invitation worked' },
    body,
    reason: { he: 'קיבלת את המייל הזה כי הזמנת אותה לדואולין.', en: 'You received this email because you invited her to duallin.' },
    unsubscribeUrl,
  })
}

export async function inviteeJoinedJob(budget: number): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const since = new Date(Date.now() - JOINED_LOOKBACK_DAYS * DAY).toISOString()
  // Members who finished onboarding recently (activated_at is set by PUT /me/status).
  const { data: joined } = await db.from('users').select('uuid, email, first_name, last_name')
    .eq('status', 'Active').gte('activated_at', since).limit(500)
  if (!joined?.length) return none
  const { data: done } = await db.from('email_log').select('ref_key').eq('kind', 'invitee_joined')
    .gte('created_at', new Date(Date.now() - (JOINED_LOOKBACK_DAYS + 1) * DAY).toISOString())
    .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const told = new Set((done ?? []).map((r) => r.ref_key))

  let attempts = 0
  let sent = 0
  for (const j of joined) {
    if (attempts >= budget || outOfTime()) break
    if (!j.email) continue
    const { data: invite } = await db.from('invites').select('id, inviter_id')
      .eq('recipient_email', normalizeEmail(j.email)).eq('status', 'accepted')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!invite?.inviter_id || told.has(String(invite.id))) continue
    const { data: inviter } = await db.from('users').select('uuid, email, first_name, status')
      .eq('uuid', invite.inviter_id).maybeSingle()
    if (!inviter?.email || inviter.status !== 'Active') continue

    attempts++
    const r = await sendEmail({
      kind: 'invitee_joined',
      category: 'invitations',
      to: inviter.email,
      userId: inviter.uuid,
      refKey: String(invite.id),
      subject: fullName(j) ? `${fullName(j)} הצטרפה לדואולין | ${fullName(j)} joined duallin` : 'העמיתה שהזמנת הצטרפה | Your colleague joined duallin',
      html: ({ unsubscribeUrl }) => renderInviteeJoined(inviter.first_name ?? '', fullName(j), j.uuid, unsubscribeUrl),
    })
    // A duplicate (already told) doesn't use up the hour's budget.
    if (r.status === 'skipped' && r.reason === 'duplicate') attempts--
    if (r.status === 'deferred') attempts-- // held by the per-member cap — doesn't use the hour's budget
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── A3 · reminder to the invitee ─────────────────────────

export function renderInviteReminder(inviterName: string, token: string, daysLeft: number, unsubscribeUrl: string | null): string {
  const who = nameSpan(inviterName)
  const body =
    biColumns({
      he: heading(who ? `ההזמנה של ${who} עדיין מחכה לך` : 'ההזמנה שלך עדיין מחכה לך') +
        paragraph(`${who ? `<b>${who}</b> הזמינה אותך אישית` : 'הוזמנת אישית'} לדואולין - רשת בלעדית ומהימנה לנשים חרדיות מקצועיות.`) +
        paragraph(daysLeft === 1 ? 'נשאר יום אחד להצטרף.' : `נשארו ${daysLeft} ימים להצטרף.`),
      en: heading(who ? `${who}'s invitation is still waiting` : 'Your invitation is still waiting') +
        paragraph(`${who ? `<b>${who}</b> invited you personally` : 'You were personally invited'} to duallin - a trusted, exclusive network for professional Haredi women.`) +
        paragraph(daysLeft === 1 ? '1 day left to join.' : `${daysLeft} days left to join.`),
    }) +
    button({ he: 'הצטרפי לדואולין', en: 'Join duallin' }, `${APP_URL()}/invite?token=${encodeURIComponent(token)}`)
  return renderLayout({
    preheader: { he: daysLeft === 1 ? 'נשאר יום אחד להצטרף' : `נשארו ${daysLeft} ימים להצטרף`, en: daysLeft === 1 ? '1 day left to join' : `${daysLeft} days left to join` },
    body,
    reason: { he: 'קיבלת את המייל כי חברה בדואולין הזמינה אותך אישית.', en: 'You received this because a duallin member invited you personally.' },
    unsubscribeUrl,
    hideSettingsLink: true, // she has no account yet — only the stop link works for her
  })
}

export async function inviteeReminderJob(budget: number): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const now = Date.now()
  const { data: invites } = await db.from('invites')
    .select('id, inviter_id, recipient_email, token, expires_at, created_at')
    .eq('status', 'pending')
    .lte('created_at', new Date(now - INVITEE_REMINDER_AFTER_DAYS * DAY).toISOString())
    .gt('expires_at', new Date(now + 12 * 3600 * 1000).toISOString()) // at least half a day left
    .limit(500)
  if (!invites?.length) return none
  const { data: done } = await db.from('email_log').select('ref_key').eq('kind', 'invite_reminder')
    .gte('created_at', new Date(now - 8 * DAY).toISOString()) // invitations live 7 days; avoids a huge id list in the URL
    .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const reminded = new Set((done ?? []).map((r) => r.ref_key))

  let attempts = 0
  let sent = 0
  for (const inv of invites) {
    if (attempts >= budget || outOfTime()) break
    if (!inv.recipient_email || !inv.token || reminded.has(String(inv.id))) continue
    const email = normalizeEmail(inv.recipient_email)
    const { data: member } = await db.from('users').select('uuid').eq('email', email).maybeSingle()
    if (member) continue // already has an account
    const { data: inviter } = await db.from('users').select('first_name, last_name').eq('uuid', inv.inviter_id).maybeSingle()
    const daysLeft = Math.max(1, Math.ceil((new Date(inv.expires_at).getTime() - now) / DAY))

    attempts++
    const name = fullName(inviter)
    const r = await sendEmail({
      kind: 'invite_reminder',
      category: 'invitee',
      to: email,
      refKey: String(inv.id),
      subject: name ? `ההזמנה של ${name} עדיין מחכה לך | ${name}'s invitation is still waiting` : 'ההזמנה שלך לדואולין עדיין מחכה | Your duallin invitation is still waiting',
      html: ({ unsubscribeUrl }) => renderInviteReminder(name, inv.token, daysLeft, unsubscribeUrl),
    })
    if (r.status === 'skipped' && r.reason === 'duplicate') attempts--
    if (r.status === 'deferred') attempts-- // held by the per-member cap — doesn't use the hour's budget
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// ───────────────────────── C4 · your invitation expired (to the inviter) ─────────────────────────
// Once per invitation, within 2 days after it expired unused — so she can send it again.

export function renderInviteExpired(inviterFirstName: string, inviteeEmail: string, unsubscribeUrl: string | null): string {
  const n = nameSpan(inviterFirstName)
  const who = `<b dir="ltr">${esc(inviteeEmail)}</b>`
  const body =
    biColumns({
      he: heading(n ? `${n}, ההזמנה ששלחת פגה` : 'ההזמנה ששלחת פגה') +
        paragraph(`ההזמנה ל-${who} פגה לפני שהיא הצטרפה. לפעמים מייל הולך לאיבוד או נשכח - אפשר לשלוח אותה שוב, או לכתוב לה כמה מילים אישיות.`),
      en: heading(n ? `${n}, your invitation expired` : 'Your invitation expired') +
        paragraph(`Your invitation to ${who} expired before she joined. Emails sometimes get lost or forgotten - you can send it again, or add a personal note.`),
    }) +
    button({ he: 'לשליחה מחדש', en: 'Send it again' }, `${APP_URL()}/innercircle/sent-invitations`)
  return renderLayout({
    preheader: { he: 'אפשר לשלוח את ההזמנה שוב', en: 'You can send the invitation again' },
    body,
    reason: { he: 'קיבלת את המייל הזה כי הזמנת עמיתה לדואולין.', en: 'You received this email because you invited a colleague to duallin.' },
    unsubscribeUrl,
  })
}

export async function inviteExpiredJob(budget: number): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const now = Date.now()
  const { data: invites } = await db.from('invites').select('id, inviter_id, recipient_email, expires_at')
    .in('status', ['pending', 'expired'])
    .lte('expires_at', new Date(now).toISOString()).gte('expires_at', new Date(now - 2 * DAY).toISOString()).limit(500)
  if (!invites?.length) return none
  const { data: done } = await db.from('email_log').select('ref_key').eq('kind', 'invite_expired')
    .gte('created_at', new Date(now - 4 * DAY).toISOString())
  const told = new Set((done ?? []).map((r) => r.ref_key))

  let attempts = 0
  let sent = 0
  for (const inv of invites) {
    if (attempts >= budget || outOfTime()) break
    if (!inv.inviter_id || !inv.recipient_email || told.has(String(inv.id))) continue
    const email = normalizeEmail(inv.recipient_email)
    const { data: member } = await db.from('users').select('uuid').eq('email', email).maybeSingle()
    if (member) continue // she joined after all
    const { data: inviter } = await db.from('users').select('uuid, email, first_name, status').eq('uuid', inv.inviter_id).maybeSingle()
    if (!inviter?.email || inviter.status !== 'Active') continue
    attempts++
    const r = await sendEmail({
      kind: 'invite_expired', category: 'invitations', to: inviter.email, userId: inviter.uuid, refKey: String(inv.id),
      subject: 'ההזמנה ששלחת פגה | Your invitation expired',
      html: ({ unsubscribeUrl }) => renderInviteExpired(inviter.first_name ?? '', email, unsubscribeUrl),
    })
    if (r.status === 'deferred') attempts--
    if (r.status === 'sent') sent++
  }
  return { sent, attempts }
}

// Service emails (email plan A5, H2).
//   A5 · join_request_received — to whoever filled in the join form, right away (her own action):
//        "we got your request". Essential (category 'account'): no unsubscribe, but hard blocks apply.
//   H2 · access_reply — to the recruiter when a candidate answers an access request
//        (approved / partly / declined). Hourly, once per request + answer. Recruiter copy is
//        gender-neutral (product rule for recruiters).
import { adminClient } from '../emailPrefs.ts'
import { sendEmail, type SendResult } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
type JobResult = { sent: number; attempts: number }
const none: JobResult = { sent: 0, attempts: 0 }
// dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
const nm = (s: string) => (s.trim() ? `<span dir="auto">${esc(s.trim())}</span>` : '')

// ───────────────────────── A5 · join request received ─────────────────────────

export function renderJoinRequestReceived(type: 'candidate' | 'recruiter', fullName: string): string {
  const first = nm(fullName.split(/\s+/)[0] ?? '')
  const body = type === 'recruiter'
    ? biColumns({
      he: heading(first ? `${first}, קיבלנו את הבקשה` : 'קיבלנו את הבקשה') +
        paragraph('תודה על הפנייה לדואולין. הצוות עובר על כל בקשה באופן אישי, ונחזור אליך במייל לכתובת הזו.') +
        paragraph('יש שאלה בינתיים? אפשר פשוט להשיב למייל הזה.'),
      en: heading(first ? `${first}, we got your request` : 'We got your request') +
        paragraph('Thank you for reaching out to duallin. Our team reviews every request personally, and we will get back to you at this address.') +
        paragraph('Questions in the meantime? Just reply to this email.'),
    })
    : biColumns({
      he: heading(first ? `${first}, קיבלנו את הבקשה שלך` : 'קיבלנו את הבקשה שלך') +
        paragraph('תודה שביקשת להצטרף לדואולין - הרשת המקצועית של נשות הייטק חרדיות. הצוות שלנו עובר על כל בקשה באופן אישי, ונחזור אלייך במייל לכתובת הזו.') +
        paragraph('יש שאלה בינתיים? אפשר פשוט להשיב למייל הזה.'),
      en: heading(first ? `${first}, we got your request` : 'We got your request') +
        paragraph('Thank you for asking to join duallin - the professional network for Orthodox women in tech. Our team reviews every request personally, and we will get back to you at this address.') +
        paragraph('Questions in the meantime? Just reply to this email.'),
    })
  return renderLayout({
    preheader: { he: 'הבקשה התקבלה ונבדקת', en: 'Your request was received and is being reviewed' },
    body,
    reason: { he: 'קיבלת את המייל כי השארת פרטים באתר דואולין.', en: 'You received this because you submitted your details on duallin.' },
  })
}

export function sendJoinRequestReceived(req: { type: 'candidate' | 'recruiter'; full_name: string; email: string }): Promise<SendResult> {
  return sendEmail({
    kind: 'join_request_received',
    category: 'account',
    to: req.email,
    refKey: 'join_request',
    subject: 'קיבלנו את הבקשה שלך | We got your request',
    html: () => renderJoinRequestReceived(req.type, req.full_name),
    immediate: true, // she just submitted the form
  })
}

// ───────────────────────── H2 · a candidate answered the recruiter ─────────────────────────

const ANSWER: Record<string, { subject: Bi; heading: (n: string) => Bi; text: Bi }> = {
  approved: {
    subject: { he: 'בקשת הגישה אושרה', en: 'Your access request was approved' },
    heading: (n) => ({ he: `${n || 'המועמדת'} אישרה את בקשת הגישה`, en: `${n || 'The candidate'} approved your access request` }),
    text: { he: 'הפרטים שביקשת זמינים עכשיו בפרופיל שלה.', en: 'The details you asked for are now available on her profile.' },
  },
  partial: {
    subject: { he: 'בקשת הגישה אושרה חלקית', en: 'Your access request was partly approved' },
    heading: (n) => ({ he: `${n || 'המועמדת'} אישרה חלק מהבקשה`, en: `${n || 'The candidate'} approved part of your request` }),
    text: { he: 'חלק מהפרטים שביקשת זמינים עכשיו בפרופיל שלה.', en: 'Some of the details you asked for are now available on her profile.' },
  },
  rejected: {
    subject: { he: 'התקבלה תשובה לבקשת הגישה', en: 'An answer to your access request' },
    heading: () => ({ he: 'התקבלה תשובה לבקשת הגישה', en: 'An answer to your access request' }),
    text: { he: 'המועמדת בחרה לא לשתף את הפרטים בשלב זה.', en: 'The candidate chose not to share these details at this time.' },
  },
}

export function renderAccessReply(status: 'approved' | 'partial' | 'rejected', candidateName: string, candidateId: string, unsubscribeUrl: string | null): string {
  const a = ANSWER[status]
  const h = a.heading(nm(candidateName))
  const body =
    biColumns({ he: heading(h.he) + paragraph(a.text.he), en: heading(h.en) + paragraph(a.text.en) }) +
    (status === 'rejected'
      ? button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, `${APP_URL()}/talent`)
      : button({ he: 'לפרופיל שלה', en: 'See her profile' }, `${APP_URL()}/profile/${encodeURIComponent(candidateId)}`))
  return renderLayout({
    preheader: a.subject,
    body,
    reason: { he: 'קיבלת את המייל כי ביקשת גישה לפרטים של מועמדת בדואולין.', en: 'You received this because you requested access to a candidate’s details on duallin.' },
    unsubscribeUrl,
  })
}

export async function accessReplyJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const since = new Date(now.getTime() - 3 * DAY).toISOString()
  const { data: rows } = await db.from('profile_access_requests')
    .select('id, recruiter_id, candidate_id, status, approved_fields, updated_at')
    .in('status', ['approved', 'partial', 'rejected']).gte('updated_at', since).limit(1000)
  if (!rows?.length) return none
  const { data: done } = await db.from('email_log').select('ref_key').eq('kind', 'access_reply')
    .gte('created_at', new Date(now.getTime() - 4 * DAY).toISOString())
  const told = new Set((done ?? []).map((r) => r.ref_key))
  const todo = rows.filter((r) => !told.has(`${r.id}:${r.status}`))
  if (!todo.length) return none

  const ids = [...new Set(todo.flatMap((r) => [r.recruiter_id, r.candidate_id]))]
  const { data: users } = await db.from('users').select('uuid, email, status, first_name, last_name, is_anonymous, privacy_lastname').in('uuid', ids)
  const byId = new Map((users ?? []).map((u) => [u.uuid, u]))

  let attempts = 0
  let sent = 0
  for (const r of todo) {
    if (attempts >= budget) break
    const rec = byId.get(r.recruiter_id)
    if (!rec?.email) continue
    const cand = byId.get(r.candidate_id)
    // The name as the site shows it to a recruiter: last name only if she allowed it or approved it.
    const showLast = Array.isArray(cand?.privacy_lastname) && cand!.privacy_lastname.includes('recruiters') || (r.approved_fields ?? []).includes('last_name')
    const name = cand?.is_anonymous ? '' : [cand?.first_name, showLast ? cand?.last_name : null].filter(Boolean).join(' ')
    const status = r.status as 'approved' | 'partial' | 'rejected'
    attempts++
    const res = await sendEmail({
      kind: 'access_reply', category: 'recruiting', to: rec.email, userId: rec.uuid, refKey: `${r.id}:${r.status}`,
      subject: `${ANSWER[status].subject.he} | ${ANSWER[status].subject.en}`,
      html: ({ unsubscribeUrl }) => renderAccessReply(status, name, r.candidate_id, unsubscribeUrl),
    })
    if (res.status === 'deferred') attempts--
    if (res.status === 'sent') sent++
  }
  return { sent, attempts }
}

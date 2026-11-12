// Company-page emails.
//   company_claim_decision — to the member who asked to manage a page, when Duallin approves or
//        declines. An answer to her own request: essential (category 'account'), sent right away.
//   company_claim_new — to the Duallin team (EMAIL_ALERT_TO), whenever a request arrives.
import { sendEmail, type SendResult } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout } from '../emailLayout.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
// dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
const nm = (s: string) => (s.trim() ? `<span dir="auto">${esc(s.trim())}</span>` : '')

// ───────────────────────── a request to manage a page was decided ─────────────────────────

export interface ClaimDecision {
  claimId: number
  status: 'approved' | 'rejected'
  /** The page's name (the organization's name for a page that was just opened). */
  companyName: string
  /** Present when approved: where the page lives. */
  slug: string | null
  firstName: string
  /** What the admin wrote to her, if anything. */
  note: string | null
}

export function renderClaimDecision(d: ClaimDecision): string {
  const first = nm(d.firstName)
  const page = nm(d.companyName)
  const note = d.note?.trim()
    ? paragraph(`<span dir="auto">${esc(d.note.trim())}</span>`)
    : ''
  const body = d.status === 'approved'
    ? biColumns({
      he: heading(first ? `${first}, הבקשה אושרה` : 'הבקשה אושרה') +
        paragraph(`מעכשיו את מנהלת את הדף של ${page} בדואולין. אפשר לערוך את פרטי הדף, להעלות לוגו ותמונת נושא, ולפרסם בשמו.`) + note,
      en: heading(first ? `${first}, your request was approved` : 'Your request was approved') +
        paragraph(`You now manage the page of ${page} on duallin. You can edit its details, upload a logo and a cover image, and publish as the page.`) + note,
    }) + button({ he: 'לדף שלך', en: 'Open your page' }, `${APP_URL()}/company/${encodeURIComponent(d.slug ?? '')}`)
    : biColumns({
      he: heading(first ? `${first}, לא הצלחנו לאשר את הבקשה` : 'לא הצלחנו לאשר את הבקשה') +
        paragraph(`בדקנו את הבקשה לנהל את הדף של ${page}, ולא יכולנו לאשר אותה כרגע.`) + note +
        paragraph('אם נראה לך שחסר לנו מידע, אפשר פשוט להשיב למייל הזה.'),
      en: heading(first ? `${first}, we could not approve your request` : 'We could not approve your request') +
        paragraph(`We reviewed the request to manage the page of ${page} and could not approve it at this time.`) + note +
        paragraph('If you think we are missing something, just reply to this email.'),
    })
  return renderLayout({
    preheader: d.status === 'approved'
      ? { he: 'הבקשה לניהול הדף אושרה', en: 'Your request to manage the page was approved' }
      : { he: 'תשובה לבקשה לניהול הדף', en: 'An answer to your request to manage the page' },
    body,
    reason: { he: 'קיבלת את המייל כי ביקשת לנהל דף ארגון בדואולין.', en: 'You received this because you asked to manage an organization page on duallin.' },
  })
}

export function sendClaimDecision(to: { email: string; userId: string }, d: ClaimDecision): Promise<SendResult> {
  const subject = d.status === 'approved'
    ? 'הבקשה לניהול הדף אושרה | Your page request was approved'
    : 'תשובה לבקשה לניהול הדף | About your page request'
  return sendEmail({
    kind: 'company_claim_decision',
    category: 'account',
    to: to.email,
    userId: to.userId,
    refKey: `claim:${d.claimId}:${d.status}`,
    subject,
    html: () => renderClaimDecision(d),
    immediate: true, // the answer to something she asked for
  })
}

// ───────────────────────── to the Duallin team: a request is waiting ─────────────────────────

const TEAM_EMAIL = () => Deno.env.get('EMAIL_ALERT_TO') ?? 'contact@duallin.com'

export interface NewClaimAlert {
  claimId: number
  /** The page asked for, or the organization's name when it has no page yet. */
  companyName: string
  isNewOrganization: boolean
  requesterName: string
  requesterTitle: string
  workEmail: string
  message: string | null
}

export function renderNewClaimAlert(a: NewClaimAlert): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:3px 0;color:#6b5a78;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:3px 10px;font-size:14px;" dir="auto">${value}</td></tr>`
  const body =
    heading(a.isNewOrganization ? 'בקשה לפתוח דף לארגון חדש' : 'בקשה לנהל דף') +
    `<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin:6px 0 14px;font-family:Arial,sans-serif;">` +
    row('ארגון', esc(a.companyName)) +
    row('מבקשת', esc(a.requesterName)) +
    row('תפקיד', esc(a.requesterTitle)) +
    row('מייל בארגון', `<span dir="ltr">${esc(a.workEmail)}</span>`) +
    (a.message?.trim() ? row('הערה', esc(a.message.trim())) : '') +
    `</table>` +
    paragraph('שום דבר לא מאושר אוטומטית: הבקשה מחכה להחלטה שלכם בתור.') +
    button({ he: 'לתור הבקשות', en: 'Open the queue' }, `${APP_URL()}/dualldmin/company-pages`)
  return renderLayout({
    preheader: { he: `בקשה חדשה: ${a.companyName}`, en: `New page request: ${a.companyName}` },
    body,
    reason: { he: 'התראה פנימית לצוות דואולין.', en: 'Internal alert for the duallin team.' },
  })
}

export function sendNewClaimAlert(a: NewClaimAlert): Promise<SendResult> {
  return sendEmail({
    kind: 'company_claim_new',
    category: 'team',
    to: TEAM_EMAIL(),
    refKey: `claim:${a.claimId}`,
    subject: `בקשה לניהול דף: ${a.companyName}`,
    html: () => renderNewClaimAlert(a),
    immediate: true, // a member is waiting for an answer
  })
}

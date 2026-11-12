// Company-page emails.
//   company_claim_decision — to the member who asked to manage a page, when Duallin approves or
//        declines. An answer to her own request: essential (category 'account'), sent right away.
//   company_claim_new — to the Duallin team (EMAIL_ALERT_TO), whenever a request arrives.
//   company_job_new — to the Duallin team, whenever a company publishes a job (it is already
//        on the board; the team can take it down).
//   company_job_applications — to a page's owners / recruiters: new applications are waiting.
//        A background job (no signed-in member), so it reads with the service role like every
//        other e-mail job. The e-mail carries no candidate details — only how many, and a link.
//        At most one per page every APPLICATIONS_EMAIL_GAP_HOURS, however many candidates apply:
//        the e-mail counts everything since the previous one (the bell in the site is immediate).
import { adminClient } from '../emailPrefs.ts'
import { sendEmail, type SendResult } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout } from '../emailLayout.ts'
import { outOfTime } from './runClock.ts'

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
    preheader: { he: `בקשה חדשה: ${esc(a.companyName)}`, en: `New page request: ${esc(a.companyName)}` },
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

// ───────────────────────── to the Duallin team: a company published a job ─────────────────────────

export interface NewJobAlert {
  jobRowId: number
  /** The job's public id, as the jobs board addresses it. */
  jobId: string
  title: string
  companyName: string
  companySlug: string
  publisherName: string
  applyMethod: string
}

export function renderNewJobAlert(a: NewJobAlert): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:3px 0;color:#6b5a78;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:3px 10px;font-size:14px;" dir="auto">${value}</td></tr>`
  const body =
    heading('חברה פרסמה משרה') +
    `<table role="presentation" cellpadding="0" cellspacing="0" dir="rtl" style="margin:6px 0 14px;font-family:Arial,sans-serif;">` +
    row('משרה', esc(a.title)) +
    row('חברה', esc(a.companyName)) +
    row('פורסמה על ידי', esc(a.publisherName)) +
    row('הגשה', a.applyMethod === 'internal' ? 'בתוך דואולין' : 'קישור חיצוני') +
    `</table>` +
    paragraph('המשרה כבר מופיעה בלוח המשרות. אם היא לא מתאימה, אפשר להסיר אותה ממסך המשרות באדמין.') +
    button({ he: 'למשרה', en: 'Open the job' }, `${APP_URL()}/careers?job=${encodeURIComponent(a.jobId)}`)
  return renderLayout({
    preheader: { he: `משרה חדשה: ${esc(a.title)}`, en: `New job: ${esc(a.title)}` },   // the layout does not escape the preheader
    body,
    reason: { he: 'התראה פנימית לצוות דואולין.', en: 'Internal alert for the duallin team.' },
  })
}

export function sendNewJobAlert(a: NewJobAlert): Promise<SendResult> {
  return sendEmail({
    kind: 'company_job_new',
    category: 'team',
    to: TEAM_EMAIL(),
    refKey: `job:${a.jobRowId}`,
    subject: `משרה חדשה מחברה: ${a.title} (${a.companyName})`,
    html: () => renderNewJobAlert(a),
    immediate: true,
  })
}

// ───────────────────────── to a page's recruiters: applications are waiting ─────────────────────────

type JobResult = { sent: number; attempts: number }
const none: JobResult = { sent: 0, attempts: 0 }
const DAY = 24 * 3600 * 1000

export function renderNewApplications(count: number, companyName: string, companySlug: string, unsubscribeUrl: string | null): string {
  const he = count === 1 ? 'התקבלה מועמדות חדשה' : `התקבלו ${count} מועמדויות חדשות`
  const en = count === 1 ? 'A new application arrived' : `${count} new applications arrived`
  const body =
    biColumns({
      he: heading(he) + paragraph(`למשרות של ${nm(companyName)} בדואולין. הפרטים וקורות החיים מחכים בתיבת המועמדויות של הדף.`),
      en: heading(en) + paragraph(`For ${nm(companyName)}'s jobs on duallin. The details and resumes are waiting in the page's applications inbox.`),
    }) +
    button({ he: 'לתיבת המועמדויות', en: 'Open the inbox' }, `${APP_URL()}/company/${encodeURIComponent(companySlug)}/admin?section=jobs`)
  return renderLayout({
    preheader: { he, en },
    body,
    reason: { he: 'קיבלת את המייל כי את/ה מנהל/ת גיוס בדף חברה בדואולין.', en: 'You received this because you manage recruiting for a company page on duallin.' },
    unsubscribeUrl,
  })
}

/** A popular job must not flood its recruiters: a page is e-mailed at most once in this many hours. */
export const APPLICATIONS_EMAIL_GAP_HOURS = 4

/** The pages (company ids) whose recruiters were e-mailed recently, from the ref keys of those e-mails ("<company id>:<last application id>"). */
export const recentlyMailedPages = (refKeys: (string | null)[]): Set<number> =>
  new Set(refKeys.map((key) => Number((key ?? '').split(':')[0])).filter((id) => Number.isInteger(id) && id > 0))

/**
 * One e-mail per recruiter per page for the applications that arrived since the last one —
 * and never more often than every APPLICATIONS_EMAIL_GAP_HOURS: applications that arrive in
 * between wait and are counted in the next e-mail. An application is marked (notified_at)
 * once its page's recruiters were handled, so it is never announced twice.
 */
export async function jobApplicationsJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const { data: rows } = await db.from('job_submissions')
    .select('id, company_id')
    .is('notified_at', null)
    .gte('created_at', new Date(now.getTime() - 7 * DAY).toISOString())
    .order('id', { ascending: true })
    .limit(1000)
  if (!rows?.length) return none

  const { data: recent } = await db.from('email_log').select('ref_key')
    .eq('kind', 'company_job_applications').in('status', ['sent', 'delivered'])
    .gte('created_at', new Date(now.getTime() - APPLICATIONS_EMAIL_GAP_HOURS * 3600 * 1000).toISOString())
    .limit(5000)
  const quiet = recentlyMailedPages((recent ?? []).map((r) => r.ref_key))

  const byCompany = new Map<number, number[]>()
  for (const r of rows) {
    if (quiet.has(r.company_id)) continue   // e-mailed recently: these wait for the next one
    byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r.id])
  }
  if (byCompany.size === 0) return none
  const companyIds = [...byCompany.keys()]
  const [{ data: companies }, { data: admins }] = await Promise.all([
    db.from('companies').select('id, name, slug').in('id', companyIds),
    db.from('company_admins').select('company_id, user_id').in('company_id', companyIds).in('role', ['owner', 'recruiter']),
  ])
  const { data: users } = await db.from('users').select('uuid, email').in('uuid', [...new Set((admins ?? []).map((a) => a.user_id))])
  const emailOf = new Map((users ?? []).map((u) => [u.uuid, u.email]))
  const companyOf = new Map((companies ?? []).map((co) => [co.id, co]))

  let attempts = 0
  let sent = 0
  for (const [companyId, ids] of byCompany) {
    if (attempts >= budget || outOfTime()) break
    const company = companyOf.get(companyId)
    const recruiters = (admins ?? []).filter((a) => a.company_id === companyId)
    let held = false
    for (const recruiter of recruiters) {
      const email = emailOf.get(recruiter.user_id)
      if (!email || !company) continue
      attempts++
      const res = await sendEmail({
        kind: 'company_job_applications', category: 'recruiting', to: email, userId: recruiter.user_id,
        refKey: `${companyId}:${ids[ids.length - 1]}`,
        subject: ids.length === 1
          ? `מועמדות חדשה למשרה של ${company.name} | New application`
          : `${ids.length} מועמדויות חדשות למשרות של ${company.name} | New applications`,
        html: ({ unsubscribeUrl }) => renderNewApplications(ids.length, company.name, company.slug, unsubscribeUrl),
      })
      if (res.status === 'deferred') { attempts--; held = true }   // outside the send window: try again next run
      if (res.status === 'sent') sent++
    }
    if (!held) await db.from('job_submissions').update({ notified_at: now.toISOString() }).in('id', ids)
  }
  return { sent, attempts }
}

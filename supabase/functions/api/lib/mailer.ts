// The one way the system sends email (email plan, phase 0b).
// Order of checks, so no email can skip one:
//   1. duplicate?  (same kind + ref_key already sent to this address)
//   2. allowed?    (canSendEmail: suppression list + the member's preferences)
//   3. now?        (send window: hours, Shabbat, Yom Tov — unless the email is immediate)
//   4. send through Resend, with the one-click unsubscribe headers
//   5. log the outcome in email_log
import { adminClient, canSendEmail, getCategory, normalizeEmail, unsubscribeLinks } from './emailPrefs.ts'
import { isSendWindowOpen } from './sendWindow.ts'

export type SendResult =
  | { status: 'sent'; resendId: string | null }
  | { status: 'skipped'; reason: 'duplicate' | 'not_allowed' | 'no_api_key' }
  | { status: 'deferred' }
  | { status: 'failed'; error: string }

export interface SendEmailOptions {
  /** Which email — used for dedupe and the admin log, e.g. 'invite', 'welcome'. */
  kind: string
  /** Preference category (see EMAIL_CATEGORIES), or 'invitee' for invitations to non-members. */
  category: string
  to: string
  /** Recipient's account, when she has one (her preferences apply; unsubscribe acts on her account). */
  userId?: string | null
  /** What the email is about; with `kind`, it makes the email go out at most once per address. */
  refKey?: string | null
  subject: string
  /** Builds the HTML; receives the unsubscribe URL for the footer (null when not applicable). */
  html: (ctx: { unsubscribeUrl: string | null }) => string
  /**
   * Send now, ignoring the send window (hours / Shabbat). For emails that answer something the
   * person just did (an invitation she was sent, a sign-in code). Default: respect the window.
   */
  immediate?: boolean
}

const FROM = () => Deno.env.get('EMAIL_FROM') ?? 'duallin <contact@duallin.com>'
const REPLY_TO = () => Deno.env.get('EMAIL_REPLY_TO') ?? 'contact@duallin.com'

async function log(row: Record<string, unknown>) {
  const { error } = await adminClient().from('email_log').insert(row)
  if (error) console.error('email_log insert failed:', error.message)
}

export async function sendEmail(o: SendEmailOptions): Promise<SendResult> {
  const email = normalizeEmail(o.to)
  const db = adminClient()
  const base = { kind: o.kind, category: o.category, email, user_id: o.userId ?? null, ref_key: o.refKey ?? null }

  // 1. duplicate
  if (o.refKey) {
    const { data: prior } = await db.from('email_log').select('id')
      .eq('kind', o.kind).eq('ref_key', o.refKey).eq('email', email)
      .in('status', ['sent', 'delivered', 'bounced', 'complained']).limit(1)
    if (prior?.length) return { status: 'skipped', reason: 'duplicate' }
  }

  // 2. suppression list + preferences
  if (!(await canSendEmail({ email, category: o.category, userId: o.userId }))) {
    await log({ ...base, status: 'skipped', skip_reason: 'not_allowed' })
    return { status: 'skipped', reason: 'not_allowed' }
  }

  // 3. send window — essential categories and immediate emails go out any time
  if (!o.immediate && !getCategory(o.category)?.essential && !isSendWindowOpen()) {
    return { status: 'deferred' }
  }

  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set — email not sent:', o.kind)
    return { status: 'skipped', reason: 'no_api_key' }
  }

  // 4. unsubscribe link + headers (missing secret → the email still goes out, without them)
  let unsub: Awaited<ReturnType<typeof unsubscribeLinks>> | null = null
  // Internal team alerts get no unsubscribe headers: admins manage them in their own settings.
  if (!getCategory(o.category)?.essential && o.category !== 'team') {
    try {
      unsub = await unsubscribeLinks(o.userId ? { u: o.userId, c: o.category } : { e: email, c: o.category })
    } catch (err) {
      console.warn(`${o.kind} sent without unsubscribe link:`, (err as Error).message)
    }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM(),
        reply_to: REPLY_TO(),
        to: [email],
        subject: o.subject,
        html: o.html({ unsubscribeUrl: unsub?.pageUrl ?? null }),
        ...(unsub ? { headers: unsub.headers } : {}),
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      const error = `Resend ${res.status}: ${JSON.stringify(body).slice(0, 300)}`
      await log({ ...base, status: 'failed', error })
      return { status: 'failed', error }
    }
    // 5. log
    await log({ ...base, status: 'sent', resend_id: body?.id ?? null })
    return { status: 'sent', resendId: body?.id ?? null }
  } catch (err) {
    const error = (err as Error).message
    await log({ ...base, status: 'failed', error })
    return { status: 'failed', error }
  }
}

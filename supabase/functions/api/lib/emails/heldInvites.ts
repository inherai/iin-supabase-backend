// Imported (held) invitations — the admin uploads a spreadsheet of up to 10,000 addresses
// (add_held_invites_queue_safe.sql). They are emailed from here, a batch per 10-minute run of the
// email timer, in the send window, AFTER all other jobs and outside the shared hourly budget, so a
// big import never holds up the site's own emails. Then one reminder, 3 days after the email.
//   held_invite          — the invitation (ref_key = invite id, so opens show on the admin page)
//   held_invite_reminder — once, while she has no account and the invitation is still open
// HELD_INVITES_PER_RUN (function secret, default 60, max 150): emails per run, both kinds together.
import { adminClient, normalizeEmail } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { sendInviteEmail } from '../email.ts'
import { renderInviteReminder } from './invitations.ts'
import { outOfTime } from './runClock.ts'

const DAY = 24 * 3600 * 1000
const VALID_DAYS = 21
const REMINDER_AFTER_DAYS = 3
// The mail provider allows a few requests a second; one email at most every half second.
const MIN_GAP_MS = 500

export const HELD_INVITE_KINDS = ['held_invite', 'held_invite_reminder']

const perRun = () => {
  const n = Number(Deno.env.get('HELD_INVITES_PER_RUN'))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 150) : 60
}

type JobResult = { sent: number; attempts: number }

export async function heldInvitesJob(): Promise<JobResult> {
  const db = adminClient()
  const budget = perRun()
  let attempts = 0
  let sent = 0
  let last = 0
  const pace = async () => {
    const wait = last + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    last = Date.now()
  }

  // 1. Invitations not emailed yet, oldest import first
  const { data: queue, error } = await db.from('invites')
    .select('id, recipient_email, token, personal_note, inviter_display_name')
    .eq('hold_for_review', true).eq('status', 'pending').is('email_sent_at', null).is('send_skipped', null)
    .order('created_at').limit(budget)
  if (error) throw new Error(error.message)

  for (const inv of queue ?? []) {
    if (attempts >= budget || outOfTime()) break
    attempts++
    await pace()
    const expiresAt = new Date(Date.now() + VALID_DAYS * DAY).toISOString()
    let r
    try {
      r = await sendInviteEmail({
        to: inv.recipient_email,
        inviterName: inv.inviter_display_name ?? '',
        token: inv.token,
        personalNote: inv.personal_note,
        expiresAt,
        queued: { inviteId: String(inv.id) },
      })
    } catch (err) {
      console.error('held invite failed (retried next run):', inv.recipient_email, (err as Error).message)
      continue
    }
    if (r.status === 'deferred') break // the send window closed meanwhile
    // 'duplicate': it did go out in an earlier run that stopped before saving — count it as sent
    const update = r.status === 'sent' || (r.status === 'skipped' && r.reason === 'duplicate')
      ? { email_sent_at: new Date().toISOString(), expires_at: expiresAt }
      : { send_skipped: r.status === 'skipped' ? r.reason : 'failed' }
    if (r.status === 'sent') sent++
    const { error: upErr } = await db.from('invites').update(update).eq('id', inv.id)
    if (upErr) console.error('held invite state not saved:', inv.id, upErr.message)
  }

  if (attempts >= budget || outOfTime()) return { sent, attempts }

  // 2. One reminder, 3 days after the invitation, while she has no account and it is still open
  const { data: due } = await db.from('invites')
    .select('id, recipient_email, token, inviter_display_name, expires_at')
    .eq('hold_for_review', true).eq('status', 'pending').is('reminder_sent_at', null)
    .lte('email_sent_at', new Date(Date.now() - REMINDER_AFTER_DAYS * DAY).toISOString())
    .gt('expires_at', new Date(Date.now() + 12 * 3600 * 1000).toISOString())
    .order('email_sent_at').limit(budget - attempts)
  if (!due?.length) return { sent, attempts }

  const emails = due.map((d) => normalizeEmail(d.recipient_email))
  const members = new Set<string>()
  for (let i = 0; i < emails.length; i += 100) {
    const { data } = await db.from('users').select('email').in('email', emails.slice(i, i + 100))
    for (const u of data ?? []) if (u.email) members.add(normalizeEmail(u.email))
  }

  for (const inv of due) {
    if (attempts >= budget || outOfTime()) break
    const email = normalizeEmail(inv.recipient_email)
    if (members.has(email)) {
      await db.from('invites').update({ reminder_sent_at: new Date().toISOString() }).eq('id', inv.id) // joined — no reminder
      continue
    }
    attempts++
    await pace()
    const name = inv.inviter_display_name?.trim() ?? ''
    const daysLeft = Math.max(1, Math.ceil((new Date(inv.expires_at).getTime() - Date.now()) / DAY))
    const r = await sendEmail({
      kind: 'held_invite_reminder',
      category: 'invitee',
      to: email,
      refKey: String(inv.id),
      subject: name ? `ההזמנה של ${name} עדיין מחכה לך | ${name}'s invitation is still waiting` : 'ההזמנה שלך לדואולין עדיין מחכה | Your duallin invitation is still waiting',
      html: ({ unsubscribeUrl }) => renderInviteReminder(name, inv.token, daysLeft, unsubscribeUrl),
    })
    if (r.status === 'deferred') break
    if (r.status === 'failed') continue // retried next run
    if (r.status === 'sent') sent++
    await db.from('invites').update({ reminder_sent_at: new Date().toISOString() }).eq('id', inv.id)
  }
  return { sent, attempts }
}

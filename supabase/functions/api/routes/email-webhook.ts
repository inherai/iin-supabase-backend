// POST /api/email-webhook — PUBLIC endpoint for Resend delivery events.
// Authenticity: Resend signs every call (Svix format); we verify it with RESEND_WEBHOOK_SECRET.
//   email.delivered  → log row: delivered
//   email.bounced    → log row: bounced; permanent bounce → address goes on the do-not-email list
//   email.complained → log row: complained; address goes on the do-not-email list (marked as spam)
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { adminClient, normalizeEmail } from '../lib/emailPrefs.ts'

const app = new Hono()
const TOLERANCE_SECONDS = 5 * 60

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Svix: base64(HMAC-SHA256(`${id}.${timestamp}.${body}`, base64-decoded secret)), header "v1,<sig> v1,<sig>". */
async function verifySvix(id: string, timestamp: string, signatures: string, body: string): Promise<boolean> {
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET')
  if (!secret || !id || !timestamp || !signatures) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))
  const expected = btoa(String.fromCharCode(...mac))
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig || sig.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
    return diff === 0
  })
}

app.post('/', async (c) => {
  const body = await c.req.text()
  const ok = await verifySvix(c.req.header('svix-id') ?? '', c.req.header('svix-timestamp') ?? '', c.req.header('svix-signature') ?? '', body)
  if (!ok) return c.json({ error: 'invalid signature' }, 401)

  const event = JSON.parse(body) as { type?: string; data?: { email_id?: string; to?: string[]; bounce?: { type?: string } } }
  const resendId = event.data?.email_id
  const to = event.data?.to?.[0] ? normalizeEmail(event.data.to[0]) : null
  const db = adminClient()
  const now = new Date().toISOString()

  const setStatus = async (status: string) => {
    if (resendId) await db.from('email_log').update({ status, updated_at: now }).eq('resend_id', resendId)
  }
  const suppress = async (reason: 'bounce' | 'complaint') => {
    if (!to) return
    // A complaint outranks an earlier opt-out; never downgrade an admin block.
    const { data: existing } = await db.from('email_suppressions').select('reason').eq('email', to).maybeSingle()
    if (existing?.reason === 'admin' || existing?.reason === reason) return
    await db.from('email_suppressions').upsert({ email: to, reason, created_at: now }, { onConflict: 'email' })
  }

  switch (event.type) {
    case 'email.delivered':
      await setStatus('delivered')
      break
    case 'email.bounced': {
      await setStatus('bounced')
      // Temporary problems (full mailbox, server down) are retried by Resend; only stop on permanent ones.
      const kind = (event.data?.bounce?.type ?? '').toLowerCase()
      if (!['transient', 'temporary', 'undetermined'].includes(kind)) await suppress('bounce')
      break
    }
    case 'email.complained':
      await setStatus('complained')
      await suppress('complaint')
      break
  }
  return c.json({ ok: true })
})

export default app

// /api/email-unsubscribe — PUBLIC (no login). Driven only by a signed token from an email link.
//   GET  ?token=…            → what the link would turn off (for the confirmation page)
//   POST ?token=…            → RFC 8058 one-click (mail clients POST "List-Unsubscribe=One-Click")
//   POST { token, undo? }    → from our page: turn off, or undo
// The token can only switch email off (or undo that). It never reveals the address or any data.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { ALL_CATEGORY, adminClient, verifyUnsubToken, type UnsubPayload } from '../lib/emailPrefs.ts'
import { savePreference, type PreferenceSource } from './email-preferences.ts'

const app = new Hono()

async function apply(p: UnsubPayload, undo: boolean, source: PreferenceSource): Promise<string | null> {
  const db = adminClient()
  if (p.u) {
    // Member: switch the category (or all non-essential email) off; undo restores the default.
    if (undo) {
      const { error } = await db.from('email_preferences').delete().eq('user_id', p.u).eq('category', p.c)
      return error?.message ?? null
    }
    return savePreference(p.u, p.c, 'off', null, source)
  }
  // Address without an account (an invitee): suppression list.
  const reason = p.c === ALL_CATEGORY ? 'unsubscribe_all' : 'unsubscribe_invites'
  if (undo) {
    // Only undo what the link itself did — never lift a bounce / complaint / admin block.
    const { error } = await db.from('email_suppressions').delete().eq('email', p.e!).in('reason', ['unsubscribe_invites', 'unsubscribe_all'])
    return error?.message ?? null
  }
  let { error } = await db.from('email_suppressions').upsert({ email: p.e!, reason, source }, { onConflict: 'email', ignoreDuplicates: true })
  // Before migrations/add_email_tracking.sql the column doesn't exist — save without it.
  if (error && /source/.test(error.message)) ({ error } = await db.from('email_suppressions').upsert({ email: p.e!, reason }, { onConflict: 'email', ignoreDuplicates: true }))
  return error?.message ?? null
}

app.get('/', async (c) => {
  const p = await verifyUnsubToken(c.req.query('token') ?? '')
  if (!p) return c.json({ error: 'invalid_token' }, 400)
  return c.json({ kind: p.u ? 'member' : 'address', category: p.c })
})

app.post('/', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  let token = c.req.query('token') ?? ''
  let undo = false
  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => ({} as any))
    token = body?.token ?? token
    undo = body?.undo === true
  }
  const p = await verifyUnsubToken(token)
  if (!p) return c.json({ error: 'invalid_token' }, 400)
  // JSON = our unsubscribe page; anything else = the mail app's one-click button (RFC 8058).
  const err = await apply(p, undo, contentType.includes('application/json') ? 'email_link' : 'one_click')
  if (err) return c.json({ error: err }, 500)
  return c.json({ ok: true, kind: p.u ? 'member' : 'address', category: p.c, undone: undo })
})

export default app

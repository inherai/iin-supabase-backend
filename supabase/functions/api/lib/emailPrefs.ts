// Email preferences, suppressions and signed unsubscribe links (email plan, phase 0a).
// Every email the system sends goes through canSendEmail() first, so no email can
// "forget" to honour a member's choices or a suppressed address.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type Frequency = 'instant' | 'daily' | 'twice_weekly' | 'weekly' | 'biweekly' | 'on' | 'off'

export interface EmailCategory {
  key: string
  /** Choices shown to the member. Essential categories have none (always sent). */
  options: Frequency[]
  default: Frequency
  /** Always sent, can't be turned off (sign-in code, invitations someone sent you, account notices). */
  essential?: boolean
  /** Shown on the settings page only once emails of this kind are actually being sent. */
  active: boolean
  /** Who the category is relevant for. */
  audience?: 'all' | 'members' | 'recruiters' | 'admins'
}

// Single source of truth for the settings page and the send layer.
// Flip `active` to true when the first email of that category goes live.
export const EMAIL_CATEGORIES: EmailCategory[] = [
  { key: 'account',            options: [], default: 'on', essential: true, active: false, audience: 'all' },
  { key: 'onboarding',         options: ['on', 'off'], default: 'on', active: false, audience: 'members' },
  { key: 'invitations',        options: ['on', 'off'], default: 'on', active: false, audience: 'members' },
  { key: 'network',            options: ['instant', 'daily', 'off'], default: 'instant', active: false, audience: 'all' },
  { key: 'content_activity',   options: ['daily', 'weekly', 'off'], default: 'daily', active: false, audience: 'members' },
  { key: 'weekly_stats',       options: ['weekly', 'off'], default: 'weekly', active: false, audience: 'members' },
  { key: 'people_suggestions', options: ['weekly', 'biweekly', 'off'], default: 'biweekly', active: false, audience: 'members' },
  { key: 'jobs',               options: ['twice_weekly', 'weekly', 'off'], default: 'weekly', active: false, audience: 'members' },
  { key: 'community',          options: ['weekly', 'biweekly', 'off'], default: 'weekly', active: false, audience: 'all' },
  { key: 'product_updates',    options: ['on', 'off'], default: 'on', active: false, audience: 'all' },
  { key: 'recruiting',         options: ['instant', 'off'], default: 'instant', active: false, audience: 'all' },
  { key: 'team',               options: ['on', 'off'], default: 'on', active: false, audience: 'admins' },
]

/** Pseudo-category: frequency 'off' = no non-essential email at all. */
export const ALL_CATEGORY = '_all'

export const getCategory = (key: string) => EMAIL_CATEGORIES.find((c) => c.key === key)

export const normalizeEmail = (email: string) =>
  email.replace(/[​-‏‪-‮﻿­]/g, '').trim().toLowerCase()

export const adminClient = () =>
  createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

// ───────────────────────── send-time check ─────────────────────────

// Reasons that stop every email to the address, essential ones included: the mail can't be
// delivered (bounce) or the person marked us as spam / asked to stop / was blocked by an admin.
const BLOCKS_EVERYTHING = new Set(['bounce', 'complaint', 'admin'])

/**
 * May we send an email of `category` to this address now?
 * - suppressed address → no (invitation-type mail also stops on 'unsubscribe_invites')
 * - member who turned the category (or all non-essential mail) off → no
 * - essential categories ignore member preferences, but not hard blocks
 */
export async function canSendEmail(opts: { email: string; category: string; userId?: string | null }): Promise<boolean> {
  const db = adminClient()
  const email = normalizeEmail(opts.email)
  const cat = getCategory(opts.category)

  const { data: sup } = await db.from('email_suppressions').select('reason').eq('email', email).maybeSingle()
  if (sup) {
    if (BLOCKS_EVERYTHING.has(sup.reason)) return false
    if (sup.reason === 'unsubscribe_all' && !cat?.essential) return false
    // Invitation emails to non-members: the invitee asked not to be invited again.
    if (sup.reason === 'unsubscribe_invites' || sup.reason === 'unsubscribe_all') {
      if (opts.category === 'invitee') return false
    }
  }

  if (cat?.essential || !opts.userId) return true

  const { data: prefs } = await db
    .from('email_preferences')
    .select('category, frequency')
    .eq('user_id', opts.userId)
    .in('category', [opts.category, ALL_CATEGORY])
  const all = prefs?.find((p) => p.category === ALL_CATEGORY)
  if (all?.frequency === 'off') return false
  const own = prefs?.find((p) => p.category === opts.category)
  const freq = own?.frequency ?? cat?.default ?? 'on'
  return freq !== 'off'
}

/** The member's effective frequency for a category (what the digest jobs will use). */
export async function getFrequency(userId: string, category: string): Promise<Frequency> {
  const cat = getCategory(category)
  if (cat?.essential) return 'on'
  const { data } = await adminClient()
    .from('email_preferences')
    .select('category, frequency')
    .eq('user_id', userId)
    .in('category', [category, ALL_CATEGORY])
  if (data?.find((p) => p.category === ALL_CATEGORY)?.frequency === 'off') return 'off'
  return (data?.find((p) => p.category === category)?.frequency as Frequency) ?? cat?.default ?? 'on'
}

// ───────────────────────── signed unsubscribe tokens ─────────────────────────
// token = base64url(payload) + "." + base64url(HMAC-SHA256(payload, EMAIL_UNSUBSCRIBE_SECRET))
// The link only ever turns email OFF (and can undo that); it grants no other access.

export interface UnsubPayload {
  v: 1
  /** member id — preferences are changed for her account */
  u?: string
  /** address — used for people without an account (invitees) */
  e?: string
  /** category key, 'invitee' for invitation emails, or '_all' */
  c: string
  iat: number
}

const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0))

async function hmacKey() {
  const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET')
  if (!secret) throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not set')
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signUnsubToken(p: Omit<UnsubPayload, 'v' | 'iat'>): Promise<string> {
  const payload: UnsubPayload = { v: 1, ...p, ...(p.e ? { e: normalizeEmail(p.e) } : {}), iat: Math.floor(Date.now() / 1000) }
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(body)))
  return `${body}.${b64url(sig)}`
}

export async function verifyUnsubToken(token: string): Promise<UnsubPayload | null> {
  const [body, sig] = (token || '').split('.')
  if (!body || !sig) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(), fromB64url(sig), new TextEncoder().encode(body))
    if (!ok) return null
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as UnsubPayload
    if (p.v !== 1 || !p.c || (!p.u && !p.e)) return null
    if (Math.floor(Date.now() / 1000) - p.iat > TOKEN_TTL_SECONDS) return null
    return p
  } catch {
    return null
  }
}

/** Link for the email footer + the List-Unsubscribe headers Gmail/Yahoo require for one-click. */
export async function unsubscribeLinks(p: Omit<UnsubPayload, 'v' | 'iat'>) {
  const token = await signUnsubToken(p)
  const appUrl = Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
  const apiUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/api/email-unsubscribe?token=${encodeURIComponent(token)}`
  return {
    pageUrl: `${appUrl}/email/unsubscribe?token=${encodeURIComponent(token)}`,
    headers: {
      'List-Unsubscribe': `<${apiUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

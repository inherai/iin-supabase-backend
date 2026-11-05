// GET/PUT /api/email-preferences — the signed-in member's email settings.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { ALL_CATEGORY, EMAIL_CATEGORIES, adminClient, getCategory, type Frequency } from '../lib/emailPrefs.ts'

const app = new Hono()

/** Categories visible to this user: only active ones; admins also see inactive ones as a preview. */
function visibleCategories(user: any) {
  const isAdmin = user?.app_metadata?.is_admin === true
  const role = user?.app_metadata?.role
  return EMAIL_CATEGORIES.filter((c) => {
    if (!c.active && !isAdmin) return false
    if (c.audience === 'admins') return isAdmin
    if (c.audience === 'recruiters') return isAdmin || role === 'recruiters'
    if (c.audience === 'members') return isAdmin || role !== 'recruiters'
    return true
  })
}

export async function loadPreferences(userId: string, user: any) {
  const { data, error } = await adminClient()
    .from('email_preferences')
    .select('category, frequency')
    .eq('user_id', userId)
  if (error) throw error
  const saved = new Map((data ?? []).map((r) => [r.category, r.frequency as Frequency]))
  return {
    allOff: saved.get(ALL_CATEGORY) === 'off',
    categories: visibleCategories(user).map((c) => ({
      key: c.key,
      options: c.options,
      default: c.default,
      essential: !!c.essential,
      active: c.active,
      value: c.essential ? 'on' : saved.get(c.key) ?? c.default,
    })),
  }
}

/** Where a change came from (shown in admin): settings page, the link in an email, the mail app's button, admin. */
export type PreferenceSource = 'settings' | 'email_link' | 'one_click' | 'admin'

/** Validates and stores one change. Returns an error message, or null when saved. */
export async function savePreference(userId: string, category: string, frequency: string, updatedBy: string | null, source: PreferenceSource | null = null) {
  const db = adminClient()
  if (category === ALL_CATEGORY) {
    if (frequency !== 'on' && frequency !== 'off') return 'invalid frequency'
    if (frequency === 'on') {
      const { error } = await db.from('email_preferences').delete().eq('user_id', userId).eq('category', ALL_CATEGORY)
      return error?.message ?? null
    }
  } else {
    const cat = getCategory(category)
    if (!cat) return 'unknown category'
    if (cat.essential) return 'this category is always sent'
    if (!cat.options.includes(frequency as Frequency)) return 'invalid frequency'
    // Back to the default → no row, so a future change of the default applies to her too.
    if (frequency === cat.default) {
      const { error } = await db.from('email_preferences').delete().eq('user_id', userId).eq('category', category)
      return error?.message ?? null
    }
  }
  const row = { user_id: userId, category, frequency, updated_at: new Date().toISOString(), updated_by: updatedBy }
  let { error } = await db.from('email_preferences').upsert({ ...row, source }, { onConflict: 'user_id,category' })
  // Before migrations/add_email_tracking.sql the column doesn't exist — save without it.
  if (error && /source/.test(error.message)) ({ error } = await db.from('email_preferences').upsert(row, { onConflict: 'user_id,category' }))
  return error?.message ?? null
}

app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  try {
    return c.json(await loadPreferences(user.id, user))
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'Failed to load preferences' }, 500)
  }
})

// Body: { category, frequency } — category may be '_all' with 'off' | 'on'.
app.put('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({} as any))
  const err = await savePreference(user.id, String(body?.category ?? ''), String(body?.frequency ?? ''), null, 'settings')
  if (err) return c.json({ error: err }, 400)
  return c.json(await loadPreferences(user.id, user))
})

export default app

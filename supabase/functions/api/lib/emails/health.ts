// Email health alert to the team (2026-11-05): checked once an hour over the last 24 hours.
// Each problem is emailed at most once a day (ref_key = date + problem), so a lasting problem
// doesn't flood the team. Thresholds:
//   bounced     > 2% of sent (with 50+ sent), or > 5% for one email kind (with 20+ sent)
//   spam        > 0.1% of sent (any complaint at our volume)
//   failed      10+ or > 5% of attempts
//   opt-outs    5+ for one category, and > 2% of what that category sent
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { esc } from '../emailLayout.ts'

const TEAM_EMAIL = () => Deno.env.get('EMAIL_ALERT_TO') ?? 'contact@duallin.com'
const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'

interface KindStats { kind: string; category: string | null; sent: number; bounced: number; complained: number; failed: number }
export interface HealthIssue { key: string; text: string }

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)

/** What is wrong right now (pure, so it can be tested without a database). */
export function findIssues(kinds: KindStats[], optOuts: Record<string, number>): HealthIssue[] {
  const issues: HealthIssue[] = []
  const sent = kinds.reduce((n, k) => n + k.sent, 0)
  const bounced = kinds.reduce((n, k) => n + k.bounced, 0)
  const complained = kinds.reduce((n, k) => n + k.complained, 0)
  const failed = kinds.reduce((n, k) => n + k.failed, 0)

  if (sent >= 50 && bounced / sent > 0.02) issues.push({ key: 'bounce', text: `${bounced} of ${sent} emails bounced (${pct(bounced, sent)}%) — above 2%.` })
  for (const k of kinds) {
    if (k.sent >= 20 && k.bounced / k.sent > 0.05) issues.push({ key: `bounce:${k.kind}`, text: `"${k.kind}": ${k.bounced} of ${k.sent} bounced (${pct(k.bounced, k.sent)}%).` })
  }
  if (complained > 0 && complained / Math.max(sent, 1) > 0.001) issues.push({ key: 'spam', text: `${complained} marked as spam out of ${sent} (${pct(complained, sent)}%) — above 0.1%.` })
  if (failed >= 10 || (failed > 0 && failed / (sent + failed) > 0.05)) issues.push({ key: 'failed', text: `${failed} emails failed to send (${pct(failed, sent + failed)}% of attempts).` })

  const sentByCategory = new Map<string, number>()
  for (const k of kinds) if (k.category) sentByCategory.set(k.category, (sentByCategory.get(k.category) ?? 0) + k.sent)
  for (const [cat, n] of Object.entries(optOuts)) {
    const catSent = sentByCategory.get(cat) ?? 0
    if (n >= 5 && catSent > 0 && n / catSent > 0.02) issues.push({ key: `optout:${cat}`, text: `${n} members turned off "${cat}" emails (${pct(n, catSent)}% of the ${catSent} sent).` })
  }
  return issues
}

export async function emailHealthJob(): Promise<{ sent: number; attempts: number }> {
  const db = adminClient()
  const since = new Date(Date.now() - 86400000).toISOString()
  const [stats, offs] = await Promise.all([
    db.rpc('email_stats', { p_days: 1 }),
    db.from('email_preferences').select('category').eq('frequency', 'off').gte('updated_at', since).limit(5000),
  ])
  if (stats.error) return { sent: 0, attempts: 0 } // before the migration: nothing to check
  const optOuts: Record<string, number> = {}
  for (const r of offs.data ?? []) optOuts[r.category] = (optOuts[r.category] ?? 0) + 1
  const issues = findIssues((stats.data ?? []) as KindStats[], optOuts)
  if (!issues.length) return { sent: 0, attempts: 0 }

  // Only problems not already reported today.
  const day = new Date().toISOString().slice(0, 10)
  const { data: told } = await db.from('email_log').select('ref_key').eq('kind', 'email_health_alert').like('ref_key', `${day}:%`)
  const already = new Set((told ?? []).map((r) => r.ref_key))
  const fresh = issues.filter((i) => !already.has(`${day}:${i.key}`))
  if (!fresh.length) return { sent: 0, attempts: 0 }

  const list = fresh.map((i) => `<li style="margin:0 0 6px;">${esc(i.text)}</li>`).join('')
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d1d1f;max-width:560px;" dir="ltr">
    <h2 style="margin:0 0 10px;font-size:17px;">duallin email health — needs a look</h2>
    <p style="margin:0 0 10px;">In the last 24 hours:</p>
    <ul style="margin:0 0 14px;padding-left:18px;">${list}</ul>
    <p style="margin:0;"><a href="${APP_URL()}/dualldmin/email-log?tab=performance" style="color:#4b154c;font-weight:bold;">Open email performance</a></p>
  </div>`
  // One email for all fresh problems. It is logged under the first problem; the others get a
  // "covered" row, so each problem is reported at most once a day.
  const r = await sendEmail({
    kind: 'email_health_alert', category: 'team', to: TEAM_EMAIL(), refKey: `${day}:${fresh[0].key}`,
    subject: `duallin emails: ${fresh.length} problem${fresh.length > 1 ? 's' : ''} to check`,
    html: () => html,
    immediate: true, // the team should know at any hour
  }).catch(() => null)
  const sent = r?.status === 'sent' ? 1 : 0
  if (sent && fresh.length > 1) {
    await db.from('email_log').insert(fresh.slice(1).map((issue) => ({
      kind: 'email_health_alert', category: 'team', email: TEAM_EMAIL(), ref_key: `${day}:${issue.key}`,
      status: 'skipped', skip_reason: 'covered_by_same_alert',
    })))
  }
  return { sent, attempts: sent }
}

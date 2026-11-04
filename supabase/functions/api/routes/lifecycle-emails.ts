// POST /api/lifecycle-emails/run — called hourly by pg_cron (see migrations/schedule_lifecycle_emails.sql).
// Authorised by the x-cron-secret header (CRON_LIFECYCLE_SECRET), not a user session.
// Runs every registered job; each job decides whom to email and sends through sendEmail(),
// which applies preferences, the send window (hours / Shabbat / Yom Tov) and dedupe.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { isSendWindowOpen } from '../lib/sendWindow.ts'
import { welcomeJob } from '../lib/emails/welcome.ts'

export interface LifecycleJob {
  name: string
  /** Returns how many emails it sent. */
  run: () => Promise<number>
}

// Wave 1 (welcome reminders, invitee reminders...) registers its jobs here.
export const LIFECYCLE_JOBS: LifecycleJob[] = [
  { name: 'welcome', run: welcomeJob },
]

const app = new Hono()

app.post('/run', async (c) => {
  const secret = Deno.env.get('CRON_LIFECYCLE_SECRET')
  if (!secret || c.req.header('x-cron-secret') !== secret) return c.json({ error: 'Unauthorized' }, 401)

  // Outside the window nothing non-essential can go out anyway; skip the work entirely.
  if (!isSendWindowOpen()) return c.json({ window: 'closed', jobs: [] })

  const results = []
  for (const job of LIFECYCLE_JOBS) {
    try {
      results.push({ job: job.name, sent: await job.run() })
    } catch (err) {
      console.error(`lifecycle job ${job.name} failed:`, err)
      results.push({ job: job.name, error: (err as Error).message })
    }
  }
  return c.json({ window: 'open', jobs: results })
})

export default app

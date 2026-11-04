// POST /api/lifecycle-emails/run — called hourly by pg_cron (see migrations/schedule_lifecycle_emails.sql).
// Authorised by the x-cron-secret header (CRON_LIFECYCLE_SECRET), not a user session.
// Runs every registered job; each job decides whom to email and sends through sendEmail(),
// which applies preferences, the send window (hours / Shabbat / Yom Tov) and dedupe.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { isSendWindowOpen } from '../lib/sendWindow.ts'
import { welcomeJob } from '../lib/emails/welcome.ts'
import { onboardingRemindersJob } from '../lib/emails/onboardingReminders.ts'
import { comeBackJob } from '../lib/emails/comeBack.ts'

export interface LifecycleJob {
  name: string
  /** Sends at most `budget` emails; returns how many it sent and how many it tried. */
  run: (budget: number) => Promise<{ sent: number; attempts: number }>
}

// All timed emails share one hourly budget, so several backlogs at once never become a burst
// (sender reputation). Jobs run in priority order and take what's left.
const HOURLY_BUDGET = 60

export const LIFECYCLE_JOBS: LifecycleJob[] = [
  { name: 'welcome', run: () => welcomeJob() },          // retries only — tiny
  { name: 'onboarding_reminders', run: (b) => onboardingRemindersJob(b) },
  { name: 'come_back', run: (b) => comeBackJob(b) },
]

const app = new Hono()

app.post('/run', async (c) => {
  const secret = Deno.env.get('CRON_LIFECYCLE_SECRET')
  if (!secret || c.req.header('x-cron-secret') !== secret) return c.json({ error: 'Unauthorized' }, 401)

  // Outside the window nothing non-essential can go out anyway; skip the work entirely.
  if (!isSendWindowOpen()) return c.json({ window: 'closed', jobs: [] })

  const results = []
  let budget = HOURLY_BUDGET
  for (const job of LIFECYCLE_JOBS) {
    try {
      const r = await job.run(budget)
      budget -= r.attempts
      results.push({ job: job.name, ...r })
    } catch (err) {
      console.error(`lifecycle job ${job.name} failed:`, err)
      results.push({ job: job.name, error: (err as Error).message })
    }
  }
  return c.json({ window: 'open', jobs: results })
})

export default app

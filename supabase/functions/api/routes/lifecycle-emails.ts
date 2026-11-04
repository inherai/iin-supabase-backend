// POST /api/lifecycle-emails/run — called hourly by pg_cron (see migrations/schedule_lifecycle_emails.sql).
// Authorised by the x-cron-secret header (CRON_LIFECYCLE_SECRET), not a user session.
// Runs every registered job; each job decides whom to email and sends through sendEmail(),
// which applies preferences, the send window (hours / Shabbat / Yom Tov) and dedupe.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { isSendWindowOpen } from '../lib/sendWindow.ts'
import { welcomeJob } from '../lib/emails/welcome.ts'
import { onboardingRemindersJob } from '../lib/emails/onboardingReminders.ts'
import { comeBackJob } from '../lib/emails/comeBack.ts'
import { inviteeJoinedJob, inviteeReminderJob, invitesUnlockedJob } from '../lib/emails/invitations.ts'
import { contentDigestJob, networkJob, peopleJob, postViewsJob, requestReminderJob, weeklyCommunityJob } from '../lib/emails/activityJobs.ts'

export interface LifecycleJob {
  name: string
  /** Sends at most `budget` emails; returns how many it sent and how many it tried. */
  run: (budget: number) => Promise<{ sent: number; attempts: number }>
}

// All timed emails share one hourly budget, so several backlogs at once never become a burst
// (sender reputation). Jobs run in priority order and take what's left.
// EMAIL_HOURLY_BUDGET (function secret) changes it without a deploy; default 60, capped at 500.
const DEFAULT_HOURLY_BUDGET = 60
const hourlyBudget = () => {
  const n = Number(Deno.env.get('EMAIL_HOURLY_BUDGET'))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : DEFAULT_HOURLY_BUDGET
}

export const LIFECYCLE_JOBS: LifecycleJob[] = [
  { name: 'welcome', run: () => welcomeJob() },          // retries only — tiny
  // Personal & important (never held by the per-member cap)
  { name: 'network_update', run: (b) => networkJob(b) },          // recruiter, messages, mentions, requests
  { name: 'request_reminder', run: (b) => requestReminderJob(b) },
  { name: 'invitee_joined', run: (b) => inviteeJoinedJob(b) },      // good news for the inviter — few
  { name: 'invite_reminder', run: (b) => inviteeReminderJob(b) },   // invitations expire in 7 days — time-sensitive
  // Nice to know (at most 1 a day / 4 a week per member — enforced in sendEmail)
  { name: 'onboarding_reminders', run: (b) => onboardingRemindersJob(b) },
  { name: 'invites_unlocked', run: (b) => invitesUnlockedJob(b) },
  { name: 'content_digest', run: (b) => contentDigestJob(b) },      // evenings
  { name: 'post_views', run: (b) => postViewsJob(b) },
  { name: 'people_suggestions', run: (b) => peopleJob(b) },         // Mondays
  { name: 'weekly_community', run: (b) => weeklyCommunityJob(b) },  // Wednesday–Thursday
  { name: 'come_back', run: (b) => comeBackJob(b) },              // incl. the monthly email
]

const app = new Hono()

app.post('/run', async (c) => {
  const secret = Deno.env.get('CRON_LIFECYCLE_SECRET')
  if (!secret || c.req.header('x-cron-secret') !== secret) return c.json({ error: 'Unauthorized' }, 401)

  // Outside the window nothing non-essential can go out anyway; skip the work entirely.
  if (!isSendWindowOpen()) return c.json({ window: 'closed', jobs: [] })

  const results = []
  let budget = hourlyBudget()
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

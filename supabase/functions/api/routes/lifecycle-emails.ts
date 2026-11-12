// POST /api/lifecycle-emails/run — called every 10 minutes by pg_cron (see migrations/schedule_lifecycle_emails.sql).
// Authorised by the x-cron-secret header (CRON_LIFECYCLE_SECRET), not a user session.
// Runs every registered job; each job decides whom to email and sends through sendEmail(),
// which applies preferences, the send window (hours / Shabbat / Yom Tov) and dedupe.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { isSendWindowOpen } from '../lib/sendWindow.ts'
import { adminClient } from '../lib/emailPrefs.ts'
import { outOfTime, startRunClock } from '../lib/emails/runClock.ts'
import { emailHealthJob } from '../lib/emails/health.ts'
import { welcomeJob } from '../lib/emails/welcome.ts'
import { onboardingRemindersJob } from '../lib/emails/onboardingReminders.ts'
import { comeBackJob } from '../lib/emails/comeBack.ts'
import { profileTipsJob } from '../lib/emails/profileTips.ts'
import { inviteeJoinedJob, inviteeReminderJob, invitesUnlockedJob, inviteExpiredJob } from '../lib/emails/invitations.ts'
import { accessReplyJob } from '../lib/emails/service.ts'
import { jobApplicationsJob } from '../lib/emails/companyPages.ts'
import { contentDigestJob, networkJob, peopleJob, postViewsJob, requestReminderJob, weeklyCommunityJob } from '../lib/emails/activityJobs.ts'

export interface LifecycleJob {
  name: string
  /** Sends at most `budget` emails; returns how many it sent and how many it tried. */
  run: (budget: number) => Promise<{ sent: number; attempts: number }>
  /** Which of the six 10-minute runs of the hour it takes part in (0 = :05, 1 = :15 … 5 = :55). */
  slots: number[]
}

// The timer runs every 10 minutes (migrations/schedule_lifecycle_emails.sql). Found 2026-11-05:
// one big hourly run went over Supabase's 2 s CPU limit and was cut off, so the jobs at the end
// of the queue (come-back) never ran. Now each run is small, and the heavier jobs take turns:
//   every run      — the personal emails (they should not wait), and the small time-sensitive ones
//   runs 0 and 3   — sign-up reminders, request reminders, expired invitations
//   runs 1 and 4   — the week on duallin (every run on Wednesday from 10:00), evening comments digest, post views
//   runs 2 and 5   — come-back, invitations unlocked, people you may know
// All timed emails still share one hourly budget (sender reputation).
// EMAIL_HOURLY_BUDGET (function secret, default 60, max 500) — the hourly total.
// EMAIL_PER_RUN (function secret, default 40, max 100) — at most this many per 10-minute run.
const DEFAULT_HOURLY_BUDGET = 60
const DEFAULT_PER_RUN = 40
const RUN_TIME_MS = 60_000
const envInt = (name: string, def: number, max: number) => {
  const n = Number(Deno.env.get(name))
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def
}
const EVERY = [0, 1, 2, 3, 4, 5]

export const LIFECYCLE_JOBS: LifecycleJob[] = [
  { name: 'welcome', run: () => welcomeJob(), slots: EVERY },                      // retries only — tiny
  // Personal & important (never held by the per-member cap)
  { name: 'network_update', run: (b) => networkJob(b), slots: EVERY },             // recruiter, messages, mentions, requests
  { name: 'access_reply', run: (b) => accessReplyJob(b), slots: EVERY },           // to recruiters: a candidate answered
  { name: 'job_applications', run: (b) => jobApplicationsJob(b), slots: EVERY },   // to a page's recruiters: applications are waiting
  { name: 'invitee_joined', run: (b) => inviteeJoinedJob(b), slots: EVERY },       // good news for the inviter — few
  { name: 'invite_reminder', run: (b) => inviteeReminderJob(b), slots: EVERY },    // invitations expire in 7 days
  { name: 'request_reminder', run: (b) => requestReminderJob(b), slots: [0, 3] },
  { name: 'invite_expired', run: (b) => inviteExpiredJob(b), slots: [0, 3] },
  // Nice to know (at most 1 a day / 4 a week per member — enforced in sendEmail)
  { name: 'onboarding_reminders', run: (b) => onboardingRemindersJob(b), slots: [0, 3] },
  { name: 'profile_tips', run: (b) => profileTipsJob(b), slots: [0, 3] },           // profile under 70%: 3 emails, 10 / 30 days apart
  { name: 'weekly_community', run: (b) => weeklyCommunityJob(b), slots: [1, 4] },  // Wednesday 10:00 → Sunday
  { name: 'content_digest', run: (b) => contentDigestJob(b), slots: [1, 4] },      // evenings
  { name: 'post_views', run: (b) => postViewsJob(b), slots: [1, 4] },
  { name: 'come_back', run: (b) => comeBackJob(b), slots: [2, 5] },
  { name: 'invites_unlocked', run: (b) => invitesUnlockedJob(b), slots: [2, 5] },
  { name: 'people_suggestions', run: (b) => peopleJob(b), slots: [2, 5] },         // Mondays
]

const israelDayHour = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour) }
}

const app = new Hono()

app.post('/run', async (c) => {
  const secret = Deno.env.get('CRON_LIFECYCLE_SECRET')
  if (!secret || c.req.header('x-cron-secret') !== secret) return c.json({ error: 'Unauthorized' }, 401)

  // Which 10-minute run of the hour this is (also works if the timer is still hourly: slot 0).
  const minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', minute: '2-digit' }).format(new Date()))
  const slot = Math.min(5, Math.floor(minute / 10))

  // Email health check for the team — once an hour, at any hour (problems don't wait for morning).
  let health: unknown = null
  if (slot === 0) {
    try { health = await emailHealthJob() } catch (err) { console.error('email health check failed:', err) }
  }

  // Outside the window nothing non-essential can go out anyway; skip the work entirely.
  if (!isSendWindowOpen()) return c.json({ window: 'closed', slot, health, jobs: [] })
  startRunClock(RUN_TIME_MS)

  // This run's budget: what's left of the hourly total, at most EMAIL_PER_RUN.
  const { count: lastHour } = await adminClient().from('email_log').select('id', { count: 'exact', head: true })
    .in('status', ['sent', 'delivered', 'bounced', 'complained']).gte('created_at', new Date(Date.now() - 3600_000).toISOString())
  let budget = Math.min(envInt('EMAIL_PER_RUN', DEFAULT_PER_RUN, 100), Math.max(0, envInt('EMAIL_HOURLY_BUDGET', DEFAULT_HOURLY_BUDGET, 500) - (lastHour ?? 0)))

  // Wednesday from 10:00 belongs to the week on duallin (2026-11-05): it takes every run and goes
  // first among the nice-to-know emails, so everyone has it within a few hours.
  const { weekday, hour } = israelDayHour()
  const weeklyDay = weekday === 3 && hour >= 10
  const jobs = weeklyDay
    ? [
      ...LIFECYCLE_JOBS.filter((j) => j.slots === EVERY),
      { ...LIFECYCLE_JOBS.find((j) => j.name === 'weekly_community')!, slots: EVERY },
      ...LIFECYCLE_JOBS.filter((j) => j.slots !== EVERY && j.name !== 'weekly_community'),
    ]
    : LIFECYCLE_JOBS

  const results = []
  for (const job of jobs) {
    if (!job.slots.includes(slot)) continue
    if (outOfTime()) { results.push({ job: job.name, skipped: 'out of time' }); continue }
    try {
      const r = await job.run(budget)
      budget -= r.attempts
      results.push({ job: job.name, ...r })
    } catch (err) {
      console.error(`lifecycle job ${job.name} failed:`, err)
      results.push({ job: job.name, error: (err as Error).message })
    }
  }
  return c.json({ window: 'open', slot, health, jobs: results })
})

export default app

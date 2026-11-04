-- ============================================================
-- Hourly lifecycle-email run (email plan, phase 0b). Run in Supabase SQL Editor
-- WHEN THE FIRST LIFECYCLE EMAIL IS READY (wave 1) — until then the run has no jobs.
--
-- Before running, replace the two placeholders:
--   <PROJECT_REF>             your Supabase project ref (from the project URL)
--   <CRON_LIFECYCLE_SECRET>   the same value you set as the CRON_LIFECYCLE_SECRET function secret
-- Requires the pg_cron and pg_net extensions (Database → Extensions).
-- ============================================================

SELECT cron.unschedule('lifecycle-emails-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lifecycle-emails-hourly');

SELECT cron.schedule(
  'lifecycle-emails-hourly',
  '5 * * * *',   -- five past every hour
  $$
  SELECT net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/api/lifecycle-emails/run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_LIFECYCLE_SECRET>'),
    body    := '{}'::jsonb
  );
  $$
);

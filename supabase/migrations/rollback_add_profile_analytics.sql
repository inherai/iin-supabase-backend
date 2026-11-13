-- ============================================================
-- UNDO add_profile_analytics_safe.sql.
-- BEFORE running: deploy the API without GET /admin/profile-analytics (it calls
-- admin_profile_analytics, removed here).
--
-- What happens to data: the daily profile snapshots are DELETED — the trend history they hold
-- cannot be rebuilt. Users, storage and every other table are untouched.
-- ============================================================
BEGIN;

SELECT cron.unschedule('profile-stats-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'profile-stats-snapshot');

DROP FUNCTION IF EXISTS public.admin_profile_analytics();
DROP FUNCTION IF EXISTS public.take_profile_stats_snapshot();
DROP FUNCTION IF EXISTS public.profile_stats_history();
DROP FUNCTION IF EXISTS public.profile_stats_compute();
DROP TABLE IF EXISTS public.profile_stats_snapshots;

COMMIT;

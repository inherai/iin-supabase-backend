-- ============================================================
-- UNDO add_marketing_stats.sql.
-- BEFORE running: deploy the frontend without the marketing stats call (public_marketing_stats,
-- removed here). The pages keep working on their built-in fallback numbers either way.
--
-- What happens to data: the daily marketing snapshots are DELETED. They hold totals only and
-- can be recomputed by running add_marketing_stats.sql again. Every other table is untouched.
-- ============================================================
BEGIN;

SELECT cron.unschedule('marketing-stats-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'marketing-stats-snapshot');

DROP FUNCTION IF EXISTS public.public_marketing_stats();
DROP FUNCTION IF EXISTS public.take_marketing_stats_snapshot();
DROP FUNCTION IF EXISTS public.marketing_stats_compute();
DROP TABLE IF EXISTS public.marketing_stats_snapshots;

COMMIT;

-- ============================================================
-- UNDO add_talent_analytics_safe.sql.
-- BEFORE running: deploy the API without GET /admin/talent-analytics, the search logging in
-- POST /talent and POST /talent/candidates/:id/view (they use the objects removed here).
--
-- What happens to data: recruiters' recorded searches and candidate views (talent_events) and
-- the outreach status history (talent_outreach_log) are DELETED — they cannot be rebuilt.
-- profile_access_requests and every other table are untouched.
-- ============================================================
BEGIN;

DROP FUNCTION IF EXISTS public.admin_talent_analytics(integer);
DROP TRIGGER IF EXISTS trg_talent_outreach_log ON public.profile_access_requests;
DROP FUNCTION IF EXISTS public.talent_outreach_log_write();
DROP TABLE IF EXISTS public.talent_outreach_log;
DROP TABLE IF EXISTS public.talent_events;

COMMIT;

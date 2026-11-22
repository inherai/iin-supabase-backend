-- ============================================================
-- UNDO add_recruiter_emails_safe.sql.
-- BEFORE running: deploy the API without the recruiter emails (lib/emails/recruiter*.ts, spotlight),
-- the /admin/spotlight routes, the pool numbers in GET /talent/overview and the spotlight opt-out
-- in /email-preferences (they use the objects removed here).
--
-- What happens to data: the team's spotlight picks, members' "don't show my work to recruiters"
-- choices and the kept "never lower" numbers are DELETED. Nothing else changes.
-- ============================================================
BEGIN;

DROP FUNCTION IF EXISTS public.admin_spotlight_suggestions(integer);
DROP TABLE IF EXISTS public.talent_spotlight_picks;
DROP TABLE IF EXISTS public.talent_spotlight_optouts;
DROP FUNCTION IF EXISTS public.talent_pool_numbers();
DROP FUNCTION IF EXISTS public.talent_ratchet(text, integer);
DROP TABLE IF EXISTS public.talent_number_floor;

COMMIT;

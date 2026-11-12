-- ============================================================
-- UNDO add_company_notifications_safe.sql.
-- Stops new company-page notifications. Ones already delivered stay in members' lists
-- (the site shows them with its generic wording once the newer site code is rolled back too).
-- ============================================================
BEGIN;
DROP TRIGGER IF EXISTS trg_company_admin_added_notify   ON public.company_admins;
DROP TRIGGER IF EXISTS trg_company_report_new_notify    ON public.company_reports;
DROP TRIGGER IF EXISTS trg_company_claim_new_notify     ON public.company_claims;
DROP TRIGGER IF EXISTS trg_company_claim_decided_notify ON public.company_claims;
DROP FUNCTION IF EXISTS public.company_admin_added_notify();
DROP FUNCTION IF EXISTS public.company_notify_admins();
DROP FUNCTION IF EXISTS public.company_claim_decided_notify();
DROP FUNCTION IF EXISTS public.platform_admin_ids();
COMMIT;

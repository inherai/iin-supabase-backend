-- ============================================================
-- UNDO add_company_claims_safe.sql.
--
-- !! This DELETES every claim and page report filed since. Managers who were approved keep
-- !! managing their pages (company_admins is not touched), and pages created by an approval stay.
-- !! Deploy the API without the claim / report routes together with this.
-- ============================================================
BEGIN;
DROP TABLE IF EXISTS public.company_reports;
DROP TABLE IF EXISTS public.company_claims;        -- drops its triggers and policies with it
DROP FUNCTION IF EXISTS public.followed_companies(uuid);
DROP FUNCTION IF EXISTS public.company_claim_decide();
DROP FUNCTION IF EXISTS public.company_claim_before_insert();
COMMIT;

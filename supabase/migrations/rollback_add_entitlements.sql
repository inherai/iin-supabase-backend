-- ============================================================
-- UNDO add_entitlements_safe.sql — back to the state after add_company_pages_core.
--
-- !! This DELETES the catalogue and every subscription, exception, usage count and credit
-- !! line created since. Lines already written to company_audit_log stay.
-- !! Deploy the API without the code that calls these functions together with this.
-- ============================================================
BEGIN;

DROP FUNCTION IF EXISTS public.credits_spend(text, text, integer, text, text, text);
DROP FUNCTION IF EXISTS public.credit_balance(text, text);
DROP FUNCTION IF EXISTS public.entitlement_consume(text, text, text, integer);
DROP FUNCTION IF EXISTS public.entitlements_for(text, text);
DROP FUNCTION IF EXISTS public.entitlement_value(text, text, text);
DROP FUNCTION IF EXISTS public.entitlement_period_start(text);

DROP TABLE IF EXISTS public.credit_ledger;          -- each table drops its triggers and policies with it
DROP TABLE IF EXISTS public.usage_counters;
DROP TABLE IF EXISTS public.entitlement_overrides;
DROP TABLE IF EXISTS public.subscriptions;
DROP TABLE IF EXISTS public.prices;
DROP TABLE IF EXISTS public.products;
DROP TABLE IF EXISTS public.plan_features;
DROP TABLE IF EXISTS public.plans;
DROP TABLE IF EXISTS public.features;

DROP FUNCTION IF EXISTS public.entitlement_audit();
DROP FUNCTION IF EXISTS public.entitlement_subject_actor(text, text);
DROP FUNCTION IF EXISTS public.entitlement_subject_visible(text, text);

COMMIT;

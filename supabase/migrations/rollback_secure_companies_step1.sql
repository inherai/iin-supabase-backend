-- ============================================================
-- UNDO secure_companies_step1_safe.sql — puts companies and companies_ranked back exactly as
-- they were in snapshot_before_company_pages.json (2026-11-11).
-- Only if something on the site misbehaves after step 1.
-- ============================================================
BEGIN;
ALTER POLICY "Enable read access for all users" ON public.companies TO public;
ALTER VIEW public.companies_ranked RESET (security_invoker);
GRANT ALL ON TABLE public.companies        TO anon;
GRANT ALL ON TABLE public.companies_ranked TO anon;
GRANT INSERT, DELETE, TRUNCATE ON TABLE public.companies TO authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.companies_ranked TO authenticated;
COMMIT;

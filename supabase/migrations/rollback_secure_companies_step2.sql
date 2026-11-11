-- ============================================================
-- UNDO secure_companies_step2_safe.sql — members read every column of companies again,
-- as in snapshot_before_company_pages.json (2026-11-11). Step 1 stays in place.
-- ============================================================
BEGIN;
REVOKE SELECT (
  id, name, active, description, employee_count_range, founded_on, industries, linkedin_url,
  locations, logo, phone, specialities, tagline, universal_name, website, created_at,
  employees, last_scraped_at, owner_uuid, source, employees_count
) ON TABLE public.companies FROM authenticated;
GRANT SELECT ON TABLE public.companies TO authenticated;
COMMIT;

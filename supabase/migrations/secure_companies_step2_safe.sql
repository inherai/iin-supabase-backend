-- ============================================================
-- Secure companies, STEP 2 of 2 — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
--
-- !! Run ONLY AFTER the API is deployed with routes/companies.ts selecting an explicit column
-- !! list (COMPANY_COLUMNS). The previous code asked for `*` on GET /api/companies/:id, which
-- !! this step makes fail with "permission denied".
--
-- Before: every signed-in member could read companies.source_raw_json — import data that
-- includes third-party contact details (poc_email, poc_phone, ...).
--
-- What changes:
--   * members read every column of companies EXCEPT source_raw_json
-- What stays exactly the same:
--   * everything else members read or do; admins' screens (they go through the API's own
--     access); triggers; the companies_ranked view (it never included that column)
--
-- NOTE for later migrations: members now hold column-level SELECT. A column added to
-- companies is invisible to them until it is granted:  GRANT SELECT (new_col) ON companies TO authenticated;
--
-- The checks run in the SAME transaction: if any fails, everything is undone automatically.
-- To go back later: rollback_secure_companies_step2.sql
-- ============================================================
BEGIN;

REVOKE SELECT ON TABLE public.companies FROM authenticated;
GRANT SELECT (
  id, name, active, description, employee_count_range, founded_on, industries, linkedin_url,
  locations, logo, phone, specialities, tagline, universal_name, website, created_at,
  employees, last_scraped_at, owner_uuid, source, employees_count
) ON TABLE public.companies TO authenticated;

DO $$
DECLARE
  v_table bigint; v_view bigint; v_articles bigint; v_problems text := '';
  v_email text; v_uid uuid; v_missing text;
BEGIN
  -- every column except source_raw_json must be granted (catches a column added since this was written)
  SELECT string_agg(a.attname, ', ') INTO v_missing
  FROM pg_attribute a
  WHERE a.attrelid = 'public.companies'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname <> 'source_raw_json'
    AND NOT has_column_privilege('authenticated', 'public.companies', a.attname, 'SELECT');
  IF v_missing IS NOT NULL THEN v_problems := v_problems || ' members lost columns they need: ' || v_missing || ';'; END IF;

  SELECT email, uuid INTO v_email, v_uid FROM users WHERE status = 'Active' AND email NOT LIKE 'deleted_%' LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'email', v_email, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- 1. the columns the API asks for (GET /api/companies/:id)
    SELECT count(*) INTO v_table FROM (
      SELECT id, name, active, description, employee_count_range, founded_on, industries, linkedin_url,
             locations, logo, phone, specialities, tagline, universal_name, website, created_at,
             employees, employees_count
      FROM companies
    ) c;
    -- 2. the companies list view
    SELECT count(*) INTO v_view FROM companies_ranked;
    -- 3. articles (their rule reads companies.id and companies.owner_uuid)
    SELECT count(*) INTO v_articles FROM articles;
    -- 4. the ownership lookup used when posting / editing a bio as a company
    PERFORM 1 FROM companies WHERE owner_uuid = v_uid LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_problems := v_problems || ' a member read failed: ' || SQLERRM || ';';
  END;
  -- 5. the import data is no longer readable
  BEGIN
    PERFORM source_raw_json FROM companies LIMIT 1;
    v_problems := v_problems || ' members can still read source_raw_json;';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  IF coalesce(v_table, 0) = 0 THEN v_problems := v_problems || ' members can no longer read companies;'; END IF;
  IF coalesce(v_view, 0) <> coalesce(v_table, 0) THEN
    v_problems := v_problems || format(' the view shows %s companies, the table %s;', v_view, v_table);
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All 5 checks passed: members read % companies (table and view) and % articles, ownership lookup works, source_raw_json blocked.', v_table, v_articles;
END $$;

COMMIT;

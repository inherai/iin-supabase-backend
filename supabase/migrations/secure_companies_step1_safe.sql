-- ============================================================
-- Secure companies, STEP 1 of 2 — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs no code change and no deploy: signed-in members see exactly what they see today.
--
-- Before: anyone with the project's public (anon) key could read the whole companies table
-- without signing in — including owner_uuid, employees (member ids per company) and
-- source_raw_json (import data with third-party contact details). The companies_ranked view
-- was also open to signed-out visitors and ran with its owner's rights, so it skipped the
-- table's row-level security altogether.
--
-- What changes:
--   * no access at all without signing in, to the table or to the view
--   * the view runs with the reader's rights, so the table's rules apply through it too
--   * members lose INSERT / DELETE / TRUNCATE on the table — no rule ever allowed those, so
--     nothing that works today stops working
-- What stays exactly the same:
--   * signed-in members read the table and the view as today
--   * admins' UPDATE rule, the triggers and the API's own access
--
-- The checks run in the SAME transaction: if any fails, everything is undone automatically
-- and nothing changes. To go back later: rollback_secure_companies_step1.sql
-- ============================================================
BEGIN;

-- 1. Reading is for signed-in members only.
ALTER POLICY "Enable read access for all users" ON public.companies TO authenticated;

-- 2. The view obeys the table's rules instead of bypassing them.
ALTER VIEW public.companies_ranked SET (security_invoker = true);

-- 3. Privileges to match.
REVOKE ALL ON TABLE public.companies        FROM anon;
REVOKE ALL ON TABLE public.companies_ranked FROM anon;
REVOKE INSERT, DELETE, TRUNCATE ON TABLE public.companies FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.companies_ranked FROM authenticated;

DO $$
DECLARE
  v_table bigint; v_view bigint; v_articles bigint; v_problems text := '';
  v_email text; v_uid uuid; v_deleted boolean := false;
BEGIN
  SELECT email, uuid INTO v_email, v_uid FROM users WHERE status = 'Active' AND email NOT LIKE 'deleted_%' LIMIT 1;

  -- as a signed-in member
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'email', v_email, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    -- 1. she still reads the table
    SELECT count(*) INTO v_table FROM companies;
    -- 2. she still reads the view (companies list on the careers page)
    SELECT count(*) INTO v_view FROM companies_ranked;
    -- 3. she still reads articles (their rule looks into companies)
    SELECT count(*) INTO v_articles FROM articles;
  EXCEPTION WHEN OTHERS THEN
    v_problems := v_problems || ' a member read failed: ' || SQLERRM || ';';
  END;
  -- 4. she cannot delete a company
  BEGIN
    DELETE FROM companies WHERE id = -1;
    v_deleted := true;
  EXCEPTION WHEN insufficient_privilege THEN v_deleted := false;
  END;
  RESET ROLE;
  IF coalesce(v_table, 0) = 0 THEN v_problems := v_problems || ' members can no longer read companies;'; END IF;
  IF coalesce(v_view, 0) <> coalesce(v_table, 0) THEN
    v_problems := v_problems || format(' the view shows %s companies, the table %s;', v_view, v_table);
  END IF;
  IF v_deleted THEN v_problems := v_problems || ' a member is still allowed to delete;'; END IF;

  -- 5 + 6. a signed-out visitor reads neither the table nor the view
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM companies LIMIT 1;
    v_problems := v_problems || ' signed-out visitors can still read the table;';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM companies_ranked LIMIT 1;
    v_problems := v_problems || ' signed-out visitors can still read the view;';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All 6 checks passed: members read % companies (table and view) and % articles, member delete blocked, signed-out blocked on table and view.', v_table, v_articles;
END $$;

COMMIT;

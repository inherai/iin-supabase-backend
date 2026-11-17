-- ============================================================
-- Community insights privacy, STEP 2 of 2 — SELF-CHECKING (2026-11-17). Run in the SQL Editor
-- ONLY AFTER step 1 ran AND the API that reads the *_public views is deployed.
--
-- Closes the four tables to direct reading and writing with the public key:
--   * anon and signed-in members lose every privilege on company_reviews,
--     company_interviews, company_fit_ratings and company_salaries — they read through the
--     *_public views (step 1), which hide the writer of an anonymous item;
--   * the API keeps writing as today (service_role, unchanged);
--   * the policies change from "anyone reads everything / any signed-in member inserts any
--     row" to "her own rows only", should a privilege ever be granted again.
-- No row is changed or deleted.
-- To go back: rollback_secure_company_insights.sql (from the snapshot taken before).  Safe to re-run.
-- ============================================================
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.company_reviews_public') IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — run secure_company_insights_step1_safe.sql first';
  END IF;
END $$;

CREATE TEMP TABLE _insight_counts ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM company_reviews) r, (SELECT count(*) FROM company_interviews) i,
         (SELECT count(*) FROM company_fit_ratings) f, (SELECT count(*) FROM company_salaries) s;

-- company_reviews
REVOKE ALL ON public.company_reviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_reviews TO service_role;
DROP POLICY IF EXISTS "Authenticated users can submit reviews" ON public.company_reviews;
DROP POLICY IF EXISTS "anyone can read reviews" ON public.company_reviews;
DROP POLICY IF EXISTS "A member reads her own reviews" ON public.company_reviews;
CREATE POLICY "A member reads her own reviews" ON public.company_reviews FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "A member submits her own reviews" ON public.company_reviews;
CREATE POLICY "A member submits her own reviews" ON public.company_reviews FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- company_interviews
REVOKE ALL ON public.company_interviews FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_interviews TO service_role;
DROP POLICY IF EXISTS "Authenticated users can submit interviews" ON public.company_interviews;
DROP POLICY IF EXISTS "anyone can read interviews" ON public.company_interviews;
DROP POLICY IF EXISTS "A member reads her own interview reports" ON public.company_interviews;
CREATE POLICY "A member reads her own interview reports" ON public.company_interviews FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "A member submits her own interview reports" ON public.company_interviews;
CREATE POLICY "A member submits her own interview reports" ON public.company_interviews FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- company_fit_ratings
REVOKE ALL ON public.company_fit_ratings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_fit_ratings TO service_role;
DROP POLICY IF EXISTS "Authenticated users can submit fit ratings" ON public.company_fit_ratings;
DROP POLICY IF EXISTS "anyone can read fit ratings" ON public.company_fit_ratings;
DROP POLICY IF EXISTS "A member reads her own fit ratings" ON public.company_fit_ratings;
CREATE POLICY "A member reads her own fit ratings" ON public.company_fit_ratings FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "A member submits her own fit ratings" ON public.company_fit_ratings;
CREATE POLICY "A member submits her own fit ratings" ON public.company_fit_ratings FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- company_salaries
REVOKE ALL ON public.company_salaries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_salaries TO service_role;
DROP POLICY IF EXISTS "Authenticated users can submit salaries" ON public.company_salaries;
DROP POLICY IF EXISTS "anyone can read salaries" ON public.company_salaries;
DROP POLICY IF EXISTS "A member reads her own salaries" ON public.company_salaries;
CREATE POLICY "A member reads her own salaries" ON public.company_salaries FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "A member submits her own salaries" ON public.company_salaries;
CREATE POLICY "A member submits her own salaries" ON public.company_salaries FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ------------------------------------------------------------
-- Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_member uuid; v_page integer; v_n bigint; v_t text;
BEGIN
  SELECT uuid INTO v_member FROM users WHERE status = 'Active' AND email NOT LIKE 'deleted_%' ORDER BY uuid LIMIT 1;
  SELECT id INTO v_page FROM companies ORDER BY id LIMIT 1;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    FOREACH v_t IN ARRAY ARRAY['company_reviews', 'company_interviews', 'company_fit_ratings', 'company_salaries'] LOOP
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
        v_problems := v_problems || format(' a member still reads %s directly;', v_t);
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        EXECUTE format('SELECT count(*) FROM public.%I', v_t || '_public') INTO v_n;
      EXCEPTION WHEN insufficient_privilege THEN
        v_problems := v_problems || format(' a member cannot read %s_public;', v_t);
      END;
    END LOOP;
    BEGIN
      INSERT INTO company_reviews (company_id, user_id, title, pros, cons, overall_rating) VALUES (v_page, v_member, 'x', 'x', 'x', 3);
      v_problems := v_problems || ' a member still writes to company_reviews directly;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    PERFORM set_config('request.jwt.claims', '', true);
    SET LOCAL ROLE anon;
    BEGIN
      SELECT count(*) INTO v_n FROM company_reviews;
      v_problems := v_problems || ' the public key still reads company_reviews;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- the API's own key keeps working
    SET LOCAL ROLE service_role;
    SELECT count(*) INTO v_n FROM company_reviews;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (SELECT (r, i, f, s) FROM _insight_counts) IS DISTINCT FROM
     (SELECT ((SELECT count(*) FROM company_reviews), (SELECT count(*) FROM company_interviews),
              (SELECT count(*) FROM company_fit_ratings), (SELECT count(*) FROM company_salaries))) THEN
    v_problems := v_problems || ' the number of items changed;';
  END IF;
  IF v_problems <> '' THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems; END IF;
  RAISE NOTICE 'All checks passed: the tables are closed to the public key and to members, the views and the API key still read them, and no item changed.';
END $$;

COMMIT;

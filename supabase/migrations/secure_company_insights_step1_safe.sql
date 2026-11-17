-- ============================================================
-- Community insights privacy, STEP 1 of 2 — SELF-CHECKING (2026-11-17). Run in the SQL Editor.
-- Adds only; changes nothing members use today. Needs add_company_responses_safe.sql.
--
-- Reviews, interview reports, fit ratings and salaries can be posted anonymously, yet the
-- tables are readable to everyone holding the public key (anon too), user_id included —
-- so who wrote an anonymous item can be read directly. This step adds what the API will read
-- instead:
--   company_reviews_public / company_interviews_public / company_fit_ratings_public /
--   company_salaries_public — every row and column as today, except user_id is NULL on an
--   anonymous item that isn't the reader's own, plus is_mine. Signed-in members only.
-- company_responses_guard reads the items through these views (it runs in the manager's
-- session, which loses direct access in step 2).
--
-- Order: run this → deploy the API that reads the views → run step 2 (closes the tables).
-- To go back: rollback_secure_company_insights.sql (covers both steps).     Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. The views members read (owner rights: the masking is done here, not by the caller)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.company_reviews_public WITH (security_invoker = false) AS
  SELECT
    t.id,
    t.company_id,
    CASE WHEN t.is_anonymous AND t.user_id IS DISTINCT FROM auth.uid() THEN NULL ELSE t.user_id END AS user_id,
    t.title,
    t.job_title,
    t.pros,
    t.cons,
    t.overall_rating,
    t.work_life_balance_rating,
    t.culture_rating,
    t.management_rating,
    t.recommend,
    t.is_anonymous,
    t.created_at,
    (t.user_id = auth.uid()) AS is_mine
  FROM public.company_reviews t;

REVOKE ALL ON public.company_reviews_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_reviews_public TO authenticated, service_role;

CREATE OR REPLACE VIEW public.company_interviews_public WITH (security_invoker = false) AS
  SELECT
    t.id,
    t.company_id,
    CASE WHEN t.is_anonymous AND t.user_id IS DISTINCT FROM auth.uid() THEN NULL ELSE t.user_id END AS user_id,
    t.job_title,
    t.difficulty,
    t.outcome,
    t.pros,
    t.cons,
    t.process_description,
    t.questions,
    t.duration_weeks,
    t.is_anonymous,
    t.created_at,
    (t.user_id = auth.uid()) AS is_mine
  FROM public.company_interviews t;

REVOKE ALL ON public.company_interviews_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_interviews_public TO authenticated, service_role;

CREATE OR REPLACE VIEW public.company_fit_ratings_public WITH (security_invoker = false) AS
  SELECT
    t.id,
    t.company_id,
    CASE WHEN t.is_anonymous AND t.user_id IS DISTINCT FROM auth.uid() THEN NULL ELSE t.user_id END AS user_id,
    t.overall_fit_rating,
    t.modesty_rating,
    t.friday_hours_rating,
    t.holiday_flexibility_rating,
    t.separate_workspace_rating,
    t.kosher_kitchen_rating,
    t.notes,
    t.is_anonymous,
    t.created_at,
    (t.user_id = auth.uid()) AS is_mine
  FROM public.company_fit_ratings t;

REVOKE ALL ON public.company_fit_ratings_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_fit_ratings_public TO authenticated, service_role;

CREATE OR REPLACE VIEW public.company_salaries_public WITH (security_invoker = false) AS
  SELECT
    t.id,
    t.company_id,
    CASE WHEN t.is_anonymous AND t.user_id IS DISTINCT FROM auth.uid() THEN NULL ELSE t.user_id END AS user_id,
    t.job_title,
    t.salary_min,
    t.salary_max,
    t.currency,
    t.employment_type,
    t.experience_years,
    t.is_anonymous,
    t.created_at,
    (t.user_id = auth.uid()) AS is_mine
  FROM public.company_salaries t;

REVOKE ALL ON public.company_salaries_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_salaries_public TO authenticated, service_role;


-- ------------------------------------------------------------
-- 2. The company-response guard reads the items through the views
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_responses_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_item_company integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.target_type, NEW.target_id, NEW.company_id) IS DISTINCT FROM (OLD.target_type, OLD.target_id, OLD.company_id) THEN
      RAISE EXCEPTION 'an answer stays on its item' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND page_status = 'claimed') THEN
      RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
    END IF;
    IF (SELECT enabled FROM entitlement_value('company', NEW.company_id::text, 'reviews.respond')) IS NOT TRUE THEN
      RAISE EXCEPTION 'not_in_plan' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_item_company := CASE NEW.target_type
      WHEN 'review'     THEN (SELECT company_id FROM company_reviews_public     WHERE id = NEW.target_id)
      WHEN 'interview'  THEN (SELECT company_id FROM company_interviews_public  WHERE id = NEW.target_id)
      WHEN 'fit_rating' THEN (SELECT company_id FROM company_fit_ratings_public WHERE id = NEW.target_id)
    END;
    IF v_item_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'item_not_about_this_page' USING ERRCODE = '42501';
    END IF;
    NEW.responded_by := auth.uid();
    NEW.created_at := now();
  ELSE
    NEW.responded_by := coalesce(auth.uid(), OLD.responded_by);
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  NEW.body := btrim(NEW.body);
  RETURN NEW;
END;
$function$;

-- ------------------------------------------------------------
-- 3. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid;
  v_b uuid; v_c uuid;
  v_b_review uuid; v_c_review uuid;
  v_n bigint; v_seen uuid; v_mine boolean;
BEGIN
  SELECT a.company_id, a.user_id INTO v_page, v_owner
  FROM company_admins a JOIN companies co ON co.id = a.company_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_owner ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid NOT IN (v_owner, v_b) ORDER BY uuid LIMIT 1;

  -- every row of every table is in its view
  IF (SELECT count(*) FROM company_reviews) <> (SELECT count(*) FROM company_reviews_public)
  OR (SELECT count(*) FROM company_interviews) <> (SELECT count(*) FROM company_interviews_public)
  OR (SELECT count(*) FROM company_fit_ratings) <> (SELECT count(*) FROM company_fit_ratings_public)
  OR (SELECT count(*) FROM company_salaries) <> (SELECT count(*) FROM company_salaries_public) THEN
    v_problems := v_problems || ' a view does not show every row;';
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_reviews (company_id, user_id, title, pros, cons, overall_rating, is_anonymous)
    VALUES (v_page, v_b, 'check', 'check', 'check', 4, true) RETURNING id INTO v_b_review;
    INSERT INTO company_reviews (company_id, user_id, title, pros, cons, overall_rating, is_anonymous)
    VALUES (v_page, v_c, 'check', 'check', 'check', 3, false) RETURNING id INTO v_c_review;

    -- 1. C reads: B's anonymous review hides B; C's own named review shows C and is_mine
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT user_id, is_mine INTO v_seen, v_mine FROM company_reviews_public WHERE id = v_b_review;
    IF v_seen IS NOT NULL OR v_mine THEN v_problems := v_problems || ' an anonymous writer was shown to another member;'; END IF;
    SELECT user_id, is_mine INTO v_seen, v_mine FROM company_reviews_public WHERE id = v_c_review;
    IF v_seen IS DISTINCT FROM v_c OR NOT v_mine THEN v_problems := v_problems || ' a named review lost its writer or is_mine;'; END IF;
    RESET ROLE;

    -- 2. B reads her own anonymous review: she is its writer
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT user_id, is_mine INTO v_seen, v_mine FROM company_reviews_public WHERE id = v_b_review;
    IF v_seen IS DISTINCT FROM v_b OR NOT v_mine THEN v_problems := v_problems || ' a member does not see her own anonymous review as hers;'; END IF;
    RESET ROLE;

    -- 3. without signing in, the views are closed
    PERFORM set_config('request.jwt.claims', '', true);
    SET LOCAL ROLE anon;
    BEGIN
      SELECT count(*) INTO v_n FROM company_reviews_public;
      v_problems := v_problems || ' the views are readable without signing in;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 4. the page's owner can still answer a review about the page
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_b_review, v_page, 'thanks');
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM company_reviews WHERE id IN (v_b_review, v_c_review)) THEN v_problems := v_problems || ' test reviews were left behind;'; END IF;
  IF v_problems <> '' THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems; END IF;
  RAISE NOTICE 'All checks passed: the views show every item, hide the writer of an anonymous item from everyone but herself, are closed without signing in, and company responses still work.';
END $$;

COMMIT;

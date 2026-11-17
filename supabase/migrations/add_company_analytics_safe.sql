-- ============================================================
-- Company pages: numbers for the page's managers — SELF-CHECKING (2026-11-17).
-- Run in the SQL Editor. Needs add_company_pages_core_safe.sql, add_entitlements_safe.sql
-- and add_company_jobs_safe.sql.
--
-- 1. company_views: one row per member, per day, for a look at a page or at one of its
--    jobs. Written in the member's own session (her own row only); a page's managers
--    looking at their own page are not counted. NOBODY reads the rows through the API —
--    not the page's managers, not the member herself.
-- 2. company_page_stats(company, days): the page's numbers, as totals only — never who.
--    Open to every manager of the page (owner / content / recruiter / analyst) when the
--    page's plan includes 'analytics.basic'; a Duallin admin may look for support.
--      * page views and viewers, followers (now and new), post impressions, reactions and
--        comments on the page's posts, job views and applications — each with the same
--        number for the period before, for the "up / down" arrow;
--      * a line per day; the page's posts with the most impressions; the page's jobs.
--    Dates are UTC days, as post_impressions keeps them.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_analytics.sql          Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Views of a page and of its jobs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_views (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  job_id     bigint      REFERENCES public.open_position(id) ON DELETE CASCADE,  -- NULL = the page itself
  viewer_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  view_date  date        NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_views_once_a_day UNIQUE NULLS NOT DISTINCT (company_id, job_id, viewer_id, view_date)
);
CREATE INDEX IF NOT EXISTS idx_company_views_company_date ON public.company_views (company_id, view_date);
CREATE INDEX IF NOT EXISTS idx_company_views_viewer ON public.company_views (viewer_id);

ALTER TABLE public.company_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_views FROM PUBLIC, anon, authenticated;
-- she may only add her own row (the date and the rest come from the defaults)
GRANT INSERT (company_id, job_id, viewer_id) ON public.company_views TO authenticated;
GRANT ALL ON public.company_views TO service_role;

DROP POLICY IF EXISTS "A member records her own look at a page" ON public.company_views;
CREATE POLICY "A member records her own look at a page" ON public.company_views
  FOR INSERT TO authenticated
  WITH CHECK (
    viewer_id = auth.uid()
    -- the page's own managers are not counted
    AND NOT public.has_company_role(company_id, NULL)
    -- a job is counted on its own page only
    -- (company_views.job_id spelled out: open_position has a job_id column of its own)
    AND (company_views.job_id IS NULL OR EXISTS (
      SELECT 1 FROM public.open_position j WHERE j.id = company_views.job_id AND j.company_id = company_views.company_id))
  );

-- ------------------------------------------------------------
-- 2. The page's numbers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_page_stats(p_company_id integer, p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days  integer := CASE WHEN p_days IN (7, 30, 90) THEN p_days ELSE 30 END;
  v_to    date := CURRENT_DATE;
  v_from  date := CURRENT_DATE - (v_days - 1);
  v_prev  date := CURRENT_DATE - (2 * v_days - 1);   -- the period before starts here, ends at v_from - 1
  v_plan  boolean;
  v_post_ids text[];
  v_result jsonb;
BEGIN
  IF NOT (public.has_company_role(p_company_id, NULL) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'not_a_manager' USING ERRCODE = '42501';
  END IF;
  SELECT enabled INTO v_plan FROM public.entitlement_value('company', p_company_id::text, 'analytics.basic');
  IF v_plan IS NOT TRUE AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'not_in_plan' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_post_ids FROM posts WHERE company_id = p_company_id;

  WITH
  days AS (SELECT d::date AS day FROM generate_series(v_from, v_to, interval '1 day') d),
  views AS (
    SELECT view_date, job_id, viewer_id FROM company_views
    WHERE company_id = p_company_id AND view_date BETWEEN v_prev AND v_to
  ),
  follows AS (
    SELECT created_at::date AS day FROM article_company_follows
    WHERE company_id = p_company_id AND created_at >= v_prev
  ),
  impressions AS (
    SELECT post_id, user_id, impression_date FROM post_impressions
    WHERE post_id = ANY (v_post_ids) AND impression_date BETWEEN v_prev AND v_to
  ),
  reactions AS (
    SELECT target_id, created_at::date AS day FROM likes
    WHERE target_type = 'post' AND target_id = ANY (v_post_ids) AND created_at >= v_prev
  ),
  post_comments AS (   -- the page's own comments are not counted
    SELECT post_id, created_at::date AS day FROM comments
    WHERE post_id = ANY (v_post_ids) AND created_at >= v_prev AND company_id IS DISTINCT FROM p_company_id
  ),
  applications AS (
    SELECT job_id, created_at::date AS day FROM job_submissions
    WHERE company_id = p_company_id AND created_at >= v_prev
  ),
  totals AS (
    SELECT
      (SELECT count(*) FROM views WHERE job_id IS NULL AND view_date >= v_from)                     AS page_views,
      (SELECT count(DISTINCT viewer_id) FROM views WHERE job_id IS NULL AND view_date >= v_from)    AS page_viewers,
      (SELECT followers_count FROM companies WHERE id = p_company_id)                               AS followers,
      (SELECT count(*) FROM follows WHERE day >= v_from)                                            AS new_followers,
      (SELECT count(*) FROM impressions WHERE impression_date >= v_from)                            AS post_impressions,
      (SELECT count(DISTINCT user_id) FROM impressions WHERE impression_date >= v_from)             AS post_viewers,
      (SELECT count(*) FROM reactions WHERE day >= v_from)                                          AS reactions,
      (SELECT count(*) FROM post_comments WHERE day >= v_from)                                      AS comments,
      (SELECT count(*) FROM views WHERE job_id IS NOT NULL AND view_date >= v_from)                 AS job_views,
      (SELECT count(*) FROM applications WHERE day >= v_from)                                       AS applications
  ),
  previous AS (
    SELECT
      (SELECT count(*) FROM views WHERE job_id IS NULL AND view_date < v_from)                      AS page_views,
      (SELECT count(*) FROM follows WHERE day < v_from)                                             AS new_followers,
      (SELECT count(*) FROM impressions WHERE impression_date < v_from)                             AS post_impressions,
      (SELECT count(*) FROM reactions WHERE day < v_from)                                           AS reactions,
      (SELECT count(*) FROM post_comments WHERE day < v_from)                                       AS comments,
      (SELECT count(*) FROM views WHERE job_id IS NOT NULL AND view_date < v_from)                  AS job_views,
      (SELECT count(*) FROM applications WHERE day < v_from)                                        AS applications
  ),
  daily AS (
    SELECT jsonb_agg(jsonb_build_object(
      'date', d.day,
      'page_views',       (SELECT count(*) FROM views v WHERE v.job_id IS NULL AND v.view_date = d.day),
      'new_followers',    (SELECT count(*) FROM follows f WHERE f.day = d.day),
      'post_impressions', (SELECT count(*) FROM impressions i WHERE i.impression_date = d.day),
      'job_views',        (SELECT count(*) FROM views v WHERE v.job_id IS NOT NULL AND v.view_date = d.day)
    ) ORDER BY d.day) AS list
    FROM days d
  ),
  top_posts AS (
    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.impressions DESC, t.sent_at DESC) AS list
    FROM (
      SELECT p.id, p.sent_at,
             left(regexp_replace(regexp_replace(coalesce(p.message, ''), '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g'), 140) AS snippet,
             (SELECT count(*) FROM impressions i WHERE i.post_id = p.id AND i.impression_date >= v_from) AS impressions,
             (SELECT count(*) FROM reactions r WHERE r.target_id = p.id AND r.day >= v_from)          AS reactions,
             (SELECT count(*) FROM post_comments c WHERE c.post_id = p.id AND c.day >= v_from)         AS comments
      FROM posts p
      WHERE p.company_id = p_company_id
      ORDER BY 4 DESC, p.sent_at DESC
      LIMIT 5
    ) t
  ),
  jobs AS (
    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.views DESC, t.created_at DESC) AS list
    FROM (
      SELECT j.id, j.job_title AS title, j.status, j.created_at,
             (SELECT count(*) FROM views v WHERE v.job_id = j.id AND v.view_date >= v_from)  AS views,
             (SELECT count(*) FROM applications a WHERE a.job_id = j.id AND a.day >= v_from) AS applications
      FROM open_position j
      WHERE j.company_id = p_company_id AND (j.status IN ('open', 'paused') OR j.created_at >= v_from)
      ORDER BY 5 DESC, j.created_at DESC
      LIMIT 10
    ) t
  )
  SELECT jsonb_build_object(
    'days', v_days, 'from', v_from, 'to', v_to,
    'totals',   (SELECT row_to_json(totals)::jsonb FROM totals),
    'previous', (SELECT row_to_json(previous)::jsonb FROM previous),
    'daily',    coalesce((SELECT list FROM daily), '[]'::jsonb),
    'top_posts', coalesce((SELECT list FROM top_posts), '[]'::jsonb),
    'jobs',     coalesce((SELECT list FROM jobs), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.company_page_stats(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_page_stats(integer, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid;
  v_b uuid; v_c uuid;
  v_job bigint; v_other_job bigint;
  v_before jsonb; v_after jsonb; v_n bigint;
BEGIN
  SELECT a.company_id, a.user_id INTO v_page, v_owner
  FROM company_admins a JOIN companies co ON co.id = a.company_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;

  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_b
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  IF v_b IS NULL OR v_c IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need two members who manage no page'; END IF;

  SELECT id INTO v_job FROM open_position WHERE company_id = v_page ORDER BY id DESC LIMIT 1;
  SELECT id INTO v_other_job FROM open_position WHERE company_id IS DISTINCT FROM v_page ORDER BY id DESC LIMIT 1;

  BEGIN
    -- the numbers before, as the owner
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_before := public.company_page_stats(v_page, 30);
    RESET ROLE;

    -- 1. B looks at the page twice today, and at its job → one page view, one job view
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_views (company_id, viewer_id) VALUES (v_page, v_b) ON CONFLICT DO NOTHING;
    INSERT INTO company_views (company_id, viewer_id) VALUES (v_page, v_b) ON CONFLICT DO NOTHING;
    IF v_job IS NOT NULL THEN
      INSERT INTO company_views (company_id, job_id, viewer_id) VALUES (v_page, v_job, v_b) ON CONFLICT DO NOTHING;
    END IF;

    -- 2. B cannot record a look in C's name
    BEGIN
      INSERT INTO company_views (company_id, viewer_id) VALUES (v_page, v_c);
      v_problems := v_problems || ' a member recorded a look in another member''s name;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 3. B cannot count another company's job on this page
    IF v_other_job IS NOT NULL THEN
      BEGIN
        INSERT INTO company_views (company_id, job_id, viewer_id) VALUES (v_page, v_other_job, v_b);
        v_problems := v_problems || ' a job was counted on a page it does not belong to;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END IF;

    -- 4. B cannot read who looked
    BEGIN
      SELECT count(*) INTO v_n FROM company_views;
      v_problems := v_problems || ' a member could read the views table;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 5. B cannot read the page's numbers
    BEGIN
      PERFORM public.company_page_stats(v_page, 30);
      v_problems := v_problems || ' a member who does not manage the page read its numbers;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 6. the owner's own look is not counted
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_views (company_id, viewer_id) VALUES (v_page, v_owner);
      v_problems := v_problems || ' a page''s manager was counted looking at her own page;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 7. the owner sees B's look once (and the job's), without anyone's name
    v_after := public.company_page_stats(v_page, 30);
    RESET ROLE;
    IF (v_after->'totals'->>'page_views')::int - (v_before->'totals'->>'page_views')::int <> 1 THEN
      v_problems := v_problems || format(' two looks on one day counted %s, expected 1;',
        (v_after->'totals'->>'page_views')::int - (v_before->'totals'->>'page_views')::int);
    END IF;
    IF v_job IS NOT NULL AND (v_after->'totals'->>'job_views')::int - (v_before->'totals'->>'job_views')::int <> 1 THEN
      v_problems := v_problems || ' a job view was not counted;';
    END IF;
    IF v_after::text LIKE '%' || v_b::text || '%' THEN
      v_problems := v_problems || ' the numbers named a member;';
    END IF;
    IF jsonb_array_length(v_after->'daily') <> 30 THEN
      v_problems := v_problems || ' the daily line does not have 30 days;';
    END IF;

    -- 8. an analyst may read the numbers
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_page, v_c, 'analyst');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.company_page_stats(v_page, 7);
    EXCEPTION WHEN insufficient_privilege THEN
      v_problems := v_problems || ' an analyst could not read the page''s numbers;';
    END;
    RESET ROLE;

    -- 9. without 'analytics.basic' in the plan, even the owner cannot
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled, reason)
    VALUES ('company', v_page::text, 'analytics.basic', false, 'self-check');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.company_page_stats(v_page, 30);
      v_problems := v_problems || ' the numbers were shown to a page whose plan does not include them;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM company_views WHERE viewer_id = v_b) THEN v_problems := v_problems || ' test views were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: looks are counted once a day, only in her own name and never for the page''s managers; nobody reads who looked; the numbers are totals, for the page''s managers, when the plan includes them.';
END $$;

COMMIT;

-- ============================================================
-- Company articles follow the page's managers — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql (has_company_role / company_admins).
--
-- Three rules on articles and article_skills asked "is the caller this company's
-- owner_uuid?". They now ask "does the caller manage this page as owner or content manager?"
-- — the same question the API asks (lib/companyAccess.ts), so the two can't drift apart.
--
-- Nothing changes for anyone today: the only page with an owner has that same person as its
-- one manager. The checks below prove it — they count what an owner, an ordinary member and
-- a signed-out visitor can see before and after, and refuse the change on any difference.
--
-- Signed-out visitors: the old rules were written for everyone, visitors included. Since
-- companies was closed to visitors (secure_companies_step1) a visitor's read of articles
-- has been failing, because the rule itself looked into companies. The new rules are written
-- for signed-in members only, so a visitor simply gets nothing — articles stay closed to
-- visitors, now on purpose rather than by accident.
--
-- The checks run in the SAME transaction: if any fails, nothing changes.
-- To go back later: rollback_article_policies_use_company_roles.sql      Safe to re-run.
-- ============================================================
BEGIN;

CREATE TEMP TABLE _article_visibility (who text, phase text, articles bigint, skills bigint) ON COMMIT DROP;
GRANT SELECT, INSERT ON _article_visibility TO anon, authenticated;

CREATE OR REPLACE FUNCTION pg_temp.count_article_visibility(p_phase text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_owner uuid; v_member uuid;
BEGIN
  SELECT user_id INTO v_owner FROM public.company_admins WHERE role = 'owner' ORDER BY created_at LIMIT 1;
  SELECT uuid INTO v_member FROM public.users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%'
    AND NOT EXISTS (SELECT 1 FROM public.company_admins a WHERE a.user_id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM public.articles ar WHERE ar.author_uuid = u.uuid) ORDER BY uuid LIMIT 1;

  IF v_owner IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO _article_visibility SELECT 'owner', p_phase, (SELECT count(*) FROM public.articles), (SELECT count(*) FROM public.article_skills);
    RESET ROLE;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO _article_visibility SELECT 'member', p_phase, (SELECT count(*) FROM public.articles), (SELECT count(*) FROM public.article_skills);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  BEGIN
    INSERT INTO _article_visibility SELECT 'visitor', p_phase, (SELECT count(*) FROM public.articles), 0;
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _article_visibility VALUES ('visitor', p_phase, -1, 0);   -- -1 = the read is refused
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

SELECT pg_temp.count_article_visibility('before');

DROP POLICY IF EXISTS articles_read_published_or_own ON public.articles;
CREATE POLICY articles_read_published_or_own ON public.articles FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (
    status = 'published'
    OR author_uuid = auth.uid()
    OR public.has_company_role(company_id, ARRAY['owner', 'content'])
  ));

DROP POLICY IF EXISTS articles_author_write ON public.articles;
CREATE POLICY articles_author_write ON public.articles FOR ALL TO authenticated
  USING (author_uuid = auth.uid() OR public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS article_skills_author_write ON public.article_skills;
CREATE POLICY article_skills_author_write ON public.article_skills FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.articles
    WHERE articles.id = article_skills.article_id
      AND (articles.author_uuid = auth.uid() OR public.has_company_role(articles.company_id, ARRAY['owner', 'content']))
  ));

SELECT pg_temp.count_article_visibility('after');

DO $$
DECLARE
  v_problems text := '';
  r record;
BEGIN
  FOR r IN
    SELECT b.who, b.articles AS a_before, a.articles AS a_after, b.skills AS s_before, a.skills AS s_after
    FROM _article_visibility b JOIN _article_visibility a ON a.who = b.who AND a.phase = 'after'
    WHERE b.phase = 'before' AND b.who <> 'visitor'
  LOOP
    IF r.a_before <> r.a_after OR r.s_before <> r.s_after THEN
      v_problems := v_problems || format(' %s saw %s articles / %s skill rows before and %s / %s after;', r.who, r.a_before, r.s_before, r.a_after, r.s_after);
    END IF;
  END LOOP;
  IF (SELECT articles FROM _article_visibility WHERE who = 'visitor' AND phase = 'after') > 0 THEN
    v_problems := v_problems || ' signed-out visitors can read articles;';
  END IF;
  IF (SELECT count(*) FROM _article_visibility WHERE phase = 'after') < 2 THEN v_problems := v_problems || ' the comparison did not run;'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('articles', 'article_skills') AND (qual ~ 'owner_uuid' OR with_check ~ 'owner_uuid')) THEN
    v_problems := v_problems || ' a rule still reads owner_uuid;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: owner and member each see exactly what they saw before, visitors see nothing (%).',
    (SELECT string_agg(who || ': ' || articles, ', ' ORDER BY who) FROM _article_visibility WHERE phase = 'after');
END $$;

COMMIT;

-- ============================================================
-- Emails to recruiters: pool numbers, the talent spotlight — SELF-CHECKING (2026-11-22).
-- Run in the SQL Editor. Needs add_talent_v2_safe.sql, add_company_pages_core_safe.sql
-- (is_platform_admin), add_member_job_seeking_safe.sql and add_talent_analytics_safe.sql.
--
-- What it adds
--   1. talent_ratchet(key, value): a number shown to recruiters never goes down. The largest value
--      ever shown is kept per key; a smaller one is answered with the kept one.
--   2. talent_pool_numbers(): the pool in numbers for the recruiter emails and the /talent hero —
--      members, working in tech now, joined lately, the most common skills and current roles.
--      Same members as talent_search() / talent_overview(). API (service role) only.
--   3. talent_spotlight_optouts: a member who does not want her work shown in emails to recruiters.
--      She adds / removes / reads only her own row.
--   4. talent_spotlight_picks: what the team picked for the spotlight email (every two weeks).
--      Duallin admins only.
--   5. admin_spotlight_suggestions(days): members' recent work recruiters can already see in the site
--      (articles, project / milestone posts, long posts, detailed answers to questions) — not
--      "community members only" content, not anonymous members, not those who opted out, not
--      anyone featured in the last 8 weeks. Admins only.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing changes.
-- To go back later: rollback_add_recruiter_emails.sql                Safe to re-run.
-- ============================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.member_job_seeking') IS NULL OR to_regclass('public.talent_events') IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — run add_member_job_seeking_safe.sql and add_talent_analytics_safe.sql first';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Numbers that only go up
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_number_floor (
  key        text        PRIMARY KEY,
  value      integer     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.talent_number_floor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.talent_number_floor FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.talent_number_floor TO service_role;

CREATE OR REPLACE FUNCTION public.talent_ratchet(p_key text, p_value integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  INSERT INTO talent_number_floor (key, value) VALUES (p_key, greatest(coalesce(p_value, 0), 0))
  ON CONFLICT (key) DO UPDATE
    SET value = greatest(talent_number_floor.value, EXCLUDED.value),
        updated_at = CASE WHEN EXCLUDED.value > talent_number_floor.value THEN now() ELSE talent_number_floor.updated_at END
  RETURNING value
$function$;
REVOKE ALL ON FUNCTION public.talent_ratchet(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_ratchet(text, integer) TO service_role;

-- ------------------------------------------------------------
-- 2. The pool in numbers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_pool_numbers()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT u.uuid, coalesce(u.activated_at, u.created_at) AS joined, coalesce(u.skills, '{}') AS skills,
           CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END AS experience,
           coalesce(u.work_preferences, '{}') AS work_prefs, nullif(btrim(split_part(coalesce(u.location, ''), ',', 1)), '') AS city
    FROM users u
    WHERE u.role::text NOT IN ('feed_participant', 'recruiters')
      AND u.status = 'Active'
      AND coalesce(u.is_anonymous, false) = false
      AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
  ),
  skills AS (
    SELECT min(btrim(sk)) AS label, count(*) AS n, count(*) FILTER (WHERE m.joined >= now() - interval '30 days') AS n_new
    FROM m, unnest(m.skills) sk
    WHERE btrim(sk) <> ''
    GROUP BY lower(btrim(sk))
  ),
  -- current roles, spellings joined: "Full Stack" / "FullStack" / "Full-stack", "Senior …" with "…"
  titles AS (
    SELECT mode() WITHIN GROUP (ORDER BY regexp_replace(regexp_replace(btrim(e ->> 'title'), '^(senior|sr\.?|junior|jr\.?)\s+', '', 'i'), '\s+', ' ', 'g')) AS label,
           count(DISTINCT m.uuid) AS n
    FROM m, jsonb_array_elements(m.experience) e
    WHERE e ->> 'current' = 'true' AND btrim(coalesce(e ->> 'title', '')) <> ''
    GROUP BY regexp_replace(regexp_replace(lower(e ->> 'title'), '^(senior|sr\.?|junior|jr\.?)\s+', ''), '[^a-z0-9א-ת]', '', 'g')
  )
  SELECT jsonb_build_object(
    'pool',           (SELECT count(*) FROM m),
    'employed',       (SELECT count(*) FROM m WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(m.experience) e WHERE e ->> 'current' = 'true')),
    'new_30d',        (SELECT count(*) FROM m WHERE joined >= now() - interval '30 days'),
    'new_7d',         (SELECT count(*) FROM m WHERE joined >= now() - interval '7 days'),
    'seeking',        (SELECT count(*) FROM m JOIN member_job_seeking js ON js.user_uuid = m.uuid
                        WHERE js.status IN ('active', 'open') AND js.visibility = 'recruiters'),
    'top_skills',     coalesce((SELECT jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label)
                        FROM (SELECT * FROM skills ORDER BY n DESC, label LIMIT 12) s), '[]'::jsonb),
    'new_skills_30d', coalesce((SELECT jsonb_agg(jsonb_build_object('label', label, 'count', n_new) ORDER BY n_new DESC, label)
                        FROM (SELECT * FROM skills WHERE n_new > 0 ORDER BY n_new DESC, label LIMIT 12) s), '[]'::jsonb),
    'top_titles',     coalesce((SELECT jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label)
                        FROM (SELECT * FROM titles ORDER BY n DESC, label LIMIT 8) t), '[]'::jsonb),
    -- for the hiring guide: how they want to work, and where they live
    'work_prefs',     coalesce((SELECT jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label)
                        FROM (SELECT min(wp) AS label, count(*) AS n FROM m, unnest(m.work_prefs) wp
                              WHERE btrim(wp) <> '' GROUP BY lower(btrim(wp)) ORDER BY count(*) DESC LIMIT 8) w), '[]'::jsonb),
    'cities',         coalesce((SELECT jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label)
                        FROM (SELECT min(city) AS label, count(*) AS n FROM m WHERE city IS NOT NULL AND lower(city) <> 'israel'
                              GROUP BY lower(city) ORDER BY count(*) DESC LIMIT 8) c), '[]'::jsonb)
  )
$function$;
REVOKE ALL ON FUNCTION public.talent_pool_numbers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_pool_numbers() TO service_role;

-- ------------------------------------------------------------
-- 3. "Don't show my work to recruiters"
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_spotlight_optouts (
  user_uuid  uuid        PRIMARY KEY DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.talent_spotlight_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.talent_spotlight_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.talent_spotlight_optouts TO authenticated;
GRANT INSERT (user_uuid) ON public.talent_spotlight_optouts TO authenticated;
GRANT ALL ON public.talent_spotlight_optouts TO service_role;

DROP POLICY IF EXISTS "A member reads her own spotlight choice" ON public.talent_spotlight_optouts;
CREATE POLICY "A member reads her own spotlight choice" ON public.talent_spotlight_optouts
  FOR SELECT TO authenticated USING (user_uuid = auth.uid());
DROP POLICY IF EXISTS "A member opts out of the spotlight" ON public.talent_spotlight_optouts;
CREATE POLICY "A member opts out of the spotlight" ON public.talent_spotlight_optouts
  FOR INSERT TO authenticated WITH CHECK (user_uuid = auth.uid());
DROP POLICY IF EXISTS "A member opts back in" ON public.talent_spotlight_optouts;
CREATE POLICY "A member opts back in" ON public.talent_spotlight_optouts
  FOR DELETE TO authenticated USING (user_uuid = auth.uid());

-- ------------------------------------------------------------
-- 4. The team's picks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_spotlight_picks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the Sunday the email goes out
  send_on      date        NOT NULL,
  member_uuid  uuid        NOT NULL REFERENCES public.users(uuid) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('article', 'project', 'post', 'answer', 'milestone')),
  role_he      text        CHECK (role_he IS NULL OR char_length(role_he) <= 120),
  role_en      text        CHECK (role_en IS NULL OR char_length(role_en) <= 120),
  did_he       text        NOT NULL CHECK (char_length(btrim(did_he)) BETWEEN 1 AND 400),
  did_en       text        NOT NULL CHECK (char_length(btrim(did_en)) BETWEEN 1 AND 400),
  skills       text[]      NOT NULL DEFAULT '{}' CHECK (cardinality(skills) <= 5),
  source_url   text        CHECK (source_url IS NULL OR char_length(source_url) <= 500),
  status       text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'sent')),
  sent_at      timestamptz,
  member_notified_at timestamptz,
  created_by   uuid        DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (send_on, member_uuid)
);
CREATE INDEX IF NOT EXISTS idx_talent_spotlight_picks_member ON public.talent_spotlight_picks (member_uuid, send_on DESC);

ALTER TABLE public.talent_spotlight_picks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.talent_spotlight_picks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.talent_spotlight_picks TO authenticated;
GRANT ALL ON public.talent_spotlight_picks TO service_role;

DROP POLICY IF EXISTS "Admins manage the spotlight" ON public.talent_spotlight_picks;
CREATE POLICY "Admins manage the spotlight" ON public.talent_spotlight_picks
  FOR ALL TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

-- ------------------------------------------------------------
-- 5. Suggestions for the team
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_spotlight_suggestions(p_days integer DEFAULT 21)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 21), 1), 90));
  v_result jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not Found' USING ERRCODE = '42501';
  END IF;

  WITH m AS (
    SELECT u.uuid, lower(u.email) AS email, u.first_name, u.last_name, u.headline, coalesce(u.skills, '{}') AS skills,
           CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END AS experience
    FROM users u
    WHERE u.role::text NOT IN ('feed_participant', 'recruiters')
      AND u.status = 'Active'
      AND coalesce(u.is_anonymous, false) = false
      AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
      AND NOT EXISTS (SELECT 1 FROM talent_spotlight_optouts o WHERE o.user_uuid = u.uuid)
      AND NOT EXISTS (SELECT 1 FROM talent_spotlight_picks p WHERE p.member_uuid = u.uuid AND p.send_on >= current_date - 56)
  ),
  -- the visible text of a post / comment
  work AS (
    SELECT a.author_uuid AS uuid, 'article'::text AS kind, coalesce(a.published_at, a.created_at) AS at,
           a.title AS title, left(coalesce(a.excerpt, ''), 300) AS excerpt, '/articles/article/' || a.id AS link
    FROM articles a
    WHERE a.status = 'published' AND a.author_type = 'user' AND coalesce(a.published_at, a.created_at) >= v_since
    UNION ALL
    SELECT m.uuid, CASE p.post_type WHEN 'milestone' THEN 'milestone' ELSE 'post' END, p.sent_at,
           nullif(btrim(coalesce(p.subject, '')), ''), left(btrim(regexp_replace(coalesce(p.message, ''), '<[^>]+>', ' ', 'g')), 300),
           '/post/' || p.id
    FROM posts p JOIN m ON m.email = lower(p.sender)
    WHERE p.sent_at >= v_since AND coalesce(p.community_members_only, false) = false AND p.company_id IS NULL
      AND (p.post_type = 'milestone'
           OR (p.post_type IN ('discussion', 'share') AND char_length(regexp_replace(coalesce(p.message, ''), '<[^>]+>', '', 'g')) > 400))
    UNION ALL
    SELECT m.uuid, 'answer', c.created_at, nullif(btrim(coalesce(q.subject, '')), ''),
           left(btrim(regexp_replace(coalesce(c.message, ''), '<[^>]+>', ' ', 'g')), 300), '/post/' || q.id
    FROM comments c JOIN posts q ON q.id = c.post_id JOIN m ON m.email = lower(c.sender)
    WHERE c.created_at >= v_since AND q.post_type = 'question' AND c.parent_comment_id IS NULL
      AND coalesce(c.community_members_only, false) = false AND coalesce(q.community_members_only, false) = false
      AND char_length(coalesce(c.message, '')) > 150
  ),
  ranked AS (
    SELECT w.*, row_number() OVER (PARTITION BY w.uuid ORDER BY
             CASE w.kind WHEN 'article' THEN 0 WHEN 'milestone' THEN 1 WHEN 'post' THEN 2 ELSE 3 END, w.at DESC) AS rn,
           count(*) OVER (PARTITION BY w.uuid) AS pieces,
           count(*) FILTER (WHERE w.kind = 'answer') OVER (PARTITION BY w.uuid) AS answers
    FROM work w
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'member_uuid', m.uuid,
      'first_name', m.first_name,
      'last_name', m.last_name,
      'headline', m.headline,
      'current_title', (SELECT e ->> 'title' FROM jsonb_array_elements(m.experience) e WHERE e ->> 'current' = 'true' LIMIT 1),
      'skills', to_jsonb(m.skills[1:6]),
      'kind', r.kind,
      'at', r.at,
      'title', r.title,
      'excerpt', r.excerpt,
      'link', r.link,
      'pieces', r.pieces,
      'answers', r.answers,
      'last_featured', (SELECT max(p.send_on) FROM talent_spotlight_picks p WHERE p.member_uuid = m.uuid)
    ) ORDER BY CASE r.kind WHEN 'article' THEN 0 WHEN 'milestone' THEN 1 WHEN 'post' THEN 2 ELSE 3 END, r.pieces DESC, r.at DESC), '[]'::jsonb)
  INTO v_result
  FROM ranked r JOIN m ON m.uuid = r.uuid
  WHERE r.rn = 1;

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_spotlight_suggestions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_spotlight_suggestions(integer) TO authenticated;

-- ------------------------------------------------------------
-- Self-check with throw-away rows. Nothing is kept.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_a uuid;
  v_b uuid;
  v_n integer;
  v_json jsonb;
BEGIN
  SELECT uuid INTO v_a FROM public.users WHERE uuid IN (SELECT id FROM auth.users) ORDER BY created_at LIMIT 1;
  SELECT uuid INTO v_b FROM public.users WHERE uuid IN (SELECT id FROM auth.users) AND uuid <> v_a ORDER BY created_at LIMIT 1;

  -- ratchet never goes down
  BEGIN
    PERFORM public.talent_ratchet('_probe', 10);
    IF public.talent_ratchet('_probe', 7) <> 10 THEN v_problems := v_problems || ' the ratchet went down;'; END IF;
    IF public.talent_ratchet('_probe', 12) <> 12 THEN v_problems := v_problems || ' the ratchet did not go up;'; END IF;
    RAISE EXCEPTION 'probe_ok';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'probe_ok' THEN v_problems := v_problems || ' ' || SQLERRM || ';'; END IF;
  END;

  v_json := public.talent_pool_numbers();
  IF (v_json ->> 'pool') IS NULL OR jsonb_typeof(v_json -> 'top_skills') <> 'array' THEN
    v_problems := v_problems || ' talent_pool_numbers is missing a part;';
  END IF;

  BEGIN
    -- a member: her own opt-out only; no pool numbers, no ratchet, no picks, no suggestions
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a, 'app_metadata', json_build_object())::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO public.talent_spotlight_optouts DEFAULT VALUES;
      SELECT count(*) INTO v_n FROM public.talent_spotlight_optouts;
      IF v_n <> 1 THEN v_problems := v_problems || ' a member does not see exactly her own opt-out;'; END IF;
      DELETE FROM public.talent_spotlight_optouts;
      RAISE EXCEPTION 'probe_ok';
    EXCEPTION
      WHEN raise_exception THEN IF SQLERRM <> 'probe_ok' THEN v_problems := v_problems || ' opt-out: ' || SQLERRM || ';'; END IF;
      WHEN OTHERS THEN v_problems := v_problems || ' a member could not opt out: ' || SQLERRM || ';';
    END;
    BEGIN
      INSERT INTO public.talent_spotlight_optouts (user_uuid) VALUES (v_b);
      v_problems := v_problems || ' a member opted out someone else;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.talent_pool_numbers();
      v_problems := v_problems || ' members can call talent_pool_numbers;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.talent_ratchet('_probe', 1);
      v_problems := v_problems || ' members can call talent_ratchet;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.admin_spotlight_suggestions(21);
      v_problems := v_problems || ' a member got spotlight suggestions;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    SELECT count(*) INTO v_n FROM public.talent_spotlight_picks;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member can read spotlight picks;'; END IF;
    BEGIN
      INSERT INTO public.talent_spotlight_picks (send_on, member_uuid, kind, did_he, did_en) VALUES (current_date, v_b, 'post', 'x', 'x');
      v_problems := v_problems || ' a member added a spotlight pick;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- an admin: picks and suggestions
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a, 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO public.talent_spotlight_picks (send_on, member_uuid, kind, did_he, did_en, skills) VALUES (current_date, v_b, 'article', 'בדיקה', 'probe', '{SQL}');
      SELECT count(*) INTO v_n FROM public.talent_spotlight_picks WHERE member_uuid = v_b AND send_on = current_date;
      IF v_n <> 1 THEN v_problems := v_problems || ' an admin cannot read her pick;'; END IF;
      RAISE EXCEPTION 'probe_ok';
    EXCEPTION
      WHEN raise_exception THEN IF SQLERRM <> 'probe_ok' THEN v_problems := v_problems || ' pick: ' || SQLERRM || ';'; END IF;
      WHEN OTHERS THEN v_problems := v_problems || ' an admin could not add a pick: ' || SQLERRM || ';';
    END;
    v_json := public.admin_spotlight_suggestions(21);
    IF jsonb_typeof(v_json) <> 'array' THEN v_problems := v_problems || ' suggestions are not a list;'; END IF;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % members in the pool, % spotlight suggestions now.',
    public.talent_pool_numbers() ->> 'pool', jsonb_array_length(v_json);
END $$;

COMMIT;

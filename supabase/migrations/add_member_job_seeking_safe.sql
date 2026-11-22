-- ============================================================
-- Job-seeking status: its own table, and never shown to her own company's recruiters
-- — SELF-CHECKING (2026-11-22). Run in the SQL Editor. Needs add_talent_experience_safe.sql
-- and add_people_search.sql / people_search_active_only.sql (people_search_index).
--
-- Two problems:
--   1. users.job_seeking_status / job_seeking_visibility were readable by every member through
--      the REST API (users has a table-wide SELECT for authenticated). A single column can't be
--      revoked while that grant stands, and narrowing it to a column list breaks every
--      select('*') on users. So the status moves to member_job_seeking: she reads and writes
--      only her own row; the API reads the rest with the service role.
--   2. A recruiter saw the status of candidates who work at her own company (and could filter
--      by it). Now, when the candidate's current workplace is one of the recruiter's companies,
--      the recruiter gets no badge, no filter match and no ranking boost for her.
--      The recruiter's companies: every company she has a page role in (company_admins), and
--      her own current workplace. Names are compared with the people-search keys
--      (people_search_company_key + people_search_canonical_company), the same ones
--      people_search_index.current_company_keys holds for the candidate.
--
-- Order:  this file → deploy the API (routes/me.ts, _talentProfiles.ts, saved_resources.ts)
--         → drop_users_job_seeking_columns_safe.sql.
-- Until the API is deployed, the old API still writes users.job_seeking_*; a trigger copies
-- every such change into member_job_seeking, so nothing is lost in between.
-- No row of users is changed.                                   Safe to re-run.
-- To go back: rollback_member_job_seeking.sql
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. The table: her own row only
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_job_seeking (
  user_uuid  uuid        PRIMARY KEY REFERENCES public.users(uuid) ON DELETE CASCADE,
  status     text        CHECK (status IN ('active', 'open', 'not_looking')),
  -- 'recruiters': a badge on her card in the talent search, and the availability filter finds her.
  -- 'quiet': no badge, not in the filter — she only ranks higher in recruiters' results.
  visibility text        NOT NULL DEFAULT 'recruiters' CHECK (visibility IN ('recruiters', 'quiet')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_member_job_seeking_status ON public.member_job_seeking (status) WHERE status IS NOT NULL;

ALTER TABLE public.member_job_seeking ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_job_seeking_select_own ON public.member_job_seeking;
DROP POLICY IF EXISTS member_job_seeking_insert_own ON public.member_job_seeking;
DROP POLICY IF EXISTS member_job_seeking_update_own ON public.member_job_seeking;
CREATE POLICY member_job_seeking_select_own ON public.member_job_seeking
  FOR SELECT TO authenticated USING (user_uuid = auth.uid());
CREATE POLICY member_job_seeking_insert_own ON public.member_job_seeking
  FOR INSERT TO authenticated WITH CHECK (user_uuid = auth.uid());
CREATE POLICY member_job_seeking_update_own ON public.member_job_seeking
  FOR UPDATE TO authenticated USING (user_uuid = auth.uid()) WITH CHECK (user_uuid = auth.uid());

REVOKE ALL ON public.member_job_seeking FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.member_job_seeking TO authenticated;
GRANT ALL ON public.member_job_seeking TO service_role;

-- ------------------------------------------------------------
-- 2. Until the API is deployed: copy what the old API writes into users
--    (dropped by drop_users_job_seeking_columns_safe.sql)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.member_job_seeking_from_users()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO member_job_seeking (user_uuid, status, visibility, updated_at)
  VALUES (NEW.uuid, NEW.job_seeking_status, coalesce(NEW.job_seeking_visibility, 'recruiters'), now())
  ON CONFLICT (user_uuid) DO UPDATE
    SET status = EXCLUDED.status, visibility = EXCLUDED.visibility, updated_at = now();
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.member_job_seeking_from_users() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_member_job_seeking_from_users ON public.users;
CREATE TRIGGER trg_member_job_seeking_from_users
  AFTER UPDATE OF job_seeking_status, job_seeking_visibility ON public.users
  FOR EACH ROW
  WHEN (OLD.job_seeking_status IS DISTINCT FROM NEW.job_seeking_status
        OR OLD.job_seeking_visibility IS DISTINCT FROM NEW.job_seeking_visibility)
  EXECUTE FUNCTION public.member_job_seeking_from_users();

-- everyone who has set something so far
INSERT INTO public.member_job_seeking (user_uuid, status, visibility)
SELECT u.uuid, u.job_seeking_status, coalesce(u.job_seeking_visibility, 'recruiters')
FROM public.users u
WHERE u.job_seeking_status IS NOT NULL OR u.job_seeking_visibility = 'quiet'
ON CONFLICT (user_uuid) DO UPDATE
  SET status = EXCLUDED.status, visibility = EXCLUDED.visibility;

-- ------------------------------------------------------------
-- 3. The recruiter's companies, as people-search keys
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_viewer_company_keys(p_viewer uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT k) FILTER (WHERE k <> ''), '{}')
  FROM (
    -- the companies she has a page role in
    SELECT people_search_company_key(people_search_canonical_company(c.name)) AS k
    FROM company_admins ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.user_id = p_viewer
    UNION ALL
    -- where she works now (her own profile)
    SELECT unnest(psi.current_company_keys)
    FROM people_search_index psi
    WHERE psi.user_uuid = p_viewer
  ) x
$function$;
REVOKE ALL ON FUNCTION public.talent_viewer_company_keys(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_viewer_company_keys(uuid) TO service_role;

-- ------------------------------------------------------------
-- 4. Which of these candidates' status this recruiter must not see:
--    quiet ones, and those who work now at one of her companies
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_hidden_seeking(p_viewer uuid, p_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT s.user_uuid
  FROM member_job_seeking s
  WHERE s.user_uuid = ANY (p_ids) AND s.visibility = 'quiet'
  UNION
  SELECT psi.user_uuid
  FROM people_search_index psi
  WHERE psi.user_uuid = ANY (p_ids)
    AND psi.current_company_keys && (SELECT talent_viewer_company_keys(p_viewer))
$function$;
REVOKE ALL ON FUNCTION public.talent_hidden_seeking(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_hidden_seeking(uuid, uuid[]) TO service_role;

-- ------------------------------------------------------------
-- 5. talent_search: same definition as add_talent_experience_safe.sql, with the status from
--    member_job_seeking, and nothing of it for her own company's recruiter
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_search(
  p_viewer             uuid,
  p_query              text             DEFAULT NULL,
  p_embedding          vector(1536)     DEFAULT NULL,
  p_skills             text[]           DEFAULT '{}',
  p_skills_all         boolean          DEFAULT true,
  p_location           text             DEFAULT NULL,
  p_work_prefs         text[]           DEFAULT '{}',
  p_languages          text[]           DEFAULT '{}',
  p_min_years          integer          DEFAULT NULL,
  p_max_years          integer          DEFAULT NULL,
  p_degree_levels      text[]           DEFAULT '{}',
  p_field              text             DEFAULT NULL,
  p_currently_employed boolean          DEFAULT false,
  p_seeking            text[]           DEFAULT '{}',
  p_min_similarity     double precision DEFAULT 0.2,
  p_sort               text             DEFAULT 'relevance',
  p_limit              integer          DEFAULT 20,
  p_offset             integer          DEFAULT 0,
  p_joined_after       timestamptz      DEFAULT NULL,
  -- the same free text in the other language (Hebrew ↔ English), and its embedding:
  -- a candidate matches in whichever language she wrote her profile
  p_query_alt          text             DEFAULT NULL,
  p_embedding_alt      vector(1536)     DEFAULT NULL,
  -- the chosen city and field of study in the other language
  p_location_alt       text             DEFAULT NULL,
  p_field_alt          text             DEFAULT NULL
)
RETURNS TABLE (candidate_id uuid, similarity double precision, keyword_hit boolean, skill_hits integer, skills text[], experience_years integer, total_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH params AS (
    SELECT
      -- each element one requirement, with its variants ("react|reactjs")
      (SELECT count(*)::int FROM unnest(coalesce(p_skills, '{}')) g WHERE cardinality(talent_variants(g)) > 0)    AS n_skills,
      (SELECT count(*)::int FROM unnest(coalesce(p_work_prefs, '{}')) g WHERE cardinality(talent_variants(g)) > 0) AS n_prefs,
      (SELECT count(*)::int FROM unnest(coalesce(p_languages, '{}')) g WHERE cardinality(talent_variants(g)) > 0)  AS n_langs,
      -- "Jerusalem, Israel" from the picker: the city is enough (profiles write the rest differently)
      nullif(replace(replace(replace(btrim(split_part(coalesce(p_location, ''), ',', 1)), '\', '\\'), '%', '\%'), '_', '\_'), '') AS city,
      nullif(replace(replace(replace(btrim(split_part(coalesce(p_location_alt, ''), ',', 1)), '\', '\\'), '%', '\%'), '_', '\_'), '') AS city2,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS q,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_query_alt, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS q2,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_field, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS field,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_field_alt, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS field2,
      -- any of the chosen levels (she picks "bachelor" and "master" herself for "bachelor or higher")
      nullif(coalesce(p_degree_levels, '{}'), '{}') AS degrees
  ),
  members AS (
    SELECT
      -- "joined": when she became an active member (activated_at), else when she signed up
      u.uuid, coalesce(u.activated_at, u.created_at) AS created_at, js.status AS job_seeking_status,
      -- she works now at one of the recruiter's companies: the recruiter never learns her status
      coalesce(psi.current_company_keys && (SELECT talent_viewer_company_keys(p_viewer)), false) AS same_company,
      coalesce(js.visibility, 'recruiters') = 'recruiters'
        AND NOT coalesce(psi.current_company_keys && (SELECT talent_viewer_company_keys(p_viewer)), false) AS seeking_visible,
      u.location, u.headline, u.about,
      coalesce(u.skills, '{}') AS skills,
      (SELECT coalesce(array_agg(talent_squash(s)), '{}') FROM unnest(coalesce(u.skills, '{}')) s) AS skills_sq,
      (SELECT coalesce(array_agg(talent_squash(w)), '{}') FROM unnest(coalesce(u.work_preferences, '{}')) w) AS prefs_sq,
      (SELECT coalesce(array_agg(talent_squash(coalesce(l ->> 'name', l #>> '{}'))), '{}')
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.languages) = 'array' THEN u.languages ELSE '[]'::jsonb END) l) AS langs_sq,
      CASE WHEN jsonb_typeof(u.education) = 'array' THEN u.education ELSE '[]'::jsonb END AS education,
      CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END AS experience,
      talent_experience_years(u.experience) AS years,
      -- the words of the experience (titles, companies, descriptions) — not the JSON's key names
      (SELECT string_agg(concat_ws(' ', x ->> 'title',
                CASE jsonb_typeof(x -> 'company') WHEN 'object' THEN x -> 'company' ->> 'name' ELSE x ->> 'company' END,
                x ->> 'description'), ' ')
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END) x
        WHERE jsonb_typeof(x) = 'object') AS experience_text
    FROM users u
    LEFT JOIN member_job_seeking js ON js.user_uuid = u.uuid
    LEFT JOIN people_search_index psi ON psi.user_uuid = u.uuid
    WHERE u.role::text NOT IN ('feed_participant', 'recruiters')
      AND u.status = 'Active'
      AND coalesce(u.is_anonymous, false) = false
      AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
      AND u.uuid <> p_viewer
      AND (p_joined_after IS NULL OR coalesce(u.activated_at, u.created_at) > p_joined_after)
  ),
  filtered AS (
    SELECT
      m.*,
      h.hits,
      EXISTS (
        SELECT 1 FROM unnest(ARRAY[p.q, p.q2]) w
        WHERE w IS NOT NULL AND (
          m.headline ILIKE '%' || w || '%'
          OR m.about ILIKE '%' || w || '%'
          OR array_to_string(m.skills, ' ') ILIKE '%' || w || '%'
          OR m.experience_text ILIKE '%' || w || '%')
      ) AS kw,
      CASE WHEN p_embedding IS NULL THEN NULL
           ELSE greatest((1 - (v.vector <=> p_embedding))::double precision,
                         CASE WHEN p_embedding_alt IS NULL THEN NULL ELSE (1 - (v.vector <=> p_embedding_alt))::double precision END)
      END AS sim
    FROM members m
    CROSS JOIN params p
    -- how many of the chosen skills / languages / work preferences she has (in any of their variants)
    CROSS JOIN LATERAL (
      SELECT
        (SELECT count(*)::int FROM unnest(coalesce(p_skills, '{}')) g WHERE talent_variants(g) && m.skills_sq)    AS hits,
        (SELECT count(*)::int FROM unnest(coalesce(p_languages, '{}')) g WHERE talent_variants(g) && m.langs_sq)  AS lang_hits,
        (SELECT count(*)::int FROM unnest(coalesce(p_work_prefs, '{}')) g WHERE talent_variants(g) && m.prefs_sq) AS pref_hits
    ) h
    LEFT JOIN users_vectors v ON v.user_id = m.uuid AND p_embedding IS NOT NULL
    WHERE (p.n_skills = 0 OR CASE WHEN p_skills_all THEN h.hits = p.n_skills ELSE h.hits > 0 END)
      AND (p.city IS NULL OR m.location ILIKE '%' || p.city || '%' OR (p.city2 IS NOT NULL AND m.location ILIKE '%' || p.city2 || '%'))
      AND (p.n_prefs = 0 OR h.pref_hits > 0)
      AND (p.n_langs = 0 OR h.lang_hits = p.n_langs)
      AND (p_min_years IS NULL OR m.years >= p_min_years)
      AND (p_max_years IS NULL OR m.years <= p_max_years)
      AND (p.degrees IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.education) e
            WHERE jsonb_typeof(e) = 'object' AND talent_degree_level(e ->> 'degree') = ANY (p.degrees)))
      AND (p.field IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.education) e
            WHERE jsonb_typeof(e) = 'object'
              AND ((e ->> 'field') ILIKE '%' || p.field || '%' OR (p.field2 IS NOT NULL AND (e ->> 'field') ILIKE '%' || p.field2 || '%'))))
      AND (NOT coalesce(p_currently_employed, false) OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.experience) x
            WHERE jsonb_typeof(x) = 'object' AND x ->> 'current' = 'true'))
      -- the filter finds only those who let recruiters see it; "quiet" ones only rank higher (below)
      AND (cardinality(coalesce(p_seeking, '{}')) = 0 OR (m.seeking_visible AND m.job_seeking_status = ANY (p_seeking)))
  ),
  matched AS (
    SELECT f.*,
      coalesce(f.sim, 0) + CASE WHEN f.kw THEN 0.1 ELSE 0 END + f.hits AS relevance,
      -- her own company's recruiter gets no hint from the order either
      CASE WHEN f.same_company THEN 0 ELSE CASE f.job_seeking_status WHEN 'active' THEN 2 WHEN 'open' THEN 1 ELSE 0 END END AS seeking_rank,
      (CASE WHEN f.headline IS NOT NULL AND f.headline <> '' THEN 1 ELSE 0 END
       + CASE WHEN cardinality(f.skills) > 0 THEN 1 ELSE 0 END
       + CASE WHEN jsonb_array_length(f.experience) > 0 THEN 1 ELSE 0 END) AS richness
    FROM filtered f
    CROSS JOIN params p
    -- with a free-text query or a job: close in meaning, or the words appear in the profile
    WHERE (p_embedding IS NULL AND (p.q IS NULL OR f.kw))
       OR (p_embedding IS NOT NULL AND (f.kw OR coalesce(f.sim, 0) >= p_min_similarity))
  )
  SELECT uuid, sim, kw, hits, skills, years, count(*) OVER ()
  FROM matched
  ORDER BY
    CASE WHEN p_sort = 'recent' THEN created_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'experience' THEN years END DESC NULLS LAST,
    relevance DESC, seeking_rank DESC, richness DESC, created_at DESC, uuid
  LIMIT greatest(least(coalesce(p_limit, 20), 300), 1)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$function$;

REVOKE ALL ON FUNCTION public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz, text, vector, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz, text, vector, text, text) TO service_role;
-- ------------------------------------------------------------
-- 6. talent_overview: same as add_talent_v2_safe.sql, the same two changes in its counts
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_overview(p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT coalesce(u.activated_at, u.created_at) AS created_at, js.status AS job_seeking_status,
      coalesce(js.visibility, 'recruiters') = 'recruiters'
        AND NOT coalesce(psi.current_company_keys && (SELECT talent_viewer_company_keys(p_viewer)), false) AS visible,
      coalesce(u.skills, '{}') AS skills
    FROM users u
    LEFT JOIN member_job_seeking js ON js.user_uuid = u.uuid
    LEFT JOIN people_search_index psi ON psi.user_uuid = u.uuid
    WHERE u.role::text NOT IN ('feed_participant', 'recruiters')
      AND u.status = 'Active'
      AND coalesce(u.is_anonymous, false) = false
      AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
      AND u.uuid <> p_viewer
  ),
  skills AS (
    SELECT min(btrim(sk)) AS skill, count(*) AS n
    FROM m, unnest(m.skills) sk
    WHERE btrim(sk) <> ''
    GROUP BY lower(btrim(sk))
    ORDER BY count(*) DESC, min(btrim(sk))
    LIMIT 12
  )
  SELECT jsonb_build_object(
    'total',          (SELECT count(*) FROM m),
    'seeking_active', (SELECT count(*) FROM m WHERE job_seeking_status = 'active' AND visible),
    'seeking_open',   (SELECT count(*) FROM m WHERE job_seeking_status = 'open' AND visible),
    'new_this_week',  (SELECT count(*) FROM m WHERE created_at >= now() - interval '7 days'),
    'new_this_month', (SELECT count(*) FROM m WHERE created_at >= now() - interval '30 days'),
    'top_skills',     coalesce((SELECT jsonb_agg(skill ORDER BY n DESC, skill) FROM skills), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.talent_overview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_overview(uuid) TO service_role;

-- ------------------------------------------------------------
-- 7. talent_search_view: the status from member_job_seeking. The view is rebuilt from its own
--    current definition with only that column changed, so every other column stays exactly as
--    it is in production (same names, order and types; its grants are kept).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_def text := pg_get_viewdef('public.talent_search_view'::regclass);
  v_old text := 'u.job_seeking_status,';
  v_new text := '(SELECT js.status FROM member_job_seeking js WHERE js.user_uuid = u.uuid) AS job_seeking_status,';
BEGIN
  IF position(v_new IN v_def) > 0 THEN
    RAISE NOTICE 'talent_search_view already reads member_job_seeking';
  ELSIF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — talent_search_view does not read u.job_seeking_status exactly once: %', v_def;
  ELSE
    EXECUTE 'CREATE OR REPLACE VIEW public.talent_search_view AS ' || replace(v_def, v_old, v_new);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 8. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_sig text := 'public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz, text, vector, text, text)';
  v_users int;
  v_copied int;
  v_mismatch int;
  v_policies int;
BEGIN
  -- everything set so far was copied, with the same values
  SELECT count(*) INTO v_users FROM users WHERE job_seeking_status IS NOT NULL OR job_seeking_visibility = 'quiet';
  SELECT count(*) INTO v_copied FROM member_job_seeking;
  SELECT count(*) INTO v_mismatch
  FROM users u JOIN member_job_seeking s ON s.user_uuid = u.uuid
  WHERE s.status IS DISTINCT FROM u.job_seeking_status OR s.visibility <> coalesce(u.job_seeking_visibility, 'recruiters');
  IF v_copied < v_users OR v_mismatch > 0 THEN
    v_problems := v_problems || format(' copied %s of %s statuses, %s differ;', v_copied, v_users, v_mismatch);
  END IF;

  -- her own row only
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_job_seeking'::regclass) THEN
    v_problems := v_problems || ' member_job_seeking has no row level security;';
  END IF;
  SELECT count(*) INTO v_policies FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_job_seeking';
  IF v_policies <> 3 THEN v_problems := v_problems || ' member_job_seeking should have 3 policies;'; END IF;
  IF has_table_privilege('anon', 'public.member_job_seeking', 'SELECT') OR has_table_privilege('authenticated', 'public.member_job_seeking', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.member_job_seeking', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.member_job_seeking', 'SELECT') THEN
    v_problems := v_problems || ' member_job_seeking privileges are wrong;';
  END IF;

  -- the functions run, and only the API (service role) can run them
  BEGIN
    PERFORM * FROM talent_search(gen_random_uuid(), p_limit => 5);
    PERFORM * FROM talent_search(gen_random_uuid(), p_seeking => ARRAY['active', 'open'], p_limit => 5);
    PERFORM talent_overview(gen_random_uuid());
    PERFORM * FROM talent_hidden_seeking(gen_random_uuid(), ARRAY[gen_random_uuid()]);
    IF talent_viewer_company_keys(gen_random_uuid()) <> '{}' THEN
      v_problems := v_problems || ' an unknown recruiter has companies;';
    END IF;
  EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a talent function failed: ' || SQLERRM || ';';
  END;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.talent_overview(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.talent_hidden_seeking(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.talent_viewer_company_keys(uuid)', 'EXECUTE') THEN
    v_problems := v_problems || ' members can run a talent function;';
  END IF;

  -- nothing reads the old columns any more except the copy trigger
  IF pg_get_viewdef('public.talent_search_view'::regclass) ~ 'u\.job_seeking' THEN
    v_problems := v_problems || ' talent_search_view still reads users.job_seeking_status;';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('talent_search', 'talent_overview')
               AND p.prosrc ~ 'u\.job_seeking') THEN
    v_problems := v_problems || ' talent_search / talent_overview still read users.job_seeking_*;';
  END IF;
  IF has_table_privilege('authenticated', 'public.talent_search_view', 'SELECT') OR has_table_privilege('anon', 'public.talent_search_view', 'SELECT') THEN
    v_problems := v_problems || ' members can read talent_search_view;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % statuses in member_job_seeking; recruiters see no status of candidates at their own companies.', v_copied;
END $$;

COMMIT;

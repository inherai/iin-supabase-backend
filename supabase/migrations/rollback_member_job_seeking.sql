-- ============================================================
-- ROLLBACK of add_member_job_seeking_safe.sql (and drop_users_job_seeking_columns_safe.sql).
-- Run in the SQL Editor, then deploy the previous API (which reads users.job_seeking_*).
-- Puts the status back on users (copied from member_job_seeking), restores talent_search /
-- talent_overview / talent_search_view as they were (add_talent_experience_safe.sql,
-- add_talent_v2_safe.sql, snapshot view definition), and drops the new functions and trigger.
-- member_job_seeking itself is KEPT (the deployed API may still write it until the old API is
-- back); drop it afterwards with:  DROP TABLE public.member_job_seeking;
-- Before running: compare these definitions with snapshot_before_job_seeking_table.json.
-- ============================================================
BEGIN;

-- 1. The columns on users, as add_talent_search.sql / add_talent_v2_safe.sql made them
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS job_seeking_status text DEFAULT NULL;
DO $$ BEGIN
  ALTER TABLE public.users ADD CONSTRAINT users_job_seeking_status_check CHECK (job_seeking_status IN ('active', 'open', 'not_looking'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS job_seeking_visibility text NOT NULL DEFAULT 'recruiters';
DO $$ BEGIN
  ALTER TABLE public.users ADD CONSTRAINT users_job_seeking_visibility_check CHECK (job_seeking_visibility IN ('recruiters', 'quiet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_users_job_seeking_status ON users(job_seeking_status) WHERE job_seeking_status IS NOT NULL;

DROP TRIGGER IF EXISTS trg_member_job_seeking_from_users ON public.users;
DROP FUNCTION IF EXISTS public.member_job_seeking_from_users();

-- the table is the newer source: copy it back
UPDATE public.users u
SET job_seeking_status = s.status, job_seeking_visibility = s.visibility
FROM public.member_job_seeking s
WHERE s.user_uuid = u.uuid
  AND (u.job_seeking_status IS DISTINCT FROM s.status OR u.job_seeking_visibility IS DISTINCT FROM s.visibility);

-- 2. talent_search as in add_talent_experience_safe.sql
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
      u.uuid, coalesce(u.activated_at, u.created_at) AS created_at, u.job_seeking_status,
      coalesce(u.job_seeking_visibility, 'recruiters') = 'recruiters' AS seeking_visible,
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
      CASE f.job_seeking_status WHEN 'active' THEN 2 WHEN 'open' THEN 1 ELSE 0 END AS seeking_rank,
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

-- 3. talent_overview as in add_talent_v2_safe.sql
CREATE OR REPLACE FUNCTION public.talent_overview(p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT coalesce(u.activated_at, u.created_at) AS created_at, u.job_seeking_status,
      coalesce(u.job_seeking_visibility, 'recruiters') = 'recruiters' AS visible, coalesce(u.skills, '{}') AS skills
    FROM users u
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

-- 4. talent_search_view reads users again (only that column changes)
DO $$
DECLARE
  v_def text := pg_get_viewdef('public.talent_search_view'::regclass);
  v_new text := '(SELECT js.status FROM member_job_seeking js WHERE js.user_uuid = u.uuid) AS job_seeking_status,';
BEGIN
  IF position(v_new IN v_def) = 0 THEN
    RAISE NOTICE 'talent_search_view already reads users.job_seeking_status';
  ELSE
    EXECUTE 'CREATE OR REPLACE VIEW public.talent_search_view AS ' || replace(v_def, v_new, 'u.job_seeking_status,');
  END IF;
END $$;

-- 5. The new functions
DROP FUNCTION IF EXISTS public.talent_hidden_seeking(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.talent_viewer_company_keys(uuid);

DO $$
BEGIN
  IF pg_get_viewdef('public.talent_search_view'::regclass) ~ 'member_job_seeking' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — talent_search_view still reads member_job_seeking';
  END IF;
  PERFORM * FROM talent_search(gen_random_uuid(), p_seeking => ARRAY['active'], p_limit => 5);
  PERFORM talent_overview(gen_random_uuid());
  RAISE NOTICE 'Rolled back: the status is on users again. Deploy the previous API, then DROP TABLE public.member_job_seeking.';
END $$;

COMMIT;

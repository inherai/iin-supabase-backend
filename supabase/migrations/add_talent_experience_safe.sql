-- ============================================================
-- Talent: years of experience as she reported them — SELF-CHECKING (2026-11-18). Run in the SQL Editor.
-- Needs add_talent_v2_safe.sql.
--
-- The talent search used calculate_experience_years(): whole years only, and two jobs at the
-- same time counted twice. Now (talent_experience_years):
--   * the periods she reported are joined — overlapping jobs count once;
--   * a date without a month (the profile form asks for the year only) counts from January /
--     to December, and the total is then rounded UP to whole years; with months on every date
--     it is exact (whole years, the months shown on her card by the API);
--   * a current job counts until today; dates in the future are cut at today.
-- The API computes the same (routes/_talentProfiles.ts → experienceSpan), so what a card shows,
-- the years filter and the "most experience" order agree.
--
-- Also: the free text is searched in both languages. The API translates the recruiter's words
-- (Hebrew ↔ English) and passes both, with both embeddings; each candidate counts with whichever
-- matches better — a profile written in English is found by a Hebrew search, and the other way.
--
-- And the filters: a skill, language or work preference chosen in one language finds the same
-- in the other ("ניהול פרויקטים" = "Project Management", "אנגלית" = "English"), and other
-- spellings of a skill ("React.js", "ReactJS"). The API sends each chosen value with its variants;
-- the city and the field of study also come in both languages.
--
-- Changes only the talent search. calculate_experience_years() and talent_search_view stay as
-- they are (the jobs match page uses them). No row is changed.        Safe to re-run.
-- To go back: DROP FUNCTION public.talent_search(<the new signature, with text, vector at the end>);
--   run the talent_search section of add_talent_v2_safe.sql again, then
--   DROP FUNCTION public.talent_experience_years(jsonb); DROP FUNCTION public.talent_month(text);
-- ============================================================
BEGIN;

-- Month (1–12) from "2021-03", "03/2021", "Mar 2021"; NULL when the date has no month.
CREATE OR REPLACE FUNCTION public.talent_month(p_date text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN m BETWEEN 1 AND 12 THEN m END
  FROM (SELECT CASE
    WHEN t ~ '^[0-9]{4}-[0-9]{1,2}' THEN substring(t from '^[0-9]{4}-([0-9]{1,2})')::int
    WHEN t ~ '^[0-9]{1,2}[/.][0-9]{4}' THEN substring(t from '^([0-9]{1,2})[/.]')::int
    ELSE array_position(ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],
                        substring(t from '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'))
  END AS m
  FROM (SELECT lower(btrim(coalesce(p_date, ''))) AS t) x) y
$function$;

CREATE OR REPLACE FUNCTION public.talent_experience_years(p_experience jsonb)
RETURNS integer
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
  WITH items AS (
    SELECT lower(btrim(coalesce(e ->> 'startDate', ''))) AS s,
           lower(btrim(coalesce(e ->> 'endDate', ''))) AS en,
           coalesce(e ->> 'current', '') = 'true' AS cur
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_experience) = 'array' THEN p_experience ELSE '[]'::jsonb END) e
    WHERE jsonb_typeof(e) = 'object'
  ),
  parsed AS (
    SELECT cur,
           substring(s from '(?:19|20)[0-9]{2}')::int AS sy, talent_month(s) AS sm,
           substring(en from '(?:19|20)[0-9]{2}')::int AS ey, talent_month(en) AS em
    FROM items
  ),
  ranges AS (
    SELECT sy * 12 + coalesce(sm, 1) - 1 AS f,
           least(CASE WHEN cur THEN n.idx ELSE ey * 12 + coalesce(em, 12) - 1 END, n.idx) AS t,
           (sm IS NULL OR (NOT cur AND em IS NULL)) AS approx
    FROM parsed
    CROSS JOIN (SELECT extract(year FROM now())::int * 12 + extract(month FROM now())::int - 1 AS idx) n
    WHERE sy IS NOT NULL AND (cur OR ey IS NOT NULL)
  )
  SELECT coalesce(CASE WHEN bool_or(r.approx) THEN ceil(count(DISTINCT m) / 12.0)::int
                       ELSE floor(count(DISTINCT m) / 12.0)::int END, 0)
  FROM ranges r
  CROSS JOIN LATERAL generate_series(r.f, r.t) m
  WHERE r.t >= r.f
$function$;

REVOKE ALL ON FUNCTION public.talent_month(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.talent_experience_years(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.talent_month(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.talent_experience_years(jsonb) TO authenticated, service_role;

-- Skills, languages and work preferences are compared in one written form: lower case, without
-- spaces, dots, dashes, slashes ("React.js" = "reactjs", "Project Management" = "projectmanagement").
CREATE OR REPLACE FUNCTION public.talent_squash(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT regexp_replace(lower(btrim(coalesce(p, ''))), '[[:space:]._/-]+', '', 'g')
$function$;

-- One requirement as the API sends it: its variants joined by "|" — the recruiter's word, its
-- translation (Hebrew ↔ English) and other spellings ("react|reactjs|ריאקט").
CREATE OR REPLACE FUNCTION public.talent_variants(p text)
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT coalesce(array_agg(DISTINCT talent_squash(v)) FILTER (WHERE talent_squash(v) <> ''), '{}')
  FROM unnest(string_to_array(coalesce(p, ''), '|')) v
$function$;

REVOKE ALL ON FUNCTION public.talent_squash(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.talent_variants(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.talent_squash(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.talent_variants(text) TO authenticated, service_role;

-- (same definition as add_talent_v2_safe.sql, with the years from talent_experience_years,
--  and every comparison in both languages)
DROP FUNCTION IF EXISTS public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz);
DROP FUNCTION IF EXISTS public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz, text, vector, text, text);

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

DO $$
DECLARE
  v_problems text := '';
  v_now int := extract(year FROM now())::int;
  v_sig text := 'public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz, text, vector, text, text)';
BEGIN
  IF talent_squash(' React.js ') <> 'reactjs' OR talent_squash('Project Management') <> 'projectmanagement'
     OR NOT (talent_variants('React|react.js| |ריאקט') @> ARRAY['react', 'reactjs', 'ריאקט'] AND cardinality(talent_variants('React|react.js| |ריאקט')) = 3) THEN
    v_problems := v_problems || ' skill spellings are not compared in one form;';
  END IF;
  IF talent_month('2021-03') IS DISTINCT FROM 3 OR talent_month('03/2021') IS DISTINCT FROM 3
     OR talent_month('Mar 2021') IS DISTINCT FROM 3 OR talent_month('2021') IS NOT NULL OR talent_month('2021-13') IS NOT NULL THEN
    v_problems := v_problems || ' months are not read right;';
  END IF;
  -- years only: Jan 2019 … Dec 2021 = 3
  IF talent_experience_years('[{"startDate":"2019","endDate":"2021"}]') IS DISTINCT FROM 3 THEN v_problems := v_problems || ' 2019–2021 is not 3 years;'; END IF;
  -- with months, overlapping jobs once: Jan 2020–Jun 2022 (30) + inside + Mar–May 2023 (3) = 33 months → 2
  IF talent_experience_years('[{"startDate":"2020-01","endDate":"2022-06"},{"startDate":"2021-01","endDate":"2021-12"},{"startDate":"2023-03","endDate":"2023-05"}]') IS DISTINCT FROM 2 THEN
    v_problems := v_problems || ' overlapping jobs are counted twice;';
  END IF;
  -- a current job since January of five years ago, year only → rounded up
  IF talent_experience_years(format('[{"startDate":"%s","current":true}]', v_now - 5)::jsonb) IS DISTINCT FROM 6 THEN
    v_problems := v_problems || ' a current job is not counted until today, rounded up;';
  END IF;
  IF talent_experience_years('[]') <> 0 OR talent_experience_years(NULL) <> 0 OR talent_experience_years('[{"title":"x"},{"startDate":"2020"}]') <> 0 THEN
    v_problems := v_problems || ' empty or unusable experience is not 0;';
  END IF;
  BEGIN
    PERFORM * FROM talent_search(gen_random_uuid(), p_min_years => 2, p_sort => 'experience', p_limit => 5);
    PERFORM * FROM talent_search(gen_random_uuid(), p_query => 'בודקת תוכנה', p_query_alt => 'qa tester', p_limit => 5);
    PERFORM * FROM talent_search(gen_random_uuid(), p_skills => ARRAY['react|reactjs', 'project management|ניהול פרויקטים'],
      p_languages => ARRAY['english|אנגלית'], p_location => 'ירושלים', p_location_alt => 'Jerusalem', p_field => 'מדעי המחשב', p_field_alt => 'computer science', p_limit => 5);
  EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' talent_search failed: ' || SQLERRM || ';';
  END;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
    v_problems := v_problems || ' members can run talent_search;';
  END IF;
  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: years of experience join overlapping jobs and round up dates without a month; the talent search uses them.';
END $$;

COMMIT;

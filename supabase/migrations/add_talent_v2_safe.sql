-- ============================================================
-- Talent v2: search, projects, notes, outreach — SELF-CHECKING (2026-11-18). Run in the SQL Editor.
-- Needs add_talent_search.sql, update_talent_search_view.sql, secure_chat_safe.sql.
--
-- What it adds
--   1. talent_search(): the recruiters' search runs in the database, so every mode is ranked and
--      paged the same way. Filters are applied together with the free-text / job match (before:
--      the 50 nearest profiles of ALL members were taken first and filtered after, so most of them
--      were feed participants, recruiters or inactive members and fell out). Skills, languages and
--      work preferences compare without case; skills can be "all of" or "any of" (ranked by how
--      many match); a free-text query also matches words in the headline, about, skills and
--      experience. Anonymous members, recruiters, feed participants, inactive and deleted members
--      are never returned, nor the recruiter herself.
--      Runs only for the service role (the API checks the recruiter first) — it reads every member.
--   1b. talent_overview(): counts for the page's opening view (candidates, looking for work, new
--      this week, most common skills). Service role only, counts only.
--   0b. users.job_seeking_visibility: 'recruiters' (badge + filter) or 'quiet' (only ranks higher).
--   2. talent_degree_level(): degrees are free text ("B.Sc", "תואר ראשון", "Bachelor of Arts"...);
--      the filter now asks for a level (certificate, practical engineer, bachelor, master, MBA, PhD).
--   3. talent_projects / talent_project_candidates / talent_notes: a recruiter's own lists of
--      candidates with a stage per candidate, and private notes. Only she reads or writes her rows
--      (row-level security, in her own session) — the candidate never sees them.
--   4. profile_access_requests.context_title: what the outreach is about (e.g. the job), shown to
--      the candidate with the message. Message and title get a length limit.
--   5. can_message(): a recruiter whose outreach the candidate ACCEPTED may write to her, and she
--      may answer (like an application, see secure_chat_safe.sql). Revoking or declining ends it.
--      profile_access_requests.contact_accepted_at keeps "she accepted" (set by a trigger), so a
--      later request to see details again does not close the conversation. Existing accepted
--      requests get it filled in (the only existing rows this changes).
--   6. talent_search_view (raw e-mail / phone / last name) is closed to the public key and to
--      members' sessions; only the API's service role reads it (it already did).
--
-- What it does NOT change: who can read profiles, privacy rules, chats or messages. No row is
-- deleted.
--
-- Order: run this, then deploy the API (talent.ts, profile-access-request.ts), then the frontend.
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing changes.
-- To go back: rollback_add_talent_v2.sql.                                          Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 0. can_message must still be the one from secure_chat_safe.sql (or this migration's)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_src text;
  v_expected text := $body$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND (
    EXISTS (
      SELECT 1 FROM connections
      WHERE status = 'accepted'
        AND ((requester_id = p_a AND receiver_id = p_b) OR (requester_id = p_b AND receiver_id = p_a))
    )
    OR EXISTS (
      -- one of them applied through duallin to a page the other manages as owner / recruiter
      SELECT 1 FROM job_submissions s
      JOIN company_admins a ON a.company_id = s.company_id AND a.role IN ('owner', 'recruiter')
      WHERE (s.user_id = p_a AND a.user_id = p_b) OR (s.user_id = p_b AND a.user_id = p_a)
    )
  )
$body$;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.can_message(uuid, uuid)'::regprocedure;
  IF position('profile_access_requests' IN v_src) = 0
     AND regexp_replace(v_src, '\s+', ' ', 'g') <> regexp_replace(v_expected, '\s+', ' ', 'g') THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — can_message() in the database is not the one in secure_chat_safe.sql. Send its current body before running this.';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 0b. "Open to work": how recruiters learn it. 'recruiters' = a badge on her card and the
--     availability filter finds her; 'quiet' = no badge, no filter, she only ranks higher in
--     recruiters' results. The status itself is users.job_seeking_status (since add_talent_search).
-- ------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS job_seeking_visibility text NOT NULL DEFAULT 'recruiters';
DO $$ BEGIN
  ALTER TABLE public.users ADD CONSTRAINT users_job_seeking_visibility_check CHECK (job_seeking_visibility IN ('recruiters', 'quiet'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 1. Degree level from free text
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.talent_degree_level(p_degree text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $function$
  -- Latin abbreviations must stand alone ("ma" is not "mathematics"): (^|[^a-z]) … ([^a-z]|$).
  -- A seminary / course / training without a degree word is a certificate ("בוגרת סמינר" is not a
  -- bachelor's degree, "MS Office course" is not a master's). "Scrum Master" is not a degree.
  SELECT CASE
    WHEN d IS NULL OR d = '' THEN NULL
    WHEN d ~ '((^|[^a-z])ph\.? ?d([^a-z]|$)|doctor|דוקטור|תואר שלישי)' THEN 'phd'
    WHEN d ~ '((^|[^a-z])m\.?b\.?a([^a-z]|$)|מנהל עסקים.*שני)' THEN 'mba'
    WHEN d ~ '(סמינר|קורס|הכשרה|course|bootcamp|certificat|diploma)'
         AND d !~ '(תואר|bachelor|(?<!scrum )master|(^|[^a-z])[bm]\.? ?(sc|a|ed|eng)\.?([^a-z]|$))' THEN 'certificate'
    WHEN d ~ '((?<!scrum )master|(^|[^a-z])m\.? ?(sc|a|ed|eng)\.?([^a-z]|$)|תואר שני|מוסמך|מוסמכת|(^|[^א-ת])מ\.א)' THEN 'master'
    WHEN d ~ '(bachelor|(^|[^a-z])b\.? ?(sc|a|ed|eng|tech|s)\.?([^a-z]|$)|תואר ראשון|בוגר|(^|[^א-ת])ב\.א)' THEN 'bachelor'
    WHEN d ~ '(practical engineer|הנדסאי|technician|טכנאי)' THEN 'practical_engineer'
    WHEN d ~ '(certificate|certification|diploma|course|bootcamp|תעודה|קורס|הכשרה|מסלול|סמינר)' THEN 'certificate'
    ELSE 'other'
  END
  FROM (SELECT lower(btrim(p_degree)) AS d) s
$function$;

REVOKE ALL ON FUNCTION public.talent_degree_level(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.talent_degree_level(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. The search
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz);

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
  p_joined_after       timestamptz      DEFAULT NULL
)
RETURNS TABLE (candidate_id uuid, similarity double precision, keyword_hit boolean, skill_hits integer, skills text[], experience_years integer, total_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  WITH params AS (
    SELECT
      (SELECT coalesce(array_agg(DISTINCT lower(btrim(s))), '{}') FROM unnest(coalesce(p_skills, '{}')) s WHERE btrim(s) <> '')     AS skills,
      (SELECT coalesce(array_agg(DISTINCT lower(btrim(s))), '{}') FROM unnest(coalesce(p_work_prefs, '{}')) s WHERE btrim(s) <> '') AS prefs,
      (SELECT coalesce(array_agg(DISTINCT lower(btrim(s))), '{}') FROM unnest(coalesce(p_languages, '{}')) s WHERE btrim(s) <> '')  AS langs,
      -- "Jerusalem, Israel" from the picker: the city is enough (profiles write the rest differently)
      nullif(replace(replace(replace(btrim(split_part(coalesce(p_location, ''), ',', 1)), '\', '\\'), '%', '\%'), '_', '\_'), '') AS city,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS q,
      nullif(replace(replace(replace(lower(btrim(coalesce(p_field, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '') AS field,
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
      (SELECT coalesce(array_agg(lower(s)), '{}') FROM unnest(coalesce(u.skills, '{}')) s) AS skills_lc,
      coalesce(u.work_preferences, '{}') AS work_preferences,
      CASE WHEN jsonb_typeof(u.languages) = 'array' THEN u.languages ELSE '[]'::jsonb END AS languages,
      CASE WHEN jsonb_typeof(u.education) = 'array' THEN u.education ELSE '[]'::jsonb END AS education,
      CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END AS experience,
      calculate_experience_years(CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END) AS years,
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
      (SELECT count(*)::int FROM unnest(p.skills) s WHERE s = ANY (m.skills_lc)) AS hits,
      p.q IS NOT NULL AND (
        m.headline ILIKE '%' || p.q || '%'
        OR m.about ILIKE '%' || p.q || '%'
        OR array_to_string(m.skills, ' ') ILIKE '%' || p.q || '%'
        OR m.experience_text ILIKE '%' || p.q || '%'
      ) AS kw,
      CASE WHEN p_embedding IS NULL THEN NULL ELSE (1 - (v.vector <=> p_embedding))::double precision END AS sim
    FROM members m
    CROSS JOIN params p
    LEFT JOIN users_vectors v ON v.user_id = m.uuid AND p_embedding IS NOT NULL
    WHERE (cardinality(p.skills) = 0 OR CASE WHEN p_skills_all THEN m.skills_lc @> p.skills ELSE m.skills_lc && p.skills END)
      AND (p.city IS NULL OR m.location ILIKE '%' || p.city || '%')
      AND (cardinality(p.prefs) = 0 OR EXISTS (SELECT 1 FROM unnest(m.work_preferences) w WHERE lower(w) = ANY (p.prefs)))
      AND (cardinality(p.langs) = 0 OR (
            SELECT count(DISTINCT lower(coalesce(l ->> 'name', l #>> '{}')))
            FROM jsonb_array_elements(m.languages) l
            WHERE lower(coalesce(l ->> 'name', l #>> '{}')) = ANY (p.langs)
          ) = cardinality(p.langs))
      AND (p_min_years IS NULL OR m.years >= p_min_years)
      AND (p_max_years IS NULL OR m.years <= p_max_years)
      AND (p.degrees IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.education) e
            WHERE jsonb_typeof(e) = 'object' AND talent_degree_level(e ->> 'degree') = ANY (p.degrees)))
      AND (p.field IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(m.education) e
            WHERE jsonb_typeof(e) = 'object' AND (e ->> 'field') ILIKE '%' || p.field || '%'))
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

REVOKE ALL ON FUNCTION public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz) TO service_role;

-- The talent page's opening view: how many candidates, how many looking for work, how many new,
-- and the skills most found among them. Counts only — same members talent_search() returns.
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

-- ------------------------------------------------------------
-- 3. Projects, stages, notes — the recruiter's own, in her own session
-- ------------------------------------------------------------
-- Recruiters are members with app role 'recruiters' (or Duallin admins).
CREATE OR REPLACE FUNCTION public.talent_is_recruiter()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $function$
  SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'recruiters'
      OR coalesce(auth.jwt() -> 'app_metadata' ->> 'is_admin', '') = 'true'
$function$;
REVOKE ALL ON FUNCTION public.talent_is_recruiter() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.talent_is_recruiter() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.talent_projects (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  job_id       text        CHECK (job_id IS NULL OR char_length(job_id) <= 200),
  job_title    text        CHECK (job_title IS NULL OR char_length(job_title) <= 200),
  archived     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_talent_projects_recruiter ON public.talent_projects (recruiter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.talent_project_candidates (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        NOT NULL REFERENCES public.talent_projects(id) ON DELETE CASCADE,
  recruiter_id     uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  candidate_id     uuid        NOT NULL REFERENCES public.users(uuid) ON DELETE CASCADE,
  stage            text        NOT NULL DEFAULT 'sourced'
                   CHECK (stage IN ('sourced', 'contacted', 'replied', 'interviewing', 'offer', 'hired', 'not_fit')),
  added_at         timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_talent_project_candidates_recruiter ON public.talent_project_candidates (recruiter_id, candidate_id);

CREATE TABLE IF NOT EXISTS public.talent_notes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  candidate_id uuid        NOT NULL REFERENCES public.users(uuid) ON DELETE CASCADE,
  body         text        NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_talent_notes_recruiter ON public.talent_notes (recruiter_id, candidate_id, created_at DESC);

ALTER TABLE public.talent_projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.talent_project_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.talent_notes              ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "A recruiter reads her projects" ON public.talent_projects;
CREATE POLICY "A recruiter reads her projects" ON public.talent_projects
  FOR SELECT TO authenticated USING (recruiter_id = auth.uid());
DROP POLICY IF EXISTS "A recruiter creates her projects" ON public.talent_projects;
CREATE POLICY "A recruiter creates her projects" ON public.talent_projects
  FOR INSERT TO authenticated WITH CHECK (recruiter_id = auth.uid() AND public.talent_is_recruiter());
DROP POLICY IF EXISTS "A recruiter changes her projects" ON public.talent_projects;
CREATE POLICY "A recruiter changes her projects" ON public.talent_projects
  FOR UPDATE TO authenticated USING (recruiter_id = auth.uid()) WITH CHECK (recruiter_id = auth.uid());
DROP POLICY IF EXISTS "A recruiter deletes her projects" ON public.talent_projects;
CREATE POLICY "A recruiter deletes her projects" ON public.talent_projects
  FOR DELETE TO authenticated USING (recruiter_id = auth.uid());

DROP POLICY IF EXISTS "A recruiter reads her project candidates" ON public.talent_project_candidates;
CREATE POLICY "A recruiter reads her project candidates" ON public.talent_project_candidates
  FOR SELECT TO authenticated USING (recruiter_id = auth.uid());
DROP POLICY IF EXISTS "A recruiter adds candidates to her projects" ON public.talent_project_candidates;
CREATE POLICY "A recruiter adds candidates to her projects" ON public.talent_project_candidates
  FOR INSERT TO authenticated WITH CHECK (
    recruiter_id = auth.uid() AND public.talent_is_recruiter()
    AND EXISTS (SELECT 1 FROM public.talent_projects p WHERE p.id = project_id AND p.recruiter_id = auth.uid())
  );
DROP POLICY IF EXISTS "A recruiter moves her project candidates" ON public.talent_project_candidates;
CREATE POLICY "A recruiter moves her project candidates" ON public.talent_project_candidates
  FOR UPDATE TO authenticated USING (recruiter_id = auth.uid()) WITH CHECK (recruiter_id = auth.uid());
DROP POLICY IF EXISTS "A recruiter removes her project candidates" ON public.talent_project_candidates;
CREATE POLICY "A recruiter removes her project candidates" ON public.talent_project_candidates
  FOR DELETE TO authenticated USING (recruiter_id = auth.uid());

DROP POLICY IF EXISTS "A recruiter reads her notes" ON public.talent_notes;
CREATE POLICY "A recruiter reads her notes" ON public.talent_notes
  FOR SELECT TO authenticated USING (recruiter_id = auth.uid());
DROP POLICY IF EXISTS "A recruiter writes her notes" ON public.talent_notes;
CREATE POLICY "A recruiter writes her notes" ON public.talent_notes
  FOR INSERT TO authenticated WITH CHECK (recruiter_id = auth.uid() AND public.talent_is_recruiter());
DROP POLICY IF EXISTS "A recruiter deletes her notes" ON public.talent_notes;
CREATE POLICY "A recruiter deletes her notes" ON public.talent_notes
  FOR DELETE TO authenticated USING (recruiter_id = auth.uid());

REVOKE ALL ON public.talent_projects, public.talent_project_candidates, public.talent_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.talent_projects TO authenticated;
GRANT INSERT (name, job_id, job_title) ON public.talent_projects TO authenticated;
GRANT UPDATE (name, job_id, job_title, archived, updated_at) ON public.talent_projects TO authenticated;
GRANT SELECT, DELETE ON public.talent_project_candidates TO authenticated;
GRANT INSERT (project_id, candidate_id, stage) ON public.talent_project_candidates TO authenticated;
GRANT UPDATE (stage, stage_changed_at) ON public.talent_project_candidates TO authenticated;
GRANT SELECT, DELETE ON public.talent_notes TO authenticated;
GRANT INSERT (candidate_id, body) ON public.talent_notes TO authenticated;
GRANT ALL ON public.talent_projects, public.talent_project_candidates, public.talent_notes TO service_role;

-- ------------------------------------------------------------
-- 4. Outreach: what it is about, and length limits
-- ------------------------------------------------------------
ALTER TABLE public.profile_access_requests ADD COLUMN IF NOT EXISTS context_title text;
DO $$ BEGIN
  ALTER TABLE public.profile_access_requests
    ADD CONSTRAINT profile_access_requests_context_title_len CHECK (context_title IS NULL OR char_length(context_title) <= 200) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.profile_access_requests
    ADD CONSTRAINT profile_access_requests_message_len CHECK (message IS NULL OR char_length(message) <= 1500) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- When she accepted contact. A later request (e.g. to see details again after an approval expired)
-- does not take the conversation away; revoking or declining does.
ALTER TABLE public.profile_access_requests ADD COLUMN IF NOT EXISTS contact_accepted_at timestamptz;

CREATE OR REPLACE FUNCTION public.profile_access_requests_contact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('approved', 'partial') THEN
    NEW.contact_accepted_at := coalesce(NEW.contact_accepted_at, now());
  ELSIF NEW.status IN ('rejected', 'revoked') THEN
    NEW.contact_accepted_at := NULL;
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS trg_profile_access_requests_contact ON public.profile_access_requests;
CREATE TRIGGER trg_profile_access_requests_contact
  BEFORE INSERT OR UPDATE OF status ON public.profile_access_requests
  FOR EACH ROW EXECUTE FUNCTION public.profile_access_requests_contact();

-- Requests she already accepted keep their conversation.
UPDATE public.profile_access_requests
   SET contact_accepted_at = coalesce(updated_at, created_at, now())
 WHERE status IN ('approved', 'partial') AND contact_accepted_at IS NULL;

-- ------------------------------------------------------------
-- 5. Who may message whom: + an accepted recruiter outreach
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_message(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND (
    EXISTS (
      SELECT 1 FROM connections
      WHERE status = 'accepted'
        AND ((requester_id = p_a AND receiver_id = p_b) OR (requester_id = p_b AND receiver_id = p_a))
    )
    OR EXISTS (
      -- one of them applied through duallin to a page the other manages as owner / recruiter
      SELECT 1 FROM job_submissions s
      JOIN company_admins a ON a.company_id = s.company_id AND a.role IN ('owner', 'recruiter')
      WHERE (s.user_id = p_a AND a.user_id = p_b) OR (s.user_id = p_b AND a.user_id = p_a)
    )
    OR EXISTS (
      -- she accepted a recruiter's outreach on duallin (revoking or declining ends the conversation)
      SELECT 1 FROM profile_access_requests r
      WHERE r.contact_accepted_at IS NOT NULL
        AND ((r.recruiter_id = p_a AND r.candidate_id = p_b) OR (r.recruiter_id = p_b AND r.candidate_id = p_a))
    )
  )
$function$;
REVOKE ALL ON FUNCTION public.can_message(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_message(uuid, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5b. talent_search_view holds raw e-mail / phone / last name: for the API (service role) only.
--     Nothing reads it in a member's session; through the public key it would show every member's
--     contact details.
-- ------------------------------------------------------------
REVOKE ALL ON public.talent_search_view FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.talent_search_view TO service_role;

-- ------------------------------------------------------------
-- 6. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_a uuid; v_b uuid; v_project uuid; v_n bigint; v_before bigint;
  v_sig text := 'public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz)';
BEGIN
  -- degree levels
  IF talent_degree_level('B.Sc')                       IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' B.Sc;'; END IF;
  IF talent_degree_level('Bachelor of Arts')           IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' Bachelor of Arts;'; END IF;
  IF talent_degree_level('תואר ראשון במדעי המחשב')    IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' תואר ראשון;'; END IF;
  IF talent_degree_level('M.A.')                       IS DISTINCT FROM 'master'   THEN v_problems := v_problems || ' M.A.;'; END IF;
  IF talent_degree_level('MBA')                        IS DISTINCT FROM 'mba'      THEN v_problems := v_problems || ' MBA;'; END IF;
  IF talent_degree_level('Ph.D')                       IS DISTINCT FROM 'phd'      THEN v_problems := v_problems || ' Ph.D;'; END IF;
  IF talent_degree_level('הנדסאית תוכנה')              IS DISTINCT FROM 'practical_engineer' THEN v_problems := v_problems || ' הנדסאית;'; END IF;
  IF talent_degree_level('Full Stack bootcamp')        IS DISTINCT FROM 'certificate' THEN v_problems := v_problems || ' bootcamp;'; END IF;
  IF talent_degree_level('Mathematics')                IS DISTINCT FROM 'other'    THEN v_problems := v_problems || ' Mathematics is not a degree level;'; END IF;
  IF talent_degree_level('בוגרת סמינר')                IS DISTINCT FROM 'certificate' THEN v_problems := v_problems || ' seminary;'; END IF;
  IF talent_degree_level('Graph Databases')            IS DISTINCT FROM 'other'    THEN v_problems := v_problems || ' graph d is not a PhD;'; END IF;
  IF talent_degree_level('B.Ed.')                      IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' B.Ed.;'; END IF;
  IF talent_degree_level('בוגרת מדעי המחשב')           IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' בוגרת מדעי המחשב;'; END IF;
  IF talent_degree_level('ב.א. בחינוך')                IS DISTINCT FROM 'bachelor' THEN v_problems := v_problems || ' ב.א.;'; END IF;
  IF talent_degree_level('מ.א. בפסיכולוגיה')           IS DISTINCT FROM 'master'   THEN v_problems := v_problems || ' מ.א.;'; END IF;
  IF talent_degree_level('מוסמכת במדעי המחשב')         IS DISTINCT FROM 'master'   THEN v_problems := v_problems || ' מוסמכת;'; END IF;
  IF talent_degree_level('MS Office course')           IS DISTINCT FROM 'certificate' THEN v_problems := v_problems || ' MS Office course;'; END IF;
  IF talent_degree_level('Scrum Master')               IS DISTINCT FROM 'other'    THEN v_problems := v_problems || ' Scrum Master;'; END IF;
  IF talent_degree_level('M.Sc')                       IS DISTINCT FROM 'master'   THEN v_problems := v_problems || ' M.Sc;'; END IF;

  -- the search runs, and only for the service role
  BEGIN
    PERFORM * FROM talent_search(gen_random_uuid(), p_skills => ARRAY['python'], p_degree_levels => ARRAY['bachelor', 'master'], p_languages => ARRAY['english'], p_currently_employed => true, p_limit => 5);
    PERFORM * FROM talent_search(gen_random_uuid(), p_query => 'data', p_sort => 'recent', p_limit => 5);
    PERFORM * FROM talent_search(gen_random_uuid(), p_skills => ARRAY['sql'], p_joined_after => now() - interval '7 days');
  EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' talent_search failed: ' || SQLERRM || ';';
  END;
  BEGIN
    PERFORM talent_overview(gen_random_uuid());
  EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' talent_overview failed: ' || SQLERRM || ';';
  END;
  IF has_function_privilege('authenticated', 'public.talent_overview(uuid)', 'EXECUTE') THEN v_problems := v_problems || ' members can run talent_overview;'; END IF;
  IF has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN v_problems := v_problems || ' members can run talent_search;'; END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN v_problems := v_problems || ' signed-out visitors can run talent_search;'; END IF;
  IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN v_problems := v_problems || ' the API cannot run talent_search;'; END IF;

  -- row-level security on the new tables
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.talent_projects'::regclass, 'public.talent_project_candidates'::regclass, 'public.talent_notes'::regclass) AND NOT relrowsecurity) THEN
    v_problems := v_problems || ' row-level security is off on a new table;';
  END IF;
  IF has_table_privilege('anon', 'public.talent_notes', 'SELECT') THEN v_problems := v_problems || ' signed-out visitors can read notes;'; END IF;
  IF has_table_privilege('anon', 'public.talent_search_view', 'SELECT') OR has_table_privilege('authenticated', 'public.talent_search_view', 'SELECT') THEN
    v_problems := v_problems || ' members can read talent_search_view (raw contact details);';
  END IF;

  -- can_message has the new rule and keeps the old ones
  IF position('profile_access_requests' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.can_message(uuid, uuid)'::regprocedure)) = 0
     OR position('job_submissions' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.can_message(uuid, uuid)'::regprocedure)) = 0 THEN
    v_problems := v_problems || ' can_message is not as expected;';
  END IF;

  -- a recruiter's rows are hers alone (throw-away rows, undone below)
  SELECT count(*) INTO v_before FROM talent_projects;
  SELECT uuid INTO v_a FROM users ORDER BY created_at LIMIT 1;
  SELECT uuid INTO v_b FROM users WHERE uuid <> v_a ORDER BY created_at LIMIT 1;
  IF v_a IS NOT NULL AND v_b IS NOT NULL THEN
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'recruiters'))::text, true);
      SET LOCAL ROLE authenticated;
      INSERT INTO talent_projects (name) VALUES ('check-7f3a') RETURNING id INTO v_project;
      INSERT INTO talent_project_candidates (project_id, candidate_id) VALUES (v_project, v_b);
      INSERT INTO talent_notes (candidate_id, body) VALUES (v_b, 'check-7f3a');
      SELECT count(*) INTO v_n FROM talent_projects WHERE id = v_project;
      IF v_n <> 1 THEN v_problems := v_problems || ' a recruiter cannot read her own project;'; END IF;

      -- another member (not a recruiter) sees nothing and cannot add
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'members'))::text, true);
      SELECT count(*) INTO v_n FROM talent_projects WHERE id = v_project;
      IF v_n <> 0 THEN v_problems := v_problems || ' another member reads a recruiter''s project;'; END IF;
      SELECT count(*) INTO v_n FROM talent_notes WHERE body = 'check-7f3a';
      IF v_n <> 0 THEN v_problems := v_problems || ' the candidate reads the recruiter''s notes;'; END IF;
      SELECT count(*) INTO v_n FROM talent_project_candidates WHERE project_id = v_project;
      IF v_n <> 0 THEN v_problems := v_problems || ' the candidate sees she is in a project;'; END IF;
      BEGIN
        INSERT INTO talent_projects (name) VALUES ('check-7f3a-b');
        v_problems := v_problems || ' a member who is not a recruiter can create a project;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        INSERT INTO talent_project_candidates (project_id, candidate_id) VALUES (v_project, v_a);
        v_problems := v_problems || ' a member can add to someone else''s project;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      UPDATE talent_projects SET name = 'taken' WHERE id = v_project;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 0 THEN v_problems := v_problems || ' a member can rename someone else''s project;'; END IF;
      RESET ROLE;
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
    EXCEPTION
      WHEN SQLSTATE 'P0002' THEN RESET ROLE;
      WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
    END;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;
  SELECT count(*) INTO v_n FROM talent_projects;
  IF v_n <> v_before THEN v_problems := v_problems || ' test projects were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: search runs for the API only; degree levels read Hebrew and English; projects and notes are each recruiter''s own; an accepted outreach opens a conversation.';
END $$;

COMMIT;

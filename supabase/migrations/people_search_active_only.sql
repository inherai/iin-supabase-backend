-- Inner-circle people search: only Active members are searchable.
--
-- Before: people_search_index held members still in onboarding (and held
-- invitations in pending_review), so any search/filter on the inner circle
-- surfaced them. match_users (the unfiltered suggestions) already required
-- status = 'Active'; this brings search and profile-relative suggestions in line.
--
-- Bodies reproduced from the live definitions (pg_get_functiondef, 2026-11-22);
-- the only behavioral changes are marked "status".
-- Rollback: rollback_people_search_active_only.sql. Run in Supabase SQL Editor. Safe to re-run.

BEGIN;

-- 1. A non-Active member is removed from the index (and re-added once Active).
CREATE OR REPLACE FUNCTION public.people_search_refresh_user(p_uuid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  u                RECORD;
  e                JSONB;
  comp             JSONB;
  v_exp            JSONB;
  v_is_current     BOOLEAN;
  v_title          TEXT;
  v_raw_name       TEXT;
  v_company_id     BIGINT;
  v_linked_id      BIGINT;
  v_linked_name    TEXT;
  v_key            TEXT;
  v_entry          JSONB;
  v_cur_titles     TEXT[] := '{}';
  v_past_titles    TEXT[] := '{}';
  v_cur_companies  JSONB  := '[]';
  v_past_companies JSONB  := '[]';
  v_latest_title   TEXT;
  v_latest_start   TEXT   := '';
  v_skills         TEXT[];
  v_name_text      TEXT;
  v_title_text     TEXT;
  v_skills_text    TEXT;
  v_company_text   TEXT;
  v_functions      TEXT[];
BEGIN
  SELECT * INTO u FROM users WHERE uuid = p_uuid;

  IF NOT FOUND
     OR COALESCE(u.is_anonymous, FALSE)
     OR COALESCE(u.email, '') ILIKE '%@deleted.local'
     OR u.role::TEXT = 'feed_participant'
     OR u.status IS DISTINCT FROM 'Active' THEN  -- status
    DELETE FROM people_search_index WHERE user_uuid = p_uuid;
    RETURN;
  END IF;

  v_exp := CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END;

  FOR e IN SELECT value FROM jsonb_array_elements(v_exp) LOOP
    CONTINUE WHEN jsonb_typeof(e) <> 'object';

    v_is_current := (e->>'current') = 'true';   -- boolean true and the string "true"
    v_title      := NULLIF(btrim(COALESCE(e->>'title', '')), '');

    -- experience.company is string | number (companies.id) | {id, name}
    comp := e->'company';
    v_raw_name := NULL;
    v_company_id := NULL;
    IF jsonb_typeof(comp) = 'string' THEN
      v_raw_name := people_search_canonical_company(btrim(comp #>> '{}'));
    ELSIF jsonb_typeof(comp) = 'number' THEN
      v_company_id := (comp #>> '{}')::NUMERIC::BIGINT;
    ELSIF jsonb_typeof(comp) = 'object' THEN
      v_raw_name := people_search_canonical_company(btrim(COALESCE(comp->>'name', '')));
      IF (comp->>'id') ~ '^\d+$' THEN v_company_id := (comp->>'id')::BIGINT; END IF;
    END IF;

    v_linked_id := NULL;
    v_linked_name := NULL;
    IF v_company_id IS NOT NULL THEN
      SELECT c.id, c.name INTO v_linked_id, v_linked_name FROM companies c WHERE c.id = v_company_id;
      v_linked_name := people_search_canonical_company(v_linked_name);
    END IF;
    IF v_linked_id IS NULL AND COALESCE(v_raw_name, '') <> '' THEN
      SELECT c.id, c.name INTO v_linked_id, v_linked_name FROM companies c
      WHERE people_search_company_key(c.name) = people_search_company_key(v_raw_name)
      ORDER BY c.id
      LIMIT 1;
    END IF;

    -- '' = not a company (canonical '' alias), so no workplace entry
    v_key := people_search_company_key(COALESCE(v_linked_name, v_raw_name));
    v_entry := CASE WHEN v_key <> '' THEN jsonb_build_object(
      'key',  v_key,
      'name', COALESCE(v_linked_name, v_raw_name),
      'id',   v_linked_id
    ) END;

    IF v_is_current THEN
      IF v_title IS NOT NULL THEN v_cur_titles := v_cur_titles || v_title; END IF;
      IF v_entry IS NOT NULL THEN v_cur_companies := v_cur_companies || jsonb_build_array(v_entry); END IF;
    ELSE
      IF v_title IS NOT NULL THEN v_past_titles := v_past_titles || v_title; END IF;
      IF v_entry IS NOT NULL THEN v_past_companies := v_past_companies || jsonb_build_array(v_entry); END IF;
    END IF;

    IF v_title IS NOT NULL AND COALESCE(e->>'startDate', '') >= v_latest_start THEN
      v_latest_start := COALESCE(e->>'startDate', '');
      v_latest_title := v_title;
    END IF;
  END LOOP;

  v_skills := COALESCE(u.skills, '{}');

  v_name_text := people_search_normalize(concat_ws(' ',
    u.first_name,
    CASE WHEN u.privacy_lastname IS NULL THEN u.last_name END));

  -- No current position → the most recent one still describes what they do.
  v_title_text := people_search_normalize(concat_ws(' | ',
    u.headline,
    array_to_string(CASE WHEN cardinality(v_cur_titles) > 0 THEN v_cur_titles
                         ELSE ARRAY[v_latest_title] END, ' | ')));

  v_skills_text := people_search_normalize(array_to_string(v_skills, ' | '));

  -- Names plus every alias of those companies, so "אינטל" finds "Intel".
  v_company_text := people_search_normalize(concat_ws(' | ',
    (SELECT string_agg(x->>'name', ' | ') FROM jsonb_array_elements(v_cur_companies) x),
    (SELECT string_agg(x->>'name', ' | ') FROM jsonb_array_elements(v_past_companies) x),
    (SELECT string_agg(ca.alias, ' | ') FROM company_aliases ca
     WHERE ca.canonical_key IN (
       SELECT x->>'key' FROM jsonb_array_elements(v_cur_companies || v_past_companies) x))));

  -- Job functions: from headline + titles (LinkedIn infers "Job Function" from
  -- titles). Members with no title signal (students, career changers with an
  -- empty headline) fall back to skills, requiring two distinct hits.
  SELECT COALESCE(array_agg(DISTINCT jt.function_key), '{}') INTO v_functions
  FROM job_function_terms jt
  WHERE people_search_term_matches(v_title_text, jt.term, jt.mode);

  IF cardinality(v_functions) = 0 AND v_skills_text <> '' THEN
    SELECT COALESCE(array_agg(fk), '{}') INTO v_functions
    FROM (
      SELECT jt.function_key AS fk
      FROM job_function_terms jt
      WHERE people_search_term_matches(v_skills_text, jt.term, jt.mode)
      GROUP BY jt.function_key
      HAVING COUNT(*) >= 2
    ) s;
  END IF;

  -- Specializations imply the parent field: a React developer is a developer.
  IF v_functions && ARRAY['frontend', 'backend', 'fullstack', 'mobile']
     AND NOT v_functions @> ARRAY['software_dev'] THEN
    v_functions := v_functions || 'software_dev'::TEXT;
  END IF;

  INSERT INTO people_search_index AS i (
    user_uuid, role, name_text, title_text, skills_text, company_text, search_text,
    current_titles, skills, current_companies, past_companies,
    current_company_keys, past_company_keys, job_functions, updated_at
  ) VALUES (
    p_uuid,
    u.role::TEXT,
    v_name_text,
    v_title_text,
    v_skills_text,
    v_company_text,
    people_search_normalize(concat_ws(' | ',
      v_name_text, v_title_text, v_skills_text, v_company_text,
      array_to_string(v_past_titles, ' | '),
      u.location,
      u.about,
      people_search_jsonb_strings(u.education),
      people_search_jsonb_strings(u.certifications),
      people_search_jsonb_strings(u.projects))),
    v_cur_titles,
    v_skills,
    v_cur_companies,
    v_past_companies,
    ARRAY(SELECT DISTINCT x->>'key' FROM jsonb_array_elements(v_cur_companies) x),
    ARRAY(SELECT DISTINCT x->>'key' FROM jsonb_array_elements(v_past_companies) x),
    v_functions,
    now()
  )
  ON CONFLICT (user_uuid) DO UPDATE SET
    role                 = EXCLUDED.role,
    name_text            = EXCLUDED.name_text,
    title_text           = EXCLUDED.title_text,
    skills_text          = EXCLUDED.skills_text,
    company_text         = EXCLUDED.company_text,
    search_text          = EXCLUDED.search_text,
    current_titles       = EXCLUDED.current_titles,
    skills               = EXCLUDED.skills,
    current_companies    = EXCLUDED.current_companies,
    past_companies       = EXCLUDED.past_companies,
    current_company_keys = EXCLUDED.current_company_keys,
    past_company_keys    = EXCLUDED.past_company_keys,
    job_functions        = EXCLUDED.job_functions,
    updated_at           = EXCLUDED.updated_at;
END;
$function$;


-- 2. Re-index on status changes too, so finishing onboarding makes her searchable.
DROP TRIGGER IF EXISTS trg_people_search_users ON users;
CREATE TRIGGER trg_people_search_users
  AFTER INSERT OR DELETE OR UPDATE OF
    first_name, last_name, privacy_lastname, headline, experience, skills,
    education, certifications, projects, about, location, is_anonymous, email, role, status
  ON users
  FOR EACH ROW EXECUTE FUNCTION people_search_users_trigger();

-- 3. Profile-relative suggestions ("people she may know"): Active only.
CREATE OR REPLACE FUNCTION public.get_suggested_users_for_profile(p_viewer_id uuid, p_target_id uuid, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(uuid uuid, first_name text, last_name text, image text, headline text, role text, mutual_with_target_count integer, count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cache_age          INTERVAL;
  v_viewer_connections UUID[];
BEGIN
  SELECT now() - MIN(computed_at) INTO v_cache_age
  FROM profile_suggestion_cache
  WHERE target_id = p_target_id;

  IF v_cache_age IS NULL OR v_cache_age > INTERVAL '24 hours' THEN
    PERFORM refresh_profile_suggestions_cache(p_target_id);
  END IF;

  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_viewer_connections
  FROM get_accepted_connection_ids(p_viewer_id);

  RETURN QUERY
  SELECT
    u.uuid, u.first_name, u.last_name, u.image, u.headline, u.role::TEXT,
    psc.mutual_with_target_count,
    COUNT(*) OVER() AS count
  FROM profile_suggestion_cache psc
  JOIN public_users_view u ON u.uuid = psc.candidate_id
  WHERE psc.target_id = p_target_id
    AND psc.candidate_id <> p_viewer_id
    AND u.status = 'Active'  -- status
    AND psc.candidate_id <> ALL(v_viewer_connections)
    AND NOT EXISTS (
      SELECT 1 FROM connections c
      WHERE c.status = 'pending'
        AND ((c.requester_id = p_viewer_id AND c.receiver_id = psc.candidate_id)
          OR (c.receiver_id = p_viewer_id AND c.requester_id = psc.candidate_id))
    )
  ORDER BY psc.mutual_with_target_count DESC, u.first_name ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;


-- 4. Clean the rows already in the index.
DELETE FROM people_search_index i
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.uuid = i.user_uuid AND u.status = 'Active');

COMMIT;

-- Check (expect 0 rows):
-- SELECT u.status, count(*) FROM people_search_index i JOIN users u ON u.uuid = i.user_uuid
-- WHERE u.status IS DISTINCT FROM 'Active' GROUP BY 1;

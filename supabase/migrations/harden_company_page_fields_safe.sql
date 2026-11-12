-- ============================================================
-- What a page manager may put in her page's fields — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql. Replaces one function, companies_page_guard().
--
-- Why: the page's fields are shown to every member, some of them as links and one (the
-- description) through an HTML path that exists for imported descriptions. A manager can
-- write to her page directly, not only through our API, so the rules have to live here:
--   * text (names, tagline, description, phone): no "<" or ">", sensible lengths (sized
--     against the imported data: the longest imported description is ~5,000 characters,
--     a few pages list up to 72 specialities and 10 industries)
--   * website / LinkedIn: an https:// address only (a "javascript:" link would run code in
--     the browser of whoever clicks it)
--   * logo / cover: only a file in this page's own folder of the company-media bucket
--   * lists (industries, specialities, locations) and size / founding year: the expected
--     shape and a small size, so a malformed value can't break the screens that read them
-- The rules apply to what a signed-in member CHANGES. Existing imported values stay as they
-- are, and Duallin admins are not restricted.
--
-- Everything else the function did stays exactly as it was: a managed page ignores updates
-- that come with no signed-in person, and only an owner renames a page.
--
-- The checks run in the SAME transaction with throw-away edits: if any fails, nothing
-- changes. To go back: re-run section 5b's companies_page_guard() from
-- add_company_pages_core_safe.sql (rollback_harden_company_page_fields.sql does exactly that).
-- Safe to re-run.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.companies_page_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_media_prefix text;
BEGIN
  IF auth.uid() IS NULL THEN
    IF OLD.page_status = 'claimed'
       AND coalesce(current_setting('duallin.system_page_edit', true), '') <> 'on' THEN
      NEW.name := OLD.name;                 NEW.name_he := OLD.name_he;
      NEW.slug := OLD.slug;                 NEW.org_type := OLD.org_type;
      NEW.tagline := OLD.tagline;           NEW.tagline_he := OLD.tagline_he;
      NEW.description := OLD.description;   NEW.description_he := OLD.description_he;
      NEW.website := OLD.website;           NEW.phone := OLD.phone;
      NEW.logo := OLD.logo;                 NEW.cover_image_url := OLD.cover_image_url;
      NEW.locations := OLD.locations;       NEW.industries := OLD.industries;
      NEW.specialities := OLD.specialities; NEW.employee_count_range := OLD.employee_count_range;
      NEW.founded_on := OLD.founded_on;     NEW.linkedin_url := OLD.linkedin_url;
      NEW.cta_type := OLD.cta_type;         NEW.cta_url := OLD.cta_url;
    END IF;
    RETURN NEW;
  END IF;

  IF public.is_platform_admin() THEN RETURN NEW; END IF;

  IF NEW.name IS DISTINCT FROM OLD.name AND NOT public.has_company_role(OLD.id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'Only an owner of the page can rename it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND public.company_name_key(NEW.name) IS NULL THEN
    RAISE EXCEPTION 'A page needs a name' USING ERRCODE = 'check_violation';
  END IF;

  -- text: plain, and not longer than the page shows
  IF (NEW.name           IS DISTINCT FROM OLD.name           AND (NEW.name           ~ '[<>]' OR length(NEW.name)           > 120))
  OR (NEW.name_he        IS DISTINCT FROM OLD.name_he        AND (NEW.name_he        ~ '[<>]' OR length(NEW.name_he)        > 120))
  OR (NEW.tagline        IS DISTINCT FROM OLD.tagline        AND (NEW.tagline        ~ '[<>]' OR length(NEW.tagline)        > 220))
  OR (NEW.tagline_he     IS DISTINCT FROM OLD.tagline_he     AND (NEW.tagline_he     ~ '[<>]' OR length(NEW.tagline_he)     > 220))
  OR (NEW.description    IS DISTINCT FROM OLD.description    AND (NEW.description    ~ '[<>]' OR length(NEW.description)    > 6000))
  OR (NEW.description_he IS DISTINCT FROM OLD.description_he AND (NEW.description_he ~ '[<>]' OR length(NEW.description_he) > 6000))
  OR (NEW.phone          IS DISTINCT FROM OLD.phone          AND (NEW.phone          ~ '[<>]' OR length(NEW.phone)          > 40))
  THEN
    RAISE EXCEPTION 'Page text must be plain text of a reasonable length' USING ERRCODE = 'check_violation';
  END IF;

  -- links: https only
  IF (NEW.website      IS DISTINCT FROM OLD.website      AND NEW.website      IS NOT NULL AND (NEW.website      !~* '^https://[^[:space:]<>"]+$' OR length(NEW.website)      > 500))
  OR (NEW.linkedin_url IS DISTINCT FROM OLD.linkedin_url AND NEW.linkedin_url IS NOT NULL AND (NEW.linkedin_url !~* '^https://[^[:space:]<>"]+$' OR length(NEW.linkedin_url) > 500))
  THEN
    RAISE EXCEPTION 'A link must be an https:// address' USING ERRCODE = 'check_violation';
  END IF;

  -- images: this page's own folder in the company-media bucket, on our own storage
  v_media_prefix := '^https://(csfyofqntrfxsystdzca\.supabase\.co|api\.duallin\.com)/storage/v1/object/public/company-media/'
                    || OLD.id || '/[A-Za-z0-9._-]+$';
  IF (NEW.logo            IS DISTINCT FROM OLD.logo            AND NEW.logo            IS NOT NULL AND NEW.logo            !~ v_media_prefix)
  OR (NEW.cover_image_url IS DISTINCT FROM OLD.cover_image_url AND NEW.cover_image_url IS NOT NULL AND NEW.cover_image_url !~ v_media_prefix)
  THEN
    RAISE EXCEPTION 'A logo or cover must be an image uploaded for this page' USING ERRCODE = 'check_violation';
  END IF;

  -- lists and small objects: the shape the screens expect
  IF (NEW.industries   IS DISTINCT FROM OLD.industries   AND NEW.industries   IS NOT NULL AND NOT (jsonb_typeof(NEW.industries)   = 'array' AND jsonb_array_length(NEW.industries)   <= 10  AND NEW.industries::text   !~ '[<>]' AND length(NEW.industries::text)   <= 2000))
  OR (NEW.specialities IS DISTINCT FROM OLD.specialities AND NEW.specialities IS NOT NULL AND NOT (jsonb_typeof(NEW.specialities) = 'array' AND jsonb_array_length(NEW.specialities) <= 100 AND NEW.specialities::text !~ '[<>]' AND length(NEW.specialities::text) <= 10000))
  OR (NEW.locations    IS DISTINCT FROM OLD.locations    AND NEW.locations    IS NOT NULL AND NOT (jsonb_typeof(NEW.locations)    = 'array' AND jsonb_array_length(NEW.locations)    <= 10 AND NEW.locations::text    !~ '[<>]' AND length(NEW.locations::text)    <= 4000))
  OR (NEW.employee_count_range IS DISTINCT FROM OLD.employee_count_range AND NEW.employee_count_range IS NOT NULL AND NOT (jsonb_typeof(NEW.employee_count_range) = 'object' AND length(NEW.employee_count_range::text) <= 100))
  OR (NEW.founded_on   IS DISTINCT FROM OLD.founded_on   AND NEW.founded_on   IS NOT NULL AND NOT (jsonb_typeof(NEW.founded_on)   = 'object' AND length(NEW.founded_on::text)   <= 100))
  THEN
    RAISE EXCEPTION 'A page detail has an unexpected shape' USING ERRCODE = 'check_violation';
  END IF;
  -- every item of a list is an object ({ "name": ... } / a location), as the screens read them
  IF (NEW.industries   IS DISTINCT FROM OLD.industries   AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.industries,   '[]'::jsonb)) e WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string'))
  OR (NEW.specialities IS DISTINCT FROM OLD.specialities AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.specialities, '[]'::jsonb)) e WHERE jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string'))
  OR (NEW.locations    IS DISTINCT FROM OLD.locations    AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.locations,    '[]'::jsonb)) e WHERE jsonb_typeof(e) <> 'object'))
  THEN
    RAISE EXCEPTION 'A page detail has an unexpected shape' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- Checks (test edits are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_a uuid; v_b uuid; v_name text; v_n bigint;
  v_bad text; v_bad_sql text[];
BEGIN
  SELECT id, name INTO v_company, v_name FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT uuid INTO v_a FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_a AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  v_bad_sql := ARRAY[
    $q$description = 'hello <img src=x onerror=alert(1)>'$q$,
    $q$tagline = '<b>bold</b>'$q$,
    $q$name_he = 'a>b'$q$,
    $q$description = repeat('a', 6001)$q$,
    $q$industries = (SELECT jsonb_agg(jsonb_build_object('name', 'i' || g)) FROM generate_series(1, 11) g)$q$,
    $q$website = 'javascript:alert(1)'$q$,
    $q$website = 'http://example.com'$q$,
    $q$linkedin_url = 'https://x.com/"onmouseover="alert(1)'$q$,
    $q$logo = 'https://evil.example/logo.png'$q$,
    $q$logo = 'https://csfyofqntrfxsystdzca.supabase.co/storage/v1/object/public/company-media/1/../x.png'$q$,
    $q$cover_image_url = 'https://evil.example/storage/v1/object/public/company-media/' || id || '/c.png'$q$,
    $q$industries = '"not a list"'::jsonb$q$,
    $q$industries = '["plain string"]'::jsonb$q$,
    $q$specialities = '[{"name": "<i>x</i>"}]'::jsonb$q$,
    $q$locations = '{"city": "x"}'::jsonb$q$,
    $q$employee_count_range = '[1, 2]'::jsonb$q$
  ];

  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_a, 'owner'), (v_company, v_b, 'content');

    -- ===== the page's owner =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 1. every bad value is refused
    FOREACH v_bad IN ARRAY v_bad_sql LOOP
      BEGIN
        EXECUTE format('UPDATE companies SET %s WHERE id = %s', v_bad, v_company);
        v_problems := v_problems || ' accepted: ' || v_bad || ';';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
    END LOOP;
    -- 2. good values are saved
    BEGIN
      EXECUTE format($u$UPDATE companies SET
          name = %L, tagline = 'We build things', description = E'First line\nSecond line & more', phone = '+972-3-0000000',
          website = 'https://example.com/about?x=1', linkedin_url = 'https://www.linkedin.com/company/example',
          logo = 'https://csfyofqntrfxsystdzca.supabase.co/storage/v1/object/public/company-media/' || id || '/logo-1.webp',
          cover_image_url = 'https://api.duallin.com/storage/v1/object/public/company-media/' || id || '/cover-1.jpg',
          industries = '[{"name": "Software"}]'::jsonb, description_he = repeat('א', 6000),
          specialities = (SELECT jsonb_agg(jsonb_build_object('name', 'speciality ' || g)) FROM generate_series(1, 100) g),
          locations = '[{"city": "Jerusalem", "country": "IL", "is_hq": true}]'::jsonb,
          employee_count_range = '{"start": 11, "end": 50}'::jsonb, founded_on = '{"year": 2020}'::jsonb
        WHERE id = %s$u$, v_name || ' check', v_company);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN v_problems := v_problems || ' a valid edit was not saved;'; END IF;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a valid edit was refused: ' || SQLERRM || ';';
    END;
    -- 3. clearing the images and details is allowed
    BEGIN
      UPDATE companies SET logo = NULL, cover_image_url = NULL, industries = NULL, website = NULL WHERE id = v_company;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' clearing fields was refused: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    -- ===== a content manager still cannot rename =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE companies SET name = v_name || ' check-b' WHERE id = v_company;
      v_problems := v_problems || ' a content manager renamed the page;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- ===== no signed-in person: a managed page is still left alone =====
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE companies SET tagline = 'auto', description = '<p>auto</p>' WHERE id = v_company;
    IF (SELECT tagline FROM companies WHERE id = v_company) IS DISTINCT FROM 'We build things' THEN
      v_problems := v_problems || ' an automatic update changed a managed page;';
    END IF;

    -- ===== a Duallin admin is not restricted (imported HTML descriptions stay possible) =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM admin_update_company(v_company, '{"description": "<p>from admin</p>", "website": "http://example.com"}'::jsonb);
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' an admin edit was refused: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row and edit above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % kinds of bad value refused, valid edits saved, admins unrestricted, managed pages still closed to automatic updates.', array_length(v_bad_sql, 1);
END $$;

COMMIT;

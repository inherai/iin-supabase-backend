-- ============================================================
-- UNDO harden_company_page_fields_safe.sql — companies_page_guard() exactly as
-- add_company_pages_core_safe.sql created it (no checks on what a manager writes).
-- !! With this undone a page manager can again save markup and non-https links on her page.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.companies_page_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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

  IF NEW.name IS DISTINCT FROM OLD.name
     AND NOT public.is_platform_admin()
     AND NOT public.has_company_role(OLD.id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'Only an owner of the page can rename it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND public.company_name_key(NEW.name) IS NULL THEN
    RAISE EXCEPTION 'A page needs a name' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;

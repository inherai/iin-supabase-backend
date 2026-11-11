-- ============================================================
-- Company pages, core schema — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
--
-- Adds what a company / organization page needs before any screen is built:
--   * page fields on companies (slug, type, cover, Hebrew texts, call-to-action, follower count)
--   * company_admins — several managers per page, each with a role
--       owner     everything, including managing the other managers
--       content   edit the page and publish in its name
--       recruiter jobs and applicants
--       analyst   read the numbers only
--   * company_audit_log — who changed what on a page
--   * the rule that lets a page's owner / content manager edit their page (and only the
--     page fields — never owner, verification, status or the employees list). Only an
--     owner may rename the page; its address (slug) stays.
--   * a managed page is closed to automatic updates: its page fields change only through a
--     signed-in person (its managers, or a Duallin admin). Importers and scrapers are ignored
--     on those fields, and cannot create a second company for an organization that already
--     has a managed page. What the community writes about a company (employees list,
--     reviews, salaries, interviews, fit ratings) is not touched by any of this.
--   * companies.import_name — the name as the job sources know it. It never changes, so
--     imported jobs keep finding the page after an owner renames it.
--
-- No existing behaviour changes: the current single owner (companies.owner_uuid) keeps
-- working and is copied into company_admins as 'owner' (and stays in step while the admin
-- screen still sets owner_uuid). One thing starts working that was silently blocked: an
-- owner editing her page's tagline.
--
-- !! Deploy the API right after running this: the admin screen's "save company" has to go
-- !! through admin_update_company() in the admin's own session. Until it does, an admin's
-- !! edit of a MANAGED page's fields is ignored like any other automatic update (unmanaged
-- !! pages are unaffected).
--
-- Permissions live in the database (row-level security). The API uses the member's own
-- session; nothing here needs the service role. Six small functions run with the table
-- owner's rights (SECURITY DEFINER), each for one narrow job a member must not do directly:
--   has_company_role            answers "does the caller manage this page?" (needed inside
--                               the rules of company_admins itself)
--   company_admins_after_change writes the audit line and keeps page_status in step
--   company_followers_count     keeps companies.followers_count in step with follows
--   company_page_audit          writes the audit line when page fields change
--   company_page_deleted_audit  writes the audit line when a company is deleted
--   admin_update_company        a Duallin admin saves a company from the admin screen; it
--                               refuses anyone whose session is not an admin's
--
-- To fix a managed page by hand in the SQL Editor (no signed-in person there), start the
-- transaction with:  SET LOCAL duallin.system_page_edit = 'on';
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, everything
-- is undone and nothing changes. To go back later: rollback_add_company_pages_core.sql
-- Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 0. "Is the caller a Duallin admin?" — same test the existing rules use, in one place.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(((auth.jwt() -> 'app_metadata') ->> 'is_admin')::boolean, false)
$$;

-- ------------------------------------------------------------
-- 1. Page fields on companies (all public page content — nothing sensitive goes here).
-- ------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS slug            text,
  ADD COLUMN IF NOT EXISTS org_type        text        NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS page_status     text        NOT NULL DEFAULT 'unclaimed',
  ADD COLUMN IF NOT EXISTS claimed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS verified        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cover_image_url text,
  ADD COLUMN IF NOT EXISTS name_he         text,
  ADD COLUMN IF NOT EXISTS tagline_he      text,
  ADD COLUMN IF NOT EXISTS description_he  text,
  ADD COLUMN IF NOT EXISTS cta_type        text,
  ADD COLUMN IF NOT EXISTS cta_url         text,
  ADD COLUMN IF NOT EXISTS followers_count integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS import_name     text;

-- The name as the job sources know it: today's name, frozen.
UPDATE public.companies SET import_name = name WHERE import_name IS NULL AND name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_import_name ON public.companies (import_name);

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_org_type_check;
ALTER TABLE public.companies ADD  CONSTRAINT companies_org_type_check
  CHECK (org_type IN ('company', 'nonprofit', 'public', 'education', 'other'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_page_status_check;
ALTER TABLE public.companies ADD  CONSTRAINT companies_page_status_check
  CHECK (page_status IN ('unclaimed', 'claimed', 'suspended'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_cta_check;
ALTER TABLE public.companies ADD  CONSTRAINT companies_cta_check
  CHECK (
    (cta_type IS NULL AND cta_url IS NULL)
    OR (cta_type = 'jobs' AND cta_url IS NULL)
    OR (cta_type IN ('website', 'contact') AND cta_url ~* '^(https://|mailto:)' AND length(cta_url) <= 500)
  );
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_slug_format_check;
ALTER TABLE public.companies ADD  CONSTRAINT companies_slug_format_check
  CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 120));

-- Slug: the page address (/company/<slug>). Built from the name; the id is appended when the
-- name has no Latin letters, is only digits, is reserved, or is already taken.
-- (universal_name is a numeric LinkedIn id for most rows and repeats, so it can't be used.)
CREATE OR REPLACE FUNCTION public.company_slug_base(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT left(nullif(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), ''), 100)
$$;

WITH s AS (
  SELECT id, btrim(public.company_slug_base(name), '-') AS base FROM public.companies WHERE slug IS NULL
), c AS (
  SELECT base, count(*) AS n FROM s GROUP BY base
)
UPDATE public.companies co
SET slug = CASE
    WHEN s.base IS NULL THEN 'company-' || co.id
    WHEN s.base ~ '^[0-9-]+$' OR c.n > 1 OR s.base IN ('new', 'claim', 'admin', 'company')
         OR EXISTS (SELECT 1 FROM public.companies x WHERE x.slug = s.base)
      THEN s.base || '-' || co.id
    ELSE s.base
  END
FROM s JOIN c ON c.base IS NOT DISTINCT FROM s.base
WHERE co.id = s.id;

CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_key ON public.companies (slug);
ALTER TABLE public.companies ALTER COLUMN slug SET NOT NULL;

-- New companies (admin screen, importers) get a slug automatically.
CREATE OR REPLACE FUNCTION public.companies_set_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_base text := btrim(public.company_slug_base(NEW.name), '-');
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  IF v_base IS NULL THEN
    NEW.slug := 'company-' || NEW.id;
  ELSIF v_base ~ '^[0-9-]+$' OR v_base IN ('new', 'claim', 'admin', 'company')
        OR EXISTS (SELECT 1 FROM companies WHERE slug = v_base) THEN
    NEW.slug := v_base || '-' || NEW.id;
  ELSE
    NEW.slug := v_base;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_companies_set_slug ON public.companies;
CREATE TRIGGER trg_companies_set_slug
  BEFORE INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_set_slug();

-- A name reduced to what identifies it: lower case, no spaces or punctuation.
CREATE OR REPLACE FUNCTION public.company_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(lower(regexp_replace(coalesce(p_name, ''), '[[:space:][:punct:]״׳־]+', '', 'g')), '')
$$;

-- New companies: remember the name they arrived with, and refuse a second company for an
-- organization whose page is already managed (whoever is creating it — admin screen or importer).
CREATE OR REPLACE FUNCTION public.companies_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_key text := public.company_name_key(NEW.name);
  v_existing integer;
BEGIN
  NEW.import_name := coalesce(NEW.import_name, NEW.name);
  IF v_key IS NOT NULL THEN
    SELECT c.id INTO v_existing
    FROM companies c
    WHERE c.page_status = 'claimed'
      AND v_key IN (public.company_name_key(c.name), public.company_name_key(c.import_name), public.company_name_key(c.name_he))
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RAISE EXCEPTION 'A managed page already exists for this organization (company id %)', v_existing
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_companies_before_insert ON public.companies;
CREATE TRIGGER trg_companies_before_insert
  BEFORE INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_before_insert();

-- ------------------------------------------------------------
-- 2. company_admins — who manages which page, in which role.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_admins (
  company_id integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.users(uuid)   ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('owner', 'content', 'recruiter', 'analyst')),
  added_by   uuid                 REFERENCES public.users(uuid)   ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_company_admins_user ON public.company_admins (user_id);

-- "Does the caller manage this page (in one of these roles)?" Answers only about the caller.
-- SECURITY DEFINER because the rules on company_admins themselves need to ask it.
CREATE OR REPLACE FUNCTION public.has_company_role(p_company_id integer, p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_admins a
    WHERE a.company_id = p_company_id
      AND a.user_id = auth.uid()
      AND (p_roles IS NULL OR a.role = ANY (p_roles))
  )
$$;
REVOKE ALL ON FUNCTION public.has_company_role(integer, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_company_role(integer, text[]) TO authenticated, service_role;

ALTER TABLE public.company_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Managers see their page's managers" ON public.company_admins;
CREATE POLICY "Managers see their page's managers"
  ON public.company_admins FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_company_role(company_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS "Owners add managers" ON public.company_admins;
CREATE POLICY "Owners add managers"
  ON public.company_admins FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner']) OR public.is_platform_admin());

DROP POLICY IF EXISTS "Owners change manager roles" ON public.company_admins;
CREATE POLICY "Owners change manager roles"
  ON public.company_admins FOR UPDATE TO authenticated
  USING      (public.has_company_role(company_id, ARRAY['owner']) OR public.is_platform_admin())
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner']) OR public.is_platform_admin());

DROP POLICY IF EXISTS "Owners remove managers, managers may leave" ON public.company_admins;
CREATE POLICY "Owners remove managers, managers may leave"
  ON public.company_admins FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_company_role(company_id, ARRAY['owner']) OR public.is_platform_admin());

REVOKE ALL ON TABLE public.company_admins FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.company_admins TO authenticated;
GRANT UPDATE (role) ON TABLE public.company_admins TO authenticated;
GRANT ALL ON TABLE public.company_admins TO service_role;

-- Rules a member can't get around: who added the row is recorded truthfully, and a page
-- never loses its last owner through a member's action (Duallin admins and system clean-up,
-- such as deleting a user, are not held back).
CREATE OR REPLACE FUNCTION public.company_admins_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN NEW.added_by := auth.uid(); END IF;
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR public.is_platform_admin() THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND NOT EXISTS (
       SELECT 1 FROM company_admins
       WHERE company_id = OLD.company_id AND role = 'owner' AND user_id <> OLD.user_id
     ) THEN
    RAISE EXCEPTION 'A page must keep at least one owner' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_company_admins_guard ON public.company_admins;
CREATE TRIGGER trg_company_admins_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_admins
  FOR EACH ROW EXECUTE FUNCTION public.company_admins_guard();

-- ------------------------------------------------------------
-- 3. company_audit_log — written only by triggers, read by the page's owners and Duallin admins.
--    company_id deliberately has no foreign key: the history outlives a deleted company.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_audit_log (
  id         bigserial   PRIMARY KEY,
  company_id integer     NOT NULL,
  actor_id   uuid,
  action     text        NOT NULL,
  details    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_audit_log_company ON public.company_audit_log (company_id, created_at DESC);

ALTER TABLE public.company_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners read their page's history" ON public.company_audit_log;
CREATE POLICY "Owners read their page's history"
  ON public.company_audit_log FOR SELECT TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner']) OR public.is_platform_admin());

REVOKE ALL ON TABLE public.company_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.company_audit_log TO authenticated;
GRANT ALL ON TABLE public.company_audit_log TO service_role;
REVOKE ALL ON SEQUENCE public.company_audit_log_id_seq FROM PUBLIC, anon, authenticated;

-- After a manager is added / changed / removed: one audit line, and page_status follows
-- whether the page has an owner. Runs as the table owner — members can write neither.
CREATE OR REPLACE FUNCTION public.company_admins_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company integer := coalesce(NEW.company_id, OLD.company_id);
  v_has_owner boolean;
BEGIN
  -- the company itself is being deleted: nothing left to record against
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = v_company) THEN RETURN NULL; END IF;

  INSERT INTO company_audit_log (company_id, actor_id, action, details)
  VALUES (
    v_company, auth.uid(), 'manager_' || lower(TG_OP),
    jsonb_strip_nulls(jsonb_build_object(
      'user_id',       coalesce(NEW.user_id, OLD.user_id),
      'role',          CASE WHEN TG_OP <> 'DELETE' THEN NEW.role END,
      'previous_role', CASE WHEN TG_OP <> 'INSERT' THEN OLD.role END
    ))
  );

  v_has_owner := EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_company AND role = 'owner');
  UPDATE companies
  SET page_status = CASE WHEN v_has_owner THEN 'claimed' ELSE 'unclaimed' END,
      claimed_at  = CASE WHEN v_has_owner THEN coalesce(claimed_at, now()) ELSE NULL END
  WHERE id = v_company
    AND page_status <> 'suspended'
    AND page_status <> CASE WHEN v_has_owner THEN 'claimed' ELSE 'unclaimed' END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_admins_after_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_admins_after_change ON public.company_admins;
CREATE TRIGGER trg_company_admins_after_change
  AFTER INSERT OR UPDATE OR DELETE ON public.company_admins
  FOR EACH ROW EXECUTE FUNCTION public.company_admins_after_change();

-- After page fields change: one audit line naming the fields; for the short identifying
-- fields also the value before and after.
CREATE OR REPLACE FUNCTION public.company_page_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fields jsonb;
  v_changes jsonb;
BEGIN
  SELECT jsonb_agg(n.key ORDER BY n.key),
         jsonb_object_agg(n.key, jsonb_build_object('from', to_jsonb(OLD) -> n.key, 'to', n.value))
           FILTER (WHERE n.key = ANY (ARRAY['name', 'name_he', 'slug', 'org_type', 'verified', 'website',
                                            'phone', 'linkedin_url', 'cta_type', 'cta_url']))
  INTO v_fields, v_changes
  FROM jsonb_each(to_jsonb(NEW)) n
  WHERE n.key = ANY (ARRAY[
          'name', 'slug', 'org_type', 'verified', 'tagline', 'description', 'website', 'phone', 'logo',
          'cover_image_url', 'locations', 'industries', 'specialities', 'employee_count_range',
          'founded_on', 'linkedin_url', 'name_he', 'tagline_he', 'description_he', 'cta_type', 'cta_url'])
    AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key);
  IF v_fields IS NOT NULL THEN
    INSERT INTO company_audit_log (company_id, actor_id, action, details)
    VALUES (NEW.id, auth.uid(), 'page_edit',
            jsonb_strip_nulls(jsonb_build_object('fields', v_fields, 'changes', v_changes)));
  END IF;
  RETURN NULL;
END;
$$;

-- A deleted company leaves one last line, with the name it had.
CREATE OR REPLACE FUNCTION public.company_page_deleted_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO company_audit_log (company_id, actor_id, action, details)
  VALUES (OLD.id, auth.uid(), 'page_deleted',
          jsonb_strip_nulls(jsonb_build_object('name', OLD.name, 'slug', OLD.slug, 'page_status', OLD.page_status)));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_page_deleted_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_page_deleted_audit ON public.companies;
CREATE TRIGGER trg_company_page_deleted_audit
  AFTER DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.company_page_deleted_audit();
REVOKE ALL ON FUNCTION public.company_page_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_page_audit ON public.companies;
CREATE TRIGGER trg_company_page_audit
  AFTER UPDATE OF name, slug, org_type, verified, tagline, description, website, phone, logo,
                  cover_image_url, locations, industries, specialities, employee_count_range,
                  founded_on, linkedin_url, name_he, tagline_he, description_he, cta_type, cta_url
  ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.company_page_audit();

-- ------------------------------------------------------------
-- 4. Followers. The existing follow table (article_company_follows) stays the one place a
--    follow is stored; the page shows the number from companies.followers_count, and a
--    page's managers may see who follows it.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_followers_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE companies SET followers_count = followers_count + 1 WHERE id = NEW.company_id;
  ELSE
    UPDATE companies SET followers_count = greatest(followers_count - 1, 0) WHERE id = OLD.company_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_followers_count() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_followers_count ON public.article_company_follows;
CREATE TRIGGER trg_company_followers_count
  AFTER INSERT OR DELETE ON public.article_company_follows
  FOR EACH ROW EXECUTE FUNCTION public.company_followers_count();

UPDATE public.companies c
SET followers_count = f.n
FROM (SELECT company_id, count(*)::int AS n FROM public.article_company_follows GROUP BY company_id) f
WHERE f.company_id = c.id AND c.followers_count IS DISTINCT FROM f.n;

DROP POLICY IF EXISTS "Managers see their page's followers" ON public.article_company_follows;
CREATE POLICY "Managers see their page's followers"
  ON public.article_company_follows FOR SELECT TO authenticated
  USING (public.has_company_role(company_id));

-- ------------------------------------------------------------
-- 5. Who may read and edit what on companies.
--    Members already hold column-level read (secure_companies_step2); the new columns join it.
--    Editing: a page's owner / content manager, the page fields only, not while suspended.
-- ------------------------------------------------------------
GRANT SELECT (slug, org_type, page_status, claimed_at, verified, cover_image_url, name_he,
              tagline_he, description_he, cta_type, cta_url, followers_count, import_name)
  ON TABLE public.companies TO authenticated;

REVOKE UPDATE ON TABLE public.companies FROM authenticated;
GRANT UPDATE (name, tagline, description, website, phone, logo, cover_image_url, locations, industries,
              specialities, employee_count_range, founded_on, linkedin_url, org_type,
              name_he, tagline_he, description_he, cta_type, cta_url)
  ON TABLE public.companies TO authenticated;

DROP POLICY IF EXISTS "Page managers edit their page" ON public.companies;
CREATE POLICY "Page managers edit their page"
  ON public.companies FOR UPDATE TO authenticated
  USING      (page_status <> 'suspended' AND public.has_company_role(id, ARRAY['owner', 'content']))
  WITH CHECK (page_status <> 'suspended' AND public.has_company_role(id, ARRAY['owner', 'content']));

-- Two rules on every update of a company:
--   * a managed page's fields change only through a signed-in person. An update that comes
--     with no signed-in person (importer, scraper, scheduled job) keeps those fields as they
--     were — quietly, so the importer itself doesn't fail. Everything else on the row
--     (employees list, counters, status) still updates.
--   * the name of a page is changed by its owner (or a Duallin admin), not by a content manager.
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
DROP TRIGGER IF EXISTS trg_companies_page_guard ON public.companies;
CREATE TRIGGER trg_companies_page_guard
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_page_guard();

-- While the admin screen still sets companies.owner_uuid, company_admins follows it, so a
-- page is never "owned" in one place and unmanaged in the other.
CREATE OR REPLACE FUNCTION public.companies_owner_uuid_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_uuid IS NOT DISTINCT FROM OLD.owner_uuid THEN RETURN NULL; END IF;
  IF NEW.owner_uuid IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE uuid = NEW.owner_uuid) THEN
    INSERT INTO company_admins (company_id, user_id, role) VALUES (NEW.id, NEW.owner_uuid, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.owner_uuid IS NOT NULL THEN
    DELETE FROM company_admins WHERE company_id = NEW.id AND user_id = OLD.owner_uuid AND role = 'owner';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_companies_owner_uuid_sync ON public.companies;
CREATE TRIGGER trg_companies_owner_uuid_sync
  AFTER INSERT OR UPDATE OF owner_uuid ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_owner_uuid_sync();

-- The admin screen's "save company", in the admin's own session. Only the listed fields are
-- taken from the request; anything else in it is ignored.
CREATE OR REPLACE FUNCTION public.admin_update_company(p_company_id integer, p_updates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE companies c
  SET (name, active, description, universal_name, website, phone, logo, tagline, locations,
       industries, specialities, employee_count_range, founded_on, linkedin_url, owner_uuid,
       slug, org_type, page_status, verified, cover_image_url, name_he, tagline_he,
       description_he, cta_type, cta_url)
    = (SELECT r.name, r.active, r.description, r.universal_name, r.website, r.phone, r.logo, r.tagline, r.locations,
              r.industries, r.specialities, r.employee_count_range, r.founded_on, r.linkedin_url, r.owner_uuid,
              r.slug, r.org_type, r.page_status, r.verified, r.cover_image_url, r.name_he, r.tagline_he,
              r.description_he, r.cta_type, r.cta_url
       FROM jsonb_populate_record(c, coalesce(p_updates, '{}'::jsonb)) r)
  WHERE c.id = p_company_id
  RETURNING to_jsonb(c) INTO v_row;

  RETURN v_row;   -- NULL when there is no such company
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_company(integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_company(integer, jsonb) TO authenticated;

-- Imported jobs find their company by the name the job source uses — the page's current
-- name or the one it was imported with. The importers match on companies.name themselves;
-- this fills the gap they leave once a page has been renamed.
-- It never stops a job from being saved.
CREATE OR REPLACE FUNCTION public.open_position_link_company()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL AND NEW.company_name IS NOT NULL THEN
    BEGIN
      SELECT c.id INTO NEW.company_id
      FROM companies c
      WHERE c.import_name = NEW.company_name OR c.name = NEW.company_name
      ORDER BY (c.page_status = 'claimed') DESC, c.id
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_open_position_link_company ON public.open_position;
CREATE TRIGGER trg_open_position_link_company
  BEFORE INSERT OR UPDATE OF company_name, company_id ON public.open_position
  FOR EACH ROW EXECUTE FUNCTION public.open_position_link_company();

-- ------------------------------------------------------------
-- 6. Today's single owners become 'owner' managers (the triggers above mark those pages claimed).
-- ------------------------------------------------------------
INSERT INTO public.company_admins (company_id, user_id, role)
SELECT c.id, c.owner_uuid, 'owner'
FROM public.companies c
WHERE c.owner_uuid IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.users u WHERE u.uuid = c.owner_uuid)
ON CONFLICT (company_id, user_id) DO NOTHING;

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_a uuid; v_a_email text; v_b uuid; v_b_email text;
  v_n bigint; v_ok boolean; v_slugs bigint; v_total bigint; v_owners_src bigint; v_owners_dst bigint;
  v_other integer; v_name text; v_slug text; v_json jsonb;
BEGIN
  -- structure
  SELECT count(*), count(DISTINCT slug) INTO v_total, v_slugs FROM companies;
  IF v_total <> v_slugs THEN v_problems := v_problems || ' slugs are not unique;'; END IF;
  SELECT count(*) INTO v_owners_src FROM companies c WHERE c.owner_uuid IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.uuid = c.owner_uuid);
  SELECT count(*) INTO v_owners_dst FROM companies c JOIN company_admins a ON a.company_id = c.id AND a.user_id = c.owner_uuid AND a.role = 'owner';
  IF v_owners_src <> v_owners_dst THEN v_problems := v_problems || format(' %s existing owners, %s copied;', v_owners_src, v_owners_dst); END IF;
  IF EXISTS (SELECT 1 FROM companies c WHERE (page_status = 'claimed') <> EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id AND a.role = 'owner') AND page_status <> 'suspended') THEN
    v_problems := v_problems || ' page_status does not match ownership;';
  END IF;
  IF EXISTS (SELECT 1 FROM companies WHERE import_name IS NULL AND name IS NOT NULL) THEN v_problems := v_problems || ' import_name was not copied from name;'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.company_audit_log'::regclass AND contype = 'f') THEN
    v_problems := v_problems || ' the history is still tied to the company row;';
  END IF;
  -- no job waiting today would be linked differently by the new job trigger
  SELECT count(*) INTO v_n FROM open_position o JOIN companies c ON (c.import_name = o.company_name OR c.name = o.company_name) WHERE o.company_id IS NULL;
  IF v_n <> 0 THEN v_problems := v_problems || format(' %s existing unlinked jobs match a company by name;', v_n); END IF;

  -- a page nobody manages, and two real members who manage nothing
  SELECT id, name, slug INTO v_company, v_name, v_slug FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT id INTO v_other FROM companies c WHERE id <> v_company AND name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT uuid, email INTO v_a, v_a_email FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid, email INTO v_b, v_b_email FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_a AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  BEGIN
    -- ===== member A, before she manages anything =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'email', v_a_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 1. she reads companies with the new fields, and the list view
    BEGIN
      PERFORM id, slug, org_type, page_status, verified, followers_count FROM companies WHERE id = v_company;
      PERFORM 1 FROM companies_ranked LIMIT 1;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a member read failed: ' || SQLERRM || ';';
    END;
    -- 2. she cannot edit a page she doesn't manage
    UPDATE companies SET tagline = 'check' WHERE id = v_company;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member edited a page she does not manage;'; END IF;
    -- 3. she cannot make herself a manager
    BEGIN
      INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_a, 'owner');
      v_problems := v_problems || ' a member made herself owner;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- Duallin makes A the owner (as the claim approval will)
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_a, 'owner');
    IF (SELECT page_status FROM companies WHERE id = v_company) <> 'claimed' THEN v_problems := v_problems || ' page not marked claimed after getting an owner;'; END IF;

    -- ===== A as owner =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'email', v_a_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 4. she edits her page
    UPDATE companies SET tagline = 'check', name_he = 'check' WHERE id = v_company;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN v_problems := v_problems || ' an owner could not edit her page;'; END IF;
    -- 5. but not the protected fields
    BEGIN
      UPDATE companies SET verified = true WHERE id = v_company;
      v_problems := v_problems || ' an owner could verify her own page;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE companies SET owner_uuid = v_a WHERE id = v_company;
      v_problems := v_problems || ' an owner could change owner_uuid;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 6. she adds B as content manager, and it is recorded as added by her
    BEGIN
      INSERT INTO company_admins (company_id, user_id, role, added_by) VALUES (v_company, v_b, 'content', v_b);
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' an owner could not add a manager: ' || SQLERRM || ';';
    END;
    IF (SELECT added_by FROM company_admins WHERE company_id = v_company AND user_id = v_b) IS DISTINCT FROM v_a THEN
      v_problems := v_problems || ' added_by was not recorded as the acting owner;';
    END IF;
    -- 7. she reads the history
    SELECT count(*) INTO v_n FROM company_audit_log WHERE company_id = v_company;
    IF v_n < 3 THEN v_problems := v_problems || format(' history has %s lines, expected at least 3;', v_n); END IF;
    -- 7b. she renames her page: the address and the import name stay, the history keeps both names
    BEGIN
      UPDATE companies SET name = v_name || ' check' WHERE id = v_company;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' an owner could not rename her page: ' || SQLERRM || ';';
    END;
    IF (SELECT slug FROM companies WHERE id = v_company) <> v_slug THEN v_problems := v_problems || ' renaming changed the page address;'; END IF;
    IF NOT EXISTS (SELECT 1 FROM company_audit_log WHERE company_id = v_company AND action = 'page_edit'
                   AND details #>> '{changes,name,from}' = v_name AND details #>> '{changes,name,to}' = v_name || ' check') THEN
      v_problems := v_problems || ' the rename was not recorded with both names;';
    END IF;
    -- 7c. she is not a Duallin admin: the admin save refuses her
    BEGIN
      PERFORM admin_update_company(v_company, '{"verified": true}'::jsonb);
      v_problems := v_problems || ' a page owner used the admin save;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 8. she cannot leave the page without an owner
    BEGIN
      DELETE FROM company_admins WHERE company_id = v_company AND user_id = v_a;
      v_problems := v_problems || ' the last owner could leave;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    RESET ROLE;

    -- ===== B as content manager =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 9. edits the page
    UPDATE companies SET description_he = 'check' WHERE id = v_company;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN v_problems := v_problems || ' a content manager could not edit the page;'; END IF;
    -- 9b. but cannot rename it
    BEGIN
      UPDATE companies SET name = v_name || ' check-b' WHERE id = v_company;
      v_problems := v_problems || ' a content manager renamed the page;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 10. cannot promote herself, cannot read the history
    UPDATE company_admins SET role = 'owner' WHERE company_id = v_company AND user_id = v_b;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a content manager promoted herself;'; END IF;
    SELECT count(*) INTO v_n FROM company_audit_log WHERE company_id = v_company;
    IF v_n <> 0 THEN v_problems := v_problems || ' a content manager read the history;'; END IF;
    -- 11. sees the page's managers, and may leave
    SELECT count(*) INTO v_n FROM company_admins WHERE company_id = v_company;
    IF v_n <> 2 THEN v_problems := v_problems || format(' a manager sees %s managers, expected 2;', v_n); END IF;
    DELETE FROM company_admins WHERE company_id = v_company AND user_id = v_b;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN v_problems := v_problems || ' a manager could not leave;'; END IF;
    -- 12. following a page moves its counter
    INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (v_b, v_company) ON CONFLICT DO NOTHING;
    RESET ROLE;
    IF (SELECT followers_count FROM companies WHERE id = v_company)
       <> (SELECT count(*) FROM article_company_follows WHERE company_id = v_company) THEN
      v_problems := v_problems || ' followers_count did not follow a new follow;';
    END IF;

    -- ===== no signed-in person: importer / scraper / scheduled job =====
    PERFORM set_config('request.jwt.claims', '', true);
    -- 13. a managed page's fields are left alone; the rest of the row still updates
    UPDATE companies SET tagline = 'auto', logo = 'auto', name = 'auto-' || id, last_scraped_at = now() WHERE id = v_company;
    SELECT (tagline = 'check' AND logo IS DISTINCT FROM 'auto' AND name = v_name || ' check' AND last_scraped_at IS NOT NULL)
      INTO v_ok FROM companies WHERE id = v_company;
    IF v_ok IS NOT TRUE THEN v_problems := v_problems || ' an automatic update changed a managed page (or was blocked entirely);'; END IF;
    -- 14. an unmanaged page still takes automatic updates
    UPDATE companies SET tagline = 'auto' WHERE id = v_other;
    IF (SELECT tagline FROM companies WHERE id = v_other) IS DISTINCT FROM 'auto' THEN v_problems := v_problems || ' an automatic update of an unmanaged page was lost;'; END IF;
    -- 15. no second company for an organization with a managed page — by its current name or the imported one
    BEGIN
      INSERT INTO companies (name) VALUES ('  ' || upper(v_name) || ' CHECK. ');
      v_problems := v_problems || ' a duplicate of a managed page was created (current name);';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO companies (name) VALUES (upper(v_name) || '!');
      v_problems := v_problems || ' a duplicate of a managed page was created (imported name);';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 16. a new, unrelated company is still created, with an address and an import name
    BEGIN
      INSERT INTO companies (name) VALUES ('Duallin Self Check 7f3a') RETURNING to_jsonb(companies.*) INTO v_json;
      IF v_json ->> 'slug' IS NULL OR v_json ->> 'import_name' <> 'Duallin Self Check 7f3a' THEN v_problems := v_problems || ' a new company got no address / import name;'; END IF;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a new company could not be created: ' || SQLERRM || ';';
    END;
    -- 17. a job arriving under the old name still finds the renamed page
    IF (SELECT c.id FROM companies c WHERE c.import_name = v_name ORDER BY (c.page_status = 'claimed') DESC, c.id LIMIT 1) IS DISTINCT FROM v_company THEN
      v_problems := v_problems || ' the old name no longer leads to the renamed page;';
    END IF;
    -- 18. owner_uuid set the old way keeps company_admins in step, both directions
    UPDATE companies SET owner_uuid = v_b WHERE id = v_other;
    IF NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_other AND user_id = v_b AND role = 'owner')
       OR (SELECT page_status FROM companies WHERE id = v_other) <> 'claimed' THEN
      v_problems := v_problems || ' setting owner_uuid did not make the page managed;';
    END IF;
    UPDATE companies SET owner_uuid = NULL WHERE id = v_other;
    IF EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_other)
       OR (SELECT page_status FROM companies WHERE id = v_other) <> 'unclaimed' THEN
      v_problems := v_problems || ' clearing owner_uuid left the page managed;';
    END IF;

    -- ===== a Duallin admin, in her own session =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    -- 19. saves a managed page through the admin save, including fields managers can't touch
    BEGIN
      v_json := admin_update_company(v_company, jsonb_build_object('tagline', 'by admin', 'verified', true, 'employees', '[]'::jsonb, 'no_such_field', 1));
      IF v_json ->> 'tagline' IS DISTINCT FROM 'by admin' OR (v_json ->> 'verified')::boolean IS NOT TRUE
         OR v_json ->> 'name' <> v_name || ' check' THEN
        v_problems := v_problems || ' the admin save did not save what it was given, or touched other fields;';
      END IF;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' the admin save failed: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    -- ===== signed-out visitor =====
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM company_admins LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read company_admins;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM company_audit_log LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read the history;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
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
  RAISE NOTICE 'All checks passed: % companies with unique slugs, % owner(s) copied, roles enforced, managed pages closed to automatic updates, history written, signed-out blocked.', v_total, v_owners_dst;
END $$;

COMMIT;

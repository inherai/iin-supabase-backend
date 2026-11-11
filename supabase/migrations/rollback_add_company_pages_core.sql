-- ============================================================
-- UNDO add_company_pages_core_safe.sql — back to the state after secure_companies_step2.
--
-- !! This DELETES data created since: every manager row in company_admins, the page history,
-- !! and whatever was typed into the new page fields (Hebrew texts, cover, call-to-action).
-- !! A page that was renamed keeps its new name; its imported name (import_name) is dropped,
-- !! so put the old name back first if imported jobs should keep finding it.
-- !! Deploy the API with the previous admin "save company" (service client) together with
-- !! this: admin_update_company() no longer exists afterwards.
-- !! companies.owner_uuid is untouched, so the original single owners keep working.
-- Only if something on the site misbehaves after the migration.
-- ============================================================
BEGIN;

DROP POLICY IF EXISTS "Page managers edit their page" ON public.companies;
DROP POLICY IF EXISTS "Managers see their page's followers" ON public.article_company_follows;

DROP TRIGGER IF EXISTS trg_company_page_audit         ON public.companies;
DROP TRIGGER IF EXISTS trg_company_page_deleted_audit ON public.companies;
DROP TRIGGER IF EXISTS trg_companies_set_slug         ON public.companies;
DROP TRIGGER IF EXISTS trg_companies_before_insert    ON public.companies;
DROP TRIGGER IF EXISTS trg_companies_page_guard       ON public.companies;
DROP TRIGGER IF EXISTS trg_companies_owner_uuid_sync  ON public.companies;
DROP TRIGGER IF EXISTS trg_open_position_link_company ON public.open_position;
DROP TRIGGER IF EXISTS trg_company_followers_count ON public.article_company_follows;

DROP TABLE IF EXISTS public.company_audit_log;
DROP TABLE IF EXISTS public.company_admins;   -- drops its triggers and policies with it

DROP FUNCTION IF EXISTS public.company_page_audit();
DROP FUNCTION IF EXISTS public.company_page_deleted_audit();
DROP FUNCTION IF EXISTS public.admin_update_company(integer, jsonb);
DROP FUNCTION IF EXISTS public.open_position_link_company();
DROP FUNCTION IF EXISTS public.companies_owner_uuid_sync();
DROP FUNCTION IF EXISTS public.companies_page_guard();
DROP FUNCTION IF EXISTS public.companies_before_insert();
DROP FUNCTION IF EXISTS public.company_name_key(text);
DROP FUNCTION IF EXISTS public.company_followers_count();
DROP FUNCTION IF EXISTS public.company_admins_after_change();
DROP FUNCTION IF EXISTS public.company_admins_guard();
DROP FUNCTION IF EXISTS public.companies_set_slug();
DROP FUNCTION IF EXISTS public.has_company_role(integer, text[]);
DROP FUNCTION IF EXISTS public.is_platform_admin();
DROP FUNCTION IF EXISTS public.company_slug_base(text);

-- members' edit rights on companies as they were (table-level UPDATE; the only rule that
-- allowed an update was "Enable update for admins only")
REVOKE UPDATE (name, tagline, description, website, phone, logo, cover_image_url, locations, industries,
               specialities, employee_count_range, founded_on, linkedin_url, org_type,
               name_he, tagline_he, description_he, cta_type, cta_url)
  ON TABLE public.companies FROM authenticated;
GRANT UPDATE ON TABLE public.companies TO authenticated;

DROP INDEX IF EXISTS public.companies_slug_key;
DROP INDEX IF EXISTS public.idx_companies_import_name;
ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_org_type_check,
  DROP CONSTRAINT IF EXISTS companies_page_status_check,
  DROP CONSTRAINT IF EXISTS companies_cta_check,
  DROP CONSTRAINT IF EXISTS companies_slug_format_check,
  DROP COLUMN IF EXISTS slug,
  DROP COLUMN IF EXISTS org_type,
  DROP COLUMN IF EXISTS page_status,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS verified,
  DROP COLUMN IF EXISTS cover_image_url,
  DROP COLUMN IF EXISTS name_he,
  DROP COLUMN IF EXISTS tagline_he,
  DROP COLUMN IF EXISTS description_he,
  DROP COLUMN IF EXISTS cta_type,
  DROP COLUMN IF EXISTS cta_url,
  DROP COLUMN IF EXISTS followers_count,
  DROP COLUMN IF EXISTS import_name;

COMMIT;

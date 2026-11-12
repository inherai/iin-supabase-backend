-- ============================================================
-- Storage for page logos and cover images — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql (has_company_role).
--
-- A new bucket, company-media. Files live under a folder named by the company id:
--     company-media/<company id>/logo-<time>.webp
-- Reading is public, like article covers (a logo is shown wherever the page's name is).
-- Writing: only a manager of THAT page (owner / content), in her own session — the rule
-- reads the company id from the folder name. Images only, up to 5 MB.
--
-- The check runs in the SAME transaction: if it fails, nothing changes.
-- To go back later: rollback_add_company_media_bucket.sql        Safe to re-run.
-- ============================================================
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('company-media', 'company-media', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- "Does the caller manage the page this file belongs to?" — the first folder is the company id.
CREATE OR REPLACE FUNCTION public.company_media_writable(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- exactly "<company id>/<file name>": no sub-folders, no "..", a plain file name
  SELECT CASE
    WHEN p_name ~ '^[0-9]{1,9}/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
      THEN public.has_company_role(split_part(p_name, '/', 1)::integer, ARRAY['owner', 'content'])
    ELSE false
  END
$$;

DROP POLICY IF EXISTS "company media public read" ON storage.objects;
CREATE POLICY "company media public read" ON storage.objects FOR SELECT
  USING (bucket_id = 'company-media');

DROP POLICY IF EXISTS "company media managers upload" ON storage.objects;
CREATE POLICY "company media managers upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-media' AND public.company_media_writable(name));

DROP POLICY IF EXISTS "company media managers replace" ON storage.objects;
CREATE POLICY "company media managers replace" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'company-media' AND public.company_media_writable(name))
  WITH CHECK (bucket_id = 'company-media' AND public.company_media_writable(name));

DROP POLICY IF EXISTS "company media managers delete" ON storage.objects;
CREATE POLICY "company media managers delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'company-media' AND public.company_media_writable(name));

DO $$
DECLARE
  v_problems text := '';
  v_owner uuid; v_company integer; v_member uuid; v_ok boolean;
BEGIN
  SELECT user_id, company_id INTO v_owner, v_company FROM public.company_admins WHERE role = 'owner' ORDER BY created_at LIMIT 1;
  SELECT uuid INTO v_member FROM public.users u WHERE status = 'Active' AND NOT EXISTS (SELECT 1 FROM public.company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  IF v_owner IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT public.company_media_writable(v_company || '/logo-1.webp') INTO v_ok;
    IF v_ok IS NOT TRUE THEN v_problems := v_problems || ' an owner may not write to her page''s folder;'; END IF;
    SELECT public.company_media_writable((v_company + 1) || '/logo-1.webp') OR public.company_media_writable('logo.webp')
        OR public.company_media_writable('x/' || v_company || '/logo.webp') OR public.company_media_writable(v_company || '/')
        OR public.company_media_writable(v_company || '/../' || (v_company + 1) || '/logo.webp') OR public.company_media_writable(v_company || '/sub/logo.webp')
        OR public.company_media_writable(v_company || '/..') INTO v_ok;
    IF v_ok IS NOT FALSE THEN v_problems := v_problems || ' an owner may write outside her page''s folder;'; END IF;
    RESET ROLE;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT public.company_media_writable(coalesce(v_company, 1) || '/logo-1.webp') INTO v_ok;
  IF v_ok IS NOT FALSE THEN v_problems := v_problems || ' an ordinary member may write to a page''s folder;'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'company media %') <> 4 THEN
    v_problems := v_problems || ' the storage rules were not all created;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'company-media' AND public) THEN v_problems := v_problems || ' the bucket was not created;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: company-media bucket ready; only a page''s owner / content manager writes to its folder.';
END $$;

COMMIT;

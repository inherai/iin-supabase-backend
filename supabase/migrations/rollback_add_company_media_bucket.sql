-- ============================================================
-- UNDO add_company_media_bucket_safe.sql.
--
-- Removes the rules that let page managers upload, so nobody can write to the bucket any more.
-- The bucket itself and the files in it are left in place: Supabase does not allow deleting
-- storage rows from SQL, and logos / covers already saved on pages would turn into broken
-- images. To remove the bucket as well, empty and delete it from the Storage screen.
-- ============================================================
BEGIN;
DROP POLICY IF EXISTS "company media managers delete"  ON storage.objects;
DROP POLICY IF EXISTS "company media managers replace" ON storage.objects;
DROP POLICY IF EXISTS "company media managers upload"  ON storage.objects;
DROP POLICY IF EXISTS "company media public read"      ON storage.objects;
DROP FUNCTION IF EXISTS public.company_media_writable(text);
COMMIT;

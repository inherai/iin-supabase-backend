-- ============================================================
-- UNDO secure_feed_cache.sql — puts feed_cache back exactly as it was before (2026-11-05).
-- Only if something on the site misbehaves after securing it.
-- ============================================================
BEGIN;
DROP POLICY IF EXISTS "Signed-in members can read the feed cache" ON public.feed_cache;
ALTER TABLE public.feed_cache DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_cache TO authenticated;
GRANT SELECT ON TABLE public.feed_cache TO anon;
ALTER FUNCTION public.feed_cache_on_post_insert()    SECURITY INVOKER RESET search_path;
ALTER FUNCTION public.feed_cache_on_post_update()    SECURITY INVOKER RESET search_path;
ALTER FUNCTION public.feed_cache_on_comment_insert() SECURITY INVOKER RESET search_path;
ALTER FUNCTION public.feed_cache_on_comment_delete() SECURITY INVOKER RESET search_path;
COMMIT;

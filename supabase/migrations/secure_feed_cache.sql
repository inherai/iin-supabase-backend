-- ============================================================
-- Secure feed_cache (Supabase security alert "rls_disabled_in_public", 2026-11-05).
-- Run in Supabase SQL Editor. Safe to re-run.
--
-- Before: RLS was off, so anyone with the project's public (anon) key could read the table —
-- including sender email addresses — and also insert, change or delete rows (break the feed).
--
-- What stays exactly the same (no regressions):
--   * signed-in members still read it, directly (routes/status.ts) and through
--     get_stabilized_feed / count_new_feed_activity (they run as the member)
--   * the four triggers that keep it up to date keep their code; they now run as the table
--     owner (SECURITY DEFINER, like handle_new_comment), so a member's post / comment still
--     updates the cache even though members can no longer write to it themselves
--   * the API's service role keeps full access
-- What changes:
--   * no access at all without signing in (nothing on the site reads it signed-out)
--   * members can't insert / update / delete rows directly
-- ============================================================

-- 1. The triggers write with the owner's rights, not the member's (bodies unchanged).
ALTER FUNCTION public.feed_cache_on_post_insert()    SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.feed_cache_on_post_update()    SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.feed_cache_on_comment_insert() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.feed_cache_on_comment_delete() SECURITY DEFINER SET search_path = public;

-- 2. Row-level security on, one rule: signed-in members may read (as today).
ALTER TABLE public.feed_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in members can read the feed cache" ON public.feed_cache;
CREATE POLICY "Signed-in members can read the feed cache"
  ON public.feed_cache FOR SELECT TO authenticated USING (true);

-- 3. Privileges to match: read for members, nothing for signed-out visitors, writes only via
--    the triggers above (owner) and the API's service role.
REVOKE ALL ON TABLE public.feed_cache FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.feed_cache FROM authenticated;
GRANT SELECT ON TABLE public.feed_cache TO authenticated;
GRANT ALL ON TABLE public.feed_cache TO service_role;

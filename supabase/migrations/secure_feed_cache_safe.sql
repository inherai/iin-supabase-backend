-- ============================================================
-- Secure feed_cache — SELF-CHECKING version (2026-11-05). Run this one in the SQL Editor.
-- It applies secure_feed_cache.sql and checks the result in the SAME transaction:
-- if any check fails, the whole thing is undone automatically and nothing changes.
-- If all checks pass it is saved. The test comment it writes is always undone.
-- To go back later: rollback_secure_feed_cache.sql
-- ============================================================
BEGIN;

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

DO $$
DECLARE
  v_read bigint; v_problems text := ''; v_post text; v_email text; v_uid uuid;
  v_before timestamptz; v_after timestamptz; v_deleted boolean := false; v_comment_ok boolean := false;
BEGIN
  SELECT post_id, effective_date INTO v_post, v_before FROM feed_cache ORDER BY effective_date DESC LIMIT 1;
  SELECT email, uuid INTO v_email, v_uid FROM users WHERE status = 'Active' AND email NOT LIKE 'deleted_%' LIMIT 1;

  -- 1. a signed-in member can still read it (the feed)
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_read FROM feed_cache;
  RESET ROLE;
  IF v_read = 0 THEN v_problems := v_problems || ' members can no longer read it;'; END IF;

  -- 2. a signed-in member can no longer delete from it
  SET LOCAL ROLE authenticated;
  BEGIN
    DELETE FROM feed_cache WHERE post_id = v_post;
    v_deleted := FOUND;
  EXCEPTION WHEN insufficient_privilege THEN v_deleted := false;
  END;
  RESET ROLE;
  IF v_deleted THEN v_problems := v_problems || ' a member could still delete;'; END IF;

  -- 3. a signed-out visitor can't read it
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM feed_cache LIMIT 1;
    v_problems := v_problems || ' signed-out visitors can still read it;';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- 4. a member's own comment still updates the cache (then the comment is undone)
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'email', v_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO comments (post_id, sender, message, created_at) VALUES (v_post, v_email, 'safety check', now() + interval '1 minute');
    RESET ROLE;
    SELECT effective_date INTO v_after FROM feed_cache WHERE post_id = v_post;
    v_comment_ok := v_after > v_before;
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test comment';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;  -- the comment and its effects are undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a member comment failed: ' || SQLERRM || ';';
  END;
  IF NOT v_comment_ok AND v_problems NOT LIKE '%comment failed%' THEN
    v_problems := v_problems || ' a new comment did not update the feed;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All 4 checks passed: members read (% rows), member delete blocked, signed-out blocked, comments update the feed.', v_read;
END $$;

COMMIT;

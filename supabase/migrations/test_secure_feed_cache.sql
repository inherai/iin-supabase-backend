-- ============================================================
-- SAFE TEST for secure_feed_cache.sql — run it AFTER that file.
-- Ends with an error on purpose so EVERYTHING is rolled back; the message is the result.
--   1. a signed-in member can still read feed_cache          → expect a number of rows
--   2. a signed-in member can no longer delete from it        → expect "blocked"
--   3. a signed-out visitor can't read it                     → expect "blocked"
--   4. a member's new comment still updates the cache (the trigger) → expect "updated"
-- ============================================================
DO $$
DECLARE
  v_read bigint; v_member_delete text; v_anon_read text; v_trigger text;
  v_post text; v_email text; v_uid uuid; v_before timestamptz; v_after timestamptz;
BEGIN
  -- a real post and a real member
  SELECT post_id INTO v_post FROM feed_cache ORDER BY effective_date DESC LIMIT 1;
  SELECT email, uuid INTO v_email, v_uid FROM users WHERE status = 'Active' AND email NOT LIKE 'deleted_%' LIMIT 1;
  SELECT effective_date INTO v_before FROM feed_cache WHERE post_id = v_post;

  -- 1 + 2: as a signed-in member
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_read FROM feed_cache;
  BEGIN
    DELETE FROM feed_cache WHERE post_id = v_post;
    v_member_delete := CASE WHEN FOUND THEN 'NOT blocked (a row was deleted)' ELSE 'blocked (0 rows)' END;
  EXCEPTION WHEN insufficient_privilege THEN v_member_delete := 'blocked (permission denied)';
  END;
  RESET ROLE;

  -- 3: as a signed-out visitor
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM feed_cache LIMIT 1;
    v_anon_read := 'NOT blocked';
  EXCEPTION WHEN insufficient_privilege THEN v_anon_read := 'blocked (permission denied)';
  END;
  RESET ROLE;

  -- 4: a member comments WITH HER OWN SESSION (as on the site) → the trigger, now SECURITY DEFINER,
  --    still moves the post up in the cache although she can't write to feed_cache herself
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'email', v_email, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO comments (post_id, sender, message, created_at) VALUES (v_post, v_email, 'test', now() + interval '1 minute');
    RESET ROLE;
    SELECT effective_date INTO v_after FROM feed_cache WHERE post_id = v_post;
    v_trigger := CASE WHEN v_after > v_before THEN 'updated' ELSE 'NOT updated' END;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_trigger := 'comment failed: ' || SQLERRM;
  END;

  RAISE EXCEPTION E'TEST RESULT — everything was rolled back:\n  1. member reads: % rows (expect > 0)\n  2. member delete: % (expect blocked)\n  3. signed-out read: % (expect blocked)\n  4. new comment updates the cache: % (expect updated)',
    v_read, v_member_delete, v_anon_read, v_trigger;
END $$;

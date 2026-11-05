-- ============================================================
-- SAFE TEST for add_notification_triggers.sql — run it AFTER that file.
-- Everything happens inside one block that ends with an error on purpose, so the database
-- rolls ALL of it back: no comment, like, follow or notification is left behind, and nobody
-- gets anything. The "error" message IS the test result.
--
-- Uses three real members (A, B, C) and a real post by B:
--   1. A comments on B's post and mentions C   → POST_COMMENT to B (existing trigger), MENTION to C
--   2. B replies to A's comment and mentions A → REPLY to A only (no extra MENTION to A)
--   3. C likes A's comment                    → COMMENT_REACTION to A
--   4. A mentions herself                     → nothing
--   5. C follows A (if not already)           → FOLLOW to A
-- ============================================================
DO $$
DECLARE
  v_post text; a uuid; b uuid; c uuid; a_email text; b_email text; c_email text;
  v_comment bigint; v_result text := ''; v_line text;
  t0 timestamptz := clock_timestamp();
BEGIN
  -- a recent real post and its author (B)
  SELECT p.id, p.posted_by_uuid INTO v_post, b
  FROM posts p JOIN users u ON u.uuid = p.posted_by_uuid AND u.status = 'Active'
  WHERE p.post_type IS NOT NULL AND p.post_type <> 'email'
  ORDER BY p.sent_at DESC LIMIT 1;
  SELECT email INTO b_email FROM users WHERE uuid = b;

  SELECT uuid, email INTO a, a_email FROM users
  WHERE status = 'Active' AND uuid <> b AND email NOT LIKE 'deleted_%' ORDER BY created_at LIMIT 1;
  SELECT uuid, email INTO c, c_email FROM users
  WHERE status = 'Active' AND uuid NOT IN (a, b) AND email NOT LIKE 'deleted_%' ORDER BY created_at LIMIT 1;

  -- 1. A comments on B's post, mentioning C
  INSERT INTO comments (post_id, sender, message, created_at)
  VALUES (v_post, a_email, 'test @[C](' || c || ')', now())
  RETURNING id INTO v_comment;

  -- 2. B replies to A's comment, mentioning A
  INSERT INTO comments (post_id, sender, message, parent_comment_id, created_at)
  VALUES (v_post, b_email, 'reply @[A](' || a || ')', v_comment, now());

  -- 3. C likes A's comment
  INSERT INTO likes (user_id, target_id, target_type, reaction_type)
  VALUES (c, v_comment::text, 'comment', 'like');

  -- 4. A mentions herself
  INSERT INTO comments (post_id, sender, message, created_at)
  VALUES (v_post, a_email, 'me @[A](' || a || ')', now());

  -- 5. C follows A
  INSERT INTO article_author_follows (follower_uuid, author_uuid) VALUES (c, a) ON CONFLICT DO NOTHING;

  -- what was created in this test
  FOR v_line IN
    SELECT n.type || ' → ' || CASE n.user_id WHEN a THEN 'A' WHEN b THEN 'B' WHEN c THEN 'C' ELSE 'other' END
           || ' (from ' || CASE n.actor_id WHEN a THEN 'A' WHEN b THEN 'B' WHEN c THEN 'C' ELSE 'other' END || ')'
           || CASE WHEN n.target_id = v_post THEN ', points to the post' ELSE '' END
    FROM notifications n
    WHERE n.created_at >= t0 - interval '1 second' AND n.user_id IN (a, b, c) AND n.actor_id IN (a, b, c)
    ORDER BY n.type
  LOOP
    v_result := v_result || E'\n  ' || v_line;
  END LOOP;

  RAISE EXCEPTION E'TEST RESULT — everything was rolled back, nothing was saved:%\n\nExpected:\n  COMMENT_REACTION → A (from C), points to the post\n  FOLLOW → A (from C)   [only if C did not already follow A]\n  MENTION → C (from A), points to the post\n  POST_COMMENT → B (from A or B), points to the post\n  REPLY → A (from B), points to the post\nand NO "MENTION → A".', v_result;
END $$;

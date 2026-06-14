-- Delete all posts where post_type = 'email' or post_type IS NULL,
-- along with all related data: vectors, likes, comments, notifications,
-- post_impressions, saved_resources.
-- post_reports are handled automatically via ON DELETE CASCADE.
--
-- Run this in the Supabase SQL editor (service role / postgres user).

DO $$
DECLARE
  email_post_ids TEXT[];
  email_comment_ids TEXT[];
BEGIN
  -- 1. Collect all post IDs to delete
  SELECT ARRAY_AGG(id::TEXT)
  INTO email_post_ids
  FROM posts
  WHERE post_type = 'email' OR post_type IS NULL;

  IF email_post_ids IS NULL OR array_length(email_post_ids, 1) = 0 THEN
    RAISE NOTICE 'No email/null posts found. Nothing to delete.';
    RETURN;
  END IF;

  RAISE NOTICE 'Found % posts to delete', array_length(email_post_ids, 1);

  -- 2. Collect comment IDs on those posts (needed to clean up comment likes)
  SELECT ARRAY_AGG(id::TEXT)
  INTO email_comment_ids
  FROM comments
  WHERE post_id::TEXT = ANY(email_post_ids);

  -- 3. Delete vectors
  DELETE FROM vectors WHERE postid::TEXT = ANY(email_post_ids);
  RAISE NOTICE 'Deleted vectors';

  -- 4. Delete post impressions
  DELETE FROM post_impressions WHERE post_id = ANY(email_post_ids);
  RAISE NOTICE 'Deleted post_impressions';

  -- 5. Delete likes on posts
  DELETE FROM likes WHERE target_type = 'post' AND target_id::TEXT = ANY(email_post_ids);
  RAISE NOTICE 'Deleted post likes';

  -- 6. Delete likes on comments belonging to those posts
  IF email_comment_ids IS NOT NULL AND array_length(email_comment_ids, 1) > 0 THEN
    DELETE FROM likes WHERE target_type = 'comment' AND target_id::TEXT = ANY(email_comment_ids);
    RAISE NOTICE 'Deleted comment likes';
  END IF;

  -- 7. Delete notifications targeting those posts
  DELETE FROM notifications WHERE target_id::TEXT = ANY(email_post_ids);
  RAISE NOTICE 'Deleted notifications';

  -- 8. Delete saved_resources for those posts
  DELETE FROM saved_resources
  WHERE saved_resource_type = 'post' AND saved_resource_id = ANY(email_post_ids);
  RAISE NOTICE 'Deleted saved_resources';

  -- 9. Delete comments (after their likes are gone)
  DELETE FROM comments WHERE post_id::TEXT = ANY(email_post_ids);
  RAISE NOTICE 'Deleted comments';

  -- 10. Delete the posts themselves (post_reports cascade automatically)
  DELETE FROM posts WHERE post_type = 'email' OR post_type IS NULL;
  RAISE NOTICE 'Deleted posts';

  RAISE NOTICE 'Done. Deleted % email/null posts and all related data.', array_length(email_post_ids, 1);
END $$;

-- ============================================================
-- Notifications that were never saved (found 2026-11-05) — now created in the database,
-- the same way as the existing ones (handle_new_comment, handle_new_like, notify_article_comment).
-- Run in Supabase SQL Editor. Safe to re-run.
--
-- Why: the API inserted these with the member's own session, and `notifications` has no INSERT
-- policy for members (only SELECT/UPDATE of her own), so every one of them was rejected:
--   MENTION, REPLY                       (posts and post comments)
--   COMMENT_REACTION, ARTICLE_COMMENT_REACTION (likes on comments)
--   ARTICLE_REPLY, ARTICLE_MENTION       (article comments)
--   FOLLOW, NEW_ARTICLE, NEW_COMPANY_ARTICLE
-- Instead of opening an INSERT policy (members could then forge "X mentioned you"), the database
-- creates each notification when the thing really happened. No policy changes.
--
-- Safety (no regressions):
--   * every function is wrapped: if creating a notification fails, the comment / like / post /
--     follow / publish itself still succeeds (a WARNING is logged, like notify_article_comment)
--   * the existing triggers are not touched; the new ones only add the types they never create
--     (ARTICLE_COMMENT stays with notify_article_comment, POST_* with handle_new_*)
--   * same rules as the API code they replace (who is skipped, what target_id points to)
-- ============================================================

-- Mentioned member ids in a post / comment.
--   html_only = false: "@[Name](uuid)" or data-user-id="uuid"   (posts & post comments)
--   html_only = true : data-user-id="uuid" only                    (article comments)
CREATE OR REPLACE FUNCTION public.extract_mention_ids(p_text text, p_html_only boolean DEFAULT false)
RETURNS SETOF uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT lower(m[1])::uuid FROM (
    SELECT regexp_matches(coalesce(p_text, ''),
      'data-user-id="([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"', 'g') AS m
    UNION ALL
    SELECT regexp_matches(coalesce(p_text, ''),
      '@\[[^\]]+\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)', 'g')
    WHERE NOT p_html_only
  ) s;
$$;

-- ── Post: mentions (new posts, incl. scheduled posts when they publish) ──
CREATE OR REPLACE FUNCTION public.notify_post_mentions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT u.uuid, NEW.posted_by_uuid, NEW.id, 'MENTION', 1, false
    FROM extract_mention_ids(NEW.message) AS m(id)
    JOIN users u ON u.uuid = m.id
    WHERE u.uuid <> NEW.posted_by_uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_post_mentions: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_post_mentions ON public.posts;
CREATE TRIGGER on_post_mentions AFTER INSERT ON public.posts
  FOR EACH ROW WHEN (NEW.posted_by_uuid IS NOT NULL AND NEW.post_type IS NOT NULL AND NEW.post_type <> 'email')
  EXECUTE FUNCTION public.notify_post_mentions();

-- ── Post comment: reply to a comment + mentions ──
-- (POST_COMMENT to the post owner stays with handle_new_comment.)
CREATE OR REPLACE FUNCTION public.notify_comment_reply_and_mentions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid;
  v_parent_author uuid;
BEGIN
  BEGIN
    SELECT uuid INTO v_actor FROM users WHERE email = NEW.sender LIMIT 1;
    IF v_actor IS NULL THEN RETURN NEW; END IF;

    IF NEW.parent_comment_id IS NOT NULL THEN
      SELECT u.uuid INTO v_parent_author
      FROM comments pc JOIN users u ON u.email = pc.sender
      WHERE pc.id = NEW.parent_comment_id LIMIT 1;
      IF v_parent_author IS NOT NULL AND v_parent_author <> v_actor THEN
        INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
        VALUES (v_parent_author, v_actor, NEW.post_id, 'REPLY', 1, false);
      END IF;
    END IF;

    -- the parent comment's author already got REPLY — not also MENTION
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT u.uuid, v_actor, NEW.post_id, 'MENTION', 1, false
    FROM extract_mention_ids(NEW.message) AS m(id)
    JOIN users u ON u.uuid = m.id
    WHERE u.uuid <> v_actor AND u.uuid IS DISTINCT FROM v_parent_author;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_comment_reply_and_mentions: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_comment_reply_and_mentions ON public.comments;
CREATE TRIGGER on_comment_reply_and_mentions AFTER INSERT ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_comment_reply_and_mentions();

-- ── Like on a comment (post comment or article comment) ──
-- (handle_new_like returns early for target_type 'comment', so no overlap.)
CREATE OR REPLACE FUNCTION public.notify_comment_reaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_target text;
  v_type text;
BEGIN
  BEGIN
    IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.target_id ~ '^[0-9]+$' THEN
      -- post comments have numeric ids
      SELECT u.uuid, c.post_id INTO v_owner, v_target
      FROM comments c JOIN users u ON u.email = c.sender
      WHERE c.id = NEW.target_id::bigint LIMIT 1;
      v_type := 'COMMENT_REACTION';
    ELSIF NEW.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      -- article comments have uuid ids
      SELECT ac.author_uuid, ac.article_id::text INTO v_owner, v_target
      FROM article_comments ac WHERE ac.id = NEW.target_id::uuid;
      v_type := 'ARTICLE_COMMENT_REACTION';
    END IF;

    IF v_owner IS NOT NULL AND v_owner <> NEW.user_id AND v_target IS NOT NULL THEN
      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      VALUES (v_owner, NEW.user_id, v_target, v_type, 1, false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_comment_reaction: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_comment_reaction ON public.likes;
CREATE TRIGGER on_comment_reaction AFTER INSERT ON public.likes
  FOR EACH ROW WHEN (lower(NEW.target_type) = 'comment')
  EXECUTE FUNCTION public.notify_comment_reaction();

-- ── Article comment: reply + mentions ──
-- (ARTICLE_COMMENT to the article owner stays with notify_article_comment.)
CREATE OR REPLACE FUNCTION public.notify_article_comment_reply_and_mentions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_article_owner uuid;
  v_parent_author uuid;
BEGIN
  BEGIN
    -- same owner rule as notify_article_comment: the author, else the company owner
    SELECT coalesce(a.author_uuid, co.owner_uuid) INTO v_article_owner
    FROM articles a LEFT JOIN companies co ON co.id = a.company_id
    WHERE a.id = NEW.article_id;

    IF NEW.parent_comment_id IS NOT NULL THEN
      SELECT author_uuid INTO v_parent_author FROM article_comments WHERE id = NEW.parent_comment_id;
      -- if she's also the article owner she already gets ARTICLE_COMMENT — not a second one
      IF v_parent_author IS NOT NULL AND v_parent_author <> NEW.author_uuid
         AND v_parent_author IS DISTINCT FROM v_article_owner THEN
        INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
        VALUES (v_parent_author, NEW.author_uuid, NEW.article_id::text, 'ARTICLE_REPLY', 1, false);
      END IF;
    END IF;

    -- not the commenter, the article owner, or the parent comment's author (they were notified above)
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT u.uuid, NEW.author_uuid, NEW.article_id::text, 'ARTICLE_MENTION', 1, false
    FROM extract_mention_ids(NEW.content, true) AS m(id)
    JOIN users u ON u.uuid = m.id
    WHERE u.uuid <> NEW.author_uuid
      AND u.uuid IS DISTINCT FROM v_article_owner
      AND u.uuid IS DISTINCT FROM v_parent_author;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_article_comment_reply_and_mentions: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_article_comment_reply_and_mentions ON public.article_comments;
CREATE TRIGGER on_article_comment_reply_and_mentions AFTER INSERT ON public.article_comments
  FOR EACH ROW EXECUTE FUNCTION public.notify_article_comment_reply_and_mentions();

-- ── New follower of an author ──
-- target_id = the follower (NOT NULL column; the site opens the follower's page from actor_id).
-- Fires only on a real new follow (re-following an existing row is an upsert UPDATE, not an INSERT).
CREATE OR REPLACE FUNCTION public.notify_new_follow()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.follower_uuid <> NEW.author_uuid THEN
      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      VALUES (NEW.author_uuid, NEW.follower_uuid, NEW.follower_uuid::text, 'FOLLOW', 1, false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_new_follow: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_new_follow ON public.article_author_follows;
CREATE TRIGGER on_new_follow AFTER INSERT ON public.article_author_follows
  FOR EACH ROW EXECUTE FUNCTION public.notify_new_follow();

-- ── Article published → its author's followers, and the company's followers ──
-- actor = whoever published it (as in the API), else the author.
CREATE OR REPLACE FUNCTION public.notify_article_published()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := coalesce(auth.uid(), NEW.author_uuid);
BEGIN
  BEGIN
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT f.follower_uuid, v_actor, NEW.id::text, 'NEW_ARTICLE', 1, false
    FROM article_author_follows f
    WHERE NEW.author_uuid IS NOT NULL AND f.author_uuid = NEW.author_uuid
      AND f.follower_uuid IS DISTINCT FROM v_actor;

    -- company followers who don't already follow the author
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT f.follower_uuid, v_actor, NEW.id::text, 'NEW_COMPANY_ARTICLE', 1, false
    FROM article_company_follows f
    WHERE NEW.company_id IS NOT NULL AND f.company_id = NEW.company_id
      AND f.follower_uuid IS DISTINCT FROM v_actor
      AND NOT EXISTS (SELECT 1 FROM article_author_follows af
                      WHERE af.author_uuid = NEW.author_uuid AND af.follower_uuid = f.follower_uuid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_article_published: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_article_published ON public.articles;
CREATE TRIGGER on_article_published AFTER UPDATE OF status ON public.articles
  FOR EACH ROW WHEN (NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' AND NEW.deleted_at IS NULL)
  EXECUTE FUNCTION public.notify_article_published();

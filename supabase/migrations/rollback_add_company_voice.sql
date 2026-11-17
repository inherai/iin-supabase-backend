-- ============================================================
-- UNDO add_company_voice_safe.sql.
-- Puts back the seven notification triggers exactly as they were in production on
-- 2026-11-16 (read from the database before the change), removes the rules for page
-- comments and the new columns.
--
-- Comments already written in a page's name stay as comments of the member who typed
-- them (comments.sender) — run this only after the site code that shows page comments
-- was rolled back, and check first:  SELECT count(*) FROM comments WHERE company_id IS NOT NULL;
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    post_owner_uuid UUID;
    commenter_uuid UUID;
    existing_notif_id UUID;
BEGIN
    SELECT uuid INTO post_owner_uuid FROM "users"
    WHERE email = (SELECT sender FROM posts WHERE id = NEW.post_id::TEXT);

    SELECT uuid INTO commenter_uuid FROM "users" WHERE email = NEW.sender;

    IF post_owner_uuid IS NULL OR post_owner_uuid = commenter_uuid THEN RETURN NEW; END IF;

    SELECT id INTO existing_notif_id FROM notifications
    WHERE user_id = post_owner_uuid AND target_id = NEW.post_id::TEXT
      AND type = 'POST_COMMENT' AND is_read = FALSE LIMIT 1;

    IF existing_notif_id IS NOT NULL THEN
        UPDATE notifications SET count = count + 1, actor_id = commenter_uuid, updated_at = now()
        WHERE id = existing_notif_id;
    ELSE
        INSERT INTO notifications (user_id, actor_id, target_id, type, count)
        VALUES (post_owner_uuid, commenter_uuid, NEW.post_id::TEXT, 'POST_COMMENT', 1);
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_delete_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$DECLARE
    post_owner_uuid UUID;
    commenter_uuid UUID;
    existing_notif_id UUID;
    current_count INT;
BEGIN
    SELECT uuid INTO post_owner_uuid 
    FROM "users" 
    WHERE email = (SELECT sender FROM posts WHERE id = OLD.post_id::TEXT);
    
    SELECT uuid INTO commenter_uuid FROM "users" WHERE email = OLD.sender;

    IF post_owner_uuid IS NULL OR post_owner_uuid = commenter_uuid THEN
        RETURN OLD;
    END IF;

    SELECT id, count INTO existing_notif_id, current_count
    FROM notifications
    WHERE user_id = post_owner_uuid 
      AND target_id = OLD.post_id::TEXT 
      AND type = 'POST_COMMENT'
    ORDER BY created_at DESC
    LIMIT 1;

    IF existing_notif_id IS NOT NULL THEN
        IF current_count > 1 THEN
            UPDATE notifications SET count = count - 1 WHERE id = existing_notif_id;
        ELSE
            DELETE FROM notifications WHERE id = existing_notif_id;
        END IF;
    END IF;

    RETURN OLD;
END;$function$;

CREATE OR REPLACE FUNCTION public.handle_new_like()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    owner_uuid UUID;
    existing_notif_id UUID;
    notif_type TEXT;
BEGIN
    IF LOWER(NEW.target_type) = 'post' THEN
        notif_type := 'POST_LIKE';
        SELECT uuid INTO owner_uuid
        FROM "users"
        WHERE email = (SELECT sender FROM posts WHERE id = NEW.target_id::TEXT);
    ELSIF LOWER(NEW.target_type) = 'article' THEN
        notif_type := 'ARTICLE_LIKE';
        SELECT author_uuid INTO owner_uuid
        FROM articles WHERE id = NEW.target_id::uuid;
    ELSE
        RETURN NEW;
    END IF;

    IF owner_uuid IS NULL OR owner_uuid = NEW.user_id THEN RETURN NEW; END IF;

    SELECT id INTO existing_notif_id FROM notifications
    WHERE user_id = owner_uuid AND target_id = NEW.target_id::TEXT
      AND type = notif_type AND is_read = FALSE LIMIT 1;

    IF existing_notif_id IS NOT NULL THEN
        UPDATE notifications SET count = count + 1, actor_id = NEW.user_id, updated_at = now()
        WHERE id = existing_notif_id;
    ELSE
        INSERT INTO notifications (user_id, actor_id, target_id, type, count)
        VALUES (owner_uuid, NEW.user_id, NEW.target_id::TEXT, notif_type, 1);
    END IF;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_unlike()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    owner_uuid UUID;
    existing_notif_id UUID;
    current_count INT;
    notif_type TEXT;
BEGIN
    IF LOWER(OLD.target_type) = 'post' THEN
        notif_type := 'POST_LIKE';
        SELECT uuid INTO owner_uuid
        FROM "users"
        WHERE email = (SELECT sender FROM posts WHERE id = OLD.target_id::TEXT);

    ELSIF LOWER(OLD.target_type) = 'article' THEN
        notif_type := 'ARTICLE_LIKE';
        SELECT author_uuid INTO owner_uuid
        FROM articles
        WHERE id = OLD.target_id::uuid;

    ELSE
        RETURN OLD;
    END IF;

    IF owner_uuid IS NULL OR owner_uuid = OLD.user_id THEN
        RETURN OLD;
    END IF;

    SELECT id, count INTO existing_notif_id, current_count
    FROM notifications
    WHERE user_id = owner_uuid
      AND target_id = OLD.target_id::TEXT
      AND type = notif_type
    ORDER BY created_at DESC
    LIMIT 1;

    IF existing_notif_id IS NOT NULL THEN
        IF current_count > 1 THEN
            UPDATE notifications SET count = count - 1 WHERE id = existing_notif_id;
        ELSE
            DELETE FROM notifications WHERE id = existing_notif_id;
        END IF;
    END IF;

    RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_comment_reaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.notify_comment_reply_and_mentions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.notify_post_mentions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

DROP TRIGGER IF EXISTS comments_company_guard ON public.comments;
DROP FUNCTION IF EXISTS public.comments_company_guard();
DROP POLICY IF EXISTS "A page comment is written by the page's managers" ON public.comments;
DROP POLICY IF EXISTS "A page comment is edited by the page's managers" ON public.comments;
DROP POLICY IF EXISTS "A page comment is deleted by the page's managers" ON public.comments;
DROP POLICY IF EXISTS "Page managers edit the page's comments" ON public.comments;
DROP POLICY IF EXISTS "Page managers delete the page's comments" ON public.comments;

DROP FUNCTION IF EXISTS public.notification_bump(uuid, uuid, integer, text, text, integer);
DROP FUNCTION IF EXISTS public.notification_drop(uuid, text, text);
DROP FUNCTION IF EXISTS public.post_notify_targets(text);
DROP FUNCTION IF EXISTS public.comment_notify_targets(bigint);
DROP FUNCTION IF EXISTS public.extract_company_mention_ids(text);

DELETE FROM public.notifications WHERE type = 'PAGE_MENTION';
DROP INDEX IF EXISTS public.idx_comments_company;
ALTER TABLE public.comments      DROP COLUMN IF EXISTS company_id;
ALTER TABLE public.notifications DROP COLUMN IF EXISTS actor_company_id, DROP COLUMN IF EXISTS company_id;
COMMIT;

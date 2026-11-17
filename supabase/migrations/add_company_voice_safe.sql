-- ============================================================
-- Company pages: the page speaks — SELF-CHECKING (2026-11-16). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql, add_entitlements_safe.sql and
-- add_company_notifications_safe.sql.
--
-- 1. A comment may be written in a page's name: comments.company_id.
--    Only a manager of that page (owner / content) may write, edit or delete it, the page
--    must be a managed page that isn't suspended, and its plan must include
--    'comments.as_company'. comments.sender still holds the member who typed it (as
--    posts.sender does for a page's posts), so the existing rules keep working.
-- 2. The bell knows about pages: notifications.actor_company_id (a page did this — the
--    member behind it is NOT named) and notifications.company_id (this is about your page).
-- 3. The seven existing notification triggers are replaced by page-aware versions:
--      * activity on a PAGE's post or comment goes to every content manager of the page,
--        not only to the member who happened to publish it;
--      * a comment or post made as a page is announced as the page;
--      * nobody is told about her own action, and a page's managers are not told about
--        what the page itself did.
--    For everything that involves no page the behaviour is unchanged.
-- 4. A page can be mentioned (data-company-id="…" in the text): its content managers get
--    PAGE_MENTION.
--
-- handle_new_comment / handle_new_like used to stop the comment or reaction itself when
-- the notification could not be written; now, like the newer triggers, they never do.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_voice.sql               Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS company_id integer REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_comments_company ON public.comments (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS actor_company_id integer REFERENCES public.companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS company_id       integer REFERENCES public.companies(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- 2. Who may write a comment in a page's name
-- ------------------------------------------------------------
-- The role is a row-level rule (added on top of the existing "your own comment" rules).
DROP POLICY IF EXISTS "A page comment is written by the page's managers" ON public.comments;
CREATE POLICY "A page comment is written by the page's managers" ON public.comments
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (company_id IS NULL OR public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "A page comment is edited by the page's managers" ON public.comments;
CREATE POLICY "A page comment is edited by the page's managers" ON public.comments
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (company_id IS NULL OR public.has_company_role(company_id, ARRAY['owner', 'content']))
  WITH CHECK (company_id IS NULL OR public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "A page comment is deleted by the page's managers" ON public.comments;
CREATE POLICY "A page comment is deleted by the page's managers" ON public.comments
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (company_id IS NULL OR public.has_company_role(company_id, ARRAY['owner', 'content']));

-- Any content manager of the page may edit or delete the page's comment, not only the one who typed it.
DROP POLICY IF EXISTS "Page managers edit the page's comments" ON public.comments;
CREATE POLICY "Page managers edit the page's comments" ON public.comments
  FOR UPDATE TO authenticated
  USING (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner', 'content']))
  WITH CHECK (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "Page managers delete the page's comments" ON public.comments;
CREATE POLICY "Page managers delete the page's comments" ON public.comments
  FOR DELETE TO authenticated
  USING (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner', 'content']));

-- The rest (the page's state, its plan, and that a comment never changes hands) is a trigger.
-- A session with no signed-in member (background jobs, the SQL editor) is not restricted.
CREATE OR REPLACE FUNCTION public.comments_company_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status  text;
  v_enabled boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       -- the one allowed change: the page itself was deleted (the foreign key clears the column)
       AND NOT (NEW.company_id IS NULL AND NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id)) THEN
      RAISE EXCEPTION 'A comment cannot move between a member and a page' USING ERRCODE = '42501';
    END IF;
    IF NEW.company_id IS NOT NULL AND (NEW.sender IS DISTINCT FROM OLD.sender OR NEW.post_id IS DISTINCT FROM OLD.post_id) THEN
      RAISE EXCEPTION 'A page comment keeps its writer and its post' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;

  SELECT page_status INTO v_status FROM companies WHERE id = NEW.company_id;
  IF v_status IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
  END IF;
  SELECT enabled INTO v_enabled FROM public.entitlement_value('company', NEW.company_id::text, 'comments.as_company');
  IF v_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'not_in_plan' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS comments_company_guard ON public.comments;
CREATE TRIGGER comments_company_guard
  BEFORE INSERT OR UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.comments_company_guard();

-- ------------------------------------------------------------
-- 3. Helpers for the notification triggers (used only inside them)
-- ------------------------------------------------------------
-- Who is told about activity on a post: a page's post → the page's content managers
-- (company_id says which page); a member's post → that member.
CREATE OR REPLACE FUNCTION public.post_notify_targets(p_post_id text)
RETURNS TABLE (user_id uuid, company_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.user_id, p.company_id
  FROM posts p
  JOIN company_admins a ON a.company_id = p.company_id AND a.role IN ('owner', 'content')
  WHERE p.id = p_post_id AND p.company_id IS NOT NULL
  UNION ALL
  -- a member's post, or a page's post whose page has no managers left: the member who published it
  SELECT u.uuid, NULL::integer
  FROM posts p
  JOIN users u ON u.email = p.sender
  WHERE p.id = p_post_id
    AND (p.company_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = p.company_id AND a.role IN ('owner', 'content')))
$$;
REVOKE ALL ON FUNCTION public.post_notify_targets(text) FROM PUBLIC, anon, authenticated;

-- The same for a comment.
CREATE OR REPLACE FUNCTION public.comment_notify_targets(p_comment_id bigint)
RETURNS TABLE (user_id uuid, company_id integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.user_id, c.company_id
  FROM comments c
  JOIN company_admins a ON a.company_id = c.company_id AND a.role IN ('owner', 'content')
  WHERE c.id = p_comment_id AND c.company_id IS NOT NULL
  UNION ALL
  SELECT u.uuid, NULL::integer
  FROM comments c
  JOIN users u ON u.email = c.sender
  WHERE c.id = p_comment_id
    AND (c.company_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.company_id AND a.role IN ('owner', 'content')))
$$;
REVOKE ALL ON FUNCTION public.comment_notify_targets(bigint) FROM PUBLIC, anon, authenticated;

-- Pages mentioned in a text: data-company-id="123".
CREATE OR REPLACE FUNCTION public.extract_company_mention_ids(p_text text)
RETURNS SETOF integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT DISTINCT m[1]::integer
  FROM regexp_matches(coalesce(p_text, ''), 'data-company-id="([0-9]{1,9})"', 'g') AS m
$$;

-- Likes and comments are counted on one unread line per member and post.
CREATE OR REPLACE FUNCTION public.notification_bump(
  p_user uuid, p_actor uuid, p_actor_company integer, p_target text, p_type text, p_company integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
BEGIN
  SELECT id INTO v_existing FROM notifications
  WHERE user_id = p_user AND target_id = p_target AND type = p_type AND is_read = FALSE
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE notifications
    SET count = count + 1, actor_id = p_actor, actor_company_id = p_actor_company, updated_at = now()
    WHERE id = v_existing;
  ELSE
    INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, company_id)
    VALUES (p_user, p_actor, p_actor_company, p_target, p_type, 1, p_company);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.notification_bump(uuid, uuid, integer, text, text, integer) FROM PUBLIC, anon, authenticated;

-- …and uncounted when the like or comment is taken back.
CREATE OR REPLACE FUNCTION public.notification_drop(p_user uuid, p_target text, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing uuid;
  v_count    integer;
BEGIN
  SELECT id, count INTO v_existing, v_count FROM notifications
  WHERE user_id = p_user AND target_id = p_target AND type = p_type
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing IS NULL THEN RETURN; END IF;
  IF v_count > 1 THEN
    UPDATE notifications SET count = count - 1 WHERE id = v_existing;
  ELSE
    DELETE FROM notifications WHERE id = v_existing;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.notification_drop(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. The notification triggers, page-aware
-- ------------------------------------------------------------
-- A new comment → whoever the post belongs to.
CREATE OR REPLACE FUNCTION public.handle_new_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  r record;
BEGIN
  BEGIN
    SELECT uuid INTO v_actor FROM users WHERE email = NEW.sender LIMIT 1;
    FOR r IN SELECT * FROM post_notify_targets(NEW.post_id::text) LOOP
      -- not about her own comment, and not to a page's managers about the page's own comment
      CONTINUE WHEN r.user_id = v_actor;
      CONTINUE WHEN NEW.company_id IS NOT NULL AND r.company_id = NEW.company_id;
      PERFORM notification_bump(r.user_id, CASE WHEN NEW.company_id IS NULL THEN v_actor END, NEW.company_id,
                                NEW.post_id::text, 'POST_COMMENT', r.company_id);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_comment: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_delete_comment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  r record;
BEGIN
  BEGIN
    SELECT uuid INTO v_actor FROM users WHERE email = OLD.sender LIMIT 1;
    FOR r IN SELECT * FROM post_notify_targets(OLD.post_id::text) LOOP
      CONTINUE WHEN r.user_id = v_actor;
      CONTINUE WHEN OLD.company_id IS NOT NULL AND r.company_id = OLD.company_id;
      PERFORM notification_drop(r.user_id, OLD.post_id::text, 'POST_COMMENT');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_delete_comment: %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;

-- A reaction to a post or an article → whoever it belongs to.
CREATE OR REPLACE FUNCTION public.handle_new_like()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  r record;
BEGIN
  BEGIN
    IF lower(NEW.target_type) = 'post' THEN
      FOR r IN SELECT * FROM post_notify_targets(NEW.target_id::text) LOOP
        CONTINUE WHEN r.user_id = NEW.user_id;
        PERFORM notification_bump(r.user_id, NEW.user_id, NULL, NEW.target_id::text, 'POST_LIKE', r.company_id);
      END LOOP;
    ELSIF lower(NEW.target_type) = 'article' THEN
      SELECT author_uuid INTO v_owner FROM articles WHERE id = NEW.target_id::uuid;
      IF v_owner IS NOT NULL AND v_owner <> NEW.user_id THEN
        PERFORM notification_bump(v_owner, NEW.user_id, NULL, NEW.target_id::text, 'ARTICLE_LIKE', NULL);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_like: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_unlike()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  r record;
BEGIN
  BEGIN
    IF lower(OLD.target_type) = 'post' THEN
      FOR r IN SELECT * FROM post_notify_targets(OLD.target_id::text) LOOP
        CONTINUE WHEN r.user_id = OLD.user_id;
        PERFORM notification_drop(r.user_id, OLD.target_id::text, 'POST_LIKE');
      END LOOP;
    ELSIF lower(OLD.target_type) = 'article' THEN
      SELECT author_uuid INTO v_owner FROM articles WHERE id = OLD.target_id::uuid;
      IF v_owner IS NOT NULL AND v_owner <> OLD.user_id THEN
        PERFORM notification_drop(v_owner, OLD.target_id::text, 'ARTICLE_LIKE');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_unlike: %', SQLERRM;
  END;
  RETURN OLD;
END;
$$;

-- A reaction to a comment → whoever the comment belongs to.
CREATE OR REPLACE FUNCTION public.notify_comment_reaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner  uuid;
  v_target text;
  r record;
BEGIN
  BEGIN
    IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.target_id ~ '^[0-9]+$' THEN
      -- post comments have numeric ids
      SELECT c.post_id INTO v_target FROM comments c WHERE c.id = NEW.target_id::bigint;
      IF v_target IS NOT NULL THEN
        FOR r IN SELECT * FROM comment_notify_targets(NEW.target_id::bigint) LOOP
          CONTINUE WHEN r.user_id = NEW.user_id;
          INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read, company_id)
          VALUES (r.user_id, NEW.user_id, v_target, 'COMMENT_REACTION', 1, false, r.company_id);
        END LOOP;
      END IF;
    ELSIF NEW.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      -- article comments have uuid ids
      SELECT ac.author_uuid, ac.article_id::text INTO v_owner, v_target
      FROM article_comments ac WHERE ac.id = NEW.target_id::uuid;
      IF v_owner IS NOT NULL AND v_owner <> NEW.user_id AND v_target IS NOT NULL THEN
        INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
        VALUES (v_owner, NEW.user_id, v_target, 'ARTICLE_COMMENT_REACTION', 1, false);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_comment_reaction: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- A reply → whoever the parent comment belongs to; mentions → the members and pages named.
CREATE OR REPLACE FUNCTION public.notify_comment_reply_and_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor      uuid;
  v_shown      uuid;             -- the member named as the one who did it (nobody, for a page comment)
  v_told       uuid[] := '{}';   -- already told by a REPLY: not also by a mention
  r record;
BEGIN
  BEGIN
    SELECT uuid INTO v_actor FROM users WHERE email = NEW.sender LIMIT 1;
    IF v_actor IS NULL THEN RETURN NEW; END IF;
    v_shown := CASE WHEN NEW.company_id IS NULL THEN v_actor END;

    IF NEW.parent_comment_id IS NOT NULL THEN
      FOR r IN SELECT * FROM comment_notify_targets(NEW.parent_comment_id) LOOP
        CONTINUE WHEN r.user_id = v_actor;
        CONTINUE WHEN NEW.company_id IS NOT NULL AND r.company_id = NEW.company_id;
        INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, is_read, company_id)
        VALUES (r.user_id, v_shown, NEW.company_id, NEW.post_id, 'REPLY', 1, false, r.company_id);
        v_told := v_told || r.user_id;
      END LOOP;
    END IF;

    INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, is_read)
    SELECT u.uuid, v_shown, NEW.company_id, NEW.post_id, 'MENTION', 1, false
    FROM extract_mention_ids(NEW.message) AS m(id)
    JOIN users u ON u.uuid = m.id
    WHERE u.uuid <> v_actor AND u.uuid <> ALL (v_told);

    INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, is_read, company_id)
    SELECT DISTINCT a.user_id, v_shown, NEW.company_id, NEW.post_id, 'PAGE_MENTION', 1, false, a.company_id
    FROM extract_company_mention_ids(NEW.message) AS m(id)
    JOIN companies co ON co.id = m.id AND co.page_status = 'claimed'
    JOIN company_admins a ON a.company_id = co.id AND a.role IN ('owner', 'content')
    WHERE a.user_id <> v_actor
      AND a.company_id IS DISTINCT FROM NEW.company_id
      AND a.user_id <> ALL (v_told);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_comment_reply_and_mentions: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- Mentions in a new post.
CREATE OR REPLACE FUNCTION public.notify_post_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shown uuid := CASE WHEN NEW.company_id IS NULL THEN NEW.posted_by_uuid END;
BEGIN
  BEGIN
    INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, is_read)
    SELECT u.uuid, v_shown, NEW.company_id, NEW.id, 'MENTION', 1, false
    FROM extract_mention_ids(NEW.message) AS m(id)
    JOIN users u ON u.uuid = m.id
    WHERE u.uuid <> NEW.posted_by_uuid;

    INSERT INTO notifications (user_id, actor_id, actor_company_id, target_id, type, count, is_read, company_id)
    SELECT DISTINCT a.user_id, v_shown, NEW.company_id, NEW.id, 'PAGE_MENTION', 1, false, a.company_id
    FROM extract_company_mention_ids(NEW.message) AS m(id)
    JOIN companies co ON co.id = m.id AND co.page_status = 'claimed'
    JOIN company_admins a ON a.company_id = co.id AND a.role IN ('owner', 'content')
    WHERE a.user_id IS DISTINCT FROM NEW.posted_by_uuid
      AND a.company_id IS DISTINCT FROM NEW.company_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_post_mentions: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid; v_owner_email text;
  v_b uuid; v_b_email text; v_c uuid; v_c_email text;
  v_managers bigint; v_n bigint;
  v_page_post text := 'voice-check-page-' || gen_random_uuid();
  v_b_post    text := 'voice-check-b-' || gen_random_uuid();
  v_comment bigint; v_page_comment bigint; v_like uuid;
BEGIN
  SELECT a.company_id, a.user_id, u.email INTO v_page, v_owner, v_owner_email
  FROM company_admins a JOIN companies co ON co.id = a.company_id JOIN users u ON u.uuid = a.user_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;

  SELECT uuid, email INTO v_b, v_b_email FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid, email INTO v_c, v_c_email FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_b
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  IF v_b IS NULL OR v_c IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need two members who manage no page'; END IF;

  BEGIN
    -- the setting: C becomes a content manager; the page has one post, B has one post
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_page, v_c, 'content');
    SELECT count(*) INTO v_managers FROM company_admins WHERE company_id = v_page AND role IN ('owner', 'content');
    INSERT INTO posts (id, sender, subject, message, company_id, posted_by_uuid) VALUES (v_page_post, v_owner_email, 'check', 'a page post', v_page, v_owner);
    INSERT INTO posts (id, sender, subject, message, posted_by_uuid) VALUES (v_b_post, v_b_email, 'check', 'a member post', v_b);
    DELETE FROM notifications WHERE target_id IN (v_page_post, v_b_post);

    -- 1. a member who doesn't manage the page cannot comment in its name
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated', 'email', v_b_email)::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO comments (post_id, sender, message, company_id) VALUES (v_b_post, v_b_email, 'as a page I do not manage', v_page);
      v_problems := v_problems || ' a member commented in the name of a page she does not manage;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 2. B comments on the page's post → every content manager is told, as "about your page"
    INSERT INTO comments (post_id, sender, message) VALUES (v_page_post, v_b_email, 'a member comment') RETURNING id INTO v_comment;
    RESET ROLE;
    SELECT count(*) INTO v_n FROM notifications WHERE target_id = v_page_post AND type = 'POST_COMMENT' AND actor_id = v_b AND company_id = v_page;
    IF v_n <> v_managers THEN v_problems := v_problems || format(' a comment on a page post told %s managers, expected %s;', v_n, v_managers); END IF;

    -- 3. B cannot hand her comment to the page afterwards
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE comments SET company_id = v_page WHERE id = v_comment;
      IF EXISTS (SELECT 1 FROM comments WHERE id = v_comment AND company_id IS NOT NULL) THEN
        v_problems := v_problems || ' a member turned her comment into a page comment;';
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 4. the owner comments as the page on B's post → B is told by the PAGE; the owner is not named
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'email', v_owner_email)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO comments (post_id, sender, message, company_id) VALUES (v_b_post, v_owner_email, 'the page comments', v_page) RETURNING id INTO v_page_comment;
    -- 5. …and on the page's own post → nobody is told
    INSERT INTO comments (post_id, sender, message, company_id) VALUES (v_page_post, v_owner_email, 'the page on its own post', v_page);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id = v_b AND target_id = v_b_post AND type = 'POST_COMMENT' AND actor_id IS NULL AND actor_company_id = v_page;
    IF v_n <> 1 THEN v_problems := v_problems || format(' a page comment produced %s notifications for the post''s writer, expected 1;', v_n); END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE target_id IN (v_b_post, v_page_post) AND actor_id = v_owner) THEN
      v_problems := v_problems || ' the member behind a page comment was named in a notification;';
    END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE target_id = v_page_post AND actor_company_id = v_page) THEN
      v_problems := v_problems || ' the page''s managers were told about the page''s own comment;';
    END IF;

    -- 6. the other content manager may edit the page's comment; B may not
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated', 'email', v_c_email)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE comments SET message = 'edited by another manager' WHERE id = v_page_comment;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM comments WHERE id = v_page_comment AND message = 'edited by another manager') THEN
      v_problems := v_problems || ' another content manager could not edit the page''s comment;';
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated', 'email', v_b_email)::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE comments SET message = 'edited by a stranger' WHERE id = v_page_comment;
    DELETE FROM comments WHERE id = v_page_comment;
    -- 7. B replies to the page's comment and mentions the page → the managers get REPLY, and not also a mention
    INSERT INTO comments (post_id, sender, message, parent_comment_id)
    VALUES (v_b_post, v_b_email, format('thanks <span data-company-id="%s">@page</span>', v_page), v_page_comment);
    -- 8. B mentions the page in a top-level comment → PAGE_MENTION
    INSERT INTO comments (post_id, sender, message) VALUES (v_b_post, v_b_email, format('see <span data-company-id="%s">@page</span>', v_page));
    -- 9. B reacts to the page's post and to the page's comment
    INSERT INTO likes (user_id, target_id, target_type, reaction_type) VALUES (v_b, v_page_post, 'post', 'like') RETURNING id INTO v_like;
    INSERT INTO likes (user_id, target_id, target_type, reaction_type) VALUES (v_b, v_page_comment::text, 'comment', 'like');
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM comments WHERE id = v_page_comment AND message = 'edited by another manager') THEN
      v_problems := v_problems || ' a member who does not manage the page changed or deleted its comment;';
    END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE target_id = v_b_post AND type = 'REPLY' AND actor_id = v_b AND company_id = v_page;
    IF v_n <> v_managers THEN v_problems := v_problems || format(' a reply to a page comment told %s managers, expected %s;', v_n, v_managers); END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE target_id = v_b_post AND type = 'PAGE_MENTION' AND actor_id = v_b AND company_id = v_page;
    IF v_n <> v_managers THEN v_problems := v_problems || format(' mentioning a page told %s managers, expected %s (one each, the reply not counted twice);', v_n, v_managers); END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE target_id = v_page_post AND type = 'POST_LIKE' AND actor_id = v_b AND company_id = v_page;
    IF v_n <> v_managers THEN v_problems := v_problems || format(' a reaction to a page post told %s managers, expected %s;', v_n, v_managers); END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE target_id = v_b_post AND type = 'COMMENT_REACTION' AND actor_id = v_b AND company_id = v_page;
    IF v_n <> v_managers THEN v_problems := v_problems || format(' a reaction to a page comment told %s managers, expected %s;', v_n, v_managers); END IF;

    -- 10. taking the reaction back removes the line
    DELETE FROM likes WHERE id = v_like;
    IF EXISTS (SELECT 1 FROM notifications WHERE target_id = v_page_post AND type = 'POST_LIKE') THEN
      v_problems := v_problems || ' taking a reaction back left its notification;';
    END IF;

    -- 11. between two members nothing changed: the owner (as herself) comments twice on B's post → one line, counted 2
    DELETE FROM notifications WHERE target_id = v_b_post;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'email', v_owner_email)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO comments (post_id, sender, message) VALUES (v_b_post, v_owner_email, 'as myself');
    INSERT INTO comments (post_id, sender, message) VALUES (v_b_post, v_owner_email, 'as myself again') RETURNING id INTO v_comment;
    RESET ROLE;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id = v_b AND target_id = v_b_post AND type = 'POST_COMMENT'
      AND actor_id = v_owner AND actor_company_id IS NULL AND company_id IS NULL AND count = 2;
    IF v_n <> 1 THEN v_problems := v_problems || ' two personal comments no longer make one notification counted 2;'; END IF;
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM comments WHERE id = v_comment;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_b AND target_id = v_b_post AND type = 'POST_COMMENT' AND count = 1) THEN
      v_problems := v_problems || ' deleting a comment no longer lowers the count;';
    END IF;

    -- 12. a suspended page cannot comment
    PERFORM set_config('duallin.system_page_edit', 'on', true);
    UPDATE companies SET page_status = 'suspended' WHERE id = v_page;
    PERFORM set_config('duallin.system_page_edit', 'off', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'email', v_owner_email)::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO comments (post_id, sender, message, company_id) VALUES (v_b_post, v_owner_email, 'from a suspended page', v_page);
      v_problems := v_problems || ' a suspended page commented;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM posts WHERE id IN (v_page_post, v_b_post)) THEN v_problems := v_problems || ' test posts were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: a page''s managers can comment in its name and are all told about activity on its posts and comments; the member behind a page comment is never named; nothing changed between members.';
END $$;

COMMIT;

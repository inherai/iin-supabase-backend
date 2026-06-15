-- ============================================================
-- STEP 1: Table + indexes
-- One row per post. effective_date = MAX(comment.created_at, post.sent_at).
-- Maintained by triggers below. Used by get_stabilized_feed and count_new_feed_activity.
-- ============================================================
CREATE TABLE IF NOT EXISTS feed_cache (
  post_id                text        PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  effective_date         timestamptz NOT NULL,
  sender                 text,
  post_type              text,
  community_members_only boolean     NOT NULL DEFAULT false,
  sent_at                timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_cache_effective_date
  ON feed_cache(effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_feed_cache_sender_effective_date
  ON feed_cache(sender, effective_date DESC);

-- ============================================================
-- STEP 2: Backfill — runs BEFORE triggers so no double-writes.
-- Uses MAX(comment.created_at) for effective_date (real-time, not session-bounded).
-- ============================================================
INSERT INTO feed_cache (post_id, effective_date, sender, post_type, community_members_only, sent_at)
SELECT
  p.id,
  COALESCE(
    (SELECT MAX(c.created_at) FROM comments c WHERE c.post_id = p.id),
    p.sent_at
  ) AS effective_date,
  p.sender,
  p.post_type,
  COALESCE(p.community_members_only, false),
  p.sent_at
FROM posts p
WHERE p.post_type IS NOT NULL
  AND p.post_type != 'email'
  AND p.sent_at   IS NOT NULL
ON CONFLICT (post_id) DO NOTHING;

-- ============================================================
-- STEP 3: Triggers
-- ============================================================

-- New post → insert into feed_cache
CREATE OR REPLACE FUNCTION feed_cache_on_post_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.post_type IS NOT NULL AND NEW.post_type != 'email' AND NEW.sent_at IS NOT NULL THEN
    INSERT INTO feed_cache(post_id, effective_date, sender, post_type, community_members_only, sent_at)
    VALUES (
      NEW.id,
      NEW.sent_at,
      NEW.sender,
      NEW.post_type,
      COALESCE(NEW.community_members_only, false),
      NEW.sent_at
    )
    ON CONFLICT (post_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feed_cache_post_insert ON posts;
CREATE TRIGGER trg_feed_cache_post_insert
AFTER INSERT ON posts FOR EACH ROW
EXECUTE FUNCTION feed_cache_on_post_insert();

-- Post UPDATE → keep community_members_only, post_type, sender in sync.
-- Critical: if author restricts visibility after publish, recruiters must stop seeing it immediately.
CREATE OR REPLACE FUNCTION feed_cache_on_post_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE feed_cache
  SET community_members_only = COALESCE(NEW.community_members_only, false),
      post_type              = NEW.post_type,
      sender                 = NEW.sender
  WHERE post_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feed_cache_post_update ON posts;
CREATE TRIGGER trg_feed_cache_post_update
AFTER UPDATE OF community_members_only, post_type, sender ON posts FOR EACH ROW
EXECUTE FUNCTION feed_cache_on_post_update();

-- New comment → bump post's effective_date (GREATEST prevents going backwards)
CREATE OR REPLACE FUNCTION feed_cache_on_comment_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE feed_cache
  SET effective_date = GREATEST(effective_date, NEW.created_at)
  WHERE post_id = NEW.post_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feed_cache_comment_insert ON comments;
CREATE TRIGGER trg_feed_cache_comment_insert
AFTER INSERT ON comments FOR EACH ROW
EXECUTE FUNCTION feed_cache_on_comment_insert();

-- Comment deleted → recompute from remaining comments; fallback to sent_at if none left
CREATE OR REPLACE FUNCTION feed_cache_on_comment_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE feed_cache
  SET effective_date = COALESCE(
    (SELECT MAX(created_at) FROM comments WHERE post_id = OLD.post_id),
    sent_at
  )
  WHERE post_id = OLD.post_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_feed_cache_comment_delete ON comments;
CREATE TRIGGER trg_feed_cache_comment_delete
AFTER DELETE ON comments FOR EACH ROW
EXECUTE FUNCTION feed_cache_on_comment_delete();

-- ============================================================
-- STEP 4: Replace get_stabilized_feed
DROP FUNCTION IF EXISTS get_stabilized_feed(timestamptz, timestamptz, text, integer, text);
--
-- Key changes vs old implementation:
-- • Reads from feed_cache (index scan) instead of full posts scan + HashAggregate
-- • Column effective_sort_date (exact name posts.ts reads at lines 595/630)
-- • Adds company_id, posted_by_uuid, linked_article_id (were missing → silently broken)
-- • p_session_start kept for API compatibility but unused (feed_cache is real-time)
-- ============================================================
CREATE OR REPLACE FUNCTION get_stabilized_feed(
  p_session_start       timestamptz,
  p_last_effective_date timestamptz DEFAULT NULL,
  p_last_id             text        DEFAULT NULL,
  p_limit               int         DEFAULT 25,
  p_filter_email        text        DEFAULT NULL
)
RETURNS TABLE (
  id                     text,
  sender                 text,
  subject                text,
  message                text,
  attachments            jsonb,
  sent_at                timestamptz,
  post_type              text,
  community_members_only boolean,
  effective_sort_date    timestamptz,
  is_saved               boolean,
  company_id             bigint,
  posted_by_uuid         uuid,
  linked_article_id      text
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.id::text,
    p.sender::text,
    p.subject::text,
    p.message::text,
    p.attachments::jsonb,
    p.sent_at::timestamptz,
    p.post_type::text,
    COALESCE(p.community_members_only, false)::boolean,
    fc.effective_date::timestamptz AS effective_sort_date,
    EXISTS (
      SELECT 1 FROM saved_resources sr
      WHERE sr.saved_resource_id  = p.id::text
        AND sr.user_id            = auth.uid()
        AND sr.saved_resource_type = 'post'
    )::boolean AS is_saved,
    p.company_id,
    p.posted_by_uuid,
    p.linked_article_id::text
  FROM feed_cache fc
  JOIN posts p ON p.id = fc.post_id
  WHERE
    (p_filter_email IS NULL OR fc.sender = p_filter_email)
    AND (
      p_last_effective_date IS NULL
      OR fc.effective_date < p_last_effective_date
      OR (fc.effective_date = p_last_effective_date AND fc.post_id < p_last_id)
    )
  ORDER BY fc.effective_date DESC, fc.post_id DESC
  LIMIT p_limit;
$$;

-- ============================================================
-- STEP 5: Replace count_new_feed_activity
--
-- Old: UNION of full posts scan + comments scan → O(n)
-- New: single index scan on feed_cache.effective_date → O(log n)
-- ============================================================
CREATE OR REPLACE FUNCTION count_new_feed_activity(
  p_since        timestamptz,
  p_user_email   text    DEFAULT NULL,
  p_is_recruiter boolean DEFAULT false
)
RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::integer
  FROM feed_cache fc
  WHERE fc.effective_date > p_since
    AND (p_user_email IS NULL OR fc.sender != p_user_email)
    AND (NOT p_is_recruiter OR fc.community_members_only IS NOT TRUE);
$$;

-- ============================================================
-- User Activity Tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS user_activity (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- כניסות ופעילות
  last_active_at            timestamptz,
  last_feed_visit_at        timestamptz,
  last_search_at            timestamptz,
  last_profile_update_at    timestamptz,
  total_feed_visits         int NOT NULL DEFAULT 0,
  total_feed_time_seconds   int NOT NULL DEFAULT 0,

  -- תוכן שיצרה
  last_post_at              timestamptz,
  last_comment_at           timestamptz,
  last_reaction_at          timestamptz,
  last_save_at              timestamptz,
  total_posts               int NOT NULL DEFAULT 0,
  total_comments            int NOT NULL DEFAULT 0,
  first_post_at             timestamptz,
  first_connection_at       timestamptz,

  -- engagement שקיבלה
  total_reactions_received  int NOT NULL DEFAULT 0,
  total_comments_received   int NOT NULL DEFAULT 0,
  total_profile_views       int NOT NULL DEFAULT 0,

  -- רשת
  total_connections         int NOT NULL DEFAULT 0,

  -- streak
  last_streak_date          date,
  current_streak_days       int NOT NULL DEFAULT 0,
  longest_streak_days       int NOT NULL DEFAULT 0,
  total_streak_breaks       int NOT NULL DEFAULT 0,

  -- onboarding
  profile_completeness_pct  smallint NOT NULL DEFAULT 0,
  onboarding_completed_at   timestamptz,

  -- invites
  total_invites_sent        int NOT NULL DEFAULT 0,
  successful_invites        int NOT NULL DEFAULT 0,

  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all" ON user_activity
  USING ((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true);

CREATE INDEX IF NOT EXISTS idx_user_activity_last_active
  ON user_activity (last_active_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_user_activity_streak
  ON user_activity (current_streak_days DESC);

-- ============================================================
-- RPC: record_feed_visit
-- קריאה אחת שמעדכנת timestamps, counter ביקורים, ו-streak
-- ============================================================
CREATE OR REPLACE FUNCTION record_feed_visit(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_last_streak_date  date;
  v_current_streak    int;
  v_new_streak        int;
  v_streak_break      int;
  v_today             date := CURRENT_DATE;
BEGIN
  SELECT last_streak_date, current_streak_days
  INTO v_last_streak_date, v_current_streak
  FROM user_activity
  WHERE user_id = p_user_id;

  -- חישוב streak חדש
  IF v_last_streak_date = v_today THEN
    v_new_streak   := COALESCE(v_current_streak, 1); -- כבר נספר היום
    v_streak_break := 0;
  ELSIF v_last_streak_date = v_today - 1 THEN
    v_new_streak   := COALESCE(v_current_streak, 0) + 1; -- רצף
    v_streak_break := 0;
  ELSE
    v_new_streak   := 1; -- איפוס
    v_streak_break := CASE WHEN COALESCE(v_current_streak, 0) > 0 THEN 1 ELSE 0 END;
  END IF;

  INSERT INTO user_activity (
    user_id, last_feed_visit_at, last_active_at, total_feed_visits,
    last_streak_date, current_streak_days, longest_streak_days,
    total_streak_breaks, updated_at
  )
  VALUES (
    p_user_id, now(), now(), 1,
    v_today, v_new_streak, v_new_streak,
    0, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    last_feed_visit_at  = now(),
    last_active_at      = now(),
    total_feed_visits   = user_activity.total_feed_visits + 1,
    last_streak_date    = v_today,
    current_streak_days = v_new_streak,
    longest_streak_days = GREATEST(user_activity.longest_streak_days, v_new_streak),
    total_streak_breaks = user_activity.total_streak_breaks + v_streak_break,
    updated_at          = now();

EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

-- ============================================================
-- RPC: add_feed_time — מוסיף שניות לזמן השהייה
-- ============================================================
CREATE OR REPLACE FUNCTION add_feed_time(p_user_id uuid, p_seconds int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO user_activity (user_id, total_feed_time_seconds, updated_at)
  VALUES (p_user_id, p_seconds, now())
  ON CONFLICT (user_id) DO UPDATE SET
    total_feed_time_seconds = user_activity.total_feed_time_seconds + p_seconds,
    updated_at = now();
EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

-- ============================================================
-- טריגר: posts → total_posts, last_post_at, first_post_at
-- ============================================================
CREATE OR REPLACE FUNCTION trg_user_activity_on_post()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO user_activity (
    user_id, total_posts, last_post_at, first_post_at, last_active_at, updated_at
  )
  VALUES (
    NEW.posted_by_uuid, 1, now(), now(), now(), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    total_posts    = user_activity.total_posts + 1,
    last_post_at   = now(),
    first_post_at  = COALESCE(user_activity.first_post_at, now()),
    last_active_at = now(),
    updated_at     = now();
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$$;

CREATE TRIGGER trg_post_inserted
  AFTER INSERT ON posts
  FOR EACH ROW
  WHEN (NEW.posted_by_uuid IS NOT NULL)
  EXECUTE FUNCTION trg_user_activity_on_post();

-- ============================================================
-- טריגר: comments → total_comments (מגיב) + total_comments_received (כותב הפוסט)
-- ============================================================
CREATE OR REPLACE FUNCTION trg_user_activity_on_comment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_post_author uuid;
BEGIN
  -- עדכון המגיב
  INSERT INTO user_activity (
    user_id, total_comments, last_comment_at, last_active_at, updated_at
  )
  VALUES (NEW.posted_by_uuid, 1, now(), now(), now())
  ON CONFLICT (user_id) DO UPDATE SET
    total_comments = user_activity.total_comments + 1,
    last_comment_at = now(),
    last_active_at  = now(),
    updated_at      = now();

  -- עדכון כותב הפוסט
  SELECT posted_by_uuid INTO v_post_author
  FROM posts WHERE id = NEW.post_id LIMIT 1;

  IF v_post_author IS NOT NULL AND v_post_author <> NEW.posted_by_uuid THEN
    INSERT INTO user_activity (user_id, total_comments_received, updated_at)
    VALUES (v_post_author, 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
      total_comments_received = user_activity.total_comments_received + 1,
      updated_at = now();
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$$;

CREATE TRIGGER trg_comment_inserted
  AFTER INSERT ON comments
  FOR EACH ROW
  WHEN (NEW.posted_by_uuid IS NOT NULL)
  EXECUTE FUNCTION trg_user_activity_on_comment();

-- ============================================================
-- טריגר: likes → last_reaction_at (מגיב) + total_reactions_received (כותב הפוסט)
-- ============================================================
CREATE OR REPLACE FUNCTION trg_user_activity_on_like()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_post_author uuid;
BEGIN
  -- עדכון המגיב
  INSERT INTO user_activity (user_id, last_reaction_at, last_active_at, updated_at)
  VALUES (NEW.user_id, now(), now(), now())
  ON CONFLICT (user_id) DO UPDATE SET
    last_reaction_at = now(),
    last_active_at   = now(),
    updated_at       = now();

  -- נסה לזהות את כותב הפוסט (target_id יכול להיות post UUID)
  BEGIN
    SELECT posted_by_uuid INTO v_post_author
    FROM posts WHERE id = NEW.target_id::uuid LIMIT 1;
  EXCEPTION WHEN invalid_text_representation THEN
    v_post_author := NULL;
  END;

  IF v_post_author IS NOT NULL AND v_post_author <> NEW.user_id THEN
    INSERT INTO user_activity (user_id, total_reactions_received, updated_at)
    VALUES (v_post_author, 1, now())
    ON CONFLICT (user_id) DO UPDATE SET
      total_reactions_received = user_activity.total_reactions_received + 1,
      updated_at = now();
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$$;

CREATE TRIGGER trg_like_inserted
  AFTER INSERT ON likes
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL)
  EXECUTE FUNCTION trg_user_activity_on_like();

-- ============================================================
-- טריגר: connections accepted → total_connections, first_connection_at
-- ============================================================
CREATE OR REPLACE FUNCTION trg_user_activity_on_connection()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF NEW.status = 'accepted' AND (OLD.status IS DISTINCT FROM 'accepted') THEN
    -- requester
    INSERT INTO user_activity (
      user_id, total_connections, first_connection_at, last_active_at, updated_at
    )
    VALUES (NEW.requester_id, 1, now(), now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      total_connections    = user_activity.total_connections + 1,
      first_connection_at  = COALESCE(user_activity.first_connection_at, now()),
      last_active_at       = now(),
      updated_at           = now();

    -- receiver
    INSERT INTO user_activity (
      user_id, total_connections, first_connection_at, last_active_at, updated_at
    )
    VALUES (NEW.receiver_id, 1, now(), now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      total_connections    = user_activity.total_connections + 1,
      first_connection_at  = COALESCE(user_activity.first_connection_at, now()),
      last_active_at       = now(),
      updated_at           = now();
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$$;

CREATE TRIGGER trg_connection_accepted
  AFTER UPDATE ON connections
  FOR EACH ROW
  EXECUTE FUNCTION trg_user_activity_on_connection();

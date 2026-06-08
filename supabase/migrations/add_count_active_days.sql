CREATE OR REPLACE FUNCTION count_active_days(
  p_user_id    UUID,
  p_user_email TEXT,
  p_since      TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT DATE(ts AT TIME ZONE 'UTC'))::INTEGER
  FROM (
    SELECT p.sent_at AS ts FROM posts p
      WHERE p.posted_by_uuid = p_user_id
        AND p.sent_at >= p_since
        AND p.post_type IS NOT NULL
        AND p.post_type != 'email'
    UNION ALL
    SELECT c.created_at AS ts FROM comments c
      JOIN posts p ON p.id = c.post_id
      WHERE c.sender = p_user_email
        AND c.created_at >= p_since
        AND p.post_type IS NOT NULL
        AND p.post_type != 'email'
    UNION ALL
    SELECT created_at AS ts FROM likes
      WHERE user_id = p_user_id AND created_at >= p_since
    UNION ALL
    SELECT created_at AS ts FROM connections
      WHERE (requester_id = p_user_id OR receiver_id = p_user_id)
        AND status = 'accepted'
        AND created_at >= p_since
  ) t
$$;

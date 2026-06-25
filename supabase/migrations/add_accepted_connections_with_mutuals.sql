-- Helper: accepted connection ids (the "other side") for a given user.
-- SQL (not plpgsql) + STABLE so the planner can inline it and use the
-- existing idx_connections_requester / idx_connections_receiver indexes.
CREATE OR REPLACE FUNCTION get_accepted_connection_ids(p_user_id UUID)
RETURNS TABLE (other_id UUID)
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN requester_id = p_user_id THEN receiver_id ELSE requester_id END
  FROM connections
  WHERE status = 'accepted' AND (requester_id = p_user_id OR receiver_id = p_user_id);
$$;

-- RPC: get_accepted_connections
-- Replaces both the plain PostgREST query and search_accepted_connections.
-- Returns the accepted connections of p_user_id (optionally filtered by the
-- other party's name), each row enriched with a real mutual_connections_count
-- (size of the intersection of both users' accepted-connection sets), plus a
-- windowed total count for pagination.
CREATE OR REPLACE FUNCTION get_accepted_connections(
  p_user_id UUID,
  p_search  TEXT DEFAULT NULL,
  p_limit   INT  DEFAULT 20,
  p_offset  INT  DEFAULT 0
)
RETURNS TABLE (
  id                       UUID,
  requester_id             UUID,
  receiver_id              UUID,
  status                   TEXT,
  created_at               TIMESTAMPTZ,
  requester                JSONB,
  receiver                 JSONB,
  mutual_connections_count BIGINT,
  count                    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- Computed exactly once per call (not once per row) — this is the set
  -- every row's mutual_connections_count gets intersected against.
  v_my_connections UUID[];
BEGIN
  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_my_connections
  FROM get_accepted_connection_ids(p_user_id);

  RETURN QUERY
  SELECT
    c.id,
    c.requester_id,
    c.receiver_id,
    c.status::TEXT,
    c.created_at,
    jsonb_build_object(
      'uuid',       req.uuid,
      'first_name', req.first_name,
      'last_name',  req.last_name,
      'image',      req.image,
      'headline',   req.headline,
      'role',       req.role
    ) AS requester,
    jsonb_build_object(
      'uuid',       rec.uuid,
      'first_name', rec.first_name,
      'last_name',  rec.last_name,
      'image',      rec.image,
      'headline',   rec.headline,
      'role',       rec.role
    ) AS receiver,
    (
      SELECT COUNT(*)
      FROM get_accepted_connection_ids(
        CASE WHEN c.requester_id = p_user_id THEN c.receiver_id ELSE c.requester_id END
      ) theirs
      WHERE theirs.other_id = ANY(v_my_connections)
    ) AS mutual_connections_count,
    COUNT(*) OVER() AS count
  FROM connections c
  JOIN public_users_view req ON req.uuid = c.requester_id
  JOIN public_users_view rec ON rec.uuid = c.receiver_id
  WHERE
    c.status = 'accepted'
    AND (c.requester_id = p_user_id OR c.receiver_id = p_user_id)
    AND (
      p_search IS NULL OR p_search = '' OR (
        (c.requester_id = p_user_id AND (
          rec.first_name ILIKE '%' || p_search || '%'
          OR rec.last_name  ILIKE '%' || p_search || '%'
          OR CONCAT(COALESCE(rec.first_name, ''), ' ', COALESCE(rec.last_name, ''))
               ILIKE '%' || p_search || '%'
        ))
        OR
        (c.receiver_id = p_user_id AND (
          req.first_name ILIKE '%' || p_search || '%'
          OR req.last_name  ILIKE '%' || p_search || '%'
          OR CONCAT(COALESCE(req.first_name, ''), ' ', COALESCE(req.last_name, ''))
               ILIKE '%' || p_search || '%'
        ))
      )
    )
  ORDER BY c.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

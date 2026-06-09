-- RPC: search_accepted_connections
-- Searches the accepted connections of a given user by the other party's
-- first name, last name, or full name (case-insensitive).
-- Returns connection rows in the same shape as the connections table select
-- (with nested requester/receiver JSONB) plus a windowed count for pagination.

CREATE OR REPLACE FUNCTION search_accepted_connections(
  p_user_id UUID,
  p_search   TEXT,
  p_limit    INT  DEFAULT 20,
  p_offset   INT  DEFAULT 0
)
RETURNS TABLE (
  id           UUID,
  requester_id UUID,
  receiver_id  UUID,
  status       TEXT,
  created_at   TIMESTAMPTZ,
  requester    JSONB,
  receiver     JSONB,
  count        BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.requester_id,
    c.receiver_id,
    c.status::TEXT,
    c.created_at,
    jsonb_build_object(
      'uuid',      req.uuid,
      'first_name', req.first_name,
      'last_name',  req.last_name,
      'image',      req.image,
      'headline',   req.headline,
      'role',       req.role
    ) AS requester,
    jsonb_build_object(
      'uuid',      rec.uuid,
      'first_name', rec.first_name,
      'last_name',  rec.last_name,
      'image',      rec.image,
      'headline',   rec.headline,
      'role',       rec.role
    ) AS receiver,
    COUNT(*) OVER() AS count
  FROM connections c
  JOIN public_users_view req ON req.uuid = c.requester_id
  JOIN public_users_view rec ON rec.uuid = c.receiver_id
  WHERE
    c.status = 'accepted'
    AND (c.requester_id = p_user_id OR c.receiver_id = p_user_id)
    AND (
      -- current user is requester → filter on receiver's name
      (c.requester_id = p_user_id AND (
        rec.first_name ILIKE '%' || p_search || '%'
        OR rec.last_name  ILIKE '%' || p_search || '%'
        OR CONCAT(COALESCE(rec.first_name, ''), ' ', COALESCE(rec.last_name, ''))
             ILIKE '%' || p_search || '%'
      ))
      OR
      -- current user is receiver → filter on requester's name
      (c.receiver_id = p_user_id AND (
        req.first_name ILIKE '%' || p_search || '%'
        OR req.last_name  ILIKE '%' || p_search || '%'
        OR CONCAT(COALESCE(req.first_name, ''), ' ', COALESCE(req.last_name, ''))
             ILIKE '%' || p_search || '%'
      ))
    )
  ORDER BY c.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- RPC: get_mutual_connections
-- Returns the intersection of p_viewer_id's and p_target_id's accepted
-- connections (people both of them are connected to), for the "Daniel,
-- Barak and 586 other mutual connections" row on a public profile's Hero.
CREATE OR REPLACE FUNCTION get_mutual_connections(
  p_viewer_id UUID,
  p_target_id UUID,
  p_limit     INT DEFAULT 3
)
RETURNS TABLE (
  uuid       UUID,
  first_name TEXT,
  last_name  TEXT,
  image      TEXT,
  headline   TEXT,
  role       TEXT,
  count      BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_viewer_connections UUID[];
BEGIN
  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_viewer_connections
  FROM get_accepted_connection_ids(p_viewer_id);

  RETURN QUERY
  SELECT
    u.uuid, u.first_name, u.last_name, u.image, u.headline, u.role::TEXT,
    COUNT(*) OVER() AS count
  FROM get_accepted_connection_ids(p_target_id) tc
  JOIN public_users_view u ON u.uuid = tc.other_id
  WHERE tc.other_id = ANY(v_viewer_connections)
  ORDER BY u.first_name ASC
  LIMIT p_limit;
END;
$$;

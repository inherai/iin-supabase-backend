-- "People you may know" relative to a specific profile (LinkedIn's "people similar
-- to X"). The candidate pool (second-degree connections of the target, ranked by
-- shared-connection count) depends only on the TARGET's network, not the viewer —
-- so it's cached per target_id instead of being recomputed on every page view.
-- Viewer-specific exclusions (self, already connected, pending request) are NOT
-- cached — they're applied fresh on every read against the small cached set, so
-- "don't suggest someone we're already connected with" is always correct even
-- though the underlying candidate pool is stale by up to a day.
CREATE TABLE IF NOT EXISTS profile_suggestion_cache (
  target_id                UUID NOT NULL,
  candidate_id              UUID NOT NULL,
  mutual_with_target_count  INT NOT NULL,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_suggestion_cache_target
  ON profile_suggestion_cache (target_id, mutual_with_target_count DESC);

-- Recomputes the cached candidate pool for one target. This is the expensive part
-- (walks every connection of every one of the target's connections) — it only runs
-- on a cache miss/staleness, not on every profile view.
CREATE OR REPLACE FUNCTION refresh_profile_suggestions_cache(
  p_target_id  UUID,
  p_cache_size INT DEFAULT 30
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_target_connections UUID[];
BEGIN
  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_target_connections
  FROM get_accepted_connection_ids(p_target_id);

  CREATE TEMP TABLE _new_suggestion_candidates ON COMMIT DROP AS
  SELECT gc.other_id AS candidate_id, COUNT(*) AS mutual_with_target_count
  FROM unnest(v_target_connections) AS tn(other_id)
  CROSS JOIN LATERAL get_accepted_connection_ids(tn.other_id) AS gc
  WHERE gc.other_id <> p_target_id
    AND gc.other_id <> ALL(v_target_connections)
  GROUP BY gc.other_id
  ORDER BY COUNT(*) DESC
  LIMIT p_cache_size;

  -- Drop rows that fell out of the top p_cache_size since the last refresh.
  DELETE FROM profile_suggestion_cache psc
  WHERE psc.target_id = p_target_id
    AND NOT EXISTS (
      SELECT 1 FROM _new_suggestion_candidates nc WHERE nc.candidate_id = psc.candidate_id
    );

  -- Upsert (not delete-then-insert) so a concurrent reader never sees an empty
  -- window for this target, and two concurrent refreshes can't unique-violate.
  INSERT INTO profile_suggestion_cache (target_id, candidate_id, mutual_with_target_count, computed_at)
  SELECT p_target_id, nc.candidate_id, nc.mutual_with_target_count, now()
  FROM _new_suggestion_candidates nc
  ON CONFLICT (target_id, candidate_id) DO UPDATE
    SET mutual_with_target_count = EXCLUDED.mutual_with_target_count,
        computed_at              = EXCLUDED.computed_at;
END;
$$;

-- RPC: get_suggested_users_for_profile
-- Reads the (lazily refreshed) cache for p_target_id, then filters out the viewer
-- themselves, anyone already directly connected to the viewer, and anyone the
-- viewer has a pending request with — all computed live, every call, against the
-- small cached set (≤ p_cache_size rows), not the full connection graph.
CREATE OR REPLACE FUNCTION get_suggested_users_for_profile(
  p_viewer_id UUID,
  p_target_id UUID,
  p_limit     INT DEFAULT 10,
  p_offset    INT DEFAULT 0
)
RETURNS TABLE (
  uuid                     UUID,
  first_name               TEXT,
  last_name                TEXT,
  image                    TEXT,
  headline                 TEXT,
  role                     TEXT,
  mutual_with_target_count INT,
  count                    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cache_age          INTERVAL;
  v_viewer_connections UUID[];
BEGIN
  SELECT now() - MIN(computed_at) INTO v_cache_age
  FROM profile_suggestion_cache
  WHERE target_id = p_target_id;

  IF v_cache_age IS NULL OR v_cache_age > INTERVAL '24 hours' THEN
    PERFORM refresh_profile_suggestions_cache(p_target_id);
  END IF;

  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_viewer_connections
  FROM get_accepted_connection_ids(p_viewer_id);

  RETURN QUERY
  SELECT
    u.uuid, u.first_name, u.last_name, u.image, u.headline, u.role::TEXT,
    psc.mutual_with_target_count,
    COUNT(*) OVER() AS count
  FROM profile_suggestion_cache psc
  JOIN public_users_view u ON u.uuid = psc.candidate_id
  WHERE psc.target_id = p_target_id
    AND psc.candidate_id <> p_viewer_id
    AND psc.candidate_id <> ALL(v_viewer_connections)
    AND NOT EXISTS (
      SELECT 1 FROM connections c
      WHERE c.status = 'pending'
        AND ((c.requester_id = p_viewer_id AND c.receiver_id = psc.candidate_id)
          OR (c.receiver_id = p_viewer_id AND c.requester_id = psc.candidate_id))
    )
  ORDER BY psc.mutual_with_target_count DESC, u.first_name ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

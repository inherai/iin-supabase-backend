-- Inner-circle suggestions: rank people with a visible profile photo higher.
--
-- Body reproduced from the live definition (pg_get_functiondef, 2026-11-02);
-- the only behavioral change is the ORDER BY. Before this file match_users
-- existed only in the DB.
--
-- The boost is a bonus on top of similarity, not an absolute tier: a much
-- stronger match without a photo still outranks a weak one with a photo.
-- The returned similarity stays the raw score.
--
-- "Has photo" means a photo THIS viewer may see, so a user who hid her picture
-- isn't surfaced higher (which would both leak that a photo exists and promote
-- an initials-only card):
--   * u.image comes from public_users_view, already masked per viewer (auth.uid()).
--   * u.privacy_picture IS NOT NULL matches the API's fail-closed rule
--     (privacyArrayAllows in functions/api/routes/profile.ts): the view treats a
--     NULL privacy_picture as visible, the API does not render it.

CREATE OR REPLACE FUNCTION public.match_users(
  p_user_id uuid,
  p_threshold double precision DEFAULT 0.3,
  p_match_count integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(user_id uuid, similarity double precision, total_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  query_vector vector;
  -- Tuned to the live spread (2026-11-02: min 0.62, median 0.65, max 0.77):
  -- enough to lift photos within the dense middle, not past the clear top matches.
  photo_boost CONSTANT double precision := 0.03;
BEGIN
  -- שליפת הוקטור של המשתמש
  SELECT vector INTO query_vector
  FROM public.users_vectors
  WHERE public.users_vectors.user_id = p_user_id;

  IF query_vector IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    uv.user_id,
    (1 - (uv.vector <=> query_vector))::FLOAT AS similarity,
    COUNT(*) OVER() AS total_count
  FROM public.users_vectors uv
  JOIN public.public_users_view u ON u.uuid = uv.user_id
  WHERE uv.user_id != p_user_id
    AND u.status = 'Active'
    AND coalesce(u.is_anonymous, false) = false -- מוודאים שמי שאנונימי לא מומלץ לאף אחד
    AND (1 - (uv.vector <=> query_vector)) > p_threshold
    AND NOT EXISTS (
      SELECT 1 FROM public.connections c
      WHERE (c.requester_id = p_user_id AND c.receiver_id = uv.user_id)
         OR (c.requester_id = uv.user_id AND c.receiver_id = p_user_id)
    )
  ORDER BY
    (1 - (uv.vector <=> query_vector))
      + CASE WHEN u.image IS NOT NULL AND u.privacy_picture IS NOT NULL THEN photo_boost ELSE 0 END
      DESC,
    uv.user_id -- stable tie-break so pages don't overlap
  LIMIT p_match_count
  OFFSET p_offset;
END;
$function$;

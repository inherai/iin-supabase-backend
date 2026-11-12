-- ============================================================
-- UNDO secure_saved_resources_safe.sql: puts get_saved_resources_with_content() back exactly as
-- it was in production on 2026-11-12 (definition and rights copied from the live database
-- before the change). Note: this brings the problem back — any member could read another
-- member's saved items again.
-- ============================================================
BEGIN;
CREATE OR REPLACE FUNCTION public.get_saved_resources_with_content(p_user_id uuid, p_type text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, saved_resource_type text, saved_resource_id text, created_at timestamp with time zone, resource jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    sr.id,
    sr.saved_resource_type::text, -- המרה לטקסט כאן
    sr.saved_resource_id::text,
    sr.created_at,
    CASE 
      WHEN sr.saved_resource_type::text = 'post' THEN -- המרה לטקסט כאן
        (SELECT to_jsonb(p.*) FROM public.posts p WHERE p.id::text = sr.saved_resource_id)
      WHEN sr.saved_resource_type::text = 'position' THEN -- המרה לטקסט כאן
        (SELECT to_jsonb(pos.*) FROM public.open_position pos WHERE pos.job_id = sr.saved_resource_id)
      ELSE NULL
    END as resource
  FROM public.saved_resources sr
  WHERE sr.user_id = p_user_id
    -- כאן הייתה השגיאה! המרנו את ה-Enum לטקסט כדי להשוות ל-p_type
    AND (p_type IS NULL OR sr.saved_resource_type::text = p_type)
  ORDER BY sr.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_saved_resources_with_content(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_saved_resources_with_content(uuid, text, integer, integer) TO authenticated, service_role;
COMMIT;

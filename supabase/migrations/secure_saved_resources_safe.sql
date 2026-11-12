-- ============================================================
-- Saved items: a member reads only her own — SELF-CHECKING (2026-11-12). Run in the SQL Editor.
--
-- The problem (found 2026-11-12): get_saved_resources_with_content(p_user_id, ...) runs with the
-- owner's rights and any signed-in member may call it directly (/rest/v1/rpc/...), with ANY
-- member's id. That showed her another member's saved posts and jobs — including the content of
-- posts meant for community members only, and, for a post published in a company's name, the
-- person who actually wrote it (posted_by_uuid), which only that page's managers may know.
--
-- The fix (same name, same parameters, same answer for the API, which always passes the
-- signed-in member's own id):
--   * a member gets saved items only for her own id; any other id returns nothing
--     (the service role — background work, no signed-in member — still reads any)
--   * a post never carries posted_by_uuid here
--   * search_path is pinned, as for every function that runs with the owner's rights
-- Nothing else changes.
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing
-- changes. To go back: rollback_secure_saved_resources.sql                     Safe to re-run.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.get_saved_resources_with_content(p_user_id uuid, p_type text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, saved_resource_type text, saved_resource_id text, created_at timestamp with time zone, resource jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
  -- only her own saved items
  IF p_user_id IS DISTINCT FROM auth.uid() AND coalesce(auth.role(), '') <> 'service_role' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    sr.id,
    sr.saved_resource_type::text,
    sr.saved_resource_id::text,
    sr.created_at,
    CASE
      WHEN sr.saved_resource_type::text = 'post' THEN
        -- who stands behind a company's post is for that page's managers only
        (SELECT to_jsonb(p.*) - 'posted_by_uuid' FROM public.posts p WHERE p.id::text = sr.saved_resource_id)
      WHEN sr.saved_resource_type::text = 'position' THEN
        (SELECT to_jsonb(pos.*) FROM public.open_position pos WHERE pos.job_id = sr.saved_resource_id)
      ELSE NULL
    END AS resource
  FROM public.saved_resources sr
  WHERE sr.user_id = p_user_id
    AND (p_type IS NULL OR sr.saved_resource_type::text = p_type)
  ORDER BY sr.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_saved_resources_with_content(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_saved_resources_with_content(uuid, text, integer, integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole change)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_a uuid; v_b uuid; v_post text; v_job text; v_n bigint; v_json jsonb;
BEGIN
  SELECT uuid INTO v_a FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_a ORDER BY uuid LIMIT 1;
  SELECT id::text INTO v_post FROM posts ORDER BY sent_at DESC NULLS LAST LIMIT 1;
  SELECT job_id INTO v_job FROM open_position ORDER BY id DESC LIMIT 1;
  IF v_b IS NULL OR v_post IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need two members and a post';
  END IF;

  BEGIN
    -- B saves a post (and a job, when there is one)
    INSERT INTO saved_resources (user_id, saved_resource_type, saved_resource_id) VALUES (v_b, 'post', v_post);
    IF v_job IS NOT NULL THEN
      INSERT INTO saved_resources (user_id, saved_resource_type, saved_resource_id) VALUES (v_b, 'position', v_job);
    END IF;

    -- 1. A asks for B's saved items: nothing
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_saved_resources_with_content(v_b, NULL, 100, 0);
    IF v_n <> 0 THEN v_problems := v_problems || format(' a member read %s of another member''s saved items;', v_n); END IF;
    RESET ROLE;

    -- 2. B asks for her own: all of them, and the post carries no posted_by_uuid
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_saved_resources_with_content(v_b, NULL, 100, 0);
    IF v_n < 1 + (v_job IS NOT NULL)::int THEN v_problems := v_problems || ' a member no longer gets her own saved items;'; END IF;
    SELECT resource INTO v_json FROM public.get_saved_resources_with_content(v_b, 'post', 100, 0) WHERE saved_resource_id = v_post;
    IF v_json IS NULL THEN v_problems := v_problems || ' her saved post came back without its content;'; END IF;
    IF v_json ? 'posted_by_uuid' THEN v_problems := v_problems || ' a saved post still carries posted_by_uuid;'; END IF;
    SELECT count(*) INTO v_n FROM public.get_saved_resources_with_content(v_b, 'position', 100, 0);
    IF v_job IS NOT NULL AND v_n < 1 THEN v_problems := v_problems || ' her saved job is missing (the type filter broke);'; END IF;
    RESET ROLE;

    -- 3. signed-out visitors cannot call it at all
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM public.get_saved_resources_with_content(v_b, NULL, 1, 0);
      v_problems := v_problems || ' signed-out visitors can call it;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 4. the service role (no member) still reads any member's
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    SELECT count(*) INTO v_n FROM public.get_saved_resources_with_content(v_b, NULL, 100, 0);
    IF v_n < 1 THEN v_problems := v_problems || ' the service role can no longer read saved items;'; END IF;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- the test rows above are undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: a member reads only her own saved items, without posted_by_uuid; signed-out visitors are refused.';
END $$;

COMMIT;

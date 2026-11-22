-- ============================================================
-- Held invitations: the member's phone on the admin list, to contact her.
-- Run in the SQL Editor after add_held_invites_queue_safe.sql. No API change needed (the route
-- passes the rows through). Undo: rollback_add_held_invites_phone.sql
-- ============================================================
BEGIN;

-- The returned columns change, so the two functions are dropped and created again.
DROP FUNCTION IF EXISTS public.admin_held_invites(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.held_invites_rows();

CREATE OR REPLACE FUNCTION public.held_invites_rows()
RETURNS TABLE (invite_id text, email text, inviter_display_name text, invited_at timestamptz,
               email_sent_at timestamptz, expires_at timestamptz, email_opened_at timestamptz,
               link_opened_at timestamptz, user_id uuid, first_name text, last_name text,
               headline text, phone text, joined_at timestamptz, stage text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH opens AS (
    SELECT l.ref_key, max(l.opened_at) AS opened_at
    FROM email_log l WHERE l.kind = 'held_invite' AND l.opened_at IS NOT NULL
    GROUP BY l.ref_key
  )
  SELECT i.id::text, i.recipient_email::text, i.inviter_display_name, i.created_at,
         i.email_sent_at, i.expires_at, o.opened_at, i.last_viewed_at,
         u.uuid, u.first_name::text, u.last_name::text, u.headline::text, nullif(trim(u.phone::text), ''), u.created_at,
         CASE
           WHEN u.status = 'pending_review'  THEN 'waiting'
           WHEN u.status = 'onboarding'      THEN 'onboarding'
           WHEN u.uuid IS NOT NULL           THEN 'approved'
           WHEN i.send_skipped IS NOT NULL   THEN 'not_sent'
           WHEN i.email_sent_at IS NULL      THEN 'queued'
           WHEN i.status = 'expired' OR i.expires_at <= now() THEN 'expired'
           WHEN i.last_viewed_at IS NOT NULL THEN 'link_opened'
           WHEN o.opened_at IS NOT NULL      THEN 'email_opened'
           ELSE 'sent'
         END
  FROM invites i
  LEFT JOIN users u ON lower(u.email) = lower(i.recipient_email)
  LEFT JOIN opens o ON o.ref_key = i.id::text
  WHERE i.hold_for_review
$$;

CREATE OR REPLACE FUNCTION public.admin_held_invites(
  p_stage text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (invite_id text, email text, inviter_display_name text, invited_at timestamptz,
               email_sent_at timestamptz, expires_at timestamptz, email_opened_at timestamptz,
               link_opened_at timestamptz, user_id uuid, first_name text, last_name text,
               headline text, phone text, joined_at timestamptz, stage text, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT r.*, count(*) OVER ()
  FROM held_invites_rows() r
  WHERE (p_stage IS NULL OR r.stage = p_stage)
    AND (coalesce(p_search, '') = '' OR r.email ILIKE '%' || p_search || '%'
         OR (coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) ILIKE '%' || p_search || '%')
  -- the newest step first: whoever is waiting or just joined is on top
  ORDER BY coalesce(r.joined_at, r.link_opened_at, r.email_sent_at, r.invited_at) DESC, r.email
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500)) OFFSET greatest(0, coalesce(p_offset, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.held_invites_rows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_held_invites(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_held_invites(text, text, integer, integer) TO authenticated;

DO $$
DECLARE v_problems text := '';
BEGIN
  IF has_function_privilege('authenticated', 'public.held_invites_rows()', 'EXECUTE') THEN
    v_problems := v_problems || ' members can run held_invites_rows;';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_held_invites(text, text, integer, integer)', 'EXECUTE') THEN
    v_problems := v_problems || ' admins cannot run admin_held_invites;';
  END IF;
  BEGIN
    PERFORM r.phone, r.stage FROM held_invites_rows() r LIMIT 1;
  EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' the list does not run: ' || SQLERRM || ';';
  END;
  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: the held invitations list now has the phone.';
END $$;

COMMIT;

-- ============================================================
-- Held invitations, part 2: big imports and tracking — SELF-CHECKING (2026-11-18). Run in the SQL Editor.
-- Needs add_held_invites_safe.sql.
--
-- What it changes
--   1. invites.email_sent_at / reminder_sent_at / send_skipped: imported invitations are no longer
--      emailed at import. The 10-minute email timer sends them gradually, in the send window, with
--      a budget of their own (lib/emails/heldInvites.ts), and one reminder 3 days later.
--      The 21 days count from the email, not from the import.
--   2. admin_create_held_invites(): up to 10,000 addresses in one import, sorted in one pass.
--   3. admin_held_invites() / admin_held_invites_summary(): every imported invitation with its
--      stage — queued, sent, opened the email, opened the link, in onboarding, waiting for
--      approval, approved, not sent, expired — for the admin page. Admins only.
--
-- What it does NOT change: ordinary invitations, approvals, who can read what.
--
-- Order: run this, then push the backend (API) and the frontend. Do not import between the two
-- steps (the API still running sends the emails at once, and the timer would send them again).
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing changes.
-- To go back: rollback_add_held_invites_queue.sql.                                Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Sending state
-- ------------------------------------------------------------
ALTER TABLE public.invites
  ADD COLUMN IF NOT EXISTS email_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_skipped     text;   -- why the email was not sent: not_allowed / invalid_address

CREATE INDEX IF NOT EXISTS invites_held_queue ON public.invites (created_at)
  WHERE hold_for_review AND email_sent_at IS NULL AND send_skipped IS NULL;

-- ------------------------------------------------------------
-- 2. Import: one pass over the whole list
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_held_invites(
  p_emails text[],
  p_inviter_display_name text,
  p_personal_note text DEFAULT NULL,
  p_days integer DEFAULT 21
)
RETURNS TABLE (email text, result text, token text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(trim(p_inviter_display_name), '') = '' THEN
    RAISE EXCEPTION 'Sender name is required' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(array_length(p_emails, 1), 0) > 10000 THEN
    RAISE EXCEPTION 'At most 10,000 addresses in one import' USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  WITH input AS (
    SELECT lower(trim(t.e)) AS addr, t.ord FROM unnest(coalesce(p_emails, '{}')) WITH ORDINALITY AS t(e, ord)
  ), firsts AS (
    SELECT addr, min(ord) AS first_ord FROM input GROUP BY addr
  ), classified AS (
    SELECT i.addr, i.ord,
      CASE
        WHEN i.addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN 'invalid'
        WHEN i.ord <> f.first_ord THEN 'duplicate'
        WHEN i.addr IN (SELECT lower(u.email) FROM users u WHERE u.email IS NOT NULL) THEN 'member'
        WHEN i.addr IN (SELECT lower(v.recipient_email) FROM invites v WHERE v.status = 'pending' AND v.expires_at > now()) THEN 'pending_invite'
        ELSE 'created'
      END AS res
    FROM input i JOIN firsts f ON f.addr = i.addr
  ), ins AS (
    INSERT INTO invites (id, inviter_id, token, recipient_email, personal_note, status, role, views_count,
                         created_at, expires_at, hold_for_review, inviter_display_name)
    SELECT gen_random_uuid(), auth.uid(), replace(gen_random_uuid()::text, '-', ''), c.addr,
           nullif(trim(p_personal_note), ''), 'pending', 'community', 0,
           now(), now() + make_interval(days => greatest(1, least(coalesce(p_days, 21), 60))), true, trim(p_inviter_display_name)
    FROM classified c WHERE c.res = 'created'
    RETURNING invites.recipient_email, invites.token, invites.expires_at
  )
  SELECT c.addr, c.res, ins.token, ins.expires_at
  FROM classified c LEFT JOIN ins ON c.res = 'created' AND ins.recipient_email = c.addr
  ORDER BY c.ord;
END;
$$;

-- ------------------------------------------------------------
-- 3. Tracking: one row per imported invitation, with its stage
-- ------------------------------------------------------------
-- Internal (no grant to members): the two admin functions below call it after checking the caller.
CREATE OR REPLACE FUNCTION public.held_invites_rows()
RETURNS TABLE (invite_id text, email text, inviter_display_name text, invited_at timestamptz,
               email_sent_at timestamptz, expires_at timestamptz, email_opened_at timestamptz,
               link_opened_at timestamptz, user_id uuid, first_name text, last_name text,
               headline text, joined_at timestamptz, stage text)
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
         u.uuid, u.first_name::text, u.last_name::text, u.headline::text, u.created_at,
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
               headline text, joined_at timestamptz, stage text, total_count bigint)
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

CREATE OR REPLACE FUNCTION public.admin_held_invites_summary()
RETURNS TABLE (stage text, n bigint)
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
  RETURN QUERY SELECT r.stage, count(*) FROM held_invites_rows() r GROUP BY r.stage;
END;
$$;

REVOKE ALL ON FUNCTION public.held_invites_rows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_held_invites(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_held_invites_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_held_invites(text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_held_invites_summary() TO authenticated;

-- ------------------------------------------------------------
-- 4. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_admin uuid; v_member_email text; v_n bigint; v_before bigint; v_emails text[];
BEGIN
  IF has_function_privilege('authenticated', 'public.held_invites_rows()', 'EXECUTE') THEN
    v_problems := v_problems || ' members can run held_invites_rows;';
  END IF;

  SELECT count(*) INTO v_before FROM invites;
  SELECT uuid INTO v_admin FROM users WHERE status = 'Active' ORDER BY created_at LIMIT 1;
  SELECT email INTO v_member_email FROM users WHERE status = 'Active' AND email IS NOT NULL AND uuid <> v_admin ORDER BY created_at LIMIT 1;

  IF v_admin IS NOT NULL AND v_member_email IS NOT NULL THEN
    BEGIN
      -- a member cannot list or import
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'community'))::text, true);
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM * FROM admin_held_invites();
        v_problems := v_problems || ' a member can list imported invitations;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      RESET ROLE;

      -- an admin imports 8,000 addresses (+ a duplicate, a bad one, a member) in one call
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
      SET LOCAL ROLE authenticated;
      SELECT array_agg('check7f3a.' || g || '@example.com') INTO v_emails FROM generate_series(1, 8000) g;
      v_emails := v_emails || ARRAY['CHECK7F3A.1@example.com', 'not-an-email', v_member_email];
      SELECT count(*) FILTER (WHERE result = 'created'), count(*) INTO v_n, v_before
        FROM (SELECT * FROM admin_create_held_invites(v_emails, 'check')) r;
      IF v_n <> 8000 THEN v_problems := v_problems || ' import created ' || v_n || ' of 8000;'; END IF;
      SELECT count(*) INTO v_n FROM admin_create_held_invites(ARRAY['check7f3a.1@example.com'], 'check') r WHERE r.result = 'pending_invite';
      IF v_n <> 1 THEN v_problems := v_problems || ' a second import of the same address was not refused;'; END IF;

      SELECT n INTO v_n FROM admin_held_invites_summary() s WHERE s.stage = 'queued';
      IF coalesce(v_n, 0) < 8000 THEN v_problems := v_problems || ' the summary does not count the queued invitations;'; END IF;
      SELECT count(*) INTO v_n FROM admin_held_invites('queued', 'check7f3a.42@', 50, 0) r WHERE r.total_count = 1;
      IF v_n <> 1 THEN v_problems := v_problems || ' search / stage filter did not find one invitation;'; END IF;
      SELECT count(*) INTO v_n FROM admin_held_invites(NULL, NULL, 50, 0);
      IF v_n <> 50 THEN v_problems := v_problems || ' paging returned ' || v_n || ' rows instead of 50;'; END IF;
      RESET ROLE;

      -- stages follow the sending state
      UPDATE invites SET email_sent_at = now() WHERE recipient_email = 'check7f3a.2@example.com';
      UPDATE invites SET email_sent_at = now(), last_viewed_at = now() WHERE recipient_email = 'check7f3a.3@example.com';
      UPDATE invites SET send_skipped = 'not_allowed' WHERE recipient_email = 'check7f3a.4@example.com';
      SELECT count(*) INTO v_n FROM held_invites_rows() r
        WHERE (r.email = 'check7f3a.2@example.com' AND r.stage = 'sent')
           OR (r.email = 'check7f3a.3@example.com' AND r.stage = 'link_opened')
           OR (r.email = 'check7f3a.4@example.com' AND r.stage = 'not_sent');
      IF v_n <> 3 THEN v_problems := v_problems || ' stages are not as expected;'; END IF;

      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
    EXCEPTION
      WHEN SQLSTATE 'P0002' THEN RESET ROLE;
      WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
    END;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;

  IF (SELECT count(*) FROM invites WHERE recipient_email LIKE 'check7f3a.%') > 0 THEN
    v_problems := v_problems || ' test invitations were left behind;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: 8,000 addresses import in one call; stages and paging work; members cannot list or import.';
END $$;

COMMIT;

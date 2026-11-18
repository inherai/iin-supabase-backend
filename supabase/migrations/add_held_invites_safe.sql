-- ============================================================
-- Held invitations — SELF-CHECKING (2026-11-18). Run in the SQL Editor.
--
-- A one-off kind of invitation, sent by an admin from a spreadsheet: the email names the sender by a
-- text the admin types (not by the admin's own name), and when the invited member finishes
-- onboarding she waits for an admin's approval before she enters.
--
-- What it adds
--   1. invites.hold_for_review / inviter_display_name / reviewed_at / reviewed_by.
--   2. users.status 'pending_review': finishing onboarding (onboarding → Active) on a held invitation
--      lands here instead. Decided in a trigger, so no client can skip it. Everything that looks for
--      status 'Active' (emails, talent search, company pages) leaves her out until she is approved;
--      the onboarding reminders look only at 'onboarding', so they stop too.
--      Only an admin moves a member out of 'pending_review' (members can update their own users row,
--      so the trigger refuses it for them).
--   3. admin_create_held_invites(): creates the invitations of one import (admins only).
--      admin_pending_review_users(): who is waiting.  admin_approve_pending_users(): lets them in —
--      status Active and activated_at now, so the hourly jobs send the welcome email and tell the
--      inviter, exactly as for anyone who just finished onboarding.
--
-- What it does NOT change: ordinary invitations, members who are already in, privacy, RLS.
--
-- Order: run this, then deploy the API (admin.ts, me.ts, lib/emails/invitations.ts) and
-- validate-invite, then the frontend (it lets a 'pending_review' member sign in, to the waiting page).
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing changes.
-- To go back: rollback_add_held_invites.sql.                                       Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Invitation fields
-- ------------------------------------------------------------
ALTER TABLE public.invites
  ADD COLUMN IF NOT EXISTS hold_for_review      boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inviter_display_name text,
  ADD COLUMN IF NOT EXISTS reviewed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by          uuid;

CREATE INDEX IF NOT EXISTS invites_held_email ON public.invites (lower(recipient_email)) WHERE hold_for_review;

-- ------------------------------------------------------------
-- 2. Finishing onboarding on a held invitation → 'pending_review'; only an admin lets her out
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hold_invited_user_for_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'onboarding' AND NEW.status = 'Active' AND EXISTS (
    SELECT 1 FROM invites i
    WHERE lower(trim(i.recipient_email)) = lower(trim(NEW.email))
      AND i.hold_for_review AND i.status = 'accepted' AND i.reviewed_at IS NULL
  ) THEN
    NEW.status := 'pending_review';
  END IF;

  -- A member's own session cannot let herself in; the API's service role and the SQL Editor can.
  IF OLD.status = 'pending_review' AND NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(auth.role(), '') IN ('authenticated', 'anon') AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'This account is waiting for approval' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hold_invited_user_for_review ON public.users;
CREATE TRIGGER hold_invited_user_for_review
  BEFORE UPDATE OF status ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.hold_invited_user_for_review();

-- ------------------------------------------------------------
-- 3. Admin functions (each checks the caller is an admin; called from the admin's own session)
-- ------------------------------------------------------------
-- One import. Returns a row per address: 'created' (with the token for the email), 'invalid',
-- 'duplicate' (twice in the file), 'member' (already has an account) or 'pending_invite'.
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
DECLARE
  v_email text;
  v_seen text[] := '{}';
  v_token text;
  v_expires timestamptz := now() + make_interval(days => greatest(1, least(coalesce(p_days, 21), 60)));
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(trim(p_inviter_display_name), '') = '' THEN
    RAISE EXCEPTION 'Sender name is required' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(array_length(p_emails, 1), 0) > 200 THEN
    RAISE EXCEPTION 'At most 200 addresses in one import' USING ERRCODE = 'check_violation';
  END IF;

  FOREACH v_email IN ARRAY coalesce(p_emails, '{}') LOOP
    v_email := lower(trim(v_email));
    email := v_email; token := NULL; expires_at := NULL;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
      result := 'invalid';
    ELSIF v_email = ANY (v_seen) THEN
      result := 'duplicate';
    ELSIF EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = v_email) THEN
      result := 'member';
    ELSIF EXISTS (SELECT 1 FROM invites i WHERE lower(i.recipient_email) = v_email AND i.status = 'pending' AND i.expires_at > now()) THEN
      result := 'pending_invite';
    ELSE
      v_token := replace(gen_random_uuid()::text, '-', '');
      INSERT INTO invites (id, inviter_id, token, recipient_email, personal_note, status, role, views_count,
                           created_at, expires_at, hold_for_review, inviter_display_name)
      VALUES (gen_random_uuid(), auth.uid(), v_token, v_email, nullif(trim(p_personal_note), ''), 'pending', 'community', 0,
              now(), v_expires, true, trim(p_inviter_display_name));
      result := 'created'; token := v_token; expires_at := v_expires;
    END IF;
    v_seen := v_seen || v_email;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_pending_review_users()
RETURNS TABLE (uuid uuid, email text, first_name text, last_name text, headline text, image text,
               joined_at timestamptz, inviter_display_name text, invited_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT u.uuid, u.email::text, u.first_name::text, u.last_name::text, u.headline::text, u.image::text,
         u.created_at, i.inviter_display_name, i.created_at
  FROM users u
  LEFT JOIN LATERAL (
    SELECT inv.inviter_display_name, inv.created_at FROM invites inv
    WHERE lower(trim(inv.recipient_email)) = lower(trim(u.email)) AND inv.hold_for_review
    ORDER BY inv.created_at DESC LIMIT 1
  ) i ON true
  WHERE u.status = 'pending_review'
  ORDER BY u.created_at;
END;
$$;

-- Returns the members who were let in (ids that were not waiting are ignored).
CREATE OR REPLACE FUNCTION public.admin_approve_pending_users(p_user_ids uuid[])
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH approved AS (
    UPDATE users SET status = 'Active', activated_at = now()
    WHERE users.uuid = ANY (p_user_ids) AND users.status = 'pending_review'
    RETURNING users.uuid, users.email
  ), marked AS (
    UPDATE invites SET reviewed_at = now(), reviewed_by = auth.uid()
    WHERE hold_for_review AND reviewed_at IS NULL
      AND lower(trim(recipient_email)) IN (SELECT lower(trim(a.email)) FROM approved a)
  )
  SELECT array_agg(a.uuid) INTO v_ids FROM approved a;

  RETURN QUERY SELECT unnest(coalesce(v_ids, '{}'));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_held_invites(text[], text, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_pending_review_users() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_approve_pending_users(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.hold_invited_user_for_review() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_held_invites(text[], text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_pending_review_users() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_pending_users(uuid[]) TO authenticated;

-- ------------------------------------------------------------
-- 4. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_admin uuid; v_member uuid; v_member_email text; v_status text; v_n bigint; v_before bigint;
BEGIN
  IF has_function_privilege('anon', 'public.admin_approve_pending_users(uuid[])', 'EXECUTE') THEN
    v_problems := v_problems || ' signed-out visitors can run admin_approve_pending_users;';
  END IF;

  SELECT count(*) INTO v_before FROM invites;
  SELECT uuid INTO v_admin FROM users WHERE status = 'Active' ORDER BY created_at LIMIT 1;
  SELECT uuid, email INTO v_member, v_member_email FROM users
    WHERE status = 'Active' AND uuid <> v_admin AND email IS NOT NULL ORDER BY created_at LIMIT 1;

  IF v_admin IS NOT NULL AND v_member IS NOT NULL THEN
    BEGIN
      -- A member in the middle of onboarding, on a held invitation (throw-away rows, undone below)
      UPDATE users SET status = 'onboarding' WHERE uuid = v_member;
      INSERT INTO invites (id, inviter_id, token, recipient_email, status, role, views_count, created_at, expires_at, hold_for_review, inviter_display_name)
      VALUES (gen_random_uuid(), v_admin, 'check7f3a' || md5(random()::text), v_member_email, 'accepted', 'community', 0, now(), now() + interval '1 day', true, 'check');

      -- she finishes onboarding in her own session → waits
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_member, 'role', 'authenticated', 'app_metadata', json_build_object('role', 'community'))::text, true);
      SET LOCAL ROLE authenticated;
      UPDATE users SET status = 'Active' WHERE uuid = v_member;
      RESET ROLE;
      SELECT status INTO v_status FROM users WHERE uuid = v_member;
      IF v_status IS DISTINCT FROM 'pending_review' THEN v_problems := v_problems || ' finishing onboarding on a held invitation did not wait (' || coalesce(v_status, 'null') || ');'; END IF;

      -- she cannot let herself in, and cannot run the admin functions
      SET LOCAL ROLE authenticated;
      BEGIN
        UPDATE users SET status = 'Active' WHERE uuid = v_member;
        v_problems := v_problems || ' a waiting member let herself in;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        PERFORM admin_approve_pending_users(ARRAY[v_member]);
        v_problems := v_problems || ' a member can run admin_approve_pending_users;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      BEGIN
        PERFORM * FROM admin_create_held_invites(ARRAY['check7f3a@example.com'], 'x');
        v_problems := v_problems || ' a member can run admin_create_held_invites;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      -- other profile edits still work while she waits
      UPDATE users SET first_name = first_name WHERE uuid = v_member;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN v_problems := v_problems || ' a waiting member cannot edit her profile;'; END IF;
      RESET ROLE;

      -- an admin sees her and lets her in
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
      SET LOCAL ROLE authenticated;
      SELECT count(*) INTO v_n FROM admin_pending_review_users() p WHERE p.uuid = v_member AND p.inviter_display_name = 'check';
      IF v_n <> 1 THEN v_problems := v_problems || ' the admin does not see the waiting member;'; END IF;
      SELECT count(*) INTO v_n FROM admin_approve_pending_users(ARRAY[v_member, v_admin]);
      IF v_n <> 1 THEN v_problems := v_problems || ' approve returned ' || v_n || ' members instead of 1;'; END IF;
      SELECT count(*) INTO v_n FROM admin_create_held_invites(ARRAY['Check7f3a@Example.com', 'check7f3a@example.com', 'not-an-email', v_member_email], 'check') r
        WHERE (r.email = 'check7f3a@example.com' AND r.result IN ('created', 'duplicate')) OR (r.email = 'not-an-email' AND r.result = 'invalid') OR (r.result = 'member');
      IF v_n <> 4 THEN v_problems := v_problems || ' admin_create_held_invites sorted the addresses wrongly;'; END IF;
      RESET ROLE;
      SELECT status INTO v_status FROM users WHERE uuid = v_member;
      IF v_status IS DISTINCT FROM 'Active' THEN v_problems := v_problems || ' approval did not let her in;'; END IF;
      SELECT count(*) INTO v_n FROM invites WHERE recipient_email = v_member_email AND inviter_display_name = 'check' AND reviewed_at IS NOT NULL;
      IF v_n <> 1 THEN v_problems := v_problems || ' approval was not recorded on the invitation;'; END IF;

      -- an ordinary invitation still goes straight to Active
      UPDATE invites SET hold_for_review = false WHERE inviter_display_name = 'check' AND recipient_email = v_member_email;
      UPDATE users SET status = 'onboarding' WHERE uuid = v_member;
      UPDATE users SET status = 'Active' WHERE uuid = v_member;
      SELECT status INTO v_status FROM users WHERE uuid = v_member;
      IF v_status IS DISTINCT FROM 'Active' THEN v_problems := v_problems || ' an ordinary invitation was held;'; END IF;

      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
    EXCEPTION
      WHEN SQLSTATE 'P0002' THEN RESET ROLE;
      WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
    END;
    PERFORM set_config('request.jwt.claims', '', true);
  END IF;

  SELECT count(*) INTO v_n FROM invites;
  IF v_n <> v_before THEN v_problems := v_problems || ' test invitations were left behind;'; END IF;
  SELECT status INTO v_status FROM users WHERE uuid = v_member;
  IF v_member IS NOT NULL AND v_status IS DISTINCT FROM 'Active' THEN v_problems := v_problems || ' the test member was not restored;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: a held invitation waits after onboarding; only an admin lets her in; ordinary invitations are unchanged.';
END $$;

COMMIT;

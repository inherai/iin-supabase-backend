-- ============================================================
-- Company pages: who gets told what — SELF-CHECKING (2026-11-12). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql and add_company_claims_safe.sql.
--
-- Adds rows to the existing notifications table (the bell in the site header), the same way
-- likes and comments already do — from triggers, never from server code:
--   COMPANY_CLAIM_APPROVED   to the member, when Duallin approves her request to manage a page
--   COMPANY_CLAIM_REJECTED   to the member, when it is declined
--   COMPANY_ADMIN_ADDED      to a member an owner added as a manager of a page
--   COMPANY_CLAIM_NEW        to every Duallin admin, when a request arrives
--   COMPANY_REPORT_NEW       to every Duallin admin, when a page is reported
-- target_id holds the company id (or 'new' for an organization that has no page yet).
--
-- Like the existing notification triggers, these run with the table owner's rights
-- (SECURITY DEFINER — a member may not write a notification for someone else) and never
-- stop the action itself: if a notification can't be written, the claim / report / manager
-- change still goes through.
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_notifications.sql        Safe to re-run.
-- ============================================================
BEGIN;

-- Duallin admins, as the site knows them: is_admin in the account's app metadata.
CREATE OR REPLACE FUNCTION public.platform_admin_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
  FROM auth.users a
  JOIN public.users u ON u.uuid = a.id
  WHERE coalesce((a.raw_app_meta_data ->> 'is_admin')::boolean, false)
$$;
REVOKE ALL ON FUNCTION public.platform_admin_ids() FROM PUBLIC, anon, authenticated;

-- A decision on a request → the member who asked.
CREATE OR REPLACE FUNCTION public.company_claim_decided_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      VALUES (NEW.requested_by, NULL, coalesce(NEW.company_id::text, 'new'),
              CASE NEW.status WHEN 'approved' THEN 'COMPANY_CLAIM_APPROVED' ELSE 'COMPANY_CLAIM_REJECTED' END, 1, false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company_claim_decided_notify: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_claim_decided_notify() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_claim_decided_notify ON public.company_claims;
CREATE TRIGGER trg_company_claim_decided_notify
  AFTER UPDATE OF status ON public.company_claims
  FOR EACH ROW EXECUTE FUNCTION public.company_claim_decided_notify();

-- A new request, or a new report about a page → every Duallin admin (except the sender herself).
CREATE OR REPLACE FUNCTION public.company_notify_admins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_type  text;
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'company_claims' THEN
      v_actor := NEW.requested_by; v_type := 'COMPANY_CLAIM_NEW';
    ELSE
      v_actor := NEW.reporter_id;  v_type := 'COMPANY_REPORT_NEW';
    END IF;
    INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
    SELECT a, v_actor, coalesce(NEW.company_id::text, 'new'), v_type, 1, false
    FROM public.platform_admin_ids() a
    WHERE a <> v_actor;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company_notify_admins: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_notify_admins() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_claim_new_notify ON public.company_claims;
CREATE TRIGGER trg_company_claim_new_notify
  AFTER INSERT ON public.company_claims
  FOR EACH ROW EXECUTE FUNCTION public.company_notify_admins();
DROP TRIGGER IF EXISTS trg_company_report_new_notify ON public.company_reports;
CREATE TRIGGER trg_company_report_new_notify
  AFTER INSERT ON public.company_reports
  FOR EACH ROW EXECUTE FUNCTION public.company_notify_admins();

-- An owner (or a Duallin admin) added a member as a manager → that member.
-- Not when the row comes from somewhere else that already tells her (an approved request),
-- and not when she is the one who added herself.
CREATE OR REPLACE FUNCTION public.company_admin_added_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF pg_trigger_depth() = 1 AND NEW.added_by IS NOT NULL AND NEW.added_by <> NEW.user_id THEN
      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      VALUES (NEW.user_id, NEW.added_by, NEW.company_id::text, 'COMPANY_ADMIN_ADDED', 1, false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company_admin_added_notify: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.company_admin_added_notify() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_admin_added_notify ON public.company_admins;
CREATE TRIGGER trg_company_admin_added_notify
  AFTER INSERT ON public.company_admins
  FOR EACH ROW EXECUTE FUNCTION public.company_admin_added_notify();

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_a uuid; v_b uuid; v_admin uuid; v_admins bigint;
  v_claim bigint; v_n bigint;
BEGIN
  SELECT id INTO v_company FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT count(*) INTO v_admins FROM platform_admin_ids();
  SELECT a INTO v_admin FROM platform_admin_ids() a ORDER BY a LIMIT 1;
  SELECT uuid INTO v_a FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
    AND uuid NOT IN (SELECT platform_admin_ids()) AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_a
    AND uuid NOT IN (SELECT platform_admin_ids()) AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  BEGIN
    -- 1. a member files a request and a report → every admin is told once about each, she is not
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (v_company, 'Head of Marketing', 'a@example.com') RETURNING id INTO v_claim;
    INSERT INTO company_reports (company_id, reason) VALUES (v_company, 'wrong_info');
    RESET ROLE;
    SELECT count(*) INTO v_n FROM notifications WHERE type = 'COMPANY_CLAIM_NEW' AND actor_id = v_a AND target_id = v_company::text;
    IF v_n <> v_admins THEN v_problems := v_problems || format(' a new request told %s admins, expected %s;', v_n, v_admins); END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE type = 'COMPANY_REPORT_NEW' AND actor_id = v_a AND target_id = v_company::text;
    IF v_n <> v_admins THEN v_problems := v_problems || format(' a new report told %s admins, expected %s;', v_n, v_admins); END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE user_id = v_a AND type LIKE 'COMPANY_%') THEN v_problems := v_problems || ' the member was told about her own request;'; END IF;

    -- 2. an admin approves → the member is told once that it was approved, and not also "you were added"
    IF v_admin IS NOT NULL THEN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
      SET LOCAL ROLE authenticated;
      UPDATE company_claims SET status = 'approved' WHERE id = v_claim;
      RESET ROLE;
    ELSE
      PERFORM set_config('request.jwt.claims', '', true);
      UPDATE company_claims SET status = 'approved' WHERE id = v_claim;
    END IF;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id = v_a AND type = 'COMPANY_CLAIM_APPROVED' AND target_id = v_company::text AND actor_id IS NULL;
    IF v_n <> 1 THEN v_problems := v_problems || format(' approval produced %s notifications for the member, expected 1;', v_n); END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE user_id = v_a AND type = 'COMPANY_ADMIN_ADDED') THEN v_problems := v_problems || ' an approved member was also told she was "added";'; END IF;
    IF NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_company AND user_id = v_a AND role = 'owner') THEN v_problems := v_problems || ' the approval itself no longer works;'; END IF;

    -- 3. she adds another member as content manager → that member is told, by her
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_b, 'content');
    -- 4. a member cannot write a notification for someone else, and reads only her own
    BEGIN
      INSERT INTO notifications (user_id, actor_id, target_id, type) VALUES (v_b, v_a, v_company::text, 'COMPANY_CLAIM_APPROVED');
      v_problems := v_problems || ' a member wrote a notification for another member;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id <> v_a;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member reads other members'' notifications;'; END IF;
    RESET ROLE;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id = v_b AND type = 'COMPANY_ADMIN_ADDED' AND actor_id = v_a AND target_id = v_company::text;
    IF v_n <> 1 THEN v_problems := v_problems || format(' adding a manager produced %s notifications, expected 1;', v_n); END IF;

    -- 5. a rejection tells the member too
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_claims (org_name, requested_by, requester_title, work_email) VALUES ('Duallin Notify Check 7f3a', v_b, 'Founder', 'b@example.org') RETURNING id INTO v_claim;
    UPDATE company_claims SET status = 'rejected' WHERE id = v_claim;
    SELECT count(*) INTO v_n FROM notifications WHERE user_id = v_b AND type = 'COMPANY_CLAIM_REJECTED' AND target_id = 'new';
    IF v_n <> 1 THEN v_problems := v_problems || format(' rejection produced %s notifications, expected 1;', v_n); END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM notifications WHERE type LIKE 'COMPANY_%' AND actor_id IN (v_a, v_b)) THEN v_problems := v_problems || ' test notifications were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % Duallin admin(s) are told about new requests and reports; members are told about decisions and about being added as a manager.', v_admins;
END $$;

COMMIT;

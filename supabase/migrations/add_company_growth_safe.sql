-- ============================================================
-- Company pages: growing a page — SELF-CHECKING (2026-11-17). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql, add_entitlements_safe.sql and
-- add_company_voice_safe.sql (notification_bump, notifications.actor_company_id).
--
-- 1. Inviting connections to follow the page: company_follow_invites.
--      * the page's owner / content managers invite their own accepted connections who
--        don't follow the page yet, on a managed page that isn't suspended;
--      * one invitation per member per page, ever: a declined invitation can't be sent again;
--      * each invitation counts toward the page's monthly 'page.follow_invites.monthly';
--      * the invited member is told (COMPANY_FOLLOW_INVITE: who invited her, to which page)
--        and accepts or declines; only she sees her invitation and its answer — the page's
--        managers learn only whom they already invited (company_invited_member_ids), never
--        who declined.
-- 2. Telling the page's employees about a new post: notify_page_employees(post).
--      * the members whose current workplace is the page (companies.employees) get
--        COMPANY_EMPLOYEE_POST from the page; the page's managers are left out;
--      * a post published in the last day, by the page's owner / content managers;
--      * at most once a week per page (company_employee_alerts keeps the record);
--      * company_employee_alert_status(page) says how many would be told and when it may
--        be used again, for the publishing box.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_growth.sql             Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Invitations to follow
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_follow_invites (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invitee_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inviter_id   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT company_follow_invites_once UNIQUE (company_id, invitee_id)
);
CREATE INDEX IF NOT EXISTS idx_company_follow_invites_invitee ON public.company_follow_invites (invitee_id, status);

ALTER TABLE public.company_follow_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_follow_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_follow_invites TO authenticated;
GRANT INSERT (company_id, invitee_id) ON public.company_follow_invites TO authenticated;
GRANT UPDATE (status) ON public.company_follow_invites TO authenticated;
GRANT ALL ON public.company_follow_invites TO service_role;

DROP POLICY IF EXISTS "A page's managers invite" ON public.company_follow_invites;
CREATE POLICY "A page's managers invite" ON public.company_follow_invites
  FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "She sees the invitations sent to her" ON public.company_follow_invites;
CREATE POLICY "She sees the invitations sent to her" ON public.company_follow_invites
  FOR SELECT TO authenticated
  USING (invitee_id = auth.uid());

DROP POLICY IF EXISTS "She answers an invitation once" ON public.company_follow_invites;
CREATE POLICY "She answers an invitation once" ON public.company_follow_invites
  FOR UPDATE TO authenticated
  USING (invitee_id = auth.uid() AND status = 'pending')
  WITH CHECK (invitee_id = auth.uid() AND status IN ('accepted', 'declined'));

-- SECURITY DEFINER: reads the inviter's connections and the follows, and counts the quota
-- (entitlement_consume checks again that the inviter manages the page).
CREATE OR REPLACE FUNCTION public.company_follow_invites_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.company_id, NEW.invitee_id, NEW.inviter_id, NEW.created_at) IS DISTINCT FROM
       (OLD.company_id, OLD.invitee_id, OLD.inviter_id, OLD.created_at) THEN
      RAISE EXCEPTION 'an invitation does not change' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.responded_at := now(); END IF;
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.created_at := now();
  NEW.responded_at := NULL;
  IF v_me IS NULL THEN RETURN NEW; END IF;   -- sessions without a member are not limited
  NEW.inviter_id := v_me;

  -- the role first (RLS checks it again): nothing is looked up or counted for anyone else
  IF NOT public.has_company_role(NEW.company_id, ARRAY['owner', 'content']) THEN
    RAISE EXCEPTION 'not_a_manager' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND page_status = 'claimed') THEN
    RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM connections
    WHERE status = 'accepted'
      AND ((requester_id = v_me AND receiver_id = NEW.invitee_id) OR (requester_id = NEW.invitee_id AND receiver_id = v_me))
  ) THEN
    RAISE EXCEPTION 'not_a_connection' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM article_company_follows WHERE company_id = NEW.company_id AND follower_uuid = NEW.invitee_id) THEN
    RAISE EXCEPTION 'already_following' USING ERRCODE = '42501';
  END IF;
  -- one use of this month's invitations; refuses when they are used up (and counts nothing)
  PERFORM public.entitlement_consume('company', NEW.company_id::text, 'page.follow_invites.monthly', 1);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS company_follow_invites_guard ON public.company_follow_invites;
CREATE TRIGGER company_follow_invites_guard
  BEFORE INSERT OR UPDATE ON public.company_follow_invites
  FOR EACH ROW EXECUTE FUNCTION public.company_follow_invites_guard();

CREATE OR REPLACE FUNCTION public.company_follow_invites_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM public.notification_bump(NEW.invitee_id, NEW.inviter_id, NEW.company_id, NEW.company_id::text, 'COMPANY_FOLLOW_INVITE', NULL);
    ELSIF NEW.status <> 'pending' THEN
      -- answered: the invitation leaves her bell
      PERFORM public.notification_drop(NEW.invitee_id, NEW.company_id::text, 'COMPANY_FOLLOW_INVITE');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company_follow_invites_notify: %', SQLERRM;   -- never blocks the invitation itself
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS company_follow_invites_notify ON public.company_follow_invites;
CREATE TRIGGER company_follow_invites_notify
  AFTER INSERT OR UPDATE ON public.company_follow_invites
  FOR EACH ROW EXECUTE FUNCTION public.company_follow_invites_notify();

-- Whom the page already invited (whatever they answered), for the manager's picker.
CREATE OR REPLACE FUNCTION public.company_invited_member_ids(p_company_id integer)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_company_role(p_company_id, ARRAY['owner', 'content']) THEN
    RAISE EXCEPTION 'not_a_manager' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT invitee_id FROM company_follow_invites WHERE company_id = p_company_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.company_follow_invites_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_follow_invites_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_invited_member_ids(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_invited_member_ids(integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Telling the page's employees about a new post
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_employee_alerts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  post_id    text        REFERENCES public.posts(id) ON DELETE SET NULL,
  sent_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  recipients integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_employee_alerts_company ON public.company_employee_alerts (company_id, created_at DESC);

ALTER TABLE public.company_employee_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_employee_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.company_employee_alerts TO service_role;

-- The members who would be told: the page's current employees, without its managers.
CREATE OR REPLACE FUNCTION public.company_employee_recipients(p_company_id integer)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT e
  FROM companies c, unnest(coalesce(c.employees, '{}'::uuid[])) e
  WHERE c.id = p_company_id
    AND EXISTS (SELECT 1 FROM users u WHERE u.uuid = e AND u.status = 'Active')
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = p_company_id AND a.user_id = e)
$function$;

CREATE OR REPLACE FUNCTION public.company_employee_alert_status(p_company_id integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_last timestamptz;
BEGIN
  IF NOT public.has_company_role(p_company_id, ARRAY['owner', 'content']) THEN
    RAISE EXCEPTION 'not_a_manager' USING ERRCODE = '42501';
  END IF;
  SELECT max(created_at) INTO v_last FROM company_employee_alerts WHERE company_id = p_company_id;
  RETURN jsonb_build_object(
    'employees', (SELECT count(*) FROM public.company_employee_recipients(p_company_id)),
    'next_at', CASE WHEN v_last > now() - interval '7 days' THEN v_last + interval '7 days' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_page_employees(p_post_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_company integer;
  v_sent_at timestamptz;
  v_count integer := 0;
  v_employee uuid;
BEGIN
  SELECT company_id, sent_at INTO v_company, v_sent_at FROM posts WHERE id = p_post_id;
  IF v_company IS NULL OR NOT public.has_company_role(v_company, ARRAY['owner', 'content']) THEN
    RAISE EXCEPTION 'not_a_manager' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = v_company AND page_status = 'claimed') THEN
    RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
  END IF;
  IF v_sent_at IS NULL OR v_sent_at < now() - interval '1 day' THEN
    RAISE EXCEPTION 'post_too_old' USING ERRCODE = 'P0001';
  END IF;
  -- once a week per page; the lock keeps two managers from sending at the same moment
  PERFORM pg_advisory_xact_lock(hashtext('company_employee_alert'), v_company);
  IF EXISTS (SELECT 1 FROM company_employee_alerts WHERE company_id = v_company AND created_at > now() - interval '7 days') THEN
    RAISE EXCEPTION 'weekly_limit' USING ERRCODE = 'P0001';
  END IF;

  FOR v_employee IN SELECT * FROM public.company_employee_recipients(v_company) LOOP
    IF v_employee IS DISTINCT FROM auth.uid() THEN
      PERFORM public.notification_bump(v_employee, NULL, v_company, p_post_id, 'COMPANY_EMPLOYEE_POST', NULL);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  INSERT INTO company_employee_alerts (company_id, post_id, sent_by, recipients)
  VALUES (v_company, p_post_id, auth.uid(), v_count);
  INSERT INTO company_audit_log (company_id, actor_id, action, details)
  VALUES (v_company, auth.uid(), 'employees_notified', jsonb_build_object('post_id', p_post_id, 'recipients', v_count));
  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.company_employee_recipients(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_employee_alert_status(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_page_employees(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_employee_alert_status(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.notify_page_employees(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid; v_owner_email text;
  v_b uuid; v_c uuid;
  v_used_before integer; v_used integer; v_n bigint;
  v_post text := 'growth-check-' || gen_random_uuid();
  v_old_post text := 'growth-check-old-' || gen_random_uuid();
BEGIN
  SELECT a.company_id, a.user_id, u.email INTO v_page, v_owner, v_owner_email
  FROM company_admins a JOIN companies co ON co.id = a.company_id JOIN users u ON u.uuid = a.user_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;

  -- two active members who manage no page, don't follow it and aren't connected to the owner
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM article_company_follows f WHERE f.follower_uuid = u.uuid AND f.company_id = v_page)
    AND NOT EXISTS (SELECT 1 FROM connections c WHERE (c.requester_id = u.uuid AND c.receiver_id = v_owner) OR (c.receiver_id = u.uuid AND c.requester_id = v_owner))
    ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_b
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM article_company_follows f WHERE f.follower_uuid = u.uuid AND f.company_id = v_page)
    AND NOT EXISTS (SELECT 1 FROM connections c WHERE (c.requester_id = u.uuid AND c.receiver_id = v_owner) OR (c.receiver_id = u.uuid AND c.requester_id = v_owner))
    ORDER BY uuid LIMIT 1;
  IF v_b IS NULL OR v_c IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need two members unrelated to the page'; END IF;

  BEGIN
    -- the setting: B is the owner's connection, C is not (yet)
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO connections (requester_id, receiver_id, status) VALUES (v_owner, v_b, 'accepted');
    DELETE FROM notifications WHERE user_id IN (v_b, v_c) AND type IN ('COMPANY_FOLLOW_INVITE', 'COMPANY_EMPLOYEE_POST');
    SELECT coalesce(max(used), 0) INTO v_used_before FROM usage_counters
    WHERE subject_type = 'company' AND subject_id = v_page::text AND feature_key = 'page.follow_invites.monthly'
      AND period_start = public.entitlement_period_start('month');

    -- 1. the owner invites B → B is told who invited her and to which page; one use is counted
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_follow_invites (company_id, invitee_id) VALUES (v_page, v_b);
    -- 2. …not twice
    BEGIN
      INSERT INTO company_follow_invites (company_id, invitee_id) VALUES (v_page, v_b);
      v_problems := v_problems || ' a member was invited twice;';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 3. C is not her connection
    BEGIN
      INSERT INTO company_follow_invites (company_id, invitee_id) VALUES (v_page, v_c);
      v_problems := v_problems || ' a manager invited someone who is not her connection;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 4. the owner cannot read B's answer
    SELECT count(*) INTO v_n FROM company_follow_invites WHERE company_id = v_page;
    IF v_n <> 0 THEN v_problems := v_problems || ' a manager could read the invitations she sent;'; END IF;
    -- 5. …but knows whom she already invited
    SELECT count(*) INTO v_n FROM public.company_invited_member_ids(v_page) i WHERE i = v_b;
    IF v_n <> 1 THEN v_problems := v_problems || ' the page does not know whom it invited;'; END IF;
    RESET ROLE;

    IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_b AND type = 'COMPANY_FOLLOW_INVITE'
                   AND actor_id = v_owner AND actor_company_id = v_page AND target_id = v_page::text) THEN
      v_problems := v_problems || ' the invited member was not told;';
    END IF;
    SELECT used INTO v_used FROM usage_counters
    WHERE subject_type = 'company' AND subject_id = v_page::text AND feature_key = 'page.follow_invites.monthly'
      AND period_start = public.entitlement_period_start('month');
    IF v_used IS DISTINCT FROM v_used_before + 1 THEN
      v_problems := v_problems || format(' the invitation counted %s uses, expected 1;', coalesce(v_used, 0) - v_used_before);
    END IF;

    -- 6. C cannot invite in the page's name, nor see B's invitation
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_follow_invites (company_id, invitee_id) VALUES (v_page, v_b);
      v_problems := v_problems || ' a member invited in the name of a page she does not manage;';
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL;
    END;
    SELECT count(*) INTO v_n FROM company_follow_invites;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member saw another member''s invitation;'; END IF;
    BEGIN
      PERFORM public.company_invited_member_ids(v_page);
      v_problems := v_problems || ' a member who does not manage the page saw whom it invited;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 7. B declines, and cannot take it back
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE company_follow_invites SET status = 'declined' WHERE company_id = v_page AND invitee_id = v_b;
    UPDATE company_follow_invites SET status = 'accepted' WHERE company_id = v_page AND invitee_id = v_b;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM company_follow_invites WHERE company_id = v_page AND invitee_id = v_b AND status = 'declined' AND responded_at IS NOT NULL) THEN
      v_problems := v_problems || ' a declined invitation was not kept as declined;';
    END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE user_id = v_b AND type = 'COMPANY_FOLLOW_INVITE') THEN
      v_problems := v_problems || ' an answered invitation stayed in her bell;';
    END IF;

    -- 8. when this month's invitations are used up, the next one is refused
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO connections (requester_id, receiver_id, status) VALUES (v_c, v_owner, 'accepted');
    INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled, limit_value, reason)
    VALUES ('company', v_page::text, 'page.follow_invites.monthly', true, v_used, 'self-check');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_follow_invites (company_id, invitee_id) VALUES (v_page, v_c);
      v_problems := v_problems || ' an invitation went out beyond the monthly limit;';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'entitlement_limit_reached%' THEN RAISE; END IF;
    END;
    RESET ROLE;

    -- 9. the page tells its employees (B and C) about a new post, once a week
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('duallin.system_page_edit', 'on', true);
    UPDATE companies SET employees = array_cat(coalesce(employees, '{}'::uuid[]), ARRAY[v_b, v_c, v_owner]) WHERE id = v_page;
    PERFORM set_config('duallin.system_page_edit', 'off', true);
    DELETE FROM company_employee_alerts WHERE company_id = v_page;
    INSERT INTO posts (id, sender, subject, message, company_id, posted_by_uuid, sent_at)
    VALUES (v_post, v_owner_email, 'check', 'a page post', v_page, v_owner, now()),
           (v_old_post, v_owner_email, 'check', 'an old page post', v_page, v_owner, now() - interval '3 days');

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.notify_page_employees(v_post);
      v_problems := v_problems || ' a member who does not manage the page alerted its employees;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.notify_page_employees(v_old_post);
      v_problems := v_problems || ' employees were alerted about an old post;';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    IF (public.company_employee_alert_status(v_page)->>'next_at') IS NOT NULL THEN
      v_problems := v_problems || ' the page was told to wait before its first alert;';
    END IF;
    v_n := public.notify_page_employees(v_post);
    BEGIN
      PERFORM public.notify_page_employees(v_post);
      v_problems := v_problems || ' employees were alerted twice in a week;';
    EXCEPTION WHEN raise_exception THEN NULL;
    END;
    IF (public.company_employee_alert_status(v_page)->>'next_at') IS NULL THEN
      v_problems := v_problems || ' the page was not told when it may alert again;';
    END IF;
    RESET ROLE;

    IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_b AND type = 'COMPANY_EMPLOYEE_POST'
                   AND actor_id IS NULL AND actor_company_id = v_page AND target_id = v_post) THEN
      v_problems := v_problems || ' an employee was not told about the page''s post;';
    END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE user_id = v_owner AND type = 'COMPANY_EMPLOYEE_POST' AND target_id = v_post) THEN
      v_problems := v_problems || ' the page''s own manager was alerted as an employee;';
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM posts WHERE id IN (v_post, v_old_post)) THEN v_problems := v_problems || ' test posts were left behind;'; END IF;
  IF EXISTS (SELECT 1 FROM company_follow_invites WHERE invitee_id IN (v_b, v_c)) THEN v_problems := v_problems || ' test invitations were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: managers invite their own connections once each, within the monthly limit, and never see who declined; employees hear about a new page post at most once a week.';
END $$;

COMMIT;

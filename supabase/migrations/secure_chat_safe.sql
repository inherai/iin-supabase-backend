-- ============================================================
-- Chat: who may send what, and applicants — SELF-CHECKING (2026-11-17). Run in the SQL Editor.
-- Needs add_company_jobs_safe.sql (job_submissions).
--
-- What was open (found 2026-11-17; none of the 53,164 messages shows any misuse):
--   * a message could be added to any conversation between two connected members by anyone
--     holding the public key — the rule checked the connection, not who is sending, nor
--     that she is in the conversation, nor sender_id;
--   * the recipient's "mark as read" rule allowed changing every column (content too);
--   * the public key (signed out) had every privilege on messages and conversations.
-- Now:
--   * a member sends only in her own name, only in a conversation she is part of, and only
--     to someone she may message — an accepted connection, as before, OR (new, the plan's
--     decision 5) an application she sent through duallin to a page the other person
--     manages as owner / recruiter (both directions: the recruiter writes, she answers);
--   * members may change only is_read; editing, reactions and deleting stay in the API;
--   * signed-out access to messages and conversations is removed.
-- What members read, and everything the API does, is unchanged. No row is changed or deleted.
--
-- Order: run this, then deploy the API (POST /chat and the chat list use can_message).
-- To go back: rollback_secure_chat.sql (from snapshot_before_secure_chat.json).   Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Who may message whom
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_message(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND (
    EXISTS (
      SELECT 1 FROM connections
      WHERE status = 'accepted'
        AND ((requester_id = p_a AND receiver_id = p_b) OR (requester_id = p_b AND receiver_id = p_a))
    )
    OR EXISTS (
      -- one of them applied through duallin to a page the other manages as owner / recruiter
      SELECT 1 FROM job_submissions s
      JOIN company_admins a ON a.company_id = s.company_id AND a.role IN ('owner', 'recruiter')
      WHERE (s.user_id = p_a AND a.user_id = p_b) OR (s.user_id = p_b AND a.user_id = p_a)
    )
  )
$function$;

-- The chat list: of these people, the ones she may message now.
CREATE OR REPLACE FUNCTION public.messageable_partners(p_partner_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT DISTINCT p FROM unnest(coalesce(p_partner_ids, '{}')) p
  WHERE auth.uid() IS NOT NULL AND public.can_message(auth.uid(), p)
$function$;

REVOKE ALL ON FUNCTION public.can_message(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.messageable_partners(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_message(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.messageable_partners(uuid[]) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Sending
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "enforce_active_connection_on_insert" ON public.messages;
DROP POLICY IF EXISTS "A member sends in her own name to someone she may message" ON public.messages;
CREATE POLICY "A member sends in her own name to someone she may message" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND auth.uid() IN (c.user1_id, c.user2_id)
        AND public.can_message(c.user1_id, c.user2_id)
    )
  );

-- ------------------------------------------------------------
-- 3. Privileges: members read, send (these columns) and mark as read; nothing signed out
-- ------------------------------------------------------------
REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT INSERT (conversation_id, sender_id, content, attachments) ON public.messages TO authenticated;
GRANT UPDATE (is_read) ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

REVOKE ALL ON public.conversations FROM PUBLIC, anon;
GRANT ALL ON public.conversations TO service_role;

-- ------------------------------------------------------------
-- 4. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid;
  v_a uuid; v_b uuid; v_c uuid;           -- A and B connected; C a stranger (the applicant)
  v_ab uuid; v_rc uuid;                   -- conversations A-B and owner-C
  v_msg bigint; v_job bigint; v_n bigint;
BEGIN
  SELECT a.company_id, a.user_id INTO v_page, v_owner
  FROM company_admins a JOIN companies co ON co.id = a.company_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;
  SELECT uuid INTO v_a FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_owner
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid NOT IN (v_owner, v_a)
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid NOT IN (v_owner, v_a, v_b)
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM connections x WHERE (x.requester_id = u.uuid AND x.receiver_id = v_owner) OR (x.requester_id = v_owner AND x.receiver_id = u.uuid))
    AND NOT EXISTS (SELECT 1 FROM company_admins x WHERE x.user_id = u.uuid)
    ORDER BY uuid LIMIT 1;
  IF v_a IS NULL OR v_b IS NULL OR v_c IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need three members'; END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM connections WHERE (requester_id = v_a AND receiver_id = v_b) OR (requester_id = v_b AND receiver_id = v_a);
    INSERT INTO connections (requester_id, receiver_id, status) VALUES (v_a, v_b, 'accepted');
    DELETE FROM conversations WHERE (user1_id, user2_id) IN ((least(v_a, v_b), greatest(v_a, v_b)), (least(v_owner, v_c), greatest(v_owner, v_c)));
    INSERT INTO conversations (user1_id, user2_id) VALUES (least(v_a, v_b), greatest(v_a, v_b)) RETURNING id INTO v_ab;
    INSERT INTO conversations (user1_id, user2_id) VALUES (least(v_owner, v_c), greatest(v_owner, v_c)) RETURNING id INTO v_rc;

    -- 1. A writes to B in her own name
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_ab, v_a, 'hello') RETURNING id INTO v_msg;
    -- 2. …but not in B's name
    BEGIN
      INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_ab, v_b, 'forged');
      v_problems := v_problems || ' a member sent a message in someone else''s name;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 3. C is not in the A-B conversation
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_ab, v_c, 'intruder');
      v_problems := v_problems || ' a member wrote into a conversation she is not part of;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 4. C may not write to the owner yet (no connection, no application)
    BEGIN
      INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_rc, v_c, 'too early');
      v_problems := v_problems || ' a member wrote to someone she is not connected to;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 5. B may mark A's message as read, not change it
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE messages SET is_read = true WHERE id = v_msg;
    BEGIN
      UPDATE messages SET content = 'changed by the recipient' WHERE id = v_msg;
      v_problems := v_problems || ' a recipient changed a message;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM messages WHERE id = v_msg AND is_read AND content = 'hello') THEN
      v_problems := v_problems || ' marking as read did not work as before;';
    END IF;

    -- 6. signed out: nothing
    PERFORM set_config('request.jwt.claims', '', true);
    SET LOCAL ROLE anon;
    BEGIN
      INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_ab, v_a, 'from the public key');
      v_problems := v_problems || ' the public key sent a message;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 7. C applies through duallin to a job on the owner's page → they may message each other
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_form)
    VALUES (v_page, 'Chat check', 'Tel Aviv', 'We are looking for an engineer and a team player. Second line of the description.',
            'internal', '{"resume": "none", "note": false, "questions": []}')
    RETURNING id INTO v_job;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO job_submissions (job_id, full_name, email) VALUES (v_job, 'Check Applicant', 'check@example.com');  -- the page is set by the database
    INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_rc, v_c, 'thank you for reading my application');
    SELECT count(*) INTO v_n FROM public.messageable_partners(ARRAY[v_owner, v_a]);
    IF v_n <> 1 THEN v_problems := v_problems || format(' the applicant''s chat list allows %s people, expected 1 (the recruiter);', v_n); END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_rc, v_owner, 'we would like to meet you');
    RESET ROLE;

    -- 8. once the application is gone, so is the permission
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM job_submissions WHERE job_id = v_job AND user_id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO messages (conversation_id, sender_id, content) VALUES (v_rc, v_owner, 'after the withdrawal');
      v_problems := v_problems || ' a recruiter still wrote after the application was withdrawn;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems; END IF;
  RAISE NOTICE 'All checks passed: members send only in their own name, in their own conversations, to a connection or (new) between an applicant and the page''s recruiters; recipients only mark as read; nothing signed out.';
END $$;

COMMIT;

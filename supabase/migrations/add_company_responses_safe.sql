-- ============================================================
-- Company pages: the company answers — SELF-CHECKING (2026-11-17). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql, add_entitlements_safe.sql and
-- add_company_voice_safe.sql (notifications.actor_company_id).
--
-- 1. company_responses: one official answer of a page to a review, an interview report or a
--    fit rating about it (not to salaries — numbers only). Written, edited and deleted by the
--    page's owner / content managers, on a managed page that isn't suspended, when its plan
--    includes 'reviews.respond'. Everyone signed in reads the answers; who typed one
--    (responded_by) is kept for the record and never handed out.
-- 2. The member who wrote the item is told (COMPANY_RESPONSE, from the page; the member
--    behind the answer is not named). An anonymous item stays anonymous: only she is told,
--    and the page never learns who she is.
-- 3. Every answer, edit and deletion is written to company_audit_log.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_responses.sql          Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_responses (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_type  text        NOT NULL CHECK (target_type IN ('review', 'interview', 'fit_rating')),
  target_id    uuid        NOT NULL,
  company_id   integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  body         text        NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  responded_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_responses_one_per_item UNIQUE (target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_company_responses_company ON public.company_responses (company_id);

ALTER TABLE public.company_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_responses FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, target_type, target_id, company_id, body, created_at, updated_at) ON public.company_responses TO authenticated;
GRANT INSERT (target_type, target_id, company_id, body) ON public.company_responses TO authenticated;
GRANT UPDATE (body) ON public.company_responses TO authenticated;
GRANT DELETE ON public.company_responses TO authenticated;
GRANT ALL ON public.company_responses TO service_role;

DROP POLICY IF EXISTS "Members read the companies' answers" ON public.company_responses;
CREATE POLICY "Members read the companies' answers" ON public.company_responses
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "A page's managers answer in its name" ON public.company_responses;
CREATE POLICY "A page's managers answer in its name" ON public.company_responses
  FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "A page's managers edit its answers" ON public.company_responses;
CREATE POLICY "A page's managers edit its answers" ON public.company_responses
  FOR UPDATE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner', 'content']))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner', 'content']));

DROP POLICY IF EXISTS "A page's managers delete its answers" ON public.company_responses;
CREATE POLICY "A page's managers delete its answers" ON public.company_responses
  FOR DELETE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner', 'content']));

-- ------------------------------------------------------------
-- 2. What an answer must be
-- ------------------------------------------------------------
-- INVOKER: reads the items (readable to every member) and the page; the plan is read
-- through entitlement_value (SECURITY DEFINER). Sessions without a member are not limited.
CREATE OR REPLACE FUNCTION public.company_responses_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_item_company integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.target_type, NEW.target_id, NEW.company_id) IS DISTINCT FROM (OLD.target_type, OLD.target_id, OLD.company_id) THEN
      RAISE EXCEPTION 'an answer stays on its item' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND page_status = 'claimed') THEN
      RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
    END IF;
    IF (SELECT enabled FROM entitlement_value('company', NEW.company_id::text, 'reviews.respond')) IS NOT TRUE THEN
      RAISE EXCEPTION 'not_in_plan' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_item_company := CASE NEW.target_type
      WHEN 'review'     THEN (SELECT company_id FROM company_reviews     WHERE id = NEW.target_id)
      WHEN 'interview'  THEN (SELECT company_id FROM company_interviews  WHERE id = NEW.target_id)
      WHEN 'fit_rating' THEN (SELECT company_id FROM company_fit_ratings WHERE id = NEW.target_id)
    END;
    IF v_item_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'item_not_about_this_page' USING ERRCODE = '42501';
    END IF;
    NEW.responded_by := auth.uid();
    NEW.created_at := now();
  ELSE
    NEW.responded_by := coalesce(auth.uid(), OLD.responded_by);
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  NEW.body := btrim(NEW.body);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS company_responses_guard ON public.company_responses;
CREATE TRIGGER company_responses_guard
  BEFORE INSERT OR UPDATE ON public.company_responses
  FOR EACH ROW EXECUTE FUNCTION public.company_responses_guard();

-- ------------------------------------------------------------
-- 3. Telling the writer, and the record
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_responses_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row    company_responses%ROWTYPE;
  v_writer uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
  BEGIN
    IF auth.uid() IS NOT NULL THEN
      INSERT INTO company_audit_log (company_id, actor_id, action, details)
      VALUES (v_row.company_id, auth.uid(),
              CASE TG_OP WHEN 'INSERT' THEN 'response_insert' WHEN 'UPDATE' THEN 'response_update' ELSE 'response_delete' END,
              jsonb_build_object('target_type', v_row.target_type, 'target_id', v_row.target_id));
    END IF;

    IF TG_OP = 'INSERT' THEN
      v_writer := CASE NEW.target_type
        WHEN 'review'     THEN (SELECT user_id FROM company_reviews     WHERE id = NEW.target_id)
        WHEN 'interview'  THEN (SELECT user_id FROM company_interviews  WHERE id = NEW.target_id)
        WHEN 'fit_rating' THEN (SELECT user_id FROM company_fit_ratings WHERE id = NEW.target_id)
      END;
      -- she is told by the page; nobody is told about her own answer
      IF v_writer IS NOT NULL AND v_writer IS DISTINCT FROM auth.uid() THEN
        PERFORM public.notification_bump(v_writer, NULL, NEW.company_id, NEW.company_id::text, 'COMPANY_RESPONSE', NULL);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company_responses_after_change: %', SQLERRM;   -- never blocks the answer itself
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.company_responses_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_responses_after_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS company_responses_after_change ON public.company_responses;
CREATE TRIGGER company_responses_after_change
  AFTER INSERT OR UPDATE OR DELETE ON public.company_responses
  FOR EACH ROW EXECUTE FUNCTION public.company_responses_after_change();

-- ------------------------------------------------------------
-- 4. Self-check
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_page integer; v_owner uuid;
  v_b uuid; v_c uuid;
  v_review uuid; v_fit uuid; v_other_review uuid;
  v_response bigint; v_n bigint;
BEGIN
  SELECT a.company_id, a.user_id INTO v_page, v_owner
  FROM company_admins a JOIN companies co ON co.id = a.company_id
  WHERE a.role = 'owner' AND co.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  IF v_page IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need one managed page with an owner'; END IF;

  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_b
    AND EXISTS (SELECT 1 FROM auth.users au WHERE au.id = u.uuid)
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  IF v_b IS NULL OR v_c IS NULL THEN RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need two members who manage no page'; END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', '', true);
    -- the setting: B reviewed the page (named) and rated its fit (anonymously); C reviewed another company
    INSERT INTO company_reviews (company_id, user_id, title, pros, cons, overall_rating, is_anonymous)
    VALUES (v_page, v_b, 'check', 'check', 'check', 4, false) RETURNING id INTO v_review;
    INSERT INTO company_fit_ratings (company_id, user_id, overall_fit_rating, is_anonymous)
    VALUES (v_page, v_b, 4, true) RETURNING id INTO v_fit;
    INSERT INTO company_reviews (company_id, user_id, title, pros, cons, overall_rating, is_anonymous)
    VALUES ((SELECT id FROM companies WHERE id <> v_page ORDER BY id LIMIT 1), v_c, 'check', 'check', 'check', 3, false) RETURNING id INTO v_other_review;
    DELETE FROM notifications WHERE user_id = v_b AND type = 'COMPANY_RESPONSE';

    -- 1. a member who doesn't manage the page cannot answer in its name
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_review, v_page, 'not mine to say');
      v_problems := v_problems || ' a member answered in the name of a page she does not manage;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- 2. the owner answers B's review → B is told by the page, the owner is not named
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_review, v_page, '  thank you  ')
    RETURNING id INTO v_response;
    -- 3. …and the anonymous fit rating
    INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('fit_rating', v_fit, v_page, 'we listened');

    -- 4. a second answer to the same item is refused
    BEGIN
      INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_review, v_page, 'again');
      v_problems := v_problems || ' an item got two answers;';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- 5. a review about another company cannot be answered by this page
    BEGIN
      INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_other_review, v_page, 'not about us');
      v_problems := v_problems || ' a page answered a review about another company;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 6. an answer cannot be moved to another item
    BEGIN
      UPDATE company_responses SET target_id = v_fit WHERE id = v_response;
      v_problems := v_problems || ' an answer was moved to another item;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- 7. who answered is not readable
    BEGIN
      PERFORM responded_by FROM company_responses WHERE id = v_response;
      v_problems := v_problems || ' a member could read who typed an answer;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    IF NOT EXISTS (SELECT 1 FROM company_responses WHERE id = v_response AND body = 'thank you' AND responded_by = v_owner) THEN
      v_problems := v_problems || ' the answer was not kept as written (trimmed, with who wrote it);';
    END IF;
    SELECT count(*) INTO v_n FROM notifications
    WHERE user_id = v_b AND type = 'COMPANY_RESPONSE' AND actor_id IS NULL AND actor_company_id = v_page AND target_id = v_page::text;
    IF v_n <> 1 THEN v_problems := v_problems || format(' the writer got %s notification lines, expected 1 (both answers on one line);', v_n); END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_b AND type = 'COMPANY_RESPONSE' AND count = 2) THEN
      v_problems := v_problems || ' two answers were not counted on the writer''s line;';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM company_audit_log WHERE company_id = v_page AND action = 'response_insert' AND details->>'target_id' = v_review::text) THEN
      v_problems := v_problems || ' the answer was not written to the page''s record;';
    END IF;

    -- 8. a member who doesn't manage the page cannot change or delete the answer
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE company_responses SET body = 'changed by a stranger' WHERE id = v_response;
    DELETE FROM company_responses WHERE id = v_response;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM company_responses WHERE id = v_response AND body = 'thank you') THEN
      v_problems := v_problems || ' a member who does not manage the page changed or deleted its answer;';
    END IF;

    -- 9. the owner edits and deletes the answer
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE company_responses SET body = 'thank you, edited' WHERE id = v_response;
    DELETE FROM company_responses WHERE id = v_response;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM company_responses WHERE id = v_response) THEN
      v_problems := v_problems || ' the owner could not delete the page''s answer;';
    END IF;

    -- 10. without 'reviews.respond' in the plan, the page cannot answer
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled, reason)
    VALUES ('company', v_page::text, 'reviews.respond', false, 'self-check');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_responses (target_type, target_id, company_id, body) VALUES ('review', v_review, v_page, 'without the plan');
      v_problems := v_problems || ' a page answered without the plan for it;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM company_reviews WHERE id IN (v_review, v_other_review)) THEN v_problems := v_problems || ' test reviews were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: a page''s managers answer an item about the page once, edit and delete it; nobody else can; the writer is told by the page; who typed the answer stays private.';
END $$;

COMMIT;

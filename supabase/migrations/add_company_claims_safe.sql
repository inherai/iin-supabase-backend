-- ============================================================
-- Asking to manage a page, reporting a page, pages a member follows — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql.
--
--   company_claims   a member asks to manage an existing page, or to open a page for an
--                    organization that isn't listed yet. A Duallin admin approves or rejects.
--                    On approval the member becomes a manager of the page (and the page is
--                    created first, when it is a new organization).
--   company_reports  a member reports a page (impersonation, wrong details, ...). Same shape
--                    as post_reports.
--   followed_companies()  the pages a member follows, for the "following" card on her
--                    profile — shown to other members as on LinkedIn, never for an
--                    anonymous member.
--
-- Who may do what — row-level security, in the member's own session, no service role:
--   * a member files a claim / report in her own name only, and sees her own
--   * she may withdraw a claim that is still waiting
--   * a page's owners see the claims waiting on their page
--   * only a Duallin admin decides a claim or resolves a report; a decision is final
--   * at most 5 claims waiting per member
-- Two functions run with the table owner's rights (SECURITY DEFINER):
--   company_claim_decide   when an admin approves, it creates the page if needed and makes
--                          the member a manager — two things neither the member nor a plain
--                          update could do. It refuses unless the session is an admin's.
--   followed_companies     a member's follows are otherwise readable only by herself; this
--                          gives other members the list of pages (nothing else), and gives
--                          nothing at all for an anonymous member.
--
-- Automatic approval by a work-email code is NOT part of this file; it needs one piece that
-- runs outside any member's session and will be presented separately first.
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_claims.sql        Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. company_claims
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_claims (
  id              bigserial   PRIMARY KEY,
  company_id      integer              REFERENCES public.companies(id) ON DELETE CASCADE,   -- NULL = a page that doesn't exist yet
  requested_by    uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  org_name        text                 CHECK (org_name IS NULL OR (length(org_name) <= 120 AND org_name !~ '[<>]')),   -- becomes the page's name
  org_type        text        NOT NULL DEFAULT 'company' CHECK (org_type IN ('company', 'nonprofit', 'public', 'education', 'other')),
  website         text                 CHECK (website IS NULL OR (website ~* '^https://' AND length(website) <= 500)),
  requester_title text        NOT NULL CHECK (length(btrim(requester_title)) BETWEEN 2 AND 120),
  work_email      text        NOT NULL CHECK (work_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND length(work_email) <= 200),
  message         text                 CHECK (message IS NULL OR length(message) <= 1000),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  granted_role    text        NOT NULL DEFAULT 'owner' CHECK (granted_role IN ('owner', 'content', 'recruiter', 'analyst')),
  review_note     text                 CHECK (review_note IS NULL OR length(review_note) <= 1000),
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (company_id IS NOT NULL OR length(btrim(coalesce(org_name, ''))) >= 2)
);
-- one waiting claim per member per page / per new organization
CREATE UNIQUE INDEX IF NOT EXISTS company_claims_one_pending_per_page
  ON public.company_claims (requested_by, company_id) WHERE status = 'pending' AND company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS company_claims_one_pending_per_new_org
  ON public.company_claims (requested_by, lower(btrim(org_name))) WHERE status = 'pending' AND company_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_company_claims_status ON public.company_claims (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_claims_company ON public.company_claims (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.company_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own claims, a page's owners, admins" ON public.company_claims;
CREATE POLICY "Own claims, a page's owners, admins"
  ON public.company_claims FOR SELECT TO authenticated
  USING (requested_by = auth.uid()
         OR public.is_platform_admin()
         OR (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner'])));

DROP POLICY IF EXISTS "A member files her own claim" ON public.company_claims;
CREATE POLICY "A member files her own claim"
  ON public.company_claims FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid());

DROP POLICY IF EXISTS "A member withdraws her waiting claim" ON public.company_claims;
CREATE POLICY "A member withdraws her waiting claim"
  ON public.company_claims FOR DELETE TO authenticated
  USING (requested_by = auth.uid() AND status = 'pending');

DROP POLICY IF EXISTS "Admins decide claims" ON public.company_claims;
CREATE POLICY "Admins decide claims"
  ON public.company_claims FOR UPDATE TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

-- A member supplies only the request itself; status and the decision fields are not hers to set.
REVOKE ALL ON TABLE public.company_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.company_claims TO authenticated;
GRANT INSERT (company_id, org_name, org_type, website, requester_title, work_email, message)
  ON TABLE public.company_claims TO authenticated;
GRANT UPDATE (status, granted_role, review_note) ON TABLE public.company_claims TO authenticated;
GRANT ALL ON TABLE public.company_claims TO service_role;
REVOKE ALL ON SEQUENCE public.company_claims_id_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.company_claims_id_seq TO authenticated, service_role;

-- Filing: always in the caller's own name, not for a page she already manages, not more
-- than 5 waiting at once.
CREATE OR REPLACE FUNCTION public.company_claim_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  NEW.requested_by := auth.uid();
  IF NEW.company_id IS NOT NULL AND public.has_company_role(NEW.company_id) THEN
    RAISE EXCEPTION 'You already manage this page' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM company_claims WHERE requested_by = auth.uid() AND status = 'pending') >= 5 THEN
    RAISE EXCEPTION 'Too many requests waiting for review' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_company_claim_before_insert ON public.company_claims;
CREATE TRIGGER trg_company_claim_before_insert
  BEFORE INSERT ON public.company_claims
  FOR EACH ROW EXECUTE FUNCTION public.company_claim_before_insert();

-- Deciding: an admin sets status to approved / rejected. Approval creates the page when it
-- is a new organization and makes the member a manager. A decision can't be changed.
CREATE OR REPLACE FUNCTION public.company_claim_decide()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'This request was already decided' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;                       -- a note or the role, edited while still waiting
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'This request was already decided' USING ERRCODE = 'P0001';
  END IF;

  NEW.reviewed_by := auth.uid();
  NEW.reviewed_at := now();

  IF NEW.status = 'approved' THEN
    IF NEW.company_id IS NULL THEN
      -- a new organization: the page is created here (a duplicate of a managed page is refused
      -- by the companies trigger, an identical name by the unique name)
      INSERT INTO companies (name, org_type, website, active, source)
      VALUES (btrim(NEW.org_name), NEW.org_type, NEW.website, true, 'claim')
      RETURNING id INTO NEW.company_id;
    END IF;
    INSERT INTO company_admins (company_id, user_id, role)
    VALUES (NEW.company_id, NEW.requested_by, NEW.granted_role)
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.company_claim_decide() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_company_claim_decide ON public.company_claims;
CREATE TRIGGER trg_company_claim_decide
  BEFORE UPDATE ON public.company_claims
  FOR EACH ROW EXECUTE FUNCTION public.company_claim_decide();

-- ------------------------------------------------------------
-- 2. company_reports
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_reports (
  id              bigserial   PRIMARY KEY,
  company_id      integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reporter_id     uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  reason          text        NOT NULL CHECK (reason IN ('impersonation', 'wrong_info', 'inappropriate', 'spam', 'other')),
  details         text                 CHECK (details IS NULL OR length(details) <= 1000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  is_resolved     boolean     NOT NULL DEFAULT false,
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolution_note text                 CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_reports_one_open_per_reporter
  ON public.company_reports (company_id, reporter_id) WHERE NOT is_resolved;
CREATE INDEX IF NOT EXISTS idx_company_reports_open ON public.company_reports (is_resolved, created_at DESC);

ALTER TABLE public.company_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own reports and admins" ON public.company_reports;
CREATE POLICY "Own reports and admins"
  ON public.company_reports FOR SELECT TO authenticated
  USING (reporter_id = auth.uid() OR public.is_platform_admin());

DROP POLICY IF EXISTS "A member files her own report" ON public.company_reports;
CREATE POLICY "A member files her own report"
  ON public.company_reports FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS "Admins resolve reports" ON public.company_reports;
CREATE POLICY "Admins resolve reports"
  ON public.company_reports FOR UPDATE TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

REVOKE ALL ON TABLE public.company_reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.company_reports TO authenticated;
GRANT INSERT (company_id, reason, details) ON TABLE public.company_reports TO authenticated;
GRANT UPDATE (is_resolved, resolved_at, resolved_by, resolution_note) ON TABLE public.company_reports TO authenticated;
GRANT ALL ON TABLE public.company_reports TO service_role;
REVOKE ALL ON SEQUENCE public.company_reports_id_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.company_reports_id_seq TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. The pages a member follows, for her profile.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.followed_companies(p_user uuid)
RETURNS TABLE (id integer, slug text, name text, name_he text, logo text, tagline text, verified boolean, followers_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.slug, c.name, c.name_he, c.logo, c.tagline, c.verified, c.followers_count
  FROM article_company_follows f
  JOIN companies c ON c.id = f.company_id
  WHERE f.follower_uuid = p_user
    AND c.page_status <> 'suspended'
    AND (p_user = auth.uid()
         OR EXISTS (SELECT 1 FROM users u WHERE u.uuid = p_user AND u.status = 'Active' AND u.is_anonymous IS NOT TRUE))
  ORDER BY f.created_at DESC
  LIMIT 50
$$;
REVOKE ALL ON FUNCTION public.followed_companies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.followed_companies(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_a uuid; v_a_email text; v_b uuid; v_b_email text;
  v_claim bigint; v_claim_new bigint; v_n bigint; v_new_company integer; v_anon uuid;
BEGIN
  SELECT uuid INTO v_anon FROM users WHERE is_anonymous IS TRUE AND status = 'Active' ORDER BY uuid LIMIT 1;
  SELECT id INTO v_company FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT uuid, email INTO v_a, v_a_email FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid, email INTO v_b, v_b_email FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_a AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  BEGIN
    -- ===== member A =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'email', v_a_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      -- 1. files a claim on an existing page and one for a new organization
      INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (v_company, 'Head of Marketing', 'a@example.com') RETURNING id INTO v_claim;
      INSERT INTO company_claims (org_name, org_type, website, requester_title, work_email) VALUES ('Duallin Claim Check 7f3a', 'nonprofit', 'https://example.org', 'Founder', 'a@example.org') RETURNING id INTO v_claim_new;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a member could not file a claim: ' || SQLERRM || ';';
    END;
    -- 2. not twice for the same page
    BEGIN
      INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (v_company, 'Again', 'a@example.com');
      v_problems := v_problems || ' the same claim was filed twice;';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- 3. cannot file in someone else's name, set the status, or approve her own
    BEGIN
      INSERT INTO company_claims (company_id, requested_by, requester_title, work_email) VALUES (v_company, v_b, 'x x', 'a@example.com');
      v_problems := v_problems || ' a member set requested_by;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      INSERT INTO company_claims (org_name, status, requester_title, work_email) VALUES ('Self Approved 7f3a', 'approved', 'x x', 'a@example.com');
      v_problems := v_problems || ' a member set the status of her claim;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE company_claims SET status = 'approved' WHERE id = v_claim;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member approved her own claim;'; END IF;
    -- 4. reports a page, once
    BEGIN
      INSERT INTO company_reports (company_id, reason, details) VALUES (v_company, 'wrong_info', 'check');
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a member could not report a page: ' || SQLERRM || ';';
    END;
    BEGIN
      INSERT INTO company_reports (company_id, reason) VALUES (v_company, 'spam');
      v_problems := v_problems || ' the same page was reported twice by one member;';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    RESET ROLE;

    -- A follows the page, and so does an anonymous member (when there is one)
    INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (v_a, v_company) ON CONFLICT DO NOTHING;
    IF v_anon IS NOT NULL THEN
      INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (v_anon, v_company) ON CONFLICT DO NOTHING;
    END IF;

    -- ===== member B sees none of it =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 4b. but does see which pages A follows — unless A is anonymous
    SELECT count(*) INTO v_n FROM followed_companies(v_a) WHERE id = v_company;
    IF v_n <> 1 THEN v_problems := v_problems || ' a member cannot see the pages another member follows;'; END IF;
    IF v_anon IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM followed_companies(v_anon);
      IF v_n <> 0 THEN v_problems := v_problems || ' the pages an anonymous member follows are visible;'; END IF;
    END IF;
    SELECT (SELECT count(*) FROM company_claims WHERE requested_by = v_a) + (SELECT count(*) FROM company_reports WHERE reporter_id = v_a) INTO v_n;
    IF v_n <> 0 THEN v_problems := v_problems || ' another member can see claims / reports;'; END IF;
    RESET ROLE;

    -- ===== a Duallin admin, in her own session =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      -- 5. approves the claim on the existing page: A becomes its owner, the page is managed
      UPDATE company_claims SET status = 'approved' WHERE id = v_claim;
      IF NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_company AND user_id = v_a AND role = 'owner') THEN
        v_problems := v_problems || ' approval did not make the member an owner;';
      END IF;
      IF (SELECT reviewed_by FROM company_claims WHERE id = v_claim) IS DISTINCT FROM v_b THEN v_problems := v_problems || ' the deciding admin was not recorded;'; END IF;
      -- 6. approves the new organization as content manager: the page is created with an address
      UPDATE company_claims SET status = 'approved', granted_role = 'content' WHERE id = v_claim_new RETURNING company_id INTO v_new_company;
      IF v_new_company IS NULL
         OR NOT EXISTS (SELECT 1 FROM companies WHERE id = v_new_company AND slug IS NOT NULL AND org_type = 'nonprofit')
         OR NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_new_company AND user_id = v_a AND role = 'content') THEN
        v_problems := v_problems || ' approving a new organization did not create its page and manager;';
      END IF;
      -- 7. a decision is final
      BEGIN
        UPDATE company_claims SET status = 'rejected' WHERE id = v_claim;
        v_problems := v_problems || ' a decided claim was changed;';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
      END;
      -- 8. resolves the report
      UPDATE company_reports SET is_resolved = true, resolved_at = now(), resolved_by = v_b WHERE company_id = v_company;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN v_problems := v_problems || ' an admin could not resolve a report;'; END IF;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' an admin action failed: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    -- ===== A again: now a manager, cannot claim the page she manages =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'email', v_a_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (v_company, 'Again', 'a@example.com');
      v_problems := v_problems || ' a manager claimed her own page;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    RESET ROLE;

    -- ===== signed-out visitor =====
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM company_claims LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read claims;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM company_reports LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read reports;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM companies WHERE name = 'Duallin Claim Check 7f3a') THEN v_problems := v_problems || ' test rows were left behind;'; END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: claims filed, withdrawn and decided by the right people only; approval creates the page and its manager; reports work; signed-out blocked.';
END $$;

COMMIT;

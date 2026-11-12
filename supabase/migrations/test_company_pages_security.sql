-- ============================================================
-- Company pages — what each kind of member can and cannot do, tried directly against the
-- database (the way someone bypassing our API would). CHANGES NOTHING: everything runs in one
-- transaction that is rolled back at the end.
--
-- Run it in the SQL Editor after the company-pages migrations, and again after any later
-- change to them. Expected last line:   NOTICE: PASSED — <n> attempts behaved as expected
-- A failure stops with:                 FAILED — <what was allowed or refused wrongly>
--
-- The cast (all real, picked from the table; nothing about them is changed for good):
--   OWNER    made owner of a test page          CONTENT  content manager of the same page
--   ANALYST  analyst of the same page           MEMBER   manages nothing
--   OTHER    owner of a second test page        ADMIN    a member whose session says is_admin
--   VISITOR  not signed in
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_fail text := '';
  v_n integer := 0;
  v_page integer; v_page2 integer; v_name text;
  v_owner uuid; v_content uuid; v_analyst uuid; v_member uuid; v_other uuid;
  v_rows bigint; v_claim bigint; v_txt text;
  r record;

  -- attempts that must be REFUSED (an error, or zero rows changed), per actor
  v_refused text[][] := ARRAY[
    -- ordinary member: nothing on a page she doesn't manage
    ['MEMBER',  'UPDATE companies SET tagline = ''x'' WHERE id = %1$s'],
    ['MEMBER',  'UPDATE companies SET name = ''x'' WHERE id = %1$s'],
    ['MEMBER',  'INSERT INTO company_admins (company_id, user_id, role) VALUES (%1$s, auth.uid(), ''owner'')'],
    ['MEMBER',  'UPDATE company_admins SET role = ''analyst'' WHERE company_id = %1$s'],
    ['MEMBER',  'DELETE FROM company_admins WHERE company_id = %1$s'],
    ['MEMBER',  'INSERT INTO company_audit_log (company_id, action) VALUES (%1$s, ''forged'')'],
    ['MEMBER',  'DELETE FROM company_audit_log WHERE company_id = %1$s'],
    ['MEMBER',  'SELECT admin_update_company(%1$s, ''{"verified": true}''::jsonb)'],
    ['MEMBER',  'INSERT INTO subscriptions (subject_type, subject_id, plan_key) VALUES (''company'', ''%1$s'', ''free'')'],
    ['MEMBER',  'INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled) VALUES (''company'', ''%1$s'', ''jobs.featured'', true)'],
    ['MEMBER',  'INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES (''company'', ''%1$s'', 1000, ''gift'')'],
    ['MEMBER',  'UPDATE plan_features SET limit_value = 1'],
    ['MEMBER',  'DELETE FROM features'],
    ['MEMBER',  'SELECT entitlement_consume(''company'', ''%1$s'', ''page.follow_invites.monthly'')'],
    ['MEMBER',  'SELECT credits_spend(''company'', ''%1$s'', 1, ''x'')'],
    ['MEMBER',  'SELECT * FROM entitlements_for(''company'', ''%1$s'')'],
    ['MEMBER',  'INSERT INTO company_claims (company_id, requested_by, requester_title, work_email) VALUES (%1$s, ''%4$s'', ''CEO'', ''a@b.co'')'],
    ['MEMBER',  'INSERT INTO company_claims (company_id, status, requester_title, work_email) VALUES (%1$s, ''approved'', ''CEO'', ''a@b.co'')'],
    ['MEMBER',  'INSERT INTO company_claims (company_id, granted_role, requester_title, work_email) VALUES (%1$s, ''owner'', ''CEO'', ''a@b.co'')'],
    ['MEMBER',  'INSERT INTO company_reports (company_id, reporter_id, reason) VALUES (%2$s, ''%4$s'', ''spam'')'],
    ['MEMBER',  'INSERT INTO company_reports (company_id, reason, is_resolved) VALUES (%1$s, ''spam'', true)'],
    ['MEMBER',  'INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (''%4$s'', %2$s)'],
    ['MEMBER',  'DELETE FROM article_company_follows WHERE follower_uuid = ''%4$s'''],
    ['MEMBER',  'INSERT INTO companies (name) VALUES (''Member Made Co 7f3a'')'],
    ['MEMBER',  'DELETE FROM companies WHERE id = %1$s'],
    -- content manager: edits the page, nothing more
    ['CONTENT', 'UPDATE companies SET name = ''Renamed 7f3a'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET verified = true WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET page_status = ''unclaimed'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET slug = ''stolen-slug'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET owner_uuid = auth.uid() WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET followers_count = 99999 WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET import_name = ''x'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET employees = ''{}'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET active = false WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET tagline = ''x'' WHERE id = %2$s'],
    ['CONTENT', 'UPDATE companies SET description = ''<script>alert(1)</script>'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET website = ''javascript:alert(1)'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET logo = ''https://evil.example/x.png'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE companies SET cta_type = ''website'', cta_url = ''javascript:alert(1)'' WHERE id = %1$s'],
    ['CONTENT', 'UPDATE company_admins SET role = ''owner'' WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['CONTENT', 'INSERT INTO company_admins (company_id, user_id, role) VALUES (%1$s, ''%3$s'', ''content'')'],
    ['CONTENT', 'DELETE FROM company_admins WHERE company_id = %1$s AND user_id <> auth.uid()'],
    ['CONTENT', 'SELECT 1/count(*) FROM company_audit_log WHERE company_id = %1$s'],
    ['CONTENT', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%2$s/logo-1.jpg'')'],
    ['CONTENT', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''logo-1.jpg'')'],
    -- analyst: sees, changes nothing
    ['ANALYST', 'UPDATE companies SET tagline = ''x'' WHERE id = %1$s'],
    ['ANALYST', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%1$s/logo-1.jpg'')'],
    ['ANALYST', 'SELECT entitlement_consume(''company'', ''%1$s'', ''page.follow_invites.monthly'')'],
    ['ANALYST', 'INSERT INTO company_admins (company_id, user_id, role) VALUES (%1$s, ''%3$s'', ''analyst'')'],
    -- owner: runs her page, not Duallin's side of it and not other pages
    ['OWNER',   'UPDATE companies SET verified = true WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET page_status = ''unclaimed'' WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET slug = ''stolen-slug'' WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET followers_count = 99999 WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET name = (SELECT name FROM companies WHERE id = %2$s) WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET name = ''   '' WHERE id = %1$s'],
    ['OWNER',   'UPDATE companies SET tagline = ''x'' WHERE id = %2$s'],
    ['OWNER',   'INSERT INTO company_admins (company_id, user_id, role) VALUES (%2$s, auth.uid(), ''owner'')'],
    ['OWNER',   'UPDATE company_admins SET company_id = %2$s WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['OWNER',   'UPDATE company_admins SET user_id = ''%3$s'' WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['OWNER',   'DELETE FROM company_admins WHERE company_id = %2$s'],
    ['OWNER',   'DELETE FROM company_admins WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['OWNER',   'UPDATE company_admins SET role = ''content'' WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['OWNER',   'DELETE FROM company_audit_log WHERE company_id = %1$s'],
    ['OWNER',   'UPDATE company_audit_log SET action = ''x'' WHERE company_id = %1$s'],
    ['OWNER',   'SELECT admin_update_company(%1$s, ''{"verified": true}''::jsonb)'],
    ['OWNER',   'INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES (''company'', ''%1$s'', 1000, ''gift'')'],
    ['OWNER',   'INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled) VALUES (''company'', ''%1$s'', ''jobs.featured'', true)'],
    ['OWNER',   'UPDATE usage_counters SET used = 0'],
    ['OWNER',   'UPDATE company_claims SET status = ''approved'' WHERE company_id = %1$s'],
    ['OWNER',   'DELETE FROM company_claims WHERE company_id = %1$s'],
    ['OWNER',   'UPDATE company_reports SET is_resolved = true WHERE company_id = %1$s'],
    ['OWNER',   'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%2$s/logo-1.jpg'')'],
    ['OWNER',   'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%1$s/../%2$s/logo-1.jpg'')'],
    -- the owner of another page has no say here
    ['OTHER',   'UPDATE companies SET tagline = ''x'' WHERE id = %1$s'],
    ['OTHER',   'INSERT INTO company_admins (company_id, user_id, role) VALUES (%1$s, auth.uid(), ''owner'')'],
    ['OTHER',   'DELETE FROM company_admins WHERE company_id = %1$s'],
    ['OTHER',   'SELECT 1/count(*) FROM company_admins WHERE company_id = %1$s'],
    ['OTHER',   'SELECT 1/count(*) FROM company_audit_log WHERE company_id = %1$s'],
    ['OTHER',   'SELECT 1/count(*) FROM company_claims WHERE requested_by <> auth.uid()'],
    ['OTHER',   'SELECT credits_spend(''company'', ''%1$s'', 1, ''x'')'],
    -- not signed in: nothing at all
    ['VISITOR', 'SELECT 1 FROM companies LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM company_admins LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM company_audit_log LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM company_claims LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM company_reports LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM plans LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM subscriptions LIMIT 1'],
    ['VISITOR', 'SELECT 1 FROM credit_ledger LIMIT 1'],
    ['VISITOR', 'SELECT * FROM entitlement_value(''company'', ''%1$s'', ''jobs.featured'')'],
    ['VISITOR', 'SELECT * FROM followed_companies(''%3$s'')'],
    ['VISITOR', 'SELECT has_company_role(%1$s)'],
    ['VISITOR', 'SELECT admin_update_company(%1$s, ''{}''::jsonb)'],
    ['VISITOR', 'INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (%1$s, ''CEO'', ''a@b.co'')'],
    ['VISITOR', 'INSERT INTO company_reports (company_id, reason) VALUES (%1$s, ''spam'')'],
    ['VISITOR', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%1$s/logo-1.jpg'')']
  ];

  -- attempts that must SUCCEED (and change at least one row, when they write)
  v_allowed text[][] := ARRAY[
    ['MEMBER',  'SELECT 1/count(*) FROM companies WHERE id = %1$s'],
    ['MEMBER',  'SELECT 1/count(*) FROM features'],
    ['MEMBER',  'SELECT 1/count(*) FROM entitlement_value(''company'', ''%1$s'', ''jobs.featured'') WHERE enabled'],
    ['MEMBER',  'INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (auth.uid(), %1$s)'],
    ['MEMBER',  'DELETE FROM article_company_follows WHERE follower_uuid = auth.uid() AND company_id = %1$s'],
    ['MEMBER',  'INSERT INTO company_claims (company_id, requester_title, work_email) VALUES (%2$s, ''Head of HR'', ''hr@example.com'')'],
    ['MEMBER',  'INSERT INTO company_reports (company_id, reason, details) VALUES (%1$s, ''wrong_info'', ''1 < 2 & more'')'],
    ['CONTENT', 'UPDATE companies SET tagline = ''Edited by content'', description = E''Plain\ntext'', website = ''https://example.com'' WHERE id = %1$s'],
    ['CONTENT', 'INSERT INTO storage.objects (bucket_id, name) VALUES (''company-media'', ''%1$s/cover-1.jpg'')'],
    ['CONTENT', 'UPDATE companies SET cover_image_url = ''https://api.duallin.com/storage/v1/object/public/company-media/%1$s/cover-1.jpg'' WHERE id = %1$s'],
    ['CONTENT', 'SELECT 1/count(*) FROM company_admins WHERE company_id = %1$s'],
    ['CONTENT', 'SELECT 1/count(*) FROM entitlements_for(''company'', ''%1$s'')'],
    ['CONTENT', 'SELECT entitlement_consume(''company'', ''%1$s'', ''page.follow_invites.monthly'')'],
    ['ANALYST', 'SELECT 1/count(*) FROM company_admins WHERE company_id = %1$s'],
    ['ANALYST', 'SELECT 1/count(*) FROM entitlements_for(''company'', ''%1$s'')'],
    ['ANALYST', 'DELETE FROM company_admins WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['OWNER',   'UPDATE companies SET name = ''Security Check Renamed 7f3a'', name_he = ''בדיקה'' WHERE id = %1$s'],
    ['OWNER',   'SELECT 1/count(*) FROM company_audit_log WHERE company_id = %1$s'],
    ['OWNER',   'INSERT INTO company_admins (company_id, user_id, role) VALUES (%1$s, ''%3$s'', ''recruiter'')'],
    ['OWNER',   'UPDATE company_admins SET role = ''owner'' WHERE company_id = %1$s AND user_id = ''%3$s'''],
    ['OWNER',   'DELETE FROM company_admins WHERE company_id = %1$s AND user_id = auth.uid()'],
    ['ADMIN',   'SELECT admin_update_company(%1$s, ''{"verified": true, "page_status": "suspended"}''::jsonb)'],
    ['ADMIN',   'UPDATE company_claims SET status = ''approved'', granted_role = ''content'' WHERE company_id = %2$s AND status = ''pending'''],
    ['ADMIN',   'UPDATE company_reports SET is_resolved = true, resolved_at = now() WHERE company_id = %1$s'],
    ['ADMIN',   'INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled) VALUES (''company'', ''%1$s'', ''jobs.featured'', false)'],
    ['ADMIN',   'INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES (''company'', ''%1$s'', 10, ''grant'')']
  ];
  v_actor text; v_sql text; v_uid uuid; v_ok boolean; v_err text;
BEGIN
  -- the cast
  SELECT array_agg(id ORDER BY id) INTO STRICT v_txt FROM (
    SELECT id FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL
      AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 2) x;
  v_page := (v_txt::integer[])[1]; v_page2 := (v_txt::integer[])[2];
  SELECT name INTO v_name FROM companies WHERE id = v_page;
  SELECT array_agg(uuid ORDER BY uuid) INTO STRICT v_txt FROM (
    SELECT uuid FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%'
      AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid)
      AND NOT EXISTS (SELECT 1 FROM article_company_follows f WHERE f.follower_uuid = u.uuid)
    ORDER BY uuid LIMIT 5) x;
  v_owner := (v_txt::uuid[])[1]; v_content := (v_txt::uuid[])[2]; v_analyst := (v_txt::uuid[])[3];
  v_member := (v_txt::uuid[])[4]; v_other := (v_txt::uuid[])[5];
  IF v_page2 IS NULL OR v_other IS NULL THEN RAISE EXCEPTION 'Not enough unmanaged companies / members to run the test'; END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO company_admins (company_id, user_id, role) VALUES
    (v_page, v_owner, 'owner'), (v_page, v_content, 'content'), (v_page, v_analyst, 'analyst'), (v_page2, v_other, 'owner');
  INSERT INTO company_claims (company_id, requested_by, requester_title, work_email) VALUES (v_page, v_other, 'Someone', 's@example.com');
  INSERT INTO company_reports (company_id, reporter_id, reason) VALUES (v_page, v_other, 'spam');
  INSERT INTO article_company_follows (follower_uuid, company_id) VALUES (v_other, v_page);
  INSERT INTO usage_counters (subject_type, subject_id, feature_key, period_start, used) VALUES ('company', v_page::text, 'page.follow_invites.monthly', public.entitlement_period_start('month'), 1);

  -- ---------- must be refused ----------
  FOR i IN 1 .. array_length(v_refused, 1) LOOP
    v_actor := v_refused[i][1];
    v_sql := format(v_refused[i][2], v_page, v_page2, v_member, v_other);
    v_uid := CASE v_actor WHEN 'OWNER' THEN v_owner WHEN 'CONTENT' THEN v_content WHEN 'ANALYST' THEN v_analyst WHEN 'MEMBER' THEN v_member WHEN 'OTHER' THEN v_other END;
    v_n := v_n + 1;
    BEGIN
      IF v_actor = 'VISITOR' THEN
        PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
        SET LOCAL ROLE anon;
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
      END IF;
      EXECUTE v_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RESET ROLE;
      -- no error: acceptable only if it touched nothing (row-level security hid the rows)
      IF v_rows > 0 THEN
        v_fail := v_fail || format(E'\n  ALLOWED but must be refused — %s: %s', v_actor, v_sql);
      END IF;
      -- undo whatever a wrongly-allowed attempt did, so later attempts start clean
      RAISE EXCEPTION USING ERRCODE = 'P0002';
    EXCEPTION
      WHEN SQLSTATE 'P0002' THEN RESET ROLE;
      -- refused with an error — but only the errors a refusal produces count: no permission,
      -- a rule or check violated, a duplicate, or (our "can she see any row?" probe) a division
      -- by zero. Anything else means the attempt itself is broken and proves nothing.
      WHEN insufficient_privilege OR check_violation OR unique_violation OR division_by_zero OR SQLSTATE 'P0001' THEN RESET ROLE;
      WHEN OTHERS THEN
        RESET ROLE;
        v_fail := v_fail || format(E'\n  UNEXPECTED ERROR (%s) — %s: %s — %s', SQLSTATE, v_actor, v_sql, SQLERRM);
    END;
  END LOOP;

  -- ---------- must be allowed (in order; each builds on the previous) ----------
  FOR i IN 1 .. array_length(v_allowed, 1) LOOP
    v_actor := v_allowed[i][1];
    v_sql := format(v_allowed[i][2], v_page, v_page2, v_member, v_other);
    v_uid := CASE v_actor WHEN 'OWNER' THEN v_owner WHEN 'CONTENT' THEN v_content WHEN 'ANALYST' THEN v_analyst WHEN 'MEMBER' THEN v_member WHEN 'OTHER' THEN v_other ELSE v_member END;
    v_n := v_n + 1;
    v_ok := true; v_err := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated',
        'app_metadata', json_build_object('is_admin', v_actor = 'ADMIN'))::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE v_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RESET ROLE;
      IF v_rows = 0 THEN v_ok := false; v_err := 'no row was read or changed'; END IF;
    EXCEPTION WHEN OTHERS THEN
      RESET ROLE; v_ok := false; v_err := SQLERRM;
    END;
    IF NOT v_ok THEN v_fail := v_fail || format(E'\n  REFUSED but must be allowed — %s: %s  (%s)', v_actor, v_sql, v_err); END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ---------- what the allowed steps must have left behind ----------
  v_n := v_n + 8;
  SELECT * INTO r FROM companies WHERE id = v_page;
  IF r.tagline IS DISTINCT FROM 'Edited by content' THEN v_fail := v_fail || E'\n  the content manager''s edit was not saved'; END IF;
  IF r.name <> 'Security Check Renamed 7f3a' OR r.import_name IS DISTINCT FROM v_name THEN v_fail := v_fail || E'\n  the rename did not keep the imported name'; END IF;
  IF NOT r.verified OR r.page_status <> 'suspended' THEN v_fail := v_fail || E'\n  the admin''s save did not apply'; END IF;
  IF NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_page AND user_id = v_member AND role = 'owner') THEN v_fail := v_fail || E'\n  ownership was not handed over'; END IF;
  IF EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_page AND user_id IN (v_owner, v_analyst)) THEN v_fail := v_fail || E'\n  a manager who left is still listed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM company_admins WHERE company_id = v_page2 AND user_id = v_member AND role = 'content') THEN v_fail := v_fail || E'\n  the approved claim did not make the member a content manager'; END IF;
  IF (SELECT count(*) FROM company_audit_log WHERE company_id = v_page AND actor_id IS NOT NULL) < 6 THEN v_fail := v_fail || E'\n  the page history is missing lines'; END IF;
  -- a suspended page: its managers can no longer edit it
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_content, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE companies SET tagline = 'after suspension' WHERE id = v_page;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    IF v_rows > 0 THEN v_fail := v_fail || E'\n  a suspended page was edited by its manager'; END IF;
  EXCEPTION WHEN OTHERS THEN RESET ROLE;
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'FAILED — %', v_fail;
  END IF;
  RAISE NOTICE 'PASSED — % attempts behaved as expected (% refused, % allowed, 8 outcomes)', v_n, array_length(v_refused, 1), array_length(v_allowed, 1);
END $$;

ROLLBACK;

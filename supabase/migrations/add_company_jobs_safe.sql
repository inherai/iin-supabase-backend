-- ============================================================
-- Company jobs and applications — SELF-CHECKING (2026-11-12). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql, add_entitlements_safe.sql, add_company_notifications_safe.sql.
--
-- What it adds
--   1. A page's owner / recruiter publishes jobs herself (open_position rows with source 'Duallin'),
--      in her own session. The database decides what she may write: plain text only, the shown
--      description is built here from her text (no HTML of hers is ever stored), the job's
--      identity fields are fixed, and the plan's limit on open jobs is enforced.
--   2. Per job she chooses how to receive candidates: an outside link, or inside Duallin — and
--      then what to ask for (resume file: required / optional / none, a note, up to 5 questions).
--   3. job_submissions: an application inside Duallin. The candidate types the name, e-mail and
--      phone she wants the company to have — nothing is taken from her profile behind her back.
--      She and that page's owners / recruiters read it; Duallin admins can read it too, for
--      support, but change nothing in it. Her private tracker (job_applications) moves to
--      "applied" by itself, and she can now read her own tracker (for "my applications").
--   3b. job_submission_reviews: the company's side of an application (its stage). A separate
--      table, so the candidate can never read it — she is shown only that her application was
--      sent. Readable by the page's owners / recruiters and Duallin admins; written by the
--      page's owners / recruiters only.
--   4. job-resumes: a PRIVATE storage bucket. A resume is readable by the candidate, and by the
--      page's owners / recruiters (and Duallin admins) only once it is attached to an application.
--   5. A managed page takes responsibility for its own jobs: automatic imports for that company
--      are skipped (also when the name is written differently). Jobs imported before stay until
--      they expire; the page may take them down. A job the company published is never deleted
--      or rewritten by an import.
--
-- What it does NOT change: who can read jobs, how imported jobs are written for pages nobody
-- manages, and the existing 'clicked / applied' tracker for outside applications.
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, nothing
-- changes. To go back later: rollback_add_company_jobs.sql                    Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Job fields
-- ------------------------------------------------------------
ALTER TABLE public.open_position
  ADD COLUMN IF NOT EXISTS status       text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS apply_method text NOT NULL DEFAULT 'external',
  ADD COLUMN IF NOT EXISTS apply_form   jsonb,
  ADD COLUMN IF NOT EXISTS closed_at    timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'open_position_status_check') THEN
    -- open: on the board · closed: taken down by the company · removed: taken down by Duallin
    ALTER TABLE public.open_position ADD CONSTRAINT open_position_status_check CHECK (status IN ('open', 'closed', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'open_position_apply_method_check') THEN
    ALTER TABLE public.open_position ADD CONSTRAINT open_position_apply_method_check CHECK (apply_method IN ('external', 'internal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_open_position_company_status ON public.open_position (company_id, status);

-- The description members see, built from the company's plain text: escaped, paragraphs kept.
-- (The board shows job_description_html; the AI step that writes it for imported jobs never
-- touches a job that already has one.)
CREATE OR REPLACE FUNCTION public.job_plain_to_html(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '<div dir="' || CASE WHEN p_text ~ '[א-ת]' THEN 'rtl' ELSE 'ltr' END || '"><p>'
      || regexp_replace(
           regexp_replace(
             replace(replace(replace(btrim(p_text), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
             E'\\r?\\n[ \\t]*(\\r?\\n[ \\t]*)+', '</p><p>', 'g'),
           E'\\r?\\n', '<br/>', 'g')
      || '</p></div>'
$$;

-- The application form of a job, checked and rewritten in one fixed shape.
CREATE OR REPLACE FUNCTION public.job_apply_form_clean(p_form jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_resume text := coalesce(p_form ->> 'resume', 'optional');
  v_questions jsonb := '[]'::jsonb;
  v_q jsonb;
  v_text text;
  v_n integer := 0;
BEGIN
  IF p_form IS NOT NULL AND jsonb_typeof(p_form) <> 'object' THEN RAISE EXCEPTION 'The application form is not valid' USING ERRCODE = 'check_violation'; END IF;
  IF v_resume NOT IN ('required', 'optional', 'none') THEN RAISE EXCEPTION 'The application form is not valid' USING ERRCODE = 'check_violation'; END IF;
  IF p_form ? 'questions' THEN
    IF jsonb_typeof(p_form -> 'questions') <> 'array' OR jsonb_array_length(p_form -> 'questions') > 5 THEN
      RAISE EXCEPTION 'A job can ask up to 5 questions' USING ERRCODE = 'check_violation';
    END IF;
    FOR v_q IN SELECT * FROM jsonb_array_elements(p_form -> 'questions') LOOP
      v_text := btrim(coalesce(v_q ->> 'text', ''));
      IF jsonb_typeof(v_q) <> 'object' OR length(v_text) NOT BETWEEN 3 AND 200 OR v_text ~ '[<>]' THEN
        RAISE EXCEPTION 'A question is not valid' USING ERRCODE = 'check_violation';
      END IF;
      v_n := v_n + 1;
      v_questions := v_questions || jsonb_build_object('id', 'q' || v_n, 'text', v_text, 'required', coalesce(v_q ->> 'required', 'false') = 'true');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('resume', v_resume, 'note', coalesce(p_form ->> 'note', 'true') = 'true', 'questions', v_questions);
END;
$$;

-- A company's name as an import may write it: the same key the rest of company pages uses
-- (case, spaces and punctuation ignored), after dropping a legal ending such as "Ltd." or בע"מ.
-- Only an ending that stands as its own word is dropped ("Zinc" stays "zinc").
CREATE OR REPLACE FUNCTION public.job_company_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.company_name_key(
    regexp_replace(coalesce(p_name, ''), '[[:space:],.]+(ltd|limited|inc|incorporated|llc|corp|corporation|בע"מ|בע״מ|בעמ)[[:space:].]*$', '', 'i'))
$$;

-- ------------------------------------------------------------
-- 2. Who may write a job, and what
--    Three kinds of session:
--      * no signed-in member (imports, the AI step, the SQL editor)  → "system"
--      * a page's owner / recruiter, in her own session
--      * a Duallin admin, in her own session
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_position_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_cname text;
  v_cstatus text;
  v_status text;
  v_limit integer;
  v_enabled boolean;
  v_open integer;
BEGIN
  -- ===== deleting =====
  IF TG_OP = 'DELETE' THEN
    -- an import's clean-up never deletes a job a company published itself
    IF v_uid IS NULL AND OLD.source = 'Duallin'
       AND coalesce(current_setting('duallin.system_job_delete', true), '') <> 'on' THEN
      RETURN NULL;
    END IF;
    RETURN OLD;
  END IF;

  -- ===== system =====
  IF v_uid IS NULL THEN
    -- a managed page publishes its own jobs: imports for it are skipped (silently — the
    -- importer's other rows must still be saved)
    IF TG_OP = 'INSERT' AND NEW.source IS DISTINCT FROM 'Duallin' THEN
      IF EXISTS (
        SELECT 1 FROM companies c
        WHERE c.page_status = 'claimed'
          AND (c.id = NEW.company_id
               OR (NEW.company_id IS NULL AND public.job_company_key(NEW.company_name) IS NOT NULL
                   AND public.job_company_key(NEW.company_name) IN
                       (public.job_company_key(c.name), public.job_company_key(c.import_name), public.job_company_key(c.name_he))))
      ) THEN
        RETURN NULL;
      END IF;
    END IF;
    -- an import can never turn its row into a company's own job, or the other way round
    IF TG_OP = 'UPDATE' AND (NEW.source = 'Duallin') IS DISTINCT FROM (OLD.source = 'Duallin') THEN
      NEW.source := OLD.source;
    END IF;
    RETURN NEW;
  END IF;

  -- ===== a signed-in member (the row-level rule has already limited her to her own pages) =====
  v_admin := public.is_platform_admin();

  IF TG_OP = 'INSERT' THEN
    SELECT name, page_status INTO v_cname, v_cstatus FROM companies WHERE id = NEW.company_id;
    IF NOT FOUND OR v_cstatus <> 'claimed' THEN
      RAISE EXCEPTION 'Jobs can be published only on a managed page' USING ERRCODE = 'P0001';
    END IF;
    -- identity and bookkeeping are never hers to choose
    NEW.source := 'Duallin';
    NEW.job_id := (900000000000000 + NEW.id)::text;          -- numeric like every job id, far from any imported one
    NEW.company_name := v_cname;
    NEW.created_at := now();
    NEW.time_posted := to_char(now() AT TIME ZONE 'Asia/Jerusalem', 'FMDD/FMMM/YYYY');
    NEW.views_count := 0;
    NEW.original_source_json := '{}'::jsonb;
    NEW.contact_details := NULL;
    NEW.community_benefits := NULL;
    NEW.employment_type := NULL;
    NEW.status := 'open';
    NEW.closed_at := NULL;
  ELSE
    v_status := NEW.status;
    IF OLD.source <> 'Duallin' THEN
      -- an imported job on her page: she may only take it down
      NEW := OLD;
      NEW.status := v_status;
    ELSE
      NEW.id := OLD.id; NEW.job_id := OLD.job_id; NEW.company_id := OLD.company_id; NEW.company_name := OLD.company_name;
      NEW.source := OLD.source; NEW.created_at := OLD.created_at; NEW.time_posted := OLD.time_posted;
      NEW.views_count := OLD.views_count; NEW.original_source_json := OLD.original_source_json;
      NEW.contact_details := OLD.contact_details; NEW.community_benefits := OLD.community_benefits;
      NEW.employment_type := OLD.employment_type;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT v_admin AND (NEW.status = 'removed' OR OLD.status = 'removed') THEN
        RAISE EXCEPTION 'Only Duallin can remove or restore a job' USING ERRCODE = 'P0001';
      END IF;
      IF NOT v_admin AND OLD.source <> 'Duallin' AND NEW.status <> 'closed' THEN
        RAISE EXCEPTION 'An imported job can only be taken down' USING ERRCODE = 'P0001';
      END IF;
      NEW.closed_at := CASE WHEN NEW.status = 'open' THEN NULL ELSE now() END;
    ELSE
      NEW.closed_at := OLD.closed_at;
    END IF;
    IF OLD.source <> 'Duallin' THEN RETURN NEW; END IF;
  END IF;

  -- ===== a company's own job: what it may contain =====
  NEW.job_title := btrim(coalesce(NEW.job_title, ''));
  NEW.location := btrim(coalesce(NEW.location, ''));
  NEW.job_description := btrim(coalesce(NEW.job_description, ''));
  NEW.salary_range := nullif(btrim(coalesce(NEW.salary_range, '')), '');
  IF length(NEW.job_title) NOT BETWEEN 3 AND 150 OR NEW.job_title ~ '[<>]'
     OR length(NEW.location) NOT BETWEEN 2 AND 120 OR NEW.location ~ '[<>]'
     OR length(NEW.job_description) NOT BETWEEN 30 AND 8000 OR NEW.job_description ~ '[<>]'
     OR (NEW.salary_range IS NOT NULL AND (length(NEW.salary_range) > 80 OR NEW.salary_range ~ '[<>]'))
     OR (NEW.location_region IS NOT NULL AND NEW.location_region NOT IN ('center', 'sharon', 'north', 'jerusalem', 'south', 'nationwide'))
     OR (NEW.seniority_level IS NOT NULL AND NEW.seniority_level !~ '^[0-9]{1,2}$')
     OR (NEW.work_schedule IS NOT NULL AND NEW.work_schedule NOT IN ('Full Time', 'Part Time', 'Internship'))
     OR coalesce(cardinality(NEW.categories), 0) > 2 THEN
    RAISE EXCEPTION 'A job field is not valid' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.apply_method = 'internal' THEN
    SELECT enabled INTO v_enabled FROM public.entitlement_value('company', NEW.company_id::text, 'jobs.internal_applications');
    IF v_enabled IS NOT TRUE THEN RAISE EXCEPTION 'plan_internal_applications' USING ERRCODE = 'P0001'; END IF;
    NEW.apply_link := NULL;
    NEW.apply_form := public.job_apply_form_clean(NEW.apply_form);
  ELSE
    IF NEW.apply_link IS NULL OR length(NEW.apply_link) > 500 OR NEW.apply_link !~* '^https://[^[:space:]<>"'']+$' THEN
      RAISE EXCEPTION 'The application link must be an https address' USING ERRCODE = 'check_violation';
    END IF;
    NEW.apply_form := NULL;
  END IF;

  -- the shown description always comes from her plain text
  NEW.job_description_html := public.job_plain_to_html(NEW.job_description);

  -- the plan's limit on jobs open at once (checked when a job becomes open)
  IF NEW.status = 'open' AND (TG_OP = 'INSERT' OR OLD.status <> 'open') THEN
    SELECT limit_value INTO v_limit FROM public.entitlement_value('company', NEW.company_id::text, 'jobs.active.max');
    IF v_limit IS NOT NULL THEN
      SELECT count(*) INTO v_open FROM open_position
      WHERE company_id = NEW.company_id AND source = 'Duallin' AND status = 'open' AND id <> NEW.id;
      IF v_open >= v_limit THEN RAISE EXCEPTION 'plan_limit' USING ERRCODE = 'P0001'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- named to run BEFORE the existing triggers (they fire in name order): the search index
-- (tr_fts_update) must see the description built here
DROP TRIGGER IF EXISTS open_position_guard ON public.open_position;
CREATE TRIGGER open_position_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.open_position
  FOR EACH ROW EXECUTE FUNCTION public.open_position_guard();

-- Row-level rules: reading stays as it is. Writing — only a page's owner / recruiter (or a
-- Duallin admin), in her own session. There is no rule for deleting: a job is closed, not deleted.
DROP POLICY IF EXISTS "Page recruiters publish jobs" ON public.open_position;
CREATE POLICY "Page recruiters publish jobs"
  ON public.open_position FOR INSERT TO authenticated
  WITH CHECK (company_id IS NOT NULL AND (public.has_company_role(company_id, ARRAY['owner', 'recruiter']) OR public.is_platform_admin()));

DROP POLICY IF EXISTS "Page recruiters manage their jobs" ON public.open_position;
CREATE POLICY "Page recruiters manage their jobs"
  ON public.open_position FOR UPDATE TO authenticated
  USING (public.is_platform_admin() OR (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner', 'recruiter'])))
  WITH CHECK (public.is_platform_admin() OR (company_id IS NOT NULL AND public.has_company_role(company_id, ARRAY['owner', 'recruiter'])));

-- History of the page + a bell for Duallin admins when a company publishes a job.
CREATE OR REPLACE FUNCTION public.open_position_company_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_action text;
BEGIN
  IF v_actor IS NULL OR NEW.company_id IS NULL THEN RETURN NULL; END IF;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      v_action := 'job_insert';
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      v_action := CASE NEW.status WHEN 'open' THEN 'job_reopened' WHEN 'closed' THEN 'job_closed' ELSE 'job_removed' END;
    ELSIF (NEW.job_title, NEW.job_description, NEW.location, NEW.apply_method, coalesce(NEW.apply_link, ''), coalesce(NEW.apply_form, '{}'::jsonb))
          IS DISTINCT FROM
          (OLD.job_title, OLD.job_description, OLD.location, OLD.apply_method, coalesce(OLD.apply_link, ''), coalesce(OLD.apply_form, '{}'::jsonb)) THEN
      v_action := 'job_update';
    ELSE
      RETURN NULL;
    END IF;
    INSERT INTO company_audit_log (company_id, actor_id, action, details)
    VALUES (NEW.company_id, v_actor, v_action, jsonb_build_object('job_id', NEW.job_id, 'title', NEW.job_title));

    IF TG_OP = 'INSERT' THEN
      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      SELECT a, v_actor, NEW.company_id::text, 'COMPANY_JOB_NEW', 1, false
      FROM public.platform_admin_ids() a
      WHERE a <> v_actor;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'open_position_company_audit: %', SQLERRM;   -- never blocks the job itself
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.open_position_company_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_open_position_company_audit ON public.open_position;
CREATE TRIGGER trg_open_position_company_audit
  AFTER INSERT OR UPDATE ON public.open_position
  FOR EACH ROW EXECUTE FUNCTION public.open_position_company_audit();

-- ------------------------------------------------------------
-- 3. Applications inside Duallin
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_submissions (
  id               bigserial   PRIMARY KEY,
  job_id           bigint      NOT NULL REFERENCES public.open_position(id) ON DELETE CASCADE,
  company_id       integer     NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,   -- copied from the job
  user_id          uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(uuid) ON DELETE CASCADE,
  -- what the candidate chose to give this company
  full_name        text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120 AND full_name !~ '[<>]'),
  email            text        NOT NULL CHECK (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND length(email) <= 200),
  phone            text                 CHECK (phone IS NULL OR (length(phone) <= 40 AND phone ~ '^[0-9+() .-]+$')),
  note             text                 CHECK (note IS NULL OR length(note) <= 2000),
  answers          jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{ id, text (the question as asked), answer }]
  resume_path      text,                                        -- a file in the job-resumes bucket
  notified_at      timestamptz,                                 -- when the page's recruiters were e-mailed about it
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_job_submissions_company ON public.job_submissions (company_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_submissions_user ON public.job_submissions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_submissions_unnotified ON public.job_submissions (created_at) WHERE notified_at IS NULL;

ALTER TABLE public.job_submissions ENABLE ROW LEVEL SECURITY;

-- Duallin admins read applications for support (they cannot change or delete them: the rules
-- below give that to nobody but the page's recruiters and the candidate).
DROP POLICY IF EXISTS "Candidate, page recruiters and Duallin admins read applications" ON public.job_submissions;
CREATE POLICY "Candidate, page recruiters and Duallin admins read applications"
  ON public.job_submissions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_company_role(company_id, ARRAY['owner', 'recruiter']) OR public.is_platform_admin());

DROP POLICY IF EXISTS "A member applies in her own name" ON public.job_submissions;
CREATE POLICY "A member applies in her own name"
  ON public.job_submissions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "A candidate withdraws her application" ON public.job_submissions;
CREATE POLICY "A candidate withdraws her application"
  ON public.job_submissions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- The candidate supplies only the application itself; nobody changes it afterwards (the
-- company's stage lives in job_submission_reviews).
REVOKE ALL ON TABLE public.job_submissions FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.job_submissions TO authenticated;
GRANT INSERT (job_id, full_name, email, phone, note, answers, resume_path) ON TABLE public.job_submissions TO authenticated;
GRANT ALL ON TABLE public.job_submissions TO service_role;   -- the background e-mail job (no signed-in member)
REVOKE ALL ON SEQUENCE public.job_submissions_id_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.job_submissions_id_seq TO authenticated, service_role;

-- An application is checked against the job's own form.
CREATE OR REPLACE FUNCTION public.job_submission_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job record;
  v_form jsonb;
  v_q jsonb;
  v_answer text;
  v_answers jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NOT NULL THEN NEW.user_id := v_uid; END IF;
  SELECT id, company_id, source, status, apply_method, apply_form INTO v_job FROM open_position WHERE id = NEW.job_id;
  IF NOT FOUND OR v_job.source <> 'Duallin' OR v_job.apply_method <> 'internal' OR v_job.company_id IS NULL THEN
    RAISE EXCEPTION 'not_accepting' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.status <> 'open' THEN RAISE EXCEPTION 'job_closed' USING ERRCODE = 'P0001'; END IF;

  NEW.company_id := v_job.company_id;
  NEW.notified_at := NULL;
  NEW.created_at := now();
  NEW.full_name := btrim(NEW.full_name);
  NEW.email := lower(btrim(NEW.email));
  NEW.phone := nullif(btrim(coalesce(NEW.phone, '')), '');
  v_form := coalesce(v_job.apply_form, '{}'::jsonb);

  -- the note, only when the job asks for one
  NEW.note := CASE WHEN coalesce(v_form ->> 'note', 'true') = 'true' THEN nullif(btrim(coalesce(NEW.note, '')), '') END;

  -- the resume: required / optional / none, and only her own file for this job
  IF coalesce(v_form ->> 'resume', 'optional') = 'none' THEN
    NEW.resume_path := NULL;
  ELSIF NEW.resume_path IS NULL THEN
    IF v_form ->> 'resume' = 'required' THEN RAISE EXCEPTION 'resume_required' USING ERRCODE = 'P0001'; END IF;
  ELSIF NEW.resume_path !~ ('^' || NEW.job_id || '/' || NEW.user_id || '/[A-Za-z0-9_-][A-Za-z0-9._-]*\.pdf$') THEN
    RAISE EXCEPTION 'The resume file is not valid' USING ERRCODE = 'check_violation';
  END IF;

  -- the answers: one per question the job asks, in the job's order, with the question as asked
  IF jsonb_typeof(coalesce(NEW.answers, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'The answers are not valid' USING ERRCODE = 'check_violation'; END IF;
  FOR v_q IN SELECT * FROM jsonb_array_elements(coalesce(v_form -> 'questions', '[]'::jsonb)) LOOP
    SELECT btrim(coalesce(a ->> 'answer', '')) INTO v_answer
    FROM jsonb_array_elements(coalesce(NEW.answers, '[]'::jsonb)) a WHERE a ->> 'id' = v_q ->> 'id' LIMIT 1;
    v_answer := coalesce(v_answer, '');
    IF length(v_answer) > 1000 THEN RAISE EXCEPTION 'An answer is too long' USING ERRCODE = 'check_violation'; END IF;
    IF v_answer = '' AND (v_q ->> 'required') = 'true' THEN RAISE EXCEPTION 'answer_required' USING ERRCODE = 'P0001'; END IF;
    IF v_answer <> '' THEN
      v_answers := v_answers || jsonb_build_object('id', v_q ->> 'id', 'text', v_q ->> 'text', 'answer', v_answer);
    END IF;
  END LOOP;
  NEW.answers := v_answers;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_job_submission_before_write ON public.job_submissions;
CREATE TRIGGER trg_job_submission_before_write
  BEFORE INSERT ON public.job_submissions
  FOR EACH ROW EXECUTE FUNCTION public.job_submission_before_write();

-- After an application: her private tracker says "applied", and the page's recruiters get a bell.
-- After she withdraws: the tracker goes back to "clicked".
CREATE OR REPLACE FUNCTION public.job_submission_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO job_applications (user_id, job_id, status, applied_at, updated_at)
      VALUES (NEW.user_id, NEW.job_id, 'applied', now(), now())
      ON CONFLICT (user_id, job_id) DO UPDATE SET status = 'applied', applied_at = now(), updated_at = now();

      INSERT INTO notifications (user_id, actor_id, target_id, type, count, is_read)
      SELECT a.user_id, NEW.user_id, NEW.company_id::text, 'COMPANY_JOB_APPLICATION', 1, false
      FROM company_admins a
      WHERE a.company_id = NEW.company_id AND a.role IN ('owner', 'recruiter') AND a.user_id <> NEW.user_id;
    ELSE
      UPDATE job_applications SET status = 'clicked', applied_at = NULL, updated_at = now()
      WHERE user_id = OLD.user_id AND job_id = OLD.job_id AND status = 'applied';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'job_submission_after_change: %', SQLERRM;   -- never blocks the application itself
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.job_submission_after_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_job_submission_after_change ON public.job_submissions;
CREATE TRIGGER trg_job_submission_after_change
  AFTER INSERT OR DELETE ON public.job_submissions
  FOR EACH ROW EXECUTE FUNCTION public.job_submission_after_change();

-- The company's side of an application. No row = 'new'. Deleted with the application.
CREATE TABLE IF NOT EXISTS public.job_submission_reviews (
  submission_id bigint      PRIMARY KEY REFERENCES public.job_submissions(id) ON DELETE CASCADE,
  company_id    integer     NOT NULL,                                     -- copied from the application
  stage         text        NOT NULL CHECK (stage IN ('new', 'reviewed', 'contacted', 'rejected', 'hired')),
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    uuid
);
CREATE INDEX IF NOT EXISTS idx_job_submission_reviews_company ON public.job_submission_reviews (company_id);
ALTER TABLE public.job_submission_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Page recruiters and Duallin admins read the company's side" ON public.job_submission_reviews;
CREATE POLICY "Page recruiters and Duallin admins read the company's side"
  ON public.job_submission_reviews FOR SELECT TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner', 'recruiter']) OR public.is_platform_admin());

DROP POLICY IF EXISTS "Page recruiters set the stage" ON public.job_submission_reviews;
CREATE POLICY "Page recruiters set the stage"
  ON public.job_submission_reviews FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner', 'recruiter']));

DROP POLICY IF EXISTS "Page recruiters change the stage" ON public.job_submission_reviews;
CREATE POLICY "Page recruiters change the stage"
  ON public.job_submission_reviews FOR UPDATE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner', 'recruiter']))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner', 'recruiter']));

REVOKE ALL ON TABLE public.job_submission_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.job_submission_reviews TO authenticated;
GRANT INSERT (submission_id, stage) ON TABLE public.job_submission_reviews TO authenticated;
GRANT UPDATE (stage) ON TABLE public.job_submission_reviews TO authenticated;
GRANT ALL ON TABLE public.job_submission_reviews TO service_role;

-- The page and who changed it come from the application and the session, never from the request.
CREATE OR REPLACE FUNCTION public.job_submission_review_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT company_id INTO NEW.company_id FROM job_submissions WHERE id = NEW.submission_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'foreign_key_violation'; END IF;
  ELSE
    NEW.submission_id := OLD.submission_id;
    NEW.company_id := OLD.company_id;
  END IF;
  NEW.changed_at := now();
  NEW.changed_by := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.job_submission_review_before_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_job_submission_review_before_write ON public.job_submission_reviews;
CREATE TRIGGER trg_job_submission_review_before_write
  BEFORE INSERT OR UPDATE ON public.job_submission_reviews
  FOR EACH ROW EXECUTE FUNCTION public.job_submission_review_before_write();

-- How many applications on a page nobody has moved past "new" — counted with the caller's own
-- rights (anyone who is not the page's recruiter gets 0).
CREATE OR REPLACE FUNCTION public.company_new_applications_count(p_company_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM job_submissions s
  WHERE s.company_id = p_company_id
    AND NOT EXISTS (SELECT 1 FROM job_submission_reviews r WHERE r.submission_id = s.id AND r.stage <> 'new')
$$;
REVOKE ALL ON FUNCTION public.company_new_applications_count(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_new_applications_count(integer) TO authenticated;

-- A member reads her own private tracker ("my applications"). Writing it stays with the API.
DROP POLICY IF EXISTS "A member reads her own applications tracker" ON public.job_applications;
CREATE POLICY "A member reads her own applications tracker"
  ON public.job_applications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ------------------------------------------------------------
-- 4. Resume files: a PRIVATE bucket.  Path: "<job row id>/<member id>/<file>.pdf"
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('job-resumes', 'job-resumes', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 5242880, allowed_mime_types = ARRAY['application/pdf'];

-- She may put a file only in her own folder of a job that takes resumes right now.
CREATE OR REPLACE FUNCTION public.job_resume_writable(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_name ~ '^[0-9]{1,18}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9_-][A-Za-z0-9._-]*\.pdf$'
         AND split_part(p_name, '/', 2) = auth.uid()::text
      THEN EXISTS (
        SELECT 1 FROM open_position o
        WHERE o.id = split_part(p_name, '/', 1)::bigint AND o.source = 'Duallin' AND o.status = 'open'
          AND o.apply_method = 'internal' AND coalesce(o.apply_form ->> 'resume', 'optional') <> 'none')
    ELSE false
  END
$$;

-- Her own file — or a file attached to an application the caller may read as the page's
-- recruiter (or as a Duallin admin, for support).
CREATE OR REPLACE FUNCTION public.job_resume_readable(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT split_part(p_name, '/', 2) = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM job_submissions s
        WHERE s.resume_path = p_name
          AND (public.has_company_role(s.company_id, ARRAY['owner', 'recruiter']) OR public.is_platform_admin()))
$$;

DROP POLICY IF EXISTS "job resumes read" ON storage.objects;
CREATE POLICY "job resumes read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'job-resumes' AND public.job_resume_readable(name));

DROP POLICY IF EXISTS "job resumes upload" ON storage.objects;
CREATE POLICY "job resumes upload" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'job-resumes' AND public.job_resume_writable(name));

DROP POLICY IF EXISTS "job resumes delete own" ON storage.objects;
CREATE POLICY "job resumes delete own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'job-resumes' AND split_part(name, '/', 2) = auth.uid()::text);

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_cname text; v_owner uuid; v_free integer; v_free_name text;
  v_b uuid; v_c uuid; v_d uuid;
  v_job bigint; v_job2 bigint; v_ext bigint; v_imported bigint; v_sub bigint;
  v_row open_position%ROWTYPE; v_n bigint; v_before bigint; v_ok boolean; v_text text;
  v_desc text := E'We are looking for an engineer & a team player.\nSecond line.\n\nNew paragraph with enough text.';
  v_form jsonb := '{"resume": "required", "note": true, "questions": [{"text": "Years of experience?", "required": true}, {"text": "Anything else?"}], "junk": 1}';
BEGIN
  -- structure: nothing about the existing jobs changed
  SELECT count(*) INTO v_before FROM open_position;
  IF EXISTS (SELECT 1 FROM open_position WHERE status <> 'open' OR apply_method <> 'external' OR apply_form IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM open_position WHERE source = 'Duallin') THEN
    v_problems := v_problems || ' existing jobs did not all stay open / external;';
  END IF;
  IF public.job_plain_to_html(E'a <b> & c\nd\n\ne') <> '<div dir="ltr"><p>a &lt;b&gt; &amp; c<br/>d</p><p>e</p></div>' THEN v_problems := v_problems || ' the description builder does not escape as expected: ' || public.job_plain_to_html(E'a <b> & c\nd\n\ne') || ';'; END IF;
  IF public.job_company_key('Acme Hardware, Inc.') <> 'acmehardware' OR public.job_company_key('אקמי בע"מ') <> public.job_company_key('אקמי')
     OR public.job_company_key('Zinc') <> 'zinc' OR public.job_company_key('Limited Run') <> 'limitedrun' OR public.job_company_key('  ') IS NOT NULL THEN
    v_problems := v_problems || ' company names are not matched as expected;';
  END IF;
  IF public.job_plain_to_html('משרה') NOT LIKE '<div dir="rtl">%' THEN v_problems := v_problems || ' a Hebrew description is not marked right-to-left;'; END IF;

  -- a managed page with its owner, a page nobody manages, and three members who manage nothing
  SELECT a.company_id, c.name, a.user_id INTO v_company, v_cname, v_owner
  FROM company_admins a JOIN companies c ON c.id = a.company_id
  WHERE a.role = 'owner' AND c.page_status = 'claimed' ORDER BY a.created_at LIMIT 1;
  SELECT id, name INTO v_free, v_free_name FROM companies c WHERE name IS NOT NULL AND page_status = 'unclaimed' AND public.company_name_key(name) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  SELECT uuid INTO v_b FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_c FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid <> v_b AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid INTO v_d FROM users u WHERE status = 'Active' AND is_anonymous IS NOT TRUE AND email NOT LIKE 'deleted_%' AND uuid NOT IN (v_b, v_c) AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  IF v_company IS NULL OR v_free IS NULL OR v_d IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — the checks need a managed page, an unmanaged page and three members who manage nothing';
  END IF;

  BEGIN
    -- v_c becomes a content manager of the page (she must NOT be able to publish jobs or read applications)
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_c, 'content');
    -- one job imported for the page before it was managed (written with the guard off, as it would have been then)
    ALTER TABLE open_position DISABLE TRIGGER open_position_guard;
    INSERT INTO open_position (job_id, job_title, company_name, company_id, location, source, time_posted, job_description, original_source_json, apply_link)
    VALUES ('check-7f3a-old', 'Imported before', v_cname, v_company, 'Tel Aviv', 'Goozali', '1/1/2026', 'An imported description', '{}', 'https://example.com/apply')
    RETURNING id INTO v_imported;
    ALTER TABLE open_position ENABLE TRIGGER open_position_guard;

    -- ===== imports (no signed-in member) =====
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    -- 1. for a managed page: skipped, by id and by name however it is written
    INSERT INTO open_position (job_id, job_title, company_name, company_id, location, source, time_posted, job_description, original_source_json)
    VALUES ('check-7f3a-1', 'Import by id', v_cname, v_company, 'Tel Aviv', 'Goozali', '1/1/2026', 'x', '{}'),
           ('check-7f3a-2', 'Import by name', '  ' || upper(v_cname) || ' ', NULL, 'Tel Aviv', 'Goozali', '1/1/2026', 'x', '{}'),
           ('check-7f3a-2b', 'Import by name with a legal ending', v_cname || ', Ltd.', NULL, 'Tel Aviv', 'Goozali', '1/1/2026', 'x', '{}');
    SELECT count(*) INTO v_n FROM open_position WHERE job_id IN ('check-7f3a-1', 'check-7f3a-2', 'check-7f3a-2b');
    IF v_n <> 0 THEN v_problems := v_problems || format(' %s imported job(s) entered a managed page;', v_n); END IF;
    -- 2. for a page nobody manages: saved and linked, exactly as before
    INSERT INTO open_position (job_id, job_title, company_name, company_id, location, source, time_posted, job_description, original_source_json)
    VALUES ('check-7f3a-3', 'Import for a free page', v_free_name, NULL, 'Tel Aviv', 'Goozali', '1/1/2026', 'x', '{}');
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE job_id = 'check-7f3a-3' AND company_id = v_free AND status = 'open' AND apply_method = 'external') THEN
      v_problems := v_problems || ' an import for an unmanaged page was not saved / linked as before;';
    END IF;
    -- 3. an import may still refresh a job that was there before the page was managed
    UPDATE open_position SET job_title = 'Imported before (refreshed)' WHERE id = v_imported;
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_imported AND job_title LIKE '%(refreshed)') THEN v_problems := v_problems || ' an import could not refresh its own older job;'; END IF;
    RESET ROLE;

    -- ===== members who are not the page's recruiters =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Not my page', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' a member published a job on a page she does not manage;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE open_position SET status = 'closed' WHERE id = v_imported;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member closed a job of a page she does not manage;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Content manager', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' a content manager published a job;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- ===== the page's owner =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 4. she publishes; everything that is not hers to choose is set here
    INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_form, apply_link,
                               source, job_id, company_name, job_description_html, views_count, status, time_posted, original_source_json, contact_details)
    VALUES (v_company, '  Backend Engineer  ', 'Tel Aviv', v_desc, 'internal', v_form, 'https://ignored.example',
            'Goozali', '1', 'Another Company', '<script>alert(1)</script>', 999, 'removed', 'yesterday', '{"x": 1}', 'call me')
    RETURNING id INTO v_job;
    SELECT * INTO v_row FROM open_position WHERE id = v_job;
    IF v_row.source <> 'Duallin' OR v_row.job_id <> (900000000000000 + v_job)::text OR v_row.company_name <> v_cname OR v_row.views_count <> 0
       OR v_row.status <> 'open' OR v_row.contact_details IS NOT NULL OR v_row.original_source_json <> '{}'::jsonb OR v_row.apply_link IS NOT NULL
       OR v_row.job_title <> 'Backend Engineer' THEN
      v_problems := v_problems || ' a published job kept values that are not the company''s to set;';
    END IF;
    IF v_row.job_description_html LIKE '%<script%' OR v_row.job_description_html NOT LIKE '<div dir="ltr"><p>We are looking for an engineer &amp; a team player.<br/>Second line.</p><p>New paragraph%' THEN
      v_problems := v_problems || ' the shown description was not built from her plain text: ' || left(v_row.job_description_html, 120) || ';';
    END IF;
    IF v_row.apply_form <> '{"resume": "required", "note": true, "questions": [{"id": "q1", "text": "Years of experience?", "required": true}, {"id": "q2", "text": "Anything else?", "required": false}]}'::jsonb THEN
      v_problems := v_problems || ' the application form was not saved in its fixed shape: ' || v_row.apply_form::text || ';';
    END IF;
    IF v_row.fts_tokens IS NULL OR NOT v_row.fts_tokens @@ to_tsquery('simple', 'engineer') THEN v_problems := v_problems || ' the new job is not searchable;'; END IF;
    -- 5. what is refused
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Bad <b>title</b>', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' markup in a title was saved;';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Short text', 'Tel Aviv', 'too short', 'external', 'https://example.com/a');
      v_problems := v_problems || ' a job with almost no description was saved;';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Bad link', 'Tel Aviv', v_desc, 'external', 'javascript:alert(1)');
      v_problems := v_problems || ' a javascript: application link was saved;';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_form) VALUES (v_company, 'Six questions', 'Tel Aviv', v_desc, 'internal',
        '{"questions": [{"text": "one?"}, {"text": "two?"}, {"text": "three?"}, {"text": "four?"}, {"text": "five?"}, {"text": "six?"}]}');
      v_problems := v_problems || ' a job with 6 questions was saved;';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_free, 'On a page nobody manages', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' she published a job on another page;';
    EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'P0001' THEN NULL;
    END;
    -- 6. editing: her text changes, the job's identity does not
    UPDATE open_position SET job_title = 'Senior Backend Engineer', job_id = '5', source = 'Goozali', company_name = 'X', views_count = 50, job_description_html = '<img src=x onerror=alert(1)>' WHERE id = v_job;
    SELECT * INTO v_row FROM open_position WHERE id = v_job;
    IF v_row.job_title <> 'Senior Backend Engineer' OR v_row.job_id <> (900000000000000 + v_job)::text OR v_row.source <> 'Duallin' OR v_row.company_name <> v_cname
       OR v_row.views_count <> 0 OR v_row.job_description_html LIKE '%onerror%' THEN
      v_problems := v_problems || ' editing a job changed what must stay fixed (or lost her change);';
    END IF;
    -- 7. closing and reopening; removing is Duallin's
    UPDATE open_position SET status = 'closed' WHERE id = v_job;
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_job AND status = 'closed' AND closed_at IS NOT NULL) THEN v_problems := v_problems || ' she could not close her job;'; END IF;
    UPDATE open_position SET status = 'open' WHERE id = v_job;
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_job AND status = 'open' AND closed_at IS NULL) THEN v_problems := v_problems || ' she could not reopen her job;'; END IF;
    BEGIN
      UPDATE open_position SET status = 'removed' WHERE id = v_job;
      v_problems := v_problems || ' a company marked a job "removed by Duallin";';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    -- 8. an imported job on her page: she may take it down, not rewrite it
    UPDATE open_position SET job_title = 'Rewritten', apply_link = 'https://evil.example', status = 'closed' WHERE id = v_imported;
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_imported AND status = 'closed' AND job_title LIKE 'Imported before%' AND apply_link = 'https://example.com/apply' AND source = 'Goozali') THEN
      v_problems := v_problems || ' an imported job was rewritten (or could not be taken down) by the page;';
    END IF;
    BEGIN
      DELETE FROM open_position WHERE id = v_job;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 0 THEN v_problems := v_problems || ' a company deleted a job (jobs are closed, not deleted);'; END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- a second job, with an outside link
    INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link, apply_form)
    VALUES (v_company, 'Outside link job', 'Haifa', v_desc, 'external', 'https://example.com/jobs/1', v_form) RETURNING id INTO v_ext;
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_ext AND apply_form IS NULL AND apply_link = 'https://example.com/jobs/1') THEN v_problems := v_problems || ' an outside-link job kept a form (or lost its link);'; END IF;
    RESET ROLE;

    -- 9. the page's history and the admins' bell
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT count(*) INTO v_n FROM company_audit_log WHERE company_id = v_company AND actor_id = v_owner AND action IN ('job_insert', 'job_update', 'job_closed', 'job_reopened');
    IF v_n < 5 THEN v_problems := v_problems || format(' the page history has %s job lines, expected at least 5;', v_n); END IF;
    IF (SELECT count(*) FROM public.platform_admin_ids() a WHERE a <> v_owner) > 0
       AND NOT EXISTS (SELECT 1 FROM notifications WHERE type = 'COMPANY_JOB_NEW' AND actor_id = v_owner AND target_id = v_company::text) THEN
      v_problems := v_problems || ' Duallin admins were not told about the new job;';
    END IF;

    -- 10. the plan's limit on open jobs
    INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled, limit_value, reason) VALUES ('company', v_company::text, 'jobs.active.max', true, 2, 'check');
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'One too many', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' a third open job was published although the plan allows 2;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    DELETE FROM entitlement_overrides WHERE subject_type = 'company' AND subject_id = v_company::text AND feature_key = 'jobs.active.max' AND reason = 'check';

    -- 11. an import's clean-up cannot delete a company's own job (an imported one it can)
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    DELETE FROM open_position WHERE id IN (v_ext, v_imported);
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF NOT EXISTS (SELECT 1 FROM open_position WHERE id = v_ext) THEN v_problems := v_problems || ' an import clean-up deleted a job the company published;'; END IF;
    IF EXISTS (SELECT 1 FROM open_position WHERE id = v_imported) THEN v_problems := v_problems || ' an import clean-up can no longer delete its own job;'; END IF;

    -- ===== applying =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 12. the job's form is enforced
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email, answers) VALUES (v_job, 'Bat Check', 'bat@check-7f3a.example', '[{"id": "q1", "answer": "5"}]');
      v_problems := v_problems || ' an application without the required resume was accepted;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email, resume_path) VALUES (v_job, 'Bat Check', 'bat@check-7f3a.example', v_job || '/' || v_b || '/cv.pdf');
      v_problems := v_problems || ' an application without a required answer was accepted;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email, resume_path, answers) VALUES (v_job, 'Bat Check', 'bat@check-7f3a.example', v_job || '/' || v_c || '/cv.pdf', '[{"id": "q1", "answer": "5"}]');
      v_problems := v_problems || ' an application pointing at another member''s file was accepted;';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email) VALUES (v_ext, 'Bat Check', 'bat@check-7f3a.example');
      v_problems := v_problems || ' an application to an outside-link job was accepted;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    -- 13. a proper application
    INSERT INTO job_submissions (job_id, full_name, email, phone, note, resume_path, answers)
    VALUES (v_job, '  Bat Check ', 'Bat@Check-7f3a.example', '050-1234567', 'Hello', v_job || '/' || v_b || '/cv-1.pdf',
            '[{"id": "q1", "answer": " 5 years "}, {"id": "q9", "answer": "not asked"}, {"id": "q2", "answer": ""}]')
    RETURNING id INTO v_sub;
    IF NOT EXISTS (SELECT 1 FROM job_submissions WHERE id = v_sub AND company_id = v_company AND user_id = v_b AND full_name = 'Bat Check'
                   AND email = 'bat@check-7f3a.example' AND answers = '[{"id": "q1", "text": "Years of experience?", "answer": "5 years"}]'::jsonb) THEN
      v_problems := v_problems || ' the application was not saved as checked (page, answers);';
    END IF;
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email, resume_path, answers) VALUES (v_job, 'Bat Check', 'bat@check-7f3a.example', v_job || '/' || v_b || '/cv-2.pdf', '[{"id": "q1", "answer": "5"}]');
      v_problems := v_problems || ' she applied twice to the same job;';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO job_submission_reviews (submission_id, stage) VALUES (v_sub, 'hired');
      v_problems := v_problems || ' a candidate set the stage of her own application;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE job_submissions SET note = 'changed' WHERE id = v_sub;
      v_problems := v_problems || ' a candidate changed an application she already sent;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- her own tracker: she reads hers
    IF NOT EXISTS (SELECT 1 FROM job_applications WHERE user_id = v_b AND job_id = v_job AND status = 'applied') THEN v_problems := v_problems || ' she cannot read her own tracker;'; END IF;
    -- her resume folder: hers only, this job only
    IF NOT public.job_resume_writable(v_job || '/' || v_b || '/cv-1.pdf') THEN v_problems := v_problems || ' she may not upload her resume for this job;'; END IF;
    IF public.job_resume_writable(v_job || '/' || v_c || '/cv.pdf') OR public.job_resume_writable(v_ext || '/' || v_b || '/cv.pdf')
       OR public.job_resume_writable(v_job || '/' || v_b || '/cv.exe') OR public.job_resume_writable(v_job || '/' || v_b || '/../' || v_c || '/cv.pdf')
       OR public.job_resume_writable(v_job || '/' || v_b || '/sub/cv.pdf') OR public.job_resume_writable('cv.pdf') THEN
      v_problems := v_problems || ' a resume could be uploaded outside her own folder of a job that takes resumes;';
    END IF;
    RESET ROLE;

    -- 14. her tracker and the recruiters' bell
    PERFORM set_config('request.jwt.claims', '', true);
    IF NOT EXISTS (SELECT 1 FROM job_applications WHERE user_id = v_b AND job_id = v_job AND status = 'applied' AND applied_at IS NOT NULL) THEN v_problems := v_problems || ' her private tracker was not moved to "applied";'; END IF;
    IF NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = v_owner AND actor_id = v_b AND type = 'COMPANY_JOB_APPLICATION' AND target_id = v_company::text) THEN v_problems := v_problems || ' the page''s owner was not told about the application;'; END IF;
    IF EXISTS (SELECT 1 FROM notifications WHERE user_id IN (v_b, v_c) AND type = 'COMPANY_JOB_APPLICATION') THEN v_problems := v_problems || ' someone who is not a recruiter of the page was told about the application;'; END IF;

    -- 15. who reads it
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submissions;
    IF v_n <> 0 THEN v_problems := v_problems || ' another member reads applications;'; END IF;
    SELECT count(*) INTO v_n FROM job_applications WHERE user_id <> v_d;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member reads other members'' trackers;'; END IF;
    IF public.company_new_applications_count(v_company) <> 0 THEN v_problems := v_problems || ' another member can count a page''s applications;'; END IF;
    IF public.job_resume_readable(v_job || '/' || v_b || '/cv-1.pdf') THEN v_problems := v_problems || ' another member may read her resume;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submissions;
    IF v_n <> 0 OR public.job_resume_readable(v_job || '/' || v_b || '/cv-1.pdf') THEN v_problems := v_problems || ' a content manager reads applications / resumes;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submissions WHERE id = v_sub;
    IF v_n <> 1 OR NOT public.job_resume_readable(v_job || '/' || v_b || '/cv-1.pdf') THEN v_problems := v_problems || ' the page''s owner cannot read the application / its resume;'; END IF;
    IF public.company_new_applications_count(v_company) <> 1 THEN v_problems := v_problems || ' the owner does not see 1 new application;'; END IF;
    IF public.job_resume_readable(v_job || '/' || v_b || '/cv-other.pdf') THEN v_problems := v_problems || ' the owner may read a file that was never attached to an application;'; END IF;
    RESET ROLE;
    -- a Duallin admin (support): reads the application and its resume, changes nothing
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submissions WHERE id = v_sub;
    IF v_n <> 1 OR NOT public.job_resume_readable(v_job || '/' || v_b || '/cv-1.pdf') THEN v_problems := v_problems || ' a Duallin admin cannot read an application / its resume;'; END IF;
    IF public.job_resume_readable(v_job || '/' || v_b || '/cv-other.pdf') THEN v_problems := v_problems || ' an admin may read a file that was never attached to an application;'; END IF;
    BEGIN
      INSERT INTO job_submission_reviews (submission_id, stage) VALUES (v_sub, 'rejected');
      v_problems := v_problems || ' a Duallin admin set an application''s stage;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    DELETE FROM job_submissions WHERE id = v_sub;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a Duallin admin deleted an application;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 16. the company moves the stage (its own table), and changes nothing she sent
    INSERT INTO job_submission_reviews (submission_id, stage) VALUES (v_sub, 'reviewed');
    UPDATE job_submission_reviews SET stage = 'contacted' WHERE submission_id = v_sub;
    BEGIN
      UPDATE job_submission_reviews SET submission_id = v_sub + 1000 WHERE submission_id = v_sub;
      v_problems := v_problems || ' a stage was moved to another application;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    IF public.company_new_applications_count(v_company) <> 0 THEN v_problems := v_problems || ' an application moved past "new" is still counted as new;'; END IF;
    BEGIN
      UPDATE job_submissions SET note = 'rewritten by the company' WHERE id = v_sub;
      v_problems := v_problems || ' the company rewrote a candidate''s note;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      DELETE FROM job_submissions WHERE id = v_sub;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 0 THEN v_problems := v_problems || ' the company deleted an application;'; END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- a closed job takes no applications
    UPDATE open_position SET status = 'closed' WHERE id = v_job;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF NOT EXISTS (SELECT 1 FROM job_submission_reviews WHERE submission_id = v_sub AND stage = 'contacted' AND changed_by = v_owner AND company_id = v_company)
       OR NOT EXISTS (SELECT 1 FROM job_submissions WHERE id = v_sub AND note = 'Hello') THEN v_problems := v_problems || ' the stage change was not recorded (or touched her application);'; END IF;
    -- the candidate never sees the company's side; a content manager neither
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submission_reviews;
    IF v_n <> 0 THEN v_problems := v_problems || ' the candidate can read the company''s stage of her application;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submission_reviews;
    IF v_n <> 0 THEN v_problems := v_problems || ' a content manager can read the stages;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM job_submission_reviews WHERE submission_id = v_sub;
    IF v_n <> 1 THEN v_problems := v_problems || ' a Duallin admin cannot read the stage;'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO job_submissions (job_id, full_name, email, resume_path, answers) VALUES (v_job, 'Dana Check', 'dana@check-7f3a.example', v_job || '/' || v_d || '/cv.pdf', '[{"id": "q1", "answer": "2"}]');
      v_problems := v_problems || ' an application to a closed job was accepted;';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    IF public.job_resume_writable(v_job || '/' || v_d || '/cv.pdf') THEN v_problems := v_problems || ' a resume can be uploaded for a closed job;'; END IF;
    RESET ROLE;

    -- 17. she withdraws: the application is gone and her tracker steps back
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    DELETE FROM job_submissions WHERE id = v_sub;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    IF EXISTS (SELECT 1 FROM job_submissions WHERE id = v_sub) THEN v_problems := v_problems || ' a candidate could not withdraw her application;'; END IF;
    IF EXISTS (SELECT 1 FROM job_submission_reviews WHERE submission_id = v_sub) THEN v_problems := v_problems || ' the company''s side outlived a withdrawn application;'; END IF;
    IF NOT EXISTS (SELECT 1 FROM job_applications WHERE user_id = v_b AND job_id = v_job AND status = 'clicked') THEN v_problems := v_problems || ' her tracker still says "applied" after she withdrew;'; END IF;

    -- ===== signed-out visitor =====
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM job_submissions LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read applications;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM job_submission_reviews LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read stages;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      INSERT INTO open_position (company_id, job_title, location, job_description, apply_method, apply_link) VALUES (v_company, 'Anonymous job', 'Tel Aviv', v_desc, 'external', 'https://example.com/a');
      v_problems := v_problems || ' signed-out visitors can publish jobs;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT count(*) INTO v_n FROM open_position;
  IF v_n <> v_before THEN v_problems := v_problems || format(' the number of jobs changed (%s → %s): test rows were left behind;', v_before, v_n); END IF;
  IF EXISTS (SELECT 1 FROM job_submissions WHERE email LIKE '%@check-7f3a.example') THEN v_problems := v_problems || ' test applications were left behind;'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.open_position'::regclass AND tgname = 'open_position_guard' AND tgenabled = 'O') THEN
    v_problems := v_problems || ' the job guard is not switched on;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % existing jobs untouched; only a page''s owner / recruiter publishes, with fixed identity and plain text; imports skip managed pages and never delete a company''s job; applications follow the job''s form and are read only by the candidate, the page''s recruiters and Duallin admins.', v_before;
END $$;

COMMIT;

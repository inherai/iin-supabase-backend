-- ============================================================
-- UNDO add_company_jobs_safe.sql.
-- BEFORE running: deploy the API and the site without company jobs (they read the columns
-- and the table removed here).
--
-- What happens to data:
--   * jobs that companies published themselves (source 'Duallin') are DELETED, with their
--     applications — without this migration nothing could show or manage them
--   * imported jobs are untouched; jobs a page took down become visible again
--   * the private 'clicked / applied' tracker is untouched (members can no longer read it directly)
--   * resume files stay in storage (Supabase does not allow deleting them from SQL):
--     empty the job-resumes bucket from the dashboard if it is no longer needed
-- ============================================================
BEGIN;

DROP POLICY IF EXISTS "job resumes read" ON storage.objects;
DROP POLICY IF EXISTS "job resumes upload" ON storage.objects;
DROP POLICY IF EXISTS "job resumes delete own" ON storage.objects;
DROP FUNCTION IF EXISTS public.job_resume_readable(text);
DROP FUNCTION IF EXISTS public.job_resume_writable(text);

DROP POLICY IF EXISTS "A member reads her own applications tracker" ON public.job_applications;
DROP FUNCTION IF EXISTS public.company_new_applications_count(integer);
DROP TABLE IF EXISTS public.job_submission_reviews;
DROP FUNCTION IF EXISTS public.job_submission_review_before_write();
DROP TABLE IF EXISTS public.job_submissions;
DROP FUNCTION IF EXISTS public.job_submission_after_change();
DROP FUNCTION IF EXISTS public.job_submission_before_write();

DROP TRIGGER IF EXISTS trg_open_position_company_audit ON public.open_position;
DROP FUNCTION IF EXISTS public.open_position_company_audit();
DROP POLICY IF EXISTS "Page recruiters publish jobs" ON public.open_position;
DROP POLICY IF EXISTS "Page recruiters manage their jobs" ON public.open_position;
DROP TRIGGER IF EXISTS open_position_guard ON public.open_position;
DROP FUNCTION IF EXISTS public.open_position_guard();
DROP FUNCTION IF EXISTS public.job_company_key(text);

DELETE FROM public.open_position WHERE source = 'Duallin';

DROP INDEX IF EXISTS public.idx_open_position_company_status;
ALTER TABLE public.open_position
  DROP CONSTRAINT IF EXISTS open_position_status_check,
  DROP CONSTRAINT IF EXISTS open_position_apply_method_check,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS apply_method,
  DROP COLUMN IF EXISTS apply_form,
  DROP COLUMN IF EXISTS closed_at;

DROP FUNCTION IF EXISTS public.job_apply_form_clean(jsonb);
DROP FUNCTION IF EXISTS public.job_plain_to_html(text);

DELETE FROM public.notifications WHERE type IN ('COMPANY_JOB_NEW', 'COMPANY_JOB_APPLICATION');

COMMIT;

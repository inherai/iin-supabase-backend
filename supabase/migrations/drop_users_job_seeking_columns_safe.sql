-- ============================================================
-- Drop users.job_seeking_status / job_seeking_visibility — SELF-CHECKING (2026-11-22).
-- Run in the SQL Editor ONLY AFTER add_member_job_seeking_safe.sql AND after the API that
-- reads/writes member_job_seeking (routes/me.ts, _talentProfiles.ts, saved_resources.ts) is deployed.
--
-- Until this runs, any member can still read the old columns through the REST API.
-- Before dropping: copies once more whatever the old API wrote (the trigger already did), checks
-- that no view or function still reads the columns, then drops the copy trigger and the columns.
-- To go back: rollback_member_job_seeking.sql
-- ============================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.member_job_seeking') IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — run add_member_job_seeking_safe.sql first';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'job_seeking_status') THEN
    -- rows the new API has not written yet (it writes member_job_seeking only)
    INSERT INTO member_job_seeking (user_uuid, status, visibility)
    SELECT u.uuid, u.job_seeking_status, coalesce(u.job_seeking_visibility, 'recruiters')
    FROM users u
    WHERE (u.job_seeking_status IS NOT NULL OR u.job_seeking_visibility = 'quiet')
    ON CONFLICT (user_uuid) DO NOTHING;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_member_job_seeking_from_users ON public.users;
DROP FUNCTION IF EXISTS public.member_job_seeking_from_users();

DO $$
DECLARE
  v_readers text;
BEGIN
  SELECT string_agg(DISTINCT x, ', ') INTO v_readers FROM (
    -- views (and anything else) that depend on the columns
    SELECT d.classid::regclass::text || ' ' || d.objid::text AS x
    FROM pg_depend d
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refobjid = 'public.users'::regclass
      AND a.attname IN ('job_seeking_status', 'job_seeking_visibility')
      AND d.deptype = 'n'
      AND d.classid = 'pg_rewrite'::regclass
    UNION ALL
    -- functions that name them (sql/plpgsql bodies are not tracked by pg_depend)
    SELECT p.oid::regprocedure::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc ~ 'job_seeking_(status|visibility)'
      AND p.prosrc !~ 'member_job_seeking'
  ) r;
  IF v_readers IS NOT NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — these still read users.job_seeking_*: %', v_readers;
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_users_job_seeking_status;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_job_seeking_visibility_check;
ALTER TABLE public.users DROP COLUMN IF EXISTS job_seeking_visibility;
ALTER TABLE public.users DROP COLUMN IF EXISTS job_seeking_status;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'job_seeking%') THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a job_seeking column is still on users';
  END IF;
  RAISE NOTICE 'All checks passed: users no longer holds the job-seeking status; it lives only in member_job_seeking.';
END $$;

COMMIT;

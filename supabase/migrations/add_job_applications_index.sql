-- Index for efficient per-user application queries (status filtering, ordered by applied_at)
CREATE INDEX IF NOT EXISTS idx_job_applications_user_status_applied
  ON public.job_applications (user_id, status, applied_at DESC);

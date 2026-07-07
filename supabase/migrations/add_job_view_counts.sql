-- ============================================================
-- Per-job view counter — powers "most viewed jobs" in admin analytics
-- ============================================================

ALTER TABLE open_position
  ADD COLUMN IF NOT EXISTS views_count int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION increment_job_views(p_job_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE open_position SET views_count = views_count + 1 WHERE job_id = p_job_id;
$$;

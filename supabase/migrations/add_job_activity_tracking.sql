-- ============================================================
-- Job activity tracking — board visits, searches, single-job views
-- ============================================================

ALTER TABLE user_activity
  ADD COLUMN IF NOT EXISTS last_job_board_visit_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_job_board_visits  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_job_search_at      timestamptz,
  ADD COLUMN IF NOT EXISTS total_job_searches      int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_job_view_at        timestamptz,
  ADD COLUMN IF NOT EXISTS total_job_views         int NOT NULL DEFAULT 0;

-- ============================================================
-- RPC: record_job_activity
-- p_kind: 'board_visit' | 'search' | 'view'
-- ============================================================
CREATE OR REPLACE FUNCTION record_job_activity(p_user_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_kind = 'board_visit' THEN
    INSERT INTO user_activity (
      user_id, last_job_board_visit_at, total_job_board_visits, last_active_at, updated_at
    )
    VALUES (p_user_id, now(), 1, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      last_job_board_visit_at = now(),
      total_job_board_visits  = user_activity.total_job_board_visits + 1,
      last_active_at          = now(),
      updated_at              = now();

  ELSIF p_kind = 'search' THEN
    INSERT INTO user_activity (
      user_id, last_job_search_at, total_job_searches, last_active_at, updated_at
    )
    VALUES (p_user_id, now(), 1, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      last_job_search_at  = now(),
      total_job_searches  = user_activity.total_job_searches + 1,
      last_active_at      = now(),
      updated_at          = now();

  ELSIF p_kind = 'view' THEN
    INSERT INTO user_activity (
      user_id, last_job_view_at, total_job_views, last_active_at, updated_at
    )
    VALUES (p_user_id, now(), 1, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      last_job_view_at = now(),
      total_job_views  = user_activity.total_job_views + 1,
      last_active_at   = now(),
      updated_at       = now();
  END IF;

EXCEPTION WHEN OTHERS THEN NULL;
END;
$$;

-- ============================================================
-- Recent Talent Searches — DB Migration
-- ============================================================

CREATE TABLE IF NOT EXISTS recent_talent_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid REFERENCES users(uuid) ON DELETE CASCADE,
  executed_at timestamptz DEFAULT now(),
  filters jsonb NOT NULL,
  search_mode text NOT NULL CHECK (search_mode IN ('filters', 'semantic', 'jd')),
  total integer NOT NULL,
  candidate_uuids text[] NOT NULL,
  candidate_scores jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS recent_talent_searches_recruiter_idx
  ON recent_talent_searches(recruiter_id, executed_at DESC);

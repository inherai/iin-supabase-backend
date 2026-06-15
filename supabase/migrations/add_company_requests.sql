-- Enable pg_trgm for fuzzy string matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Company addition requests submitted by users
CREATE TABLE IF NOT EXISTS company_requests (
  id          BIGSERIAL PRIMARY KEY,
  requested_name TEXT NOT NULL,
  requested_by    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent duplicate requests from the same user for the same name
CREATE UNIQUE INDEX IF NOT EXISTS company_requests_user_name_idx
  ON company_requests (requested_by, lower(requested_name));

-- Fast lookup by status for admin
CREATE INDEX IF NOT EXISTS company_requests_status_idx ON company_requests (status);

-- RLS: users can only insert/read their own rows; admin reads all via service role
ALTER TABLE company_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own requests"
  ON company_requests FOR INSERT
  TO authenticated
  WITH CHECK (requested_by = auth.uid());

CREATE POLICY "Users can view own requests"
  ON company_requests FOR SELECT
  TO authenticated
  USING (requested_by = auth.uid());

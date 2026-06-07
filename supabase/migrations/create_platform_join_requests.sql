CREATE TABLE IF NOT EXISTS platform_join_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('candidate', 'recruiter')),
  -- common fields
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT,
  -- candidate-specific
  job_title TEXT,
  years_experience TEXT,
  -- recruiter-specific
  company_name TEXT,
  company_size TEXT,
  roles_looking_for TEXT,
  -- metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'contacted'))
);

ALTER TABLE platform_join_requests ENABLE ROW LEVEL SECURITY;
-- No RLS policies = no browser access; admin reads via service role

CREATE INDEX IF NOT EXISTS platform_join_requests_created_at_idx
  ON platform_join_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS platform_join_requests_type_idx
  ON platform_join_requests(type);

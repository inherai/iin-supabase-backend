-- ============================================================
-- Talent Search Feature — DB Migration
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Function: calculate experience years from JSONB
CREATE OR REPLACE FUNCTION calculate_experience_years(experience jsonb)
RETURNS int LANGUAGE plpgsql STABLE AS $$
DECLARE
  total_years int := 0;
  exp jsonb;
  start_year int;
  end_year int;
BEGIN
  IF experience IS NULL OR jsonb_array_length(experience) = 0 THEN RETURN 0; END IF;
  FOR exp IN SELECT * FROM jsonb_array_elements(experience) LOOP
    BEGIN
      start_year := SUBSTRING(COALESCE(exp->>'startDate',''), 1, 4)::int;
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
    IF (exp->>'current')::boolean = true THEN
      total_years := total_years + (EXTRACT(YEAR FROM NOW())::int - start_year);
    ELSIF exp->>'endDate' IS NOT NULL THEN
      BEGIN end_year := SUBSTRING(exp->>'endDate', 1, 4)::int;
      EXCEPTION WHEN OTHERS THEN end_year := EXTRACT(YEAR FROM NOW())::int; END;
      total_years := total_years + GREATEST(end_year - start_year, 0);
    END IF;
  END LOOP;
  RETURN GREATEST(total_years, 0);
END;
$$;

-- 2. RPC: semantic user search via pgvector
CREATE OR REPLACE FUNCTION match_users_by_embedding(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int
)
RETURNS TABLE (user_id uuid, similarity float)
LANGUAGE sql STABLE AS $$
  SELECT user_id, 1 - (vector <=> query_embedding) AS similarity
  FROM users_vectors
  WHERE 1 - (vector <=> query_embedding) > similarity_threshold
  ORDER BY vector <=> query_embedding
  LIMIT match_count;
$$;

-- 3. talent_search_view — wraps public_users_view without touching it
CREATE OR REPLACE VIEW talent_search_view AS
SELECT
  puv.*,
  u.job_seeking_status,
  calculate_experience_years(puv.experience) AS experience_years
FROM public_users_view puv
JOIN users u ON u.uuid = puv.uuid;

-- 4. Cache table for JD embeddings
CREATE TABLE IF NOT EXISTS job_embeddings (
  job_id text PRIMARY KEY REFERENCES open_position(job_id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 5. job_seeking_status field on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_seeking_status text
  CHECK (job_seeking_status IN ('active', 'open', 'not_looking')) DEFAULT NULL;

-- 6. Saved talent searches per recruiter
CREATE TABLE IF NOT EXISTS saved_talent_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid REFERENCES users(uuid) ON DELETE CASCADE,
  name text NOT NULL,
  filters jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  last_used_at timestamptz
);

-- 7. Profile access requests (full schema including phase 2 fields)
CREATE TABLE IF NOT EXISTS profile_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id uuid REFERENCES users(uuid) ON DELETE CASCADE,
  candidate_id uuid REFERENCES users(uuid) ON DELETE CASCADE,
  requested_fields text[] NOT NULL,
  approved_fields  text[],
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','partial','approved','rejected','revoked')),
  message     text,
  expires_at  timestamptz,
  viewed_at   timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(recruiter_id, candidate_id)
);

-- 8. Extend saved_resources to support 'candidate' type
DO $$ BEGIN
  ALTER TABLE saved_resources DROP CONSTRAINT IF EXISTS saved_resources_type_check;
  ALTER TABLE saved_resources ADD CONSTRAINT saved_resources_type_check
    CHECK (saved_resource_type IN ('post', 'position', 'candidate'));
END $$;

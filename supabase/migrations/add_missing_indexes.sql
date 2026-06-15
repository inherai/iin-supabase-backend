-- likes: feed loads query WHERE target_id IN (...) but only a (user_id, target_id) unique
-- index exists → full scan on target_id. Covering index enables index-only scans.
CREATE INDEX IF NOT EXISTS idx_likes_target_id_cover
  ON likes(target_id)
  INCLUDE (user_id, reaction_type);

-- users: talent search filters on these columns with no GIN indexes → sequential scans.
-- work_preferences is text[] (array), languages/education are jsonb.
CREATE INDEX IF NOT EXISTS idx_users_work_preferences_gin
  ON users USING GIN (work_preferences);

CREATE INDEX IF NOT EXISTS idx_users_languages_gin
  ON users USING GIN (languages);

CREATE INDEX IF NOT EXISTS idx_users_education_gin
  ON users USING GIN (education);

-- Partial btree on job_seeking_status — most rows are NULL so a partial index is much smaller.
CREATE INDEX IF NOT EXISTS idx_users_job_seeking_status
  ON users(job_seeking_status)
  WHERE job_seeking_status IS NOT NULL;

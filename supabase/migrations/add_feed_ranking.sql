-- Feed Ranking v2: last_seen_at + indexes + RLS policies
-- All changes are additive — nothing existing is modified or removed

-- 1. Add last_seen_at to post_impressions
--    created_at remains unchanged (first impression of the day)
--    last_seen_at updates on every re-view (used for "new since you last saw this")
ALTER TABLE post_impressions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz DEFAULT NOW();

-- 2. Composite index for ranked feed query: WHERE user_id = X AND post_id IN (...)
--    Existing indexes are (post_id) and (user_id) separately — not optimal for this query
CREATE INDEX IF NOT EXISTS idx_post_impressions_user_post
  ON post_impressions (user_id, post_id);

-- 3. Indexes on connections table
--    Currently no index on requester_id/receiver_id → full table scan on every feed request
CREATE INDEX IF NOT EXISTS idx_connections_requester
  ON connections (requester_id, status);

CREATE INDEX IF NOT EXISTS idx_connections_receiver
  ON connections (receiver_id, status);

-- 4. RLS policies on post_impressions
--    Currently only INSERT policy exists; ranked feed reads impressions as the user
CREATE POLICY "Users can read own impressions"
  ON post_impressions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own impressions"
  ON post_impressions FOR UPDATE
  USING (auth.uid() = user_id);

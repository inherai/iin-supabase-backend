-- ============================================================
-- Scheduled Posts
-- Posts authored by users but not yet published.
-- A cron job (every minute) moves rows whose scheduled_at <= NOW()
-- into the regular `posts` table via POST /api/posts/publish-scheduled.
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id                     TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sender                 TEXT        NOT NULL,
  subject                TEXT        NOT NULL DEFAULT '',
  message                TEXT        NOT NULL,
  attachments            JSONB       NOT NULL DEFAULT '[]',
  post_type              TEXT        NOT NULL DEFAULT 'discussion',
  community_members_only BOOLEAN     NOT NULL DEFAULT false,
  company_id             BIGINT      NULL,
  posted_by_uuid         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  linked_article_id      TEXT        NULL,
  scheduled_at           TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_posted_by
  ON scheduled_posts(posted_by_uuid);

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_at
  ON scheduled_posts(scheduled_at);

-- RLS: users can only access their own scheduled posts
ALTER TABLE scheduled_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own scheduled posts"
  ON scheduled_posts
  FOR ALL
  USING (posted_by_uuid = auth.uid())
  WITH CHECK (posted_by_uuid = auth.uid());

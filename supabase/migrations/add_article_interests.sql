-- ─── ARTICLE INTERESTS TAGGING ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS article_interests (
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  interest_id INT  NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, interest_id)
);

CREATE INDEX IF NOT EXISTS idx_article_interests_interest_id
  ON article_interests (interest_id);

ALTER TABLE article_interests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read article interests"
  ON article_interests FOR SELECT USING (true);

CREATE POLICY "author manages interests"
  ON article_interests FOR ALL USING (
    EXISTS (SELECT 1 FROM articles WHERE id = article_id AND author_uuid = auth.uid())
  );

-- ─── SMART FILTER TAGS RPC ─────────────────────────────────────────────────────
-- Returns top N tags (skills + interests) that actually appear on published
-- articles, sorted: user's own profile tags first, then by article count.
-- Efficient: uses indexes on article_skills.skill_id, article_interests.interest_id,
-- and the partial index on articles(status, deleted_at).

CREATE OR REPLACE FUNCTION get_article_filter_tags(
  p_limit INT DEFAULT 20
)
RETURNS TABLE(
  id            INT,
  name          TEXT,
  type          TEXT,
  article_count BIGINT,
  is_user_tag   BOOLEAN
)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  WITH published AS (
    SELECT id FROM articles
    WHERE status = 'published' AND deleted_at IS NULL
  ),
  skill_counts AS (
    SELECT s.id, s.name, 'skill'::TEXT AS type, COUNT(*)::BIGINT AS cnt
    FROM article_skills asj
    JOIN published p ON p.id = asj.article_id
    JOIN skills    s ON s.id = asj.skill_id
    GROUP BY s.id, s.name
  ),
  interest_counts AS (
    SELECT i.id, i.name, 'interest'::TEXT AS type, COUNT(*)::BIGINT AS cnt
    FROM article_interests aij
    JOIN published p ON p.id = aij.article_id
    JOIN interests i ON i.id = aij.interest_id
    GROUP BY i.id, i.name
  ),
  all_tags AS (
    SELECT * FROM skill_counts
    UNION ALL
    SELECT * FROM interest_counts
  ),
  user_profile AS (
    SELECT
      COALESCE(skills,    '{}') AS user_skills,
      COALESCE(interests, '{}') AS user_interests
    FROM users WHERE uuid = auth.uid()
    LIMIT 1
  )
  SELECT
    at.id,
    at.name,
    at.type,
    at.cnt AS article_count,
    CASE
      WHEN at.type = 'skill'    AND lower(at.name) = ANY(SELECT lower(x) FROM unnest((SELECT user_skills    FROM user_profile)) AS x) THEN true
      WHEN at.type = 'interest' AND lower(at.name) = ANY(SELECT lower(x) FROM unnest((SELECT user_interests FROM user_profile)) AS x) THEN true
      ELSE false
    END AS is_user_tag
  FROM all_tags at
  ORDER BY is_user_tag DESC, at.cnt DESC
  LIMIT p_limit;
$$;

-- ─── TRIGRAM EXTENSION ─────────────────────────────────────────────────────────
-- Required for efficient ILIKE %q% queries via GIN indexes.
-- Without this, every ILIKE does a full-table sequential scan.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── TRIGRAM INDEXES — articles ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_articles_title_trgm
  ON articles USING GIN (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_articles_excerpt_trgm
  ON articles USING GIN (excerpt gin_trgm_ops)
  WHERE excerpt IS NOT NULL AND deleted_at IS NULL;

-- ─── TRIGRAM INDEXES — skills & interests ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_skills_name_trgm
  ON skills USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_interests_name_trgm
  ON interests USING GIN (name gin_trgm_ops);

-- ─── TRIGRAM INDEXES — user names ──────────────────────────────────────────────
-- Separate indexes so each predicate (first_name ILIKE / last_name ILIKE)
-- can use its own index independently.

CREATE INDEX IF NOT EXISTS idx_users_first_name_trgm
  ON users USING GIN (first_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_last_name_trgm
  ON users USING GIN (last_name gin_trgm_ops);

-- ─── get_articles_feed RPC ─────────────────────────────────────────────────────
-- Single-query feed with multi-tag OR scoring and keyset pagination.
-- Replaces 3–5 round-trips (tag-id lookups + articles fetch + JS sort) with 1.
--
-- Parameters:
--   p_skill_ids / p_interest_ids — optional filter arrays (OR semantics)
--   p_cursor_match / p_cursor_date / p_cursor_id — keyset pagination tuple
--   p_limit — page size (default 20, caller enforces max)
--
-- Result ordering: match_count DESC, published_at DESC, id DESC
-- Cursor format the caller should pass back: "{match_count}__{published_at}__{id}"

CREATE OR REPLACE FUNCTION get_articles_feed(
  p_skill_ids     INT[]       DEFAULT '{}',
  p_interest_ids  INT[]       DEFAULT '{}',
  p_cursor_match  BIGINT      DEFAULT NULL,
  p_cursor_date   TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id     UUID        DEFAULT NULL,
  p_limit         INT         DEFAULT 20
)
RETURNS TABLE (
  id                      UUID,
  title                   TEXT,
  excerpt                 TEXT,
  cover_image_url         TEXT,
  read_time               INT,
  published_at            TIMESTAMPTZ,
  author_uuid             UUID,
  author_type             TEXT,
  company_id              INT,
  guest_author_name       TEXT,
  guest_author_avatar_url TEXT,
  is_editors_pick         BOOLEAN,
  match_count             BIGINT
)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  WITH tag_matches AS (
    -- Count how many of the requested tags each article satisfies (OR logic)
    SELECT article_id, COUNT(*)::BIGINT AS match_count
    FROM (
      SELECT article_id FROM article_skills    WHERE skill_id    = ANY(p_skill_ids)
      UNION ALL
      SELECT article_id FROM article_interests WHERE interest_id = ANY(p_interest_ids)
    ) t
    GROUP BY article_id
  ),
  has_filter AS (
    SELECT (cardinality(p_skill_ids) > 0 OR cardinality(p_interest_ids) > 0) AS active
  )
  SELECT
    a.id,
    a.title,
    a.excerpt,
    a.cover_image_url,
    a.read_time,
    a.published_at,
    a.author_uuid,
    a.author_type,
    a.company_id,
    a.guest_author_name,
    a.guest_author_avatar_url,
    a.is_editors_pick,
    COALESCE(tm.match_count, 0)::BIGINT AS match_count
  FROM articles a
  LEFT JOIN tag_matches tm ON tm.article_id = a.id
  CROSS JOIN has_filter hf
  WHERE
    a.status = 'published'
    AND a.deleted_at IS NULL
    -- When a filter is active, only include articles that match at least one tag
    AND (NOT hf.active OR tm.article_id IS NOT NULL)
    -- Keyset pagination: exclude rows we've already seen
    AND (
      p_cursor_match IS NULL
      OR COALESCE(tm.match_count, 0) < p_cursor_match
      OR (COALESCE(tm.match_count, 0) = p_cursor_match AND a.published_at < p_cursor_date)
      OR (COALESCE(tm.match_count, 0) = p_cursor_match AND a.published_at = p_cursor_date AND a.id < p_cursor_id)
    )
  ORDER BY COALESCE(tm.match_count, 0) DESC, a.published_at DESC, a.id DESC
  LIMIT p_limit + 1  -- caller checks if length > p_limit to determine hasMore
$$;

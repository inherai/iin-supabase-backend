-- Fix get_articles_feed: the deployed version lost its ORDER BY, LIMIT, and
-- keyset-cursor predicate (it returned ALL published articles, unordered, on
-- every page — causing duplicates on "load more" and an arbitrary feed order).
--
-- This recreates the function with:
--   * deterministic ordering: match_count DESC, published_at DESC, id DESC
--   * the keyset pagination predicate matching that order
--   * LIMIT p_limit + 1 (caller checks the extra row to compute hasMore)
--   * article_type in the result (added to the deployed version after the
--     original migration was written; kept so the news badge keeps working)
--
-- DROP first because CREATE OR REPLACE cannot change the return columns.

DROP FUNCTION IF EXISTS get_articles_feed(INT[], INT[], BIGINT, TIMESTAMPTZ, UUID, INT);

CREATE FUNCTION get_articles_feed(
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
  article_type            TEXT,
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
    a.article_type,
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
  ORDER BY COALESCE(tm.match_count, 0) DESC, a.published_at DESC NULLS LAST, a.id DESC
  LIMIT p_limit + 1  -- caller checks if length > p_limit to determine hasMore
$$;

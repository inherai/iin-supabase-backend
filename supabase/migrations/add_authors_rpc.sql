-- ─── INDEX — article_author_follows.author_uuid ──────────────────────────────
-- Without this, every follower-count query (author page, authors list) is a
-- full sequential scan on article_author_follows. With even a few thousand
-- follows this is the slowest query in the articles feature.
--
-- Covers:
--   • GET /articles/user/:id  — .select('follower_uuid', count:'exact').eq('author_uuid', id)
--   • GET /articles/authors   — GROUP BY author_uuid in get_top_authors RPC
--   • main feed route         — .select('author_uuid').in('author_uuid', uuids)

CREATE INDEX IF NOT EXISTS idx_article_author_follows_author_uuid
  ON article_author_follows (author_uuid);

-- ─── INDEX — articles by author (published only) ──────────────────────────────
-- Supports the GROUP BY author_uuid in get_top_authors without scanning the
-- full articles table. The partial predicate (status + deleted_at + author_uuid)
-- matches the WHERE clause exactly, keeping the index small.
--
-- Existing idx_articles_author_uuid covers (author_uuid, published_at DESC)
-- WHERE author_uuid IS NOT NULL AND deleted_at IS NULL — but it does NOT filter
-- by status, so the planner still has to re-check status on every row it visits.
-- This index adds the status predicate for a precise match.

CREATE INDEX IF NOT EXISTS idx_articles_author_published
  ON articles (author_uuid)
  WHERE status = 'published'
    AND deleted_at IS NULL
    AND author_uuid IS NOT NULL;

-- ─── get_top_authors RPC ──────────────────────────────────────────────────────
-- Returns top N authors with aggregated stats, computed entirely in Postgres.
--
-- Before (old edge-function approach):
--   • Download ALL published articles into Deno RAM  → O(total_articles) rows
--   • Download ALL view counts into Deno RAM          → O(total_articles) rows
--   • Download follower rows for top-N authors        → O(total_follows_for_top_N) rows
--   • Group / sort / count in JavaScript
--   Total: up to tens of thousands of rows transferred; grows linearly with content.
--
-- After (this RPC):
--   • Everything aggregated in Postgres               → exactly p_limit rows returned
--   • Edge function only fetches p_limit profile rows (names / avatars)
--   Total: O(1) rows transferred regardless of platform size.
--
-- Parameters:
--   p_sort  — 'popular' (default): total_views DESC, then article_count DESC
--             'new'              : first published article DESC (freshest newcomer first)
--   p_limit — rows to return; caller enforces max (currently 50)
--
-- Returns only UUIDs + stats; caller fetches profile display data separately
-- (first_name, last_name, image) with a targeted IN() on p_limit UUIDs.
--
-- Security: SECURITY DEFINER bypasses RLS on article_impressions so we can
-- aggregate view counts across all users (same reason article_view_counts VIEW
-- exists). Does not expose any user_id — only per-article totals.

CREATE OR REPLACE FUNCTION get_top_authors(
  p_sort  TEXT DEFAULT 'popular',
  p_limit INT  DEFAULT 20
)
RETURNS TABLE (
  author_uuid     UUID,
  article_count   BIGINT,
  total_views     BIGINT,
  follower_count  BIGINT,
  first_published TIMESTAMPTZ
)
LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  WITH article_stats AS (
    -- One pass over published articles: count articles, sum views, find first publish date.
    -- article_impressions joined here (not the article_view_counts VIEW) so the planner
    -- can see the underlying table and optimise the aggregate with idx_article_impressions_article_id.
    SELECT
      a.author_uuid,
      COUNT(DISTINCT a.id)::BIGINT                 AS article_count,
      COALESCE(SUM(ai_agg.view_count), 0)::BIGINT  AS total_views,
      MIN(a.published_at)                          AS first_published
    FROM articles a
    LEFT JOIN (
      SELECT article_id, COUNT(*)::BIGINT AS view_count
      FROM article_impressions
      GROUP BY article_id
    ) ai_agg ON ai_agg.article_id = a.id
    WHERE
      a.status      = 'published'
      AND a.deleted_at IS NULL
      AND a.author_uuid IS NOT NULL
    GROUP BY a.author_uuid
  ),
  follower_stats AS (
    -- One pass over article_author_follows — uses idx_article_author_follows_author_uuid.
    SELECT author_uuid, COUNT(*)::BIGINT AS follower_count
    FROM article_author_follows
    GROUP BY author_uuid
  )
  SELECT
    s.author_uuid,
    s.article_count,
    s.total_views,
    COALESCE(f.follower_count, 0)::BIGINT   AS follower_count,
    s.first_published
  FROM article_stats   s
  LEFT JOIN follower_stats f ON f.author_uuid = s.author_uuid
  -- Conditional sort: only one branch is non-NULL per call, so the active
  -- branch drives the order; NULLs sort last (PostgreSQL NULLS LAST default for DESC).
  ORDER BY
    CASE WHEN p_sort = 'new'     THEN EXTRACT(EPOCH FROM s.first_published) END DESC,
    CASE WHEN p_sort = 'popular' THEN s.total_views                         END DESC,
    CASE WHEN p_sort = 'popular' THEN s.article_count                       END DESC
  LIMIT p_limit
$$;

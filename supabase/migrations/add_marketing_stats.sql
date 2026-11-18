-- ============================================================
-- Platform numbers for the public marketing pages (2026-11-18). Run in the SQL Editor.
-- Needs the pg_cron extension (already used by profile-stats-snapshot).
--
-- What it adds
--   1. marketing_stats_compute(): community-wide totals as one jsonb — activity, connections,
--      messages, post views, feed interactions, profile views, job apply clicks and the share
--      of members with a current employer. Members = users rows that are not deleted.
--   2. marketing_stats_snapshots: one row per day with that jsonb, written by pg_cron at
--      23:50 Israel time (21:50 UTC). The first snapshot is taken right here.
--   3. public_marketing_stats(): what the public pages read — the latest snapshot and its date.
--
-- Who can do what
--   * nobody reads marketing_stats_snapshots directly (RLS on, no policies, no grants to API
--     roles); service_role may read it for background jobs.
--   * marketing_stats_compute / take_marketing_stats_snapshot are not callable from the API.
--   * public_marketing_stats is callable by anyone, signed in or not (the pages are public).
--     It is SECURITY DEFINER (owner rights) only to read the snapshot table, and returns
--     community totals only — never a member's identity or content.
--
-- Undo: rollback_add_marketing_stats.sql
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Current totals
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marketing_stats_compute()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH members AS (
    SELECT u.uuid, u.experience
    FROM users u
    WHERE u.email NOT LIKE 'deleted_%@deleted.local'
  ),
  m AS (SELECT count(*)::numeric AS total FROM members),
  employed AS (
    SELECT count(*) AS n
    FROM members mb
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mb.experience) = 'array' THEN mb.experience ELSE '[]'::jsonb END) e
      WHERE e ->> 'current' = 'true'
        AND CASE jsonb_typeof(e -> 'company')
              WHEN 'string' THEN trim(e ->> 'company') <> ''
              WHEN 'object' THEN coalesce(trim(e -> 'company' ->> 'name'), '') <> '' OR e -> 'company' ? 'id'
              WHEN 'number' THEN true
              ELSE false
            END
    )
  ),
  conn AS (SELECT count(*) AS n FROM connections WHERE status = 'accepted')
  SELECT jsonb_build_object(
    'members',            (SELECT total FROM m),
    'active_30d_pct',     round(100 * (SELECT count(DISTINCT d.user_id) FROM user_active_days d JOIN members mb ON mb.uuid = d.user_id
                                       WHERE d.day > current_date - 30) / nullif((SELECT total FROM m), 0), 1),
    'active_7d_pct',      round(100 * (SELECT count(DISTINCT d.user_id) FROM user_active_days d JOIN members mb ON mb.uuid = d.user_id
                                       WHERE d.day > current_date - 7) / nullif((SELECT total FROM m), 0), 1),
    'connections',        (SELECT n FROM conn),
    'avg_connections',    round(2 * (SELECT n FROM conn) / nullif((SELECT total FROM m), 0), 1),
    'messages',           (SELECT count(*) FROM messages),
    'messages_30d',       (SELECT count(*) FROM messages WHERE created_at > now() - interval '30 days'),
    'post_views',         (SELECT count(*) FROM post_impressions),
    'post_views_30d',     (SELECT count(*) FROM post_impressions WHERE impression_date > current_date - 30),
    'feed_interactions',  (SELECT count(*) FROM posts) + (SELECT count(*) FROM comments) + (SELECT count(*) FROM likes),
    'profile_views',      (SELECT count(*) FROM profile_views),
    'apply_clicks',       (SELECT count(*) FROM job_applications),
    'apply_clicks_30d',   (SELECT count(*) FROM job_applications
                           WHERE coalesce(apply_clicked_at, applied_at) > now() - interval '30 days'),
    'with_employer_pct',  round(100 * (SELECT n FROM employed) / nullif((SELECT total FROM m), 0), 1)
  );
$$;

-- ------------------------------------------------------------
-- 2. Daily snapshots
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_stats_snapshots (
  snapshot_date date PRIMARY KEY,
  stats         jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.marketing_stats_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_stats_snapshots FROM anon, authenticated;
GRANT SELECT ON public.marketing_stats_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.take_marketing_stats_snapshot()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Re-running on the same day replaces that day's snapshot
  INSERT INTO marketing_stats_snapshots (snapshot_date, stats)
  VALUES ((now() AT TIME ZONE 'Asia/Jerusalem')::date, marketing_stats_compute())
  ON CONFLICT (snapshot_date) DO UPDATE SET stats = EXCLUDED.stats, created_at = now();
$$;

-- ------------------------------------------------------------
-- 3. What the public pages read
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_marketing_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('date', snapshot_date, 'stats', stats)
  FROM marketing_stats_snapshots
  ORDER BY snapshot_date DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.marketing_stats_compute() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.take_marketing_stats_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_marketing_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_marketing_stats() TO anon, authenticated;

SELECT public.take_marketing_stats_snapshot();

SELECT cron.unschedule('marketing-stats-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'marketing-stats-snapshot');
SELECT cron.schedule('marketing-stats-snapshot', '50 21 * * *', $$SELECT public.take_marketing_stats_snapshot()$$);

-- ------------------------------------------------------------
-- Self-check: a visitor gets the latest snapshot and nothing else. Nothing is kept.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_json jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
    SET LOCAL ROLE anon;
    v_json := public.public_marketing_stats();
    IF v_json -> 'stats' ->> 'connections' IS NULL OR v_json ->> 'date' IS NULL THEN
      v_problems := v_problems || ' the public reply is missing the snapshot;';
    END IF;
    BEGIN
      PERFORM 1 FROM public.marketing_stats_snapshots LIMIT 1;
      v_problems := v_problems || ' visitors can read marketing_stats_snapshots;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.marketing_stats_compute();
      v_problems := v_problems || ' visitors can call marketing_stats_compute;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.take_marketing_stats_snapshot();
      v_problems := v_problems || ' visitors can call take_marketing_stats_snapshot;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM 1 FROM public.marketing_stats_snapshots LIMIT 1;
      v_problems := v_problems || ' members can read marketing_stats_snapshots;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: first snapshot taken (% accepted connections), daily job scheduled.',
    v_json -> 'stats' ->> 'connections';
END $$;

COMMIT;

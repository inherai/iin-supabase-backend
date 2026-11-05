-- ============================================================
-- Email measurement (2026-11-05). Run in Supabase SQL Editor. Safe to re-run.
--   * email_log.opened_at / clicked_at / click_count — from Resend webhook events
--     (open + click tracking must be turned on for the domain in Resend).
--   * user_active_days — one row per member per day she used the site (written by the API,
--     at most every 30 min per member). Used for "came back to the site within 48 hours".
--   * email_preferences.source / email_suppressions.source — where an opt-out came from:
--     'settings', 'email_link', 'one_click' (the mail app's button), 'admin'.
--   * email_stats(days) — per email kind: sent, delivered, bounced, spam, not sent, opened,
--     clicked, came back within 48h, and reached the email's goal (where it has one).
-- The API works with or without this migration.
-- ============================================================

ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS opened_at   timestamptz;
ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS clicked_at  timestamptz;
ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.email_preferences  ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.email_suppressions ADD COLUMN IF NOT EXISTS source text;

CREATE TABLE IF NOT EXISTS public.user_active_days (
  user_id  uuid        NOT NULL,
  day      date        NOT NULL,
  last_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.user_active_days ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_active_days TO service_role;

CREATE INDEX IF NOT EXISTS email_log_kind_created ON public.email_log (kind, created_at);

-- Drop first: the return columns changed since the first version of this file.
DROP FUNCTION IF EXISTS public.email_stats(integer);

CREATE FUNCTION public.email_stats(p_days integer DEFAULT 30)
RETURNS TABLE (
  kind        text,
  category    text,     -- the settings category (opt-outs are counted per category)
  sent        bigint,   -- went out (sent + delivered + bounced + complained)
  delivered   bigint,
  bounced     bigint,
  complained  bigint,
  skipped     bigint,   -- not sent: turned off / blocked / invalid address
  failed      bigint,
  opened      bigint,   -- at least one open (approximate — Apple Mail pre-opens)
  clicked     bigint,   -- at least one click on a link
  -- Two views of each result, so a fair rate never mixes finished and unfinished emails:
  --   *_closed / *_closed_met : emails whose window has closed (48h / 7 days) → the real rate
  --   *_all    / *_met        : every email so far, and how many already succeeded → "so far X of N"
  returned_closed      bigint,
  returned_closed_met  bigint,
  returned_all         bigint,
  returned_met         bigint,
  goal_closed          bigint,  -- 0 for kinds without a goal
  goal_closed_met      bigint,
  goal_all             bigint,
  goal_met             bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH l AS (
    SELECT e.*, e.status IN ('sent', 'delivered', 'bounced', 'complained') AS went_out
    FROM email_log e
    WHERE e.created_at >= now() - make_interval(days => p_days)
  ),
  g AS (
    SELECT l.id,
      -- the goal of each kind (null = no goal)
      CASE
        WHEN l.kind LIKE 'onboarding_reminder_%' THEN
          EXISTS (SELECT 1 FROM users u WHERE u.uuid = l.user_id AND u.status = 'Active'
                  AND u.activated_at BETWEEN l.created_at AND l.created_at + interval '7 days')
        WHEN l.kind IN ('invites_unlocked', 'invites_thanks', 'invites_reminder_1', 'invites_reminder_2', 'invitee_joined', 'invite_expired') THEN
          EXISTS (SELECT 1 FROM invites i WHERE i.inviter_id = l.user_id
                  AND i.created_at BETWEEN l.created_at AND l.created_at + interval '7 days')
        WHEN l.kind IN ('invite', 'invite_reminder') THEN
          EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = l.email
                  AND u.created_at BETWEEN l.created_at AND l.created_at + interval '7 days')
        WHEN l.kind = 'request_reminder' THEN
          -- a request that was waiting when the email went out (5–7 days old then) is now accepted
          -- (connections has no updated_at, so "accepted after the email" can't be timed exactly)
          EXISTS (SELECT 1 FROM connections c WHERE c.receiver_id = l.user_id AND c.status = 'accepted'
                  AND c.created_at BETWEEN l.created_at - interval '8 days' AND l.created_at - interval '4 days')
        WHEN l.kind = 'welcome' THEN
          -- it goes out while she is still on the site (right after sign-up), so "came back within
          -- 48h" counts that same visit; the real question is a visit on ANOTHER day within 7 days
          EXISTS (SELECT 1 FROM user_active_days d WHERE d.user_id = l.user_id
                  AND d.day > l.created_at::date AND d.day <= (l.created_at + interval '7 days')::date)
        WHEN l.kind = 'people_suggestions' THEN
          EXISTS (SELECT 1 FROM connections c WHERE c.requester_id = l.user_id
                  AND c.created_at BETWEEN l.created_at AND l.created_at + interval '7 days')
        WHEN l.kind = 'content_digest' THEN
          EXISTS (SELECT 1 FROM comments cm WHERE lower(cm.sender) = l.email
                  AND cm.created_at BETWEEN l.created_at AND l.created_at + interval '48 hours')
        ELSE NULL   -- no single goal: "came back to the site" is the measure (the admin page shows it)
      END AS goal,
      -- how long the goal is given (a result is only counted once this window has closed)
      CASE WHEN l.kind = 'content_digest' THEN interval '48 hours' ELSE interval '7 days' END AS goal_window,
      -- came back: active later the same day, or on one of the next 2 days. Not the same day for
      -- welcome: it goes out while she is still on the site, so that visit isn't "coming back".
      EXISTS (SELECT 1 FROM user_active_days d WHERE d.user_id = l.user_id
              AND ((d.day = l.created_at::date AND d.last_at > l.created_at AND l.kind <> 'welcome')
                   OR (d.day > l.created_at::date AND d.day <= (l.created_at + interval '48 hours')::date))) AS came_back
    FROM l WHERE l.went_out
  )
  SELECT
    l.kind,
    max(l.category),
    count(*) FILTER (WHERE l.went_out),
    count(*) FILTER (WHERE l.status = 'delivered'),
    count(*) FILTER (WHERE l.status = 'bounced'),
    count(*) FILTER (WHERE l.status = 'complained'),
    count(*) FILTER (WHERE l.status = 'skipped'),
    count(*) FILTER (WHERE l.status = 'failed'),
    count(*) FILTER (WHERE l.went_out AND l.opened_at IS NOT NULL),
    count(*) FILTER (WHERE l.went_out AND l.clicked_at IS NOT NULL),
    count(*) FILTER (WHERE l.went_out AND l.user_id IS NOT NULL AND l.created_at <= now() - interval '48 hours'),
    count(*) FILTER (WHERE l.went_out AND l.user_id IS NOT NULL AND l.created_at <= now() - interval '48 hours' AND g.came_back),
    count(*) FILTER (WHERE l.user_id IS NOT NULL AND l.went_out),
    count(*) FILTER (WHERE l.went_out AND l.user_id IS NOT NULL AND g.came_back),
    count(*) FILTER (WHERE g.goal IS NOT NULL AND l.created_at <= now() - g.goal_window),
    count(*) FILTER (WHERE g.goal IS TRUE AND l.created_at <= now() - g.goal_window),
    count(*) FILTER (WHERE g.goal IS NOT NULL),
    count(*) FILTER (WHERE g.goal IS TRUE)
  FROM l LEFT JOIN g ON g.id = l.id
  GROUP BY l.kind
  ORDER BY 3 DESC;
$$;

REVOKE ALL ON FUNCTION public.email_stats(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_stats(integer) TO service_role;

-- How many emails each member got in the last `p_days` (members only, not service/team emails):
-- one row per bucket (1, 2, 3 … 6 = "6 or more"), to see that nobody is flooded.
CREATE OR REPLACE FUNCTION public.email_member_volume(p_days integer DEFAULT 7)
RETURNS TABLE (emails integer, members bigint, max_emails integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH per AS (
    SELECT user_id, count(*)::int AS n
    FROM email_log
    WHERE user_id IS NOT NULL
      AND status IN ('sent', 'delivered', 'bounced', 'complained')
      AND category NOT IN ('account', 'team', 'invitee')
      AND created_at >= now() - make_interval(days => p_days)
    GROUP BY user_id
  )
  SELECT least(n, 6) AS emails, count(*) AS members, (SELECT max(n) FROM per) AS max_emails
  FROM per GROUP BY 1 ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.email_member_volume(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_member_volume(integer) TO service_role;

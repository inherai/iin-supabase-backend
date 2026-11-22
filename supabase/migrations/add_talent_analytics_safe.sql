-- ============================================================
-- Talent (recruiters) usage analytics for the admin panel — SELF-CHECKING (2026-11-22).
-- Run in the SQL Editor. Needs add_talent_v2_safe.sql (talent_is_recruiter, talent_projects,
-- contact_accepted_at), add_company_pages_core_safe.sql (is_platform_admin) and
-- add_member_job_seeking_safe.sql (member_job_seeking — "open to work" lives there now).
--
-- What it adds
--   1. talent_events: what recruiters do in /talent that nothing kept until now — each search
--      (mode, free text, the filters she chose, how many results, the ids on the page she saw)
--      and each candidate she opened. Written by the API in the recruiter's own session (her own
--      row only). NOBODY reads the rows through the API — only admin_talent_analytics() below.
--   2. talent_outreach_log: every status a recruiter's outreach goes through. The request row
--      itself is overwritten when she asks again (one row per recruiter + candidate), so its
--      history was lost. Filled by a trigger; the rows that exist today are backfilled from
--      their timestamps (marked backfilled).
--   3. admin_talent_analytics(p_days): one jsonb for /dualldmin/talent — per recruiter, searches,
--      outreach and how candidates answered, what happened in chat after an acceptance, projects
--      and stages, candidates most viewed / contacted. Admins only (is_admin in the JWT).
--      Admins' own use of /talent is not counted: only members with app role 'recruiters'.
--      Recruiters' private notes are COUNTED, never read; outreach messages show their length only.
--
-- The checks run in the SAME transaction with throw-away rows: if any fails, nothing
-- changes. To go back later: rollback_add_talent_analytics.sql          Safe to re-run.
-- ============================================================
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.member_job_seeking') IS NULL THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — run add_member_job_seeking_safe.sql first';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. What recruiters do in /talent
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_events (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recruiter_id uuid        NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         text        NOT NULL CHECK (kind IN ('search', 'candidate_view')),
  search_mode  text        CHECK (search_mode IN ('filters', 'semantic', 'jd')),
  query        text        CHECK (query IS NULL OR char_length(query) <= 300),
  filters      jsonb,
  job_id       text        CHECK (job_id IS NULL OR char_length(job_id) <= 200),
  total        integer,
  page         integer,
  result_ids   uuid[]      CHECK (result_ids IS NULL OR cardinality(result_ids) <= 50),
  candidate_id uuid        REFERENCES public.users(uuid) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_talent_events_created ON public.talent_events (created_at);
CREATE INDEX IF NOT EXISTS idx_talent_events_recruiter ON public.talent_events (recruiter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_talent_events_candidate ON public.talent_events (candidate_id) WHERE candidate_id IS NOT NULL;

ALTER TABLE public.talent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.talent_events FROM PUBLIC, anon, authenticated;
-- she may only add her own row (who and when come from the defaults)
GRANT INSERT (kind, search_mode, query, filters, job_id, total, page, result_ids, candidate_id)
  ON public.talent_events TO authenticated;
GRANT ALL ON public.talent_events TO service_role;

DROP POLICY IF EXISTS "A recruiter records her own use of talent" ON public.talent_events;
CREATE POLICY "A recruiter records her own use of talent" ON public.talent_events
  FOR INSERT TO authenticated
  WITH CHECK (recruiter_id = auth.uid() AND public.talent_is_recruiter());

-- ------------------------------------------------------------
-- 2. Every status of an outreach
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.talent_outreach_log (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   uuid        NOT NULL,
  recruiter_id uuid        NOT NULL REFERENCES public.users(uuid) ON DELETE CASCADE,
  candidate_id uuid        NOT NULL REFERENCES public.users(uuid) ON DELETE CASCADE,
  status       text        NOT NULL,
  context_title text,
  at           timestamptz NOT NULL DEFAULT now(),
  backfilled   boolean     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_talent_outreach_log_request ON public.talent_outreach_log (request_id, at);
CREATE INDEX IF NOT EXISTS idx_talent_outreach_log_at ON public.talent_outreach_log (at);

ALTER TABLE public.talent_outreach_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.talent_outreach_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.talent_outreach_log TO service_role;

-- A new request, a new status, or the same pair asked again (created_at moves) → one row.
CREATE OR REPLACE FUNCTION public.talent_outreach_log_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    INSERT INTO talent_outreach_log (request_id, recruiter_id, candidate_id, status, context_title)
    VALUES (NEW.id, NEW.recruiter_id, NEW.candidate_id, NEW.status, NEW.context_title);
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.talent_outreach_log_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_talent_outreach_log ON public.profile_access_requests;
CREATE TRIGGER trg_talent_outreach_log
  AFTER INSERT OR UPDATE OF status, created_at ON public.profile_access_requests
  FOR EACH ROW EXECUTE FUNCTION public.talent_outreach_log_write();

-- The requests that exist today: sent at created_at, and their current answer when there is one.
INSERT INTO public.talent_outreach_log (request_id, recruiter_id, candidate_id, status, context_title, at, backfilled)
SELECT r.id, r.recruiter_id, r.candidate_id, s.status, r.context_title, s.at, true
FROM public.profile_access_requests r
CROSS JOIN LATERAL (
  SELECT 'pending'::text AS status, coalesce(r.created_at, now()) AS at
  UNION ALL
  SELECT r.status, coalesce(
           CASE WHEN r.status IN ('approved', 'partial') THEN r.contact_accepted_at END,
           CASE WHEN r.status = 'revoked' THEN r.revoked_at END,
           r.updated_at, r.created_at, now())
  WHERE r.status <> 'pending'
) s
WHERE r.recruiter_id IS NOT NULL AND r.candidate_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.talent_outreach_log l WHERE l.request_id = r.id);

-- ------------------------------------------------------------
-- 3. The numbers, for admins
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_talent_analytics(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days   integer := CASE WHEN p_days IN (7, 30, 90, 365) THEN p_days ELSE 0 END;   -- 0 = all time
  v_from   timestamptz := CASE WHEN p_days IN (7, 30, 90, 365) THEN now() - make_interval(days => p_days) ELSE '-infinity' END;
  v_prev   timestamptz := CASE WHEN p_days IN (7, 30, 90, 365) THEN now() - make_interval(days => 2 * p_days) END;
  v_result jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not Found' USING ERRCODE = '42501';
  END IF;

  -- Recruiters: app role 'recruiters' (users.role or the JWT's app_metadata), not admins, not deleted.
  WITH
  ta_rec AS (
  SELECT u.uuid,
         nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name,
         u.email, u.status::text AS status,
         coalesce(u.activated_at, u.created_at) AS joined_at,
         a.last_sign_in_at,
         (SELECT CASE jsonb_typeof(e -> 'company')
                   WHEN 'object' THEN e -> 'company' ->> 'name'
                   WHEN 'string' THEN e ->> 'company'
                   WHEN 'number' THEN (SELECT c.name FROM companies c WHERE c.id::text = e ->> 'company')
                 END
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END) e
           WHERE e ->> 'current' = 'true'
           LIMIT 1) AS company
  FROM users u
  LEFT JOIN auth.users a ON a.id = u.uuid
  WHERE (u.role::text = 'recruiters' OR a.raw_app_meta_data ->> 'role' = 'recruiters')
    AND coalesce(a.raw_app_meta_data ->> 'is_admin', '') <> 'true'
    AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
  ),
  ta_ev AS (SELECT e.* FROM talent_events e JOIN ta_rec r ON r.uuid = e.recruiter_id),

  -- Outreach of those recruiters, with when / how she first answered and what followed in chat.
  ta_req AS (
  SELECT q.*,
         extract(epoch FROM q.decided_at - q.created_at) / 3600.0 AS response_hours,
         (q.status IN ('approved', 'partial', 'revoked') OR q.first_answer IN ('approved', 'partial')) AS accepted
  FROM (
    SELECT r.id, r.recruiter_id, r.candidate_id, r.status, r.context_title, r.requested_fields, r.approved_fields,
           char_length(coalesce(r.message, '')) AS message_length,
           r.created_at, r.expires_at, r.contact_accepted_at, r.revoked_at,
           coalesce(
             (SELECT min(l.at) FROM talent_outreach_log l
               WHERE l.request_id = r.id AND l.status <> 'pending' AND l.at >= r.created_at),
             r.contact_accepted_at,
             CASE WHEN r.status <> 'pending' THEN coalesce(r.revoked_at, r.updated_at) END
           ) AS decided_at,
           (SELECT l.status FROM talent_outreach_log l
             WHERE l.request_id = r.id AND l.status <> 'pending' AND l.at >= r.created_at
             ORDER BY l.at LIMIT 1) AS first_answer,
           m.recruiter_msgs, m.candidate_msgs, m.first_candidate_msg_at, m.last_msg_at
    FROM profile_access_requests r
    JOIN ta_rec rec ON rec.uuid = r.recruiter_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE msg.sender_id = r.recruiter_id) AS recruiter_msgs,
             count(*) FILTER (WHERE msg.sender_id = r.candidate_id) AS candidate_msgs,
             min(msg.created_at) FILTER (WHERE msg.sender_id = r.candidate_id) AS first_candidate_msg_at,
             max(msg.created_at) AS last_msg_at
      FROM conversations c
      JOIN messages msg ON msg.conversation_id = c.id AND msg.created_at >= r.created_at
      WHERE (c.user1_id = r.recruiter_id AND c.user2_id = r.candidate_id)
         OR (c.user1_id = r.candidate_id AND c.user2_id = r.recruiter_id)
    ) m ON true
  ) q
  ),
  ev AS (SELECT * FROM ta_ev WHERE created_at >= v_from),
  searches AS (SELECT * FROM ev WHERE kind = 'search' AND coalesce(page, 1) = 1),
  views AS (SELECT * FROM ev WHERE kind = 'candidate_view'),
  req AS (SELECT * FROM ta_req WHERE created_at >= v_from),
  pool AS (
    SELECT u.uuid
    FROM users u
    WHERE u.role::text NOT IN ('feed_participant', 'recruiters')
      AND u.status = 'Active'
      AND coalesce(u.is_anonymous, false) = false
      AND coalesce(u.email, '') NOT ILIKE '%@deleted.local'
  ),
  days AS (
    SELECT d::date AS day
    FROM generate_series(
      CASE WHEN v_days > 0 THEN current_date - (v_days - 1)
           ELSE least(current_date - 29,
                      coalesce((SELECT min(created_at)::date FROM ta_ev), current_date),
                      coalesce((SELECT min(created_at)::date FROM ta_req), current_date)) END,
      current_date, interval '1 day') d
  ),
  -- the sidebar filters she chose, one row per (search, filter, value)
  filter_values AS (
    SELECT s.id, f.key, btrim(v.value) AS value
    FROM searches s
    CROSS JOIN LATERAL jsonb_each(coalesce(s.filters, '{}'::jsonb)) f
    CROSS JOIN LATERAL (
      SELECT x AS value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE '[]'::jsonb END) x
      UNION ALL
      SELECT f.value #>> '{}' WHERE jsonb_typeof(f.value) IN ('string', 'number')
      UNION ALL
      SELECT 'yes' WHERE f.value = 'true'::jsonb
    ) v
    WHERE f.key <> 'job_title' AND btrim(v.value) <> ''
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'logging_since', (SELECT min(created_at) FROM talent_events),
    'outreach_log_since', (SELECT min(at) FROM talent_outreach_log WHERE NOT backfilled),

    'kpis', jsonb_build_object(
      'recruiters', (SELECT count(*) FROM ta_rec),
      'recruiters_onboarded', (SELECT count(*) FROM ta_rec WHERE status = 'Active'),
      'recruiters_active', (SELECT count(DISTINCT x) FROM (
          SELECT recruiter_id AS x FROM ev UNION SELECT recruiter_id FROM req
          UNION SELECT p.recruiter_id FROM talent_projects p JOIN ta_rec r ON r.uuid = p.recruiter_id WHERE p.updated_at >= v_from) a),
      'recruiters_signed_in', (SELECT count(*) FROM ta_rec WHERE last_sign_in_at >= v_from),
      'searches', (SELECT count(*) FROM searches),
      'searches_prev', CASE WHEN v_prev IS NULL THEN NULL ELSE
          (SELECT count(*) FROM ta_ev WHERE kind = 'search' AND coalesce(page, 1) = 1 AND created_at >= v_prev AND created_at < v_from) END,
      'zero_result_searches', (SELECT count(*) FROM searches WHERE total = 0),
      'candidate_views', (SELECT count(*) FROM views),
      'candidate_views_prev', CASE WHEN v_prev IS NULL THEN NULL ELSE
          (SELECT count(*) FROM ta_ev WHERE kind = 'candidate_view' AND created_at >= v_prev AND created_at < v_from) END,
      'outreach_sent', (SELECT count(*) FROM req),
      'outreach_sent_prev', CASE WHEN v_prev IS NULL THEN NULL ELSE
          (SELECT count(*) FROM ta_req WHERE created_at >= v_prev AND created_at < v_from) END,
      'answered', (SELECT count(*) FROM req WHERE status <> 'pending'),
      'accepted', (SELECT count(*) FROM req WHERE accepted),
      'declined', (SELECT count(*) FROM req WHERE status = 'rejected'),
      'withdrawn', (SELECT count(*) FROM req WHERE status = 'revoked'),
      'pending', (SELECT count(*) FROM req WHERE status = 'pending'),
      'median_response_hours', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY response_hours)::numeric, 1) FROM req WHERE response_hours IS NOT NULL),
      'conversations', (SELECT count(*) FROM req WHERE accepted AND coalesce(recruiter_msgs, 0) + coalesce(candidate_msgs, 0) > 0),
      'candidate_replied_in_chat', (SELECT count(*) FROM req WHERE coalesce(candidate_msgs, 0) > 0),
      'hired', (SELECT count(*) FROM talent_project_candidates pc JOIN ta_rec r ON r.uuid = pc.recruiter_id
                 WHERE pc.stage = 'hired' AND pc.stage_changed_at >= v_from),
      'pool', (SELECT count(*) FROM pool)
    ),

    'daily', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'date', d.day,
        'searches', (SELECT count(*) FROM ta_ev e WHERE e.kind = 'search' AND coalesce(e.page, 1) = 1 AND e.created_at::date = d.day),
        'views', (SELECT count(*) FROM ta_ev e WHERE e.kind = 'candidate_view' AND e.created_at::date = d.day),
        'outreach', (SELECT count(*) FROM ta_req q WHERE q.created_at::date = d.day),
        'accepted', (SELECT count(*) FROM ta_req q WHERE q.accepted AND q.decided_at::date = d.day),
        'declined', (SELECT count(*) FROM ta_req q WHERE q.status = 'rejected' AND q.decided_at::date = d.day),
        'active_recruiters', (SELECT count(DISTINCT e.recruiter_id) FROM ta_ev e WHERE e.created_at::date = d.day)
      ) ORDER BY d.day), '[]'::jsonb) FROM days d),

    'recruiters', (SELECT coalesce(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.last_activity_at DESC NULLS LAST, x.name), '[]'::jsonb) FROM (
      SELECT r.uuid, r.name, r.email, r.company, r.status, r.joined_at, r.last_sign_in_at,
             greatest(
               (SELECT max(created_at) FROM ta_ev e WHERE e.recruiter_id = r.uuid),
               (SELECT max(created_at) FROM ta_req q WHERE q.recruiter_id = r.uuid),
               (SELECT max(updated_at) FROM talent_projects p WHERE p.recruiter_id = r.uuid),
               (SELECT max(created_at) FROM talent_notes n WHERE n.recruiter_id = r.uuid)
             ) AS last_activity_at,
             (SELECT count(DISTINCT created_at::date) FROM ev e WHERE e.recruiter_id = r.uuid) AS active_days,
             (SELECT count(*) FROM searches s WHERE s.recruiter_id = r.uuid) AS searches,
             (SELECT count(*) FROM searches s WHERE s.recruiter_id = r.uuid AND s.total = 0) AS zero_result_searches,
             (SELECT count(*) FROM views v WHERE v.recruiter_id = r.uuid) AS candidate_views,
             (SELECT count(DISTINCT candidate_id) FROM views v WHERE v.recruiter_id = r.uuid) AS candidates_viewed,
             (SELECT count(*) FROM req q WHERE q.recruiter_id = r.uuid) AS outreach_sent,
             (SELECT count(*) FROM req q WHERE q.recruiter_id = r.uuid AND q.accepted) AS accepted,
             (SELECT count(*) FROM req q WHERE q.recruiter_id = r.uuid AND q.status = 'rejected') AS declined,
             (SELECT count(*) FROM req q WHERE q.recruiter_id = r.uuid AND q.status = 'pending') AS pending,
             (SELECT count(*) FROM req q WHERE q.recruiter_id = r.uuid AND coalesce(q.candidate_msgs, 0) > 0) AS replied_in_chat,
             (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY q.response_hours)::numeric, 1)
                FROM req q WHERE q.recruiter_id = r.uuid AND q.response_hours IS NOT NULL) AS median_response_hours,
             (SELECT count(*) FROM talent_projects p WHERE p.recruiter_id = r.uuid) AS projects,
             (SELECT count(*) FROM talent_project_candidates pc WHERE pc.recruiter_id = r.uuid) AS pipeline,
             (SELECT count(*) FROM talent_project_candidates pc WHERE pc.recruiter_id = r.uuid AND pc.stage = 'hired') AS hired,
             (SELECT count(*) FROM talent_notes n WHERE n.recruiter_id = r.uuid) AS notes,
             (SELECT count(*) FROM saved_resources sr WHERE sr.user_id = r.uuid AND sr.saved_resource_type::text = 'candidate') AS saved_candidates,
             (SELECT count(*) FROM saved_talent_searches ss WHERE ss.recruiter_id = r.uuid) AS saved_searches
      FROM ta_rec r
    ) x),

    'searches', jsonb_build_object(
      'by_mode', (SELECT coalesce(jsonb_object_agg(m, n), '{}'::jsonb) FROM (SELECT coalesce(search_mode, 'filters') AS m, count(*) AS n FROM searches GROUP BY 1) a),
      'job_matches', jsonb_build_object(
        'job', (SELECT count(*) FROM searches WHERE search_mode = 'jd' AND job_id IS NOT NULL),
        'pasted', (SELECT count(*) FROM searches WHERE search_mode = 'jd' AND job_id IS NULL)),
      'avg_results', (SELECT round(avg(total)::numeric, 1) FROM searches),
      'median_results', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total) FROM searches),
      'paged_past_first', (SELECT count(*) FROM ev WHERE kind = 'search' AND page > 1),
      'results_buckets', (SELECT jsonb_agg(jsonb_build_object('label', b.label, 'count',
          (SELECT count(*) FROM searches s WHERE s.total BETWEEN b.lo AND b.hi)) ORDER BY b.lo)
        FROM (VALUES ('0', 0, 0), ('1–5', 1, 5), ('6–20', 6, 20), ('21–100', 21, 100), ('100+', 101, 2147483647)) b(label, lo, hi)),
      'top_queries', (SELECT coalesce(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.count DESC, q.label), '[]'::jsonb) FROM (
          SELECT min(btrim(query)) AS label, count(*) AS count, count(DISTINCT recruiter_id) AS recruiters,
                 round(avg(total)::numeric, 1) AS avg_results, count(*) FILTER (WHERE total = 0) AS zero
          FROM searches WHERE btrim(coalesce(query, '')) <> ''
          GROUP BY lower(btrim(query)) ORDER BY count(*) DESC, min(btrim(query)) LIMIT 30) q),
      'filter_usage', (SELECT coalesce(jsonb_object_agg(key, n), '{}'::jsonb) FROM (
          SELECT key, count(DISTINCT id) AS n FROM filter_values GROUP BY key) a),
      'top_values', (SELECT coalesce(jsonb_object_agg(key, items), '{}'::jsonb) FROM (
          SELECT key, jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label) AS items
          FROM (
            SELECT key, min(value) AS label, count(*) AS n,
                   row_number() OVER (PARTITION BY key ORDER BY count(*) DESC, min(value)) AS rn
            FROM filter_values GROUP BY key, lower(value)
          ) v WHERE rn <= 15 GROUP BY key) a),
      'zero_results', (SELECT coalesce(jsonb_agg(row_to_json(z)::jsonb ORDER BY z.at DESC), '[]'::jsonb) FROM (
          SELECT s.created_at AS at, s.recruiter_id, r.name AS recruiter_name, s.search_mode AS mode, s.query, s.filters
          FROM searches s JOIN ta_rec r ON r.uuid = s.recruiter_id
          WHERE s.total = 0 ORDER BY s.created_at DESC LIMIT 60) z),
      'recent', (SELECT coalesce(jsonb_agg(row_to_json(z)::jsonb ORDER BY z.at DESC), '[]'::jsonb) FROM (
          SELECT s.created_at AS at, s.recruiter_id, r.name AS recruiter_name, s.search_mode AS mode, s.query, s.filters, s.total
          FROM searches s JOIN ta_rec r ON r.uuid = s.recruiter_id
          ORDER BY s.created_at DESC LIMIT 100) z)
    ),

    'outreach', jsonb_build_object(
      'response_buckets', (SELECT jsonb_agg(jsonb_build_object('label', b.label,
          'accepted', (SELECT count(*) FROM req q WHERE q.accepted AND q.response_hours >= b.lo AND q.response_hours < b.hi),
          'declined', (SELECT count(*) FROM req q WHERE q.status = 'rejected' AND q.response_hours >= b.lo AND q.response_hours < b.hi)
        ) ORDER BY b.lo)
        FROM (VALUES ('< 1h', 0, 1), ('1–24h', 1, 24), ('1–3 days', 24, 72), ('3–7 days', 72, 168), ('7+ days', 168, 1e9)) b(label, lo, hi)),
      'pending_age', (SELECT jsonb_agg(jsonb_build_object('label', b.label,
          'count', (SELECT count(*) FROM ta_req q WHERE q.status = 'pending'
                      AND now() - q.created_at >= make_interval(days => b.lo) AND now() - q.created_at < make_interval(days => b.hi))
        ) ORDER BY b.lo)
        FROM (VALUES ('< 1 day', 0, 1), ('1–3 days', 1, 3), ('3–7 days', 3, 7), ('7–30 days', 7, 30), ('30+ days', 30, 100000)) b(label, lo, hi)),
      'requested_fields', (SELECT coalesce(jsonb_object_agg(f, jsonb_build_object('asked', asked, 'granted', granted)), '{}'::jsonb) FROM (
          SELECT f, count(*) AS asked,
                 count(*) FILTER (WHERE f = ANY (coalesce(q.approved_fields, '{}'))) AS granted
          FROM req q, unnest(coalesce(q.requested_fields, '{}')) f GROUP BY f) a),
      'nothing_requested', (SELECT count(*) FROM req WHERE cardinality(coalesce(requested_fields, '{}')) = 0),
      'avg_message_length', (SELECT round(avg(message_length)) FROM req),
      'top_topics', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.count DESC, t.label), '[]'::jsonb) FROM (
          SELECT min(btrim(context_title)) AS label, count(*) AS count, count(*) FILTER (WHERE accepted) AS accepted
          FROM req WHERE btrim(coalesce(context_title, '')) <> ''
          GROUP BY lower(btrim(context_title)) ORDER BY count(*) DESC LIMIT 20) t),
      -- does "open to work" on the profile predict a yes?
      'by_job_seeking', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.sent DESC), '[]'::jsonb) FROM (
          SELECT coalesce(js.status, 'not_set') AS status, count(*) AS sent,
                 count(*) FILTER (WHERE q.accepted) AS accepted, count(*) FILTER (WHERE q.status = 'rejected') AS declined,
                 count(*) FILTER (WHERE q.status = 'pending') AS pending
          FROM req q LEFT JOIN member_job_seeking js ON js.user_uuid = q.candidate_id GROUP BY 1) t)
    ),

    'requests', (SELECT coalesce(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC), '[]'::jsonb) FROM (
      SELECT q.id, q.recruiter_id, rec.name AS recruiter_name, rec.company AS recruiter_company,
             q.candidate_id, nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS candidate_name,
             (SELECT js.status FROM member_job_seeking js WHERE js.user_uuid = q.candidate_id) AS candidate_seeking,
             q.status, q.accepted, q.context_title, q.requested_fields, q.approved_fields, q.message_length,
             q.created_at, q.decided_at, round(q.response_hours::numeric, 1) AS response_hours, q.expires_at,
             coalesce(q.recruiter_msgs, 0) AS recruiter_msgs, coalesce(q.candidate_msgs, 0) AS candidate_msgs,
             q.first_candidate_msg_at, q.last_msg_at,
             EXISTS (SELECT 1 FROM ta_ev e WHERE e.kind = 'candidate_view' AND e.recruiter_id = q.recruiter_id AND e.candidate_id = q.candidate_id) AS viewed_first,
             (SELECT pc.stage FROM talent_project_candidates pc WHERE pc.recruiter_id = q.recruiter_id AND pc.candidate_id = q.candidate_id
               ORDER BY pc.stage_changed_at DESC LIMIT 1) AS stage,
             (SELECT count(*) FROM ta_req q2 WHERE q2.candidate_id = q.candidate_id) AS candidate_total_requests,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('status', l.status, 'at', l.at, 'backfilled', l.backfilled) ORDER BY l.at), '[]'::jsonb)
                FROM talent_outreach_log l WHERE l.request_id = q.id) AS history
      FROM req q
      JOIN ta_rec rec ON rec.uuid = q.recruiter_id
      LEFT JOIN users u ON u.uuid = q.candidate_id
      ORDER BY q.created_at DESC LIMIT 500
    ) x),

    'candidates', jsonb_build_object(
      'surfaced', (SELECT count(DISTINCT c) FROM ev e, unnest(coalesce(e.result_ids, '{}')) c WHERE e.kind = 'search'),
      'viewed', (SELECT count(DISTINCT candidate_id) FROM views),
      'contacted', (SELECT count(DISTINCT candidate_id) FROM req),
      'contacted_by_several', (SELECT count(*) FROM (SELECT candidate_id FROM req GROUP BY 1 HAVING count(DISTINCT recruiter_id) > 1) a),
      'most_viewed', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.views DESC), '[]'::jsonb) FROM (
          SELECT v.candidate_id AS uuid, nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name,
                 js.status AS seeking, count(*) AS views, count(DISTINCT v.recruiter_id) AS recruiters,
                 (SELECT count(*) FROM req q WHERE q.candidate_id = v.candidate_id) AS requests
          FROM views v JOIN users u ON u.uuid = v.candidate_id
          LEFT JOIN member_job_seeking js ON js.user_uuid = v.candidate_id
          GROUP BY v.candidate_id, u.first_name, u.last_name, js.status
          ORDER BY count(*) DESC LIMIT 15) t),
      'most_contacted', (SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.requests DESC), '[]'::jsonb) FROM (
          SELECT q.candidate_id AS uuid, nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name,
                 js.status AS seeking, count(*) AS requests,
                 count(*) FILTER (WHERE q.accepted) AS accepted, count(*) FILTER (WHERE q.status = 'rejected') AS declined,
                 count(*) FILTER (WHERE q.status = 'pending') AS pending
          FROM req q JOIN users u ON u.uuid = q.candidate_id
          LEFT JOIN member_job_seeking js ON js.user_uuid = q.candidate_id
          GROUP BY q.candidate_id, u.first_name, u.last_name, js.status
          ORDER BY count(*) DESC LIMIT 15) t),
      -- from opening a profile to the next steps (same recruiter, same candidate, any time after)
      'view_funnel', (SELECT jsonb_build_object(
          'pairs', count(*),
          'saved', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM saved_resources sr WHERE sr.user_id = p.recruiter_id
                      AND sr.saved_resource_type::text = 'candidate' AND sr.saved_resource_id = p.candidate_id::text)),
          'in_project', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM talent_project_candidates pc
                      WHERE pc.recruiter_id = p.recruiter_id AND pc.candidate_id = p.candidate_id)),
          'contacted', count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ta_req q
                      WHERE q.recruiter_id = p.recruiter_id AND q.candidate_id = p.candidate_id)))
        FROM (SELECT DISTINCT recruiter_id, candidate_id FROM views) p)
    ),

    'pipeline', jsonb_build_object(
      'projects', (SELECT count(*) FROM talent_projects p JOIN ta_rec r ON r.uuid = p.recruiter_id),
      'projects_new', (SELECT count(*) FROM talent_projects p JOIN ta_rec r ON r.uuid = p.recruiter_id WHERE p.created_at >= v_from),
      'projects_archived', (SELECT count(*) FROM talent_projects p JOIN ta_rec r ON r.uuid = p.recruiter_id WHERE p.archived),
      'projects_with_job', (SELECT count(*) FROM talent_projects p JOIN ta_rec r ON r.uuid = p.recruiter_id WHERE p.job_id IS NOT NULL),
      'stages', (SELECT coalesce(jsonb_object_agg(stage, n), '{}'::jsonb) FROM (
          SELECT pc.stage, count(*) AS n FROM talent_project_candidates pc JOIN ta_rec r ON r.uuid = pc.recruiter_id GROUP BY 1) a),
      'moved_in_period', (SELECT coalesce(jsonb_object_agg(stage, n), '{}'::jsonb) FROM (
          SELECT pc.stage, count(*) AS n FROM talent_project_candidates pc JOIN ta_rec r ON r.uuid = pc.recruiter_id
          WHERE pc.stage_changed_at >= v_from GROUP BY 1) a),
      'notes', (SELECT count(*) FROM talent_notes n JOIN ta_rec r ON r.uuid = n.recruiter_id WHERE n.created_at >= v_from),
      'saved_candidates', (SELECT count(*) FROM saved_resources sr JOIN ta_rec r ON r.uuid = sr.user_id
                            WHERE sr.saved_resource_type::text = 'candidate' AND sr.created_at >= v_from),
      'saved_searches', (SELECT count(*) FROM saved_talent_searches ss JOIN ta_rec r ON r.uuid = ss.recruiter_id),
      'saved_searches_used', (SELECT count(*) FROM saved_talent_searches ss JOIN ta_rec r ON r.uuid = ss.recruiter_id WHERE ss.last_used_at >= v_from)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_talent_analytics(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_talent_analytics(integer) TO authenticated;

-- ------------------------------------------------------------
-- Self-check with throw-away rows. Nothing is kept.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_json jsonb;
  v_a uuid;
  v_b uuid;
  v_req uuid;
  v_n integer;
BEGIN
  SELECT uuid INTO v_a FROM public.users WHERE uuid IN (SELECT id FROM auth.users) ORDER BY created_at LIMIT 1;
  SELECT uuid INTO v_b FROM public.users WHERE uuid IN (SELECT id FROM auth.users) AND uuid <> v_a ORDER BY created_at LIMIT 1;

  BEGIN
    -- a member who is not a recruiter: no analytics, cannot write or read events
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a, 'app_metadata', json_build_object())::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.admin_talent_analytics(30);
      v_problems := v_problems || ' a member who is not an admin got the analytics;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      INSERT INTO public.talent_events (kind) VALUES ('search');
      v_problems := v_problems || ' a member who is not a recruiter wrote an event;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM public.talent_events LIMIT 1;
      v_problems := v_problems || ' members can read talent_events;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM public.talent_outreach_log LIMIT 1;
      v_problems := v_problems || ' members can read talent_outreach_log;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- a recruiter: writes her own events, never under someone else's name
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a, 'app_metadata', json_build_object('role', 'recruiters'))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO public.talent_events (kind, search_mode, query, filters, total, page, result_ids)
      VALUES ('search', 'semantic', 'probe', '{"skills": ["React"]}', 3, 1, ARRAY[v_b]);
      INSERT INTO public.talent_events (kind, candidate_id) VALUES ('candidate_view', v_b);
      RAISE EXCEPTION 'probe_ok';
    EXCEPTION
      WHEN raise_exception THEN IF SQLERRM <> 'probe_ok' THEN v_problems := v_problems || ' recruiter insert: ' || SQLERRM || ';'; END IF;
      WHEN OTHERS THEN v_problems := v_problems || ' a recruiter could not record her search: ' || SQLERRM || ';';
    END;
    BEGIN
      INSERT INTO public.talent_events (recruiter_id, kind) VALUES (v_b, 'search');
      v_problems := v_problems || ' a recruiter wrote an event under another member;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- the outreach log follows a request through its statuses
    BEGIN
      INSERT INTO public.profile_access_requests (recruiter_id, candidate_id, requested_fields, status, message)
      VALUES (v_a, v_b, '{}', 'pending', 'probe')
      ON CONFLICT (recruiter_id, candidate_id) DO UPDATE SET status = 'pending', created_at = now() + interval '1 second'
      RETURNING id INTO v_req;
      UPDATE public.profile_access_requests SET status = 'approved' WHERE id = v_req;
      SELECT count(*) INTO v_n FROM public.talent_outreach_log WHERE request_id = v_req AND NOT backfilled AND at >= now();
      IF v_n <> 2 THEN v_problems := v_problems || ' the outreach log kept ' || v_n || ' rows instead of 2;'; END IF;
      RAISE EXCEPTION 'probe_ok';
    EXCEPTION
      WHEN raise_exception THEN IF SQLERRM <> 'probe_ok' THEN v_problems := v_problems || ' ' || SQLERRM || ';'; END IF;
    END;

    -- an admin gets every part
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_a, 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    v_json := public.admin_talent_analytics(30);
    IF v_json -> 'kpis' ->> 'recruiters' IS NULL
       OR jsonb_typeof(v_json -> 'daily') <> 'array' OR jsonb_array_length(v_json -> 'daily') <> 30
       OR jsonb_typeof(v_json -> 'recruiters') <> 'array'
       OR jsonb_typeof(v_json -> 'requests') <> 'array'
       OR v_json -> 'searches' IS NULL OR v_json -> 'outreach' IS NULL
       OR v_json -> 'candidates' IS NULL OR v_json -> 'pipeline' IS NULL THEN
      v_problems := v_problems || ' the admin reply is missing a part;';
    END IF;
    v_json := public.admin_talent_analytics(0);   -- all time works too
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % recruiters, % outreach rows in the log (backfilled).',
    v_json -> 'kpis' ->> 'recruiters', (SELECT count(*) FROM public.talent_outreach_log);
END $$;

COMMIT;

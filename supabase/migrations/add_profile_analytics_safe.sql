-- ============================================================
-- Profile analytics for the admin panel (2026-11-13). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql (is_platform_admin) and the pg_cron extension.
--
-- What it adds
--   1. profile_stats_compute(): the state of all members' profiles right now, as one jsonb —
--      field completion, profile strength (computed live, same rules as calculateProfileStrength
--      in _scoreHelpers.ts, not the cache), privacy choices, photos, most common values,
--      onboarding, and signup-month cohorts. Members = users rows that are not deleted.
--   2. profile_stats_history(): what can be rebuilt from timestamps that already exist —
--      signups per week and every profile photo / cover upload (storage keeps old files, named
--      <uuid>_<ms>). Profile fields have no edit history, so they are NOT rebuilt.
--   3. profile_stats_snapshots: one row per day with the full profile_stats_compute() result,
--      written by pg_cron at 23:55 Israel time (21:55 UTC). This is where field trends come
--      from — from the first run of this file onward. The first snapshot is taken right here.
--   4. admin_profile_analytics(): what the admin page reads. Admins only (app_metadata.is_admin
--      in the JWT); anyone else gets an error. Returns the current state, the rebuilt history
--      and each snapshot's "trend" summary (not the whole snapshot, to keep the reply small).
--
-- Who can do what
--   * nobody reads profile_stats_snapshots directly (RLS on, no policies, no grants to API
--     roles); service_role may read it for background jobs.
--   * profile_stats_compute / profile_stats_history / take_profile_stats_snapshot are not
--     callable from the API at all. admin_profile_analytics is callable by signed-in users
--     and refuses non-admins. It is SECURITY DEFINER (owner rights) because it aggregates
--     every member's profile and reads storage file names — confined to this one function,
--     which returns counts only, never a member's identity or content.
--
-- Undo: rollback_add_profile_analytics.sql
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Current state
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_stats_compute()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH m AS (
  SELECT
    u.uuid,
    u.created_at,
    coalesce(u.status, 'unknown') AS status,
    coalesce(u.role::text, 'unknown') AS role,
    coalesce(u.is_anonymous, false) AS is_anonymous,
    (u.image IS NOT NULL AND u.image NOT IN ('', 'null', 'false')) AS has_photo,
    coalesce(trim(u.cover_image_url), '') <> '' AS has_cover,
    coalesce(trim(u.headline), '') <> '' AS has_headline,
    length(coalesce(trim(u.about), '')) AS about_len,
    CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END AS exp,
    CASE WHEN jsonb_typeof(u.projects) = 'array' THEN u.projects ELSE '[]'::jsonb END AS proj,
    CASE WHEN jsonb_typeof(u.education) = 'array' THEN u.education ELSE '[]'::jsonb END AS edu,
    CASE WHEN jsonb_typeof(u.certifications) = 'array' THEN u.certifications ELSE '[]'::jsonb END AS cert,
    CASE WHEN jsonb_typeof(u.languages) = 'array' THEN u.languages ELSE '[]'::jsonb END AS langs,
    coalesce(u.skills, '{}') AS skills,
    coalesce(u.interests, '{}') AS interests,
    coalesce(u.work_preferences, '{}') AS work_preferences,
    coalesce(trim(u.location), '') AS location,
    coalesce(trim(u.github_url), '') <> '' AS has_github,
    coalesce(trim(u.website_url), '') <> '' AS has_website,
    coalesce(trim(u.phone), '') <> '' AS has_phone,
    coalesce(u.public_profile_enabled, false) AS public_profile,
    coalesce(u.values_agreed, false) AS values_agreed,
    u.privacy_picture,
    u.privacy_lastname,
    u.privacy_contact_details
  FROM users u
  WHERE u.email NOT LIKE 'deleted_%@deleted.local'
),
conn AS (
  SELECT id, count(*) AS n
  FROM (
    SELECT requester_id AS id FROM connections WHERE status = 'accepted'
    UNION ALL
    SELECT receiver_id FROM connections WHERE status = 'accepted'
  ) x
  GROUP BY id
),
uploads AS (
  -- profile-images-folder/<uuid>_<ms>.jpg — every photo a member ever uploaded
  SELECT split_part(split_part(o.name, '/', 2), '_', 1) AS uid, count(*) AS n, min(o.created_at) AS first_at
  FROM storage.objects o
  WHERE o.bucket_id = 'profile-images' AND o.name LIKE 'profile-images-folder/%'
  GROUP BY 1
),
f AS (
  SELECT
    m.*,
    coalesce(conn.n, 0) AS conn_n,
    coalesce(up.n, 0) AS uploads_n,
    up.first_at AS first_upload_at,
    jsonb_array_length(m.exp) AS exp_n,
    jsonb_array_length(m.proj) AS proj_n,
    jsonb_array_length(m.edu) AS edu_n,
    jsonb_array_length(m.cert) AS cert_n,
    jsonb_array_length(m.langs) AS lang_n,
    cardinality(m.skills) AS skills_n,
    cardinality(m.interests) AS interests_n,
    cardinality(m.work_preferences) AS prefs_n,
    EXISTS (SELECT 1 FROM jsonb_array_elements(m.exp) e
            WHERE length(trim(coalesce(e ->> 'description', e ->> 'summary', ''))) >= 30) AS exp_desc,
    EXISTS (SELECT 1 FROM jsonb_array_elements(m.exp) e WHERE e ->> 'current' = 'true') AS has_current_job,
    EXISTS (SELECT 1 FROM jsonb_array_elements(m.proj) p
            WHERE length(trim(coalesce(p ->> 'description', ''))) >= 30 OR coalesce(p ->> 'url', '') <> '') AS proj_rich
  FROM m
  LEFT JOIN conn ON conn.id = m.uuid
  LEFT JOIN uploads up ON up.uid = m.uuid::text
),
-- Strength components — same scores and weights as calculateProfileStrength
c AS (
  SELECT
    f.*,
    CASE WHEN exp_n = 0 THEN 0 WHEN exp_desc THEN 1 ELSE 0.5 END AS s_exp_only,
    CASE WHEN proj_n = 0 THEN 0 WHEN proj_rich THEN 1 ELSE 0.5 END AS s_proj_only,
    CASE WHEN skills_n >= 6 THEN 1 WHEN skills_n >= 3 THEN 0.5 ELSE 0 END AS s_skills,
    CASE WHEN has_photo THEN 1 ELSE 0 END AS s_photo,
    CASE WHEN about_len = 0 THEN 0 WHEN about_len < 200 THEN 0.5 ELSE 1 END AS s_about,
    CASE WHEN has_headline THEN 1 ELSE 0 END AS s_headline,
    CASE WHEN conn_n >= 30 THEN 1 WHEN conn_n >= 15 THEN 0.75 WHEN conn_n >= 5 THEN 0.5 WHEN conn_n >= 1 THEN 0.25 ELSE 0 END AS s_conn,
    CASE WHEN edu_n >= 1 THEN 1 ELSE 0 END AS s_edu,
    CASE WHEN cert_n >= 1 THEN 1 ELSE 0 END AS s_cert,
    CASE WHEN location <> '' THEN 1 ELSE 0 END AS s_loc
  FROM f
),
sc AS (
  SELECT
    c.*,
    least(1, greatest(s_exp_only, s_proj_only) + 0.5 * least(s_exp_only, s_proj_only)) AS s_exp
  FROM c
),
st AS (
  SELECT
    sc.*,
    round(100 * (0.22 * s_exp + 0.20 * s_skills + 0.12 * s_photo + 0.11 * s_about + 0.10 * s_headline
               + 0.09 * s_conn + 0.08 * s_edu + 0.05 * s_cert + 0.03 * s_loc))::int AS strength,
    -- the item the member's own "next step" card shows: highest weight that is not full
    CASE
      WHEN s_exp < 1 THEN 'experience'
      WHEN s_skills < 1 THEN 'skills'
      WHEN s_photo < 1 THEN 'photo'
      WHEN s_about < 1 THEN 'about'
      WHEN s_headline < 1 THEN 'headline'
      WHEN s_conn < 1 THEN 'connections'
      WHEN s_edu < 1 THEN 'education'
      WHEN s_cert < 1 THEN 'certifications'
      WHEN s_loc < 1 THEN 'location'
      ELSE 'complete'
    END AS next_item,
    status = 'Active' AS is_active
  FROM sc
),
-- Field completion, counted over all members and over Active members only
fields AS (
  SELECT jsonb_object_agg(k, jsonb_build_object('all', n_all, 'active', n_active)) AS j
  FROM (
    SELECT k, count(*) FILTER (WHERE ok) AS n_all, count(*) FILTER (WHERE ok AND is_active) AS n_active
    FROM st
    CROSS JOIN LATERAL (VALUES
      ('photo', has_photo),
      ('cover', has_cover),
      ('headline', has_headline),
      ('about_any', about_len > 0),
      ('about_full', about_len >= 200),
      ('experience_any', exp_n > 0),
      ('experience_desc', exp_desc),
      ('current_job', has_current_job),
      ('projects_any', proj_n > 0),
      ('projects_rich', proj_rich),
      ('experience_or_projects', exp_n > 0 OR proj_n > 0),
      ('skills_any', skills_n > 0),
      ('skills_3', skills_n >= 3),
      ('skills_6', skills_n >= 6),
      ('education', edu_n > 0),
      ('certifications', cert_n > 0),
      ('languages', lang_n > 0),
      ('location', location <> ''),
      ('interests', interests_n > 0),
      ('work_preferences', prefs_n > 0),
      ('github', has_github),
      ('website', has_website),
      ('phone', has_phone),
      ('connections_any', conn_n > 0),
      ('public_profile', public_profile),
      ('values_agreed', values_agreed)
    ) v(k, ok)
    GROUP BY k
  ) x
),
-- Where strength points are lost: average points (out of 100) missing per component
lost AS (
  SELECT jsonb_build_object(
    'experience',     round(avg(22 * (1 - s_exp)), 1),
    'skills',         round(avg(20 * (1 - s_skills)), 1),
    'photo',          round(avg(12 * (1 - s_photo)), 1),
    'about',          round(avg(11 * (1 - s_about)), 1),
    'headline',       round(avg(10 * (1 - s_headline)), 1),
    'connections',    round(avg(9 * (1 - s_conn)), 1),
    'education',      round(avg(8 * (1 - s_edu)), 1),
    'certifications', round(avg(5 * (1 - s_cert)), 1),
    'location',       round(avg(3 * (1 - s_loc)), 1)
  ) AS j
  FROM st
),
next_items AS (
  SELECT jsonb_object_agg(next_item, n) AS j FROM (SELECT next_item, count(*) AS n FROM st GROUP BY 1) x
),
-- Bucketed distributions: label -> count, labels in display order
dist AS (
  SELECT jsonb_build_object(
    'strength', jsonb_build_array(
      jsonb_build_object('label', '0–19',   'count', count(*) FILTER (WHERE strength < 20)),
      jsonb_build_object('label', '20–39',  'count', count(*) FILTER (WHERE strength BETWEEN 20 AND 39)),
      jsonb_build_object('label', '40–59',  'count', count(*) FILTER (WHERE strength BETWEEN 40 AND 59)),
      jsonb_build_object('label', '60–69',  'count', count(*) FILTER (WHERE strength BETWEEN 60 AND 69)),
      jsonb_build_object('label', '70–84',  'count', count(*) FILTER (WHERE strength BETWEEN 70 AND 84)),
      jsonb_build_object('label', '85–94',  'count', count(*) FILTER (WHERE strength BETWEEN 85 AND 94)),
      jsonb_build_object('label', '95–100', 'count', count(*) FILTER (WHERE strength >= 95))),
    'tiers', jsonb_build_array(
      jsonb_build_object('label', 'Starter',  'count', count(*) FILTER (WHERE strength < 40)),
      jsonb_build_object('label', 'Building', 'count', count(*) FILTER (WHERE strength BETWEEN 40 AND 69)),
      jsonb_build_object('label', 'Strong',   'count', count(*) FILTER (WHERE strength BETWEEN 70 AND 84)),
      jsonb_build_object('label', 'Expert',   'count', count(*) FILTER (WHERE strength BETWEEN 85 AND 94)),
      jsonb_build_object('label', 'Elite',    'count', count(*) FILTER (WHERE strength >= 95))),
    'skills', jsonb_build_array(
      jsonb_build_object('label', '0',    'count', count(*) FILTER (WHERE skills_n = 0)),
      jsonb_build_object('label', '1–2',  'count', count(*) FILTER (WHERE skills_n BETWEEN 1 AND 2)),
      jsonb_build_object('label', '3–5',  'count', count(*) FILTER (WHERE skills_n BETWEEN 3 AND 5)),
      jsonb_build_object('label', '6–10', 'count', count(*) FILTER (WHERE skills_n BETWEEN 6 AND 10)),
      jsonb_build_object('label', '11+',  'count', count(*) FILTER (WHERE skills_n >= 11))),
    'experience', jsonb_build_array(
      jsonb_build_object('label', '0',  'count', count(*) FILTER (WHERE exp_n = 0)),
      jsonb_build_object('label', '1',  'count', count(*) FILTER (WHERE exp_n = 1)),
      jsonb_build_object('label', '2',  'count', count(*) FILTER (WHERE exp_n = 2)),
      jsonb_build_object('label', '3',  'count', count(*) FILTER (WHERE exp_n = 3)),
      jsonb_build_object('label', '4+', 'count', count(*) FILTER (WHERE exp_n >= 4))),
    'about', jsonb_build_array(
      jsonb_build_object('label', 'Empty',    'count', count(*) FILTER (WHERE about_len = 0)),
      jsonb_build_object('label', '1–99',     'count', count(*) FILTER (WHERE about_len BETWEEN 1 AND 99)),
      jsonb_build_object('label', '100–199',  'count', count(*) FILTER (WHERE about_len BETWEEN 100 AND 199)),
      jsonb_build_object('label', '200–499',  'count', count(*) FILTER (WHERE about_len BETWEEN 200 AND 499)),
      jsonb_build_object('label', '500+',     'count', count(*) FILTER (WHERE about_len >= 500))),
    'connections', jsonb_build_array(
      jsonb_build_object('label', '0',     'count', count(*) FILTER (WHERE conn_n = 0)),
      jsonb_build_object('label', '1–4',   'count', count(*) FILTER (WHERE conn_n BETWEEN 1 AND 4)),
      jsonb_build_object('label', '5–14',  'count', count(*) FILTER (WHERE conn_n BETWEEN 5 AND 14)),
      jsonb_build_object('label', '15–29', 'count', count(*) FILTER (WHERE conn_n BETWEEN 15 AND 29)),
      jsonb_build_object('label', '30+',   'count', count(*) FILTER (WHERE conn_n >= 30))),
    'photo_uploads', jsonb_build_array(
      jsonb_build_object('label', 'Never', 'count', count(*) FILTER (WHERE uploads_n = 0)),
      jsonb_build_object('label', '1',     'count', count(*) FILTER (WHERE uploads_n = 1)),
      jsonb_build_object('label', '2',     'count', count(*) FILTER (WHERE uploads_n = 2)),
      jsonb_build_object('label', '3–5',   'count', count(*) FILTER (WHERE uploads_n BETWEEN 3 AND 5)),
      jsonb_build_object('label', '6+',    'count', count(*) FILTER (WHERE uploads_n >= 6)))
  ) AS j
  FROM st
),
-- Who may see the photo / last name / contact details. NULL = never chosen (for the photo
-- this means nobody sees it — fail-closed, same as can_view_profile_picture).
privacy AS (
  SELECT jsonb_object_agg(field, counts) AS j
  FROM (
    SELECT field, jsonb_object_agg(cls, n) AS counts
    FROM (
      SELECT field, cls, count(*) AS n
      FROM st
      CROSS JOIN LATERAL (VALUES
        ('picture', privacy_picture), ('lastname', privacy_lastname), ('contact', privacy_contact_details)
      ) v(field, arr)
      CROSS JOIN LATERAL (SELECT CASE
        WHEN arr IS NULL THEN 'not_set'
        WHEN cardinality(arr) = 0 THEN 'nobody'
        WHEN 'community' = ANY (arr) AND 'recruiters' = ANY (arr) THEN 'everyone'
        WHEN 'recruiters' = ANY (arr) THEN 'recruiters_only'
        WHEN 'community' = ANY (arr) THEN 'community_only'
        ELSE 'other'
      END AS cls) k
      GROUP BY 1, 2
    ) x
    GROUP BY field
  ) y
),
photo AS (
  SELECT jsonb_build_object(
    'has_now',         count(*) FILTER (WHERE has_photo),
    'ever_uploaded',   count(*) FILTER (WHERE uploads_n > 0),
    'removed',         count(*) FILTER (WHERE uploads_n > 0 AND NOT has_photo),
    'replaced',        count(*) FILTER (WHERE uploads_n >= 2),
    'uploads_total',   coalesce(sum(uploads_n), 0),
    'shown_to_nobody', count(*) FILTER (WHERE has_photo AND (privacy_picture IS NULL OR cardinality(privacy_picture) = 0)),
    'has_cover',       count(*) FILTER (WHERE has_cover),
    -- time from signup to first photo
    'first_photo_lag', jsonb_build_array(
      jsonb_build_object('label', 'Same day',  'count', count(*) FILTER (WHERE first_upload_at < created_at + interval '1 day')),
      jsonb_build_object('label', '1–7 days',  'count', count(*) FILTER (WHERE first_upload_at >= created_at + interval '1 day' AND first_upload_at < created_at + interval '7 days')),
      jsonb_build_object('label', '7–30 days', 'count', count(*) FILTER (WHERE first_upload_at >= created_at + interval '7 days' AND first_upload_at < created_at + interval '30 days')),
      jsonb_build_object('label', '30+ days',  'count', count(*) FILTER (WHERE first_upload_at >= created_at + interval '30 days')),
      jsonb_build_object('label', 'Never',     'count', count(*) FILTER (WHERE first_upload_at IS NULL)))
  ) AS j
  FROM st
),
-- Most common values. Grouped case-insensitively; the label is the most common spelling.
vals AS (
  SELECT 'skills' AS kind, lower(trim(v)) AS k, trim(v) AS label, uuid FROM st, unnest(skills) v
  UNION ALL SELECT 'interests', lower(trim(v)), trim(v), uuid FROM st, unnest(interests) v
  UNION ALL SELECT 'work_preferences', lower(trim(v)), trim(v), uuid FROM st, unnest(work_preferences) v
  UNION ALL SELECT 'locations', regexp_replace(lower(location), ',\s*(israel|ישראל)$', ''), location, uuid FROM st WHERE location <> ''
  UNION ALL SELECT 'languages', lower(trim(l ->> 'name')), trim(l ->> 'name'), uuid FROM st, jsonb_array_elements(langs) l
  UNION ALL SELECT 'degrees', lower(trim(e ->> 'degree')), trim(e ->> 'degree'), uuid FROM st, jsonb_array_elements(edu) e
  UNION ALL SELECT 'institutions', lower(trim(e ->> 'institution')), trim(e ->> 'institution'), uuid FROM st, jsonb_array_elements(edu) e
  UNION ALL SELECT 'current_titles', lower(trim(e ->> 'title')), trim(e ->> 'title'), uuid FROM st, jsonb_array_elements(exp) e WHERE e ->> 'current' = 'true'
),
tops AS (
  SELECT jsonb_object_agg(kind, items) AS j
  FROM (
    SELECT kind, jsonb_agg(jsonb_build_object('label', label, 'count', n) ORDER BY n DESC, label) AS items
    FROM (
      SELECT kind, k, mode() WITHIN GROUP (ORDER BY label) AS label, count(DISTINCT uuid) AS n,
             row_number() OVER (PARTITION BY kind ORDER BY count(DISTINCT uuid) DESC, k) AS rn
      FROM vals
      WHERE coalesce(k, '') <> ''
      GROUP BY kind, k
    ) x
    WHERE rn <= 20
    GROUP BY kind
  ) y
),
onboarding AS (
  SELECT jsonb_build_object(
    'total', count(*),
    'age', jsonb_build_array(
      jsonb_build_object('label', '< 1 day',   'count', count(*) FILTER (WHERE created_at > now() - interval '1 day')),
      jsonb_build_object('label', '1–7 days',  'count', count(*) FILTER (WHERE created_at <= now() - interval '1 day' AND created_at > now() - interval '7 days')),
      jsonb_build_object('label', '7–30 days', 'count', count(*) FILTER (WHERE created_at <= now() - interval '7 days' AND created_at > now() - interval '30 days')),
      jsonb_build_object('label', '30+ days',  'count', count(*) FILTER (WHERE created_at <= now() - interval '30 days')))
  ) AS j
  FROM st
  WHERE status = 'onboarding'
),
-- Signup-month cohorts: how complete each month's members are today
cohorts AS (
  SELECT jsonb_agg(row_to_json(x) ORDER BY x.month) AS j
  FROM (
    SELECT
      to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Jerusalem'), 'YYYY-MM') AS month,
      count(*) AS members,
      count(*) FILTER (WHERE is_active) AS active,
      round(avg(strength), 1) AS avg_strength,
      count(*) FILTER (WHERE strength >= 70) AS strong_plus,
      count(*) FILTER (WHERE has_photo) AS photo,
      count(*) FILTER (WHERE has_headline) AS headline,
      count(*) FILTER (WHERE about_len > 0) AS about,
      count(*) FILTER (WHERE exp_n > 0 OR proj_n > 0) AS experience_or_projects,
      count(*) FILTER (WHERE skills_n >= 6) AS skills_6,
      count(*) FILTER (WHERE edu_n > 0) AS education,
      count(*) FILTER (WHERE conn_n > 0) AS connected
    FROM st
    WHERE created_at IS NOT NULL
    GROUP BY 1
  ) x
),
totals AS (
  SELECT
    count(*) AS members,
    count(*) FILTER (WHERE is_active) AS active,
    round(avg(strength), 1) AS avg_strength,
    round(avg(strength) FILTER (WHERE is_active), 1) AS avg_strength_active,
    percentile_disc(0.5) WITHIN GROUP (ORDER BY strength) AS median_strength,
    count(*) FILTER (WHERE strength >= 70) AS strong_plus,
    round(avg(conn_n), 1) AS avg_connections
  FROM st
)
SELECT jsonb_build_object(
  'members', (SELECT jsonb_build_object(
      'total', t.members,
      'active', t.active,
      'by_status', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM st GROUP BY 1) s),
      'by_role', (SELECT jsonb_object_agg(role, n) FROM (SELECT role, count(*) AS n FROM st GROUP BY 1) r),
      'anonymous', (SELECT count(*) FROM st WHERE is_anonymous)) FROM totals t),
  'strength', (SELECT jsonb_build_object(
      'avg', t.avg_strength, 'avg_active', t.avg_strength_active, 'median', t.median_strength,
      'strong_plus', t.strong_plus) FROM totals t),
  'fields', (SELECT j FROM fields),
  'points_lost', (SELECT j FROM lost),
  'next_items', (SELECT j FROM next_items),
  'distributions', (SELECT j FROM dist),
  'privacy', (SELECT j FROM privacy),
  'photo', (SELECT j FROM photo),
  'tops', (SELECT j FROM tops),
  'onboarding', (SELECT j FROM onboarding),
  'cohorts', (SELECT j FROM cohorts),
  -- Flat summary kept per snapshot for the trend charts (percentages of all members)
  'trend', (SELECT jsonb_build_object(
      'members', t.members,
      'active', t.active,
      'avg_strength', t.avg_strength,
      'avg_strength_active', t.avg_strength_active,
      'median_strength', t.median_strength,
      'avg_connections', t.avg_connections,
      'pct_strong_plus', round(100.0 * t.strong_plus / nullif(t.members, 0), 1),
      'pct_photo',       round(100.0 * (SELECT count(*) FROM st WHERE has_photo) / nullif(t.members, 0), 1),
      'pct_headline',    round(100.0 * (SELECT count(*) FROM st WHERE has_headline) / nullif(t.members, 0), 1),
      'pct_about',       round(100.0 * (SELECT count(*) FROM st WHERE about_len > 0) / nullif(t.members, 0), 1),
      'pct_experience_or_projects', round(100.0 * (SELECT count(*) FROM st WHERE exp_n > 0 OR proj_n > 0) / nullif(t.members, 0), 1),
      'pct_skills_6',    round(100.0 * (SELECT count(*) FROM st WHERE skills_n >= 6) / nullif(t.members, 0), 1),
      'pct_education',   round(100.0 * (SELECT count(*) FROM st WHERE edu_n > 0) / nullif(t.members, 0), 1),
      'pct_certifications', round(100.0 * (SELECT count(*) FROM st WHERE cert_n > 0) / nullif(t.members, 0), 1),
      'pct_location',    round(100.0 * (SELECT count(*) FROM st WHERE location <> '') / nullif(t.members, 0), 1),
      'pct_connected',   round(100.0 * (SELECT count(*) FROM st WHERE conn_n > 0) / nullif(t.members, 0), 1),
      'pct_public_profile', round(100.0 * (SELECT count(*) FROM st WHERE public_profile) / nullif(t.members, 0), 1)
    ) FROM totals t)
)
$$;

-- ------------------------------------------------------------
-- 2. History rebuilt from existing timestamps (weeks start on Sunday, Israel time)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_stats_history()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH m AS (
  SELECT uuid, created_at FROM users WHERE email NOT LIKE 'deleted_%@deleted.local'
),
photos AS (
  SELECT o.created_at,
         row_number() OVER (PARTITION BY m.uuid ORDER BY o.created_at) AS nth
  FROM storage.objects o
  JOIN m ON m.uuid::text = split_part(split_part(o.name, '/', 2), '_', 1)
  WHERE o.bucket_id = 'profile-images' AND o.name LIKE 'profile-images-folder/%'
),
covers AS (
  SELECT o.created_at,
         row_number() OVER (PARTITION BY m.uuid ORDER BY o.created_at) AS nth
  FROM storage.objects o
  JOIN m ON m.uuid::text = split_part(o.name, '_', 1)
  WHERE o.bucket_id = 'profile-headers' AND o.name NOT LIKE '%/%'
),
ev AS (
  SELECT created_at AS at, 'signup' AS kind FROM m WHERE created_at IS NOT NULL
  UNION ALL SELECT created_at, CASE WHEN nth = 1 THEN 'first_photo' ELSE 'photo_change' END FROM photos
  UNION ALL SELECT created_at, CASE WHEN nth = 1 THEN 'first_cover' ELSE 'cover_change' END FROM covers
),
evw AS (
  -- Sunday-start week, in Israel time
  SELECT (date_trunc('week', (at AT TIME ZONE 'Asia/Jerusalem') + interval '1 day') - interval '1 day')::date AS week, kind
  FROM ev
),
weeks AS (
  SELECT generate_series(
    (SELECT min(week) FROM evw),
    (date_trunc('week', (now() AT TIME ZONE 'Asia/Jerusalem') + interval '1 day') - interval '1 day')::date,
    interval '7 days'
  )::date AS week
),
per_week AS (
  SELECT
    w.week,
    count(e.kind) FILTER (WHERE e.kind = 'signup') AS signups,
    count(e.kind) FILTER (WHERE e.kind = 'first_photo') AS first_photos,
    count(e.kind) FILTER (WHERE e.kind = 'photo_change') AS photo_changes,
    count(e.kind) FILTER (WHERE e.kind = 'first_cover') AS first_covers,
    count(e.kind) FILTER (WHERE e.kind = 'cover_change') AS cover_changes
  FROM weeks w
  LEFT JOIN evw e ON e.week = w.week
  GROUP BY w.week
),
cum AS (
  SELECT per_week.*,
         sum(signups) OVER (ORDER BY week) AS members_cum,
         sum(first_photos) OVER (ORDER BY week) AS photo_ever_cum
  FROM per_week
)
SELECT jsonb_build_object(
  'weekly', coalesce(jsonb_agg(jsonb_build_object(
    'week', week,
    'signups', signups,
    'members_cum', members_cum,
    'first_photos', first_photos,
    'photo_changes', photo_changes,
    'photo_ever_cum', photo_ever_cum,
    'first_covers', first_covers,
    'cover_changes', cover_changes
  ) ORDER BY week), '[]'::jsonb)
)
FROM cum
$$;

-- ------------------------------------------------------------
-- 3. Daily snapshots
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profile_stats_snapshots (
  snapshot_date date PRIMARY KEY,
  stats         jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profile_stats_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_stats_snapshots FROM anon, authenticated;
GRANT SELECT ON public.profile_stats_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.take_profile_stats_snapshot()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Re-running on the same day replaces that day's snapshot
  INSERT INTO profile_stats_snapshots (snapshot_date, stats)
  VALUES ((now() AT TIME ZONE 'Asia/Jerusalem')::date, profile_stats_compute())
  ON CONFLICT (snapshot_date) DO UPDATE SET stats = EXCLUDED.stats, created_at = now();
$$;

-- ------------------------------------------------------------
-- 4. What the admin page reads
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_profile_analytics()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not Found' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'generated_at', now(),
    'current', profile_stats_compute(),
    'history', profile_stats_history(),
    'snapshots', coalesce((
      SELECT jsonb_agg(jsonb_build_object('date', snapshot_date, 'trend', stats -> 'trend') ORDER BY snapshot_date)
      FROM profile_stats_snapshots
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.profile_stats_compute() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profile_stats_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.take_profile_stats_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_profile_analytics() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_profile_analytics() TO authenticated;

SELECT public.take_profile_stats_snapshot();

SELECT cron.unschedule('profile-stats-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'profile-stats-snapshot');
SELECT cron.schedule('profile-stats-snapshot', '55 21 * * *', $$SELECT public.take_profile_stats_snapshot()$$);

-- ------------------------------------------------------------
-- Self-check: a non-admin is refused, an admin gets the three parts. Nothing is kept.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_json jsonb;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'app_metadata', json_build_object())::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.admin_profile_analytics();
      v_problems := v_problems || ' a member who is not an admin got the analytics;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM public.profile_stats_snapshots LIMIT 1;
      v_problems := v_problems || ' members can read profile_stats_snapshots;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.profile_stats_compute();
      v_problems := v_problems || ' members can call profile_stats_compute;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    v_json := public.admin_profile_analytics();
    IF v_json -> 'current' -> 'members' ->> 'total' IS NULL
       OR jsonb_array_length(v_json -> 'history' -> 'weekly') = 0
       OR jsonb_array_length(v_json -> 'snapshots') = 0 THEN
      v_problems := v_problems || ' the admin reply is missing a part;';
    END IF;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % members analysed, first snapshot taken, daily job scheduled.',
    v_json -> 'current' -> 'members' ->> 'total';
END $$;

COMMIT;

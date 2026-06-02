-- ============================================================
-- Fix talent_search_view: add raw private columns needed by talent.ts
-- The original view only exposed puv.* which doesn't include
-- privacy_lastname, privacy_picture (or their aliases), or raw
-- last_name / email / phone / has_image.
-- This update adds them by selecting directly from the already-joined
-- users table, keeping the same puv.* columns intact.
-- ============================================================

CREATE OR REPLACE VIEW talent_search_view AS
SELECT
  puv.*,
  u.job_seeking_status,
  u.last_name                                          AS raw_last_name,
  u.email                                              AS raw_email,
  u.phone                                              AS raw_phone,
  u.privacy_lastname                                   AS user_privacy_lastname,
  u.privacy_picture                                    AS user_privacy_picture,
  (u.image IS NOT NULL AND u.image <> '')::boolean     AS has_image,
  calculate_experience_years(puv.experience)           AS experience_years
FROM public_users_view puv
JOIN users u ON u.uuid = puv.uuid;

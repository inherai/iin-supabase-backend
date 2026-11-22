-- READ-ONLY. Run after add_member_job_seeking_safe.sql.
-- For every recruiter (role 'recruiters' or a company page role): her companies as keys, and how
-- many candidates now hide their status from her because they work there — with examples.
-- Check that the examples really are her company (e.g. "Intel" vs "אינטל בע״מ").
WITH r AS (
  SELECT u.uuid, u.first_name, u.role::text AS role, talent_viewer_company_keys(u.uuid) AS keys
  FROM users u
  WHERE u.status = 'Active'
    AND (u.role::text = 'recruiters' OR EXISTS (SELECT 1 FROM company_admins ca WHERE ca.user_id = u.uuid))
)
SELECT
  r.first_name AS recruiter,
  r.role,
  r.keys AS her_companies,
  count(psi.user_uuid) AS candidates_at_her_companies,
  count(s.user_uuid) FILTER (WHERE s.status IN ('active', 'open')) AS of_them_seeking,
  (array_agg(DISTINCT psi.current_companies::text) FILTER (WHERE psi.user_uuid IS NOT NULL))[1:5] AS examples
FROM r
LEFT JOIN people_search_index psi
  ON psi.current_company_keys && r.keys AND psi.user_uuid <> r.uuid
LEFT JOIN member_job_seeking s ON s.user_uuid = psi.user_uuid
GROUP BY r.uuid, r.first_name, r.role, r.keys
ORDER BY candidates_at_her_companies DESC;

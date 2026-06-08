-- View that adds activity_score and latest_job_at to companies for sorted pagination.
-- Sorted by latest_job_at (most recently imported/updated job) descending.
--
-- NOTE: uses cardinality(employees) — works when employees is a native Postgres array (text[], uuid[]).
-- If employees is stored as jsonb, replace cardinality(...) with jsonb_array_length(...).

DROP VIEW IF EXISTS companies_ranked;
CREATE VIEW companies_ranked AS
SELECT
  c.*,
  COALESCE(cardinality(c.employees), 0)                           AS employees_count,
  COALESCE(op.open_positions_count, 0)                            AS open_positions_count,
  COALESCE(cardinality(c.employees), 0)
    + COALESCE(op.open_positions_count, 0)                        AS activity_score,
  op.latest_job_at                                                 AS latest_job_at
FROM companies c
LEFT JOIN (
  SELECT company_id, COUNT(*)::int AS open_positions_count, MAX(created_at) AS latest_job_at
  FROM open_position
  GROUP BY company_id
) op ON op.company_id = c.id;

-- View that adds activity_score to companies for sorted pagination.
-- activity_score = employees_count + open_positions_count (highest first).
--
-- NOTE: uses cardinality(employees) — works when employees is a native Postgres array (text[], uuid[]).
-- If employees is stored as jsonb, replace cardinality(...) with jsonb_array_length(...).

CREATE OR REPLACE VIEW companies_ranked AS
SELECT
  c.*,
  COALESCE(cardinality(c.employees), 0)                           AS employees_count,
  COALESCE(op.open_positions_count, 0)                            AS open_positions_count,
  COALESCE(cardinality(c.employees), 0)
    + COALESCE(op.open_positions_count, 0)                        AS activity_score
FROM companies c
LEFT JOIN (
  SELECT company_id, COUNT(*)::int AS open_positions_count
  FROM open_position
  GROUP BY company_id
) op ON op.company_id = c.id;

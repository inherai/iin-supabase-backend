-- Fix calculate_experience_years: same-year roles (and current roles starting
-- this year) were counted as 0. Any role with a valid startDate now counts
-- as at least 1 year, matching standard year-only-precision behaviour.
CREATE OR REPLACE FUNCTION calculate_experience_years(experience jsonb)
RETURNS int LANGUAGE plpgsql STABLE AS $$
DECLARE
  total_years int := 0;
  exp jsonb;
  start_year int;
  end_year int;
BEGIN
  IF experience IS NULL OR jsonb_array_length(experience) = 0 THEN RETURN 0; END IF;
  FOR exp IN SELECT * FROM jsonb_array_elements(experience) LOOP
    BEGIN
      start_year := SUBSTRING(COALESCE(exp->>'startDate',''), 1, 4)::int;
    EXCEPTION WHEN OTHERS THEN CONTINUE;
    END;
    IF (exp->>'current')::boolean = true THEN
      total_years := total_years + GREATEST(EXTRACT(YEAR FROM NOW())::int - start_year, 1);
    ELSIF exp->>'endDate' IS NOT NULL THEN
      BEGIN end_year := SUBSTRING(exp->>'endDate', 1, 4)::int;
      EXCEPTION WHEN OTHERS THEN end_year := EXTRACT(YEAR FROM NOW())::int; END;
      total_years := total_years + GREATEST(end_year - start_year, 1);
    END IF;
  END LOOP;
  RETURN GREATEST(total_years, 0);
END;
$$;

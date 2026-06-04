-- GIN index on users.skills for fast && (overlap) queries
CREATE INDEX IF NOT EXISTS idx_users_skills_gin ON users USING GIN (skills);

-- Drop first in case it exists with a different return type
DROP FUNCTION IF EXISTS get_random_skills(integer);

CREATE OR REPLACE FUNCTION get_random_skills(row_limit INT DEFAULT 20)
RETURNS TABLE(id INT, name TEXT)
LANGUAGE sql STABLE AS $$
  SELECT id, name FROM skills ORDER BY random() LIMIT row_limit;
$$;

-- Popularity signal: count how many (non-recruiter) users have each skill
CREATE OR REPLACE FUNCTION get_skill_popularity()
RETURNS TABLE(sname TEXT, cnt BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT lower(sk) AS sname, COUNT(*) AS cnt
  FROM users u, unnest(u.skills) sk
  WHERE u.role != 'recruiters'
    AND sk IS NOT NULL
  GROUP BY 1;
$$;

-- Role affinity signal: skills common among users with a matching current job title
CREATE OR REPLACE FUNCTION get_role_skill_affinity(p_title TEXT)
RETURNS TABLE(sname TEXT, cnt BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT lower(sk) AS sname, COUNT(*) AS cnt
  FROM users u,
       unnest(u.skills) sk,
       jsonb_array_elements(u.experience) exp
  WHERE p_title IS NOT NULL
    AND p_title != ''
    AND (exp->>'current') = 'true'
    AND lower(exp->>'title') ILIKE '%' || lower(p_title) || '%'
    AND sk IS NOT NULL
  GROUP BY 1;
$$;

-- Co-occurrence signal: skills held by users who share ≥1 skill with the querying user
CREATE OR REPLACE FUNCTION get_skill_cooccurrence(p_existing TEXT[], p_user_id UUID)
RETURNS TABLE(sname TEXT, cnt BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT lower(sk) AS sname, COUNT(*) AS cnt
  FROM users u, unnest(u.skills) sk
  WHERE u.skills && p_existing
    AND u.uuid != p_user_id
    AND sk IS NOT NULL
    AND NOT (lower(sk) = ANY(SELECT lower(e) FROM unnest(p_existing) e))
  GROUP BY 1;
$$;

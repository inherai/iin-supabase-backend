-- company_reviews
CREATE TABLE company_reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  title TEXT NOT NULL,
  job_title TEXT,
  pros TEXT NOT NULL,
  cons TEXT NOT NULL,
  overall_rating SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  work_life_balance_rating SMALLINT CHECK (work_life_balance_rating BETWEEN 1 AND 5),
  culture_rating SMALLINT CHECK (culture_rating BETWEEN 1 AND 5),
  management_rating SMALLINT CHECK (management_rating BETWEEN 1 AND 5),
  recommend BOOLEAN NOT NULL DEFAULT false,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- company_salaries
CREATE TABLE company_salaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  job_title TEXT NOT NULL,
  salary_min INTEGER NOT NULL,
  salary_max INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ILS',
  employment_type TEXT CHECK (employment_type IN ('full_time','part_time','contract','freelance')),
  experience_years SMALLINT,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- company_interviews
CREATE TABLE company_interviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  job_title TEXT NOT NULL,
  difficulty SMALLINT NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  outcome TEXT NOT NULL CHECK (outcome IN ('offer','rejected','pending')),
  pros TEXT,
  cons TEXT,
  process_description TEXT,
  questions TEXT[],
  duration_weeks SMALLINT,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- company_fit_ratings
CREATE TABLE company_fit_ratings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  overall_fit_rating SMALLINT NOT NULL CHECK (overall_fit_rating BETWEEN 1 AND 5),
  modesty_rating SMALLINT CHECK (modesty_rating BETWEEN 1 AND 5),
  friday_hours_rating SMALLINT CHECK (friday_hours_rating BETWEEN 1 AND 5),
  holiday_flexibility_rating SMALLINT CHECK (holiday_flexibility_rating BETWEEN 1 AND 5),
  separate_workspace_rating SMALLINT CHECK (separate_workspace_rating BETWEEN 1 AND 5),
  kosher_kitchen_rating SMALLINT CHECK (kosher_kitchen_rating BETWEEN 1 AND 5),
  notes TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_company_reviews_company_id ON company_reviews(company_id);
CREATE INDEX idx_company_salaries_company_id ON company_salaries(company_id);
CREATE INDEX idx_company_interviews_company_id ON company_interviews(company_id);
CREATE INDEX idx_company_fit_ratings_company_id ON company_fit_ratings(company_id);

-- RLS
ALTER TABLE company_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_salaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_fit_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can read reviews" ON company_reviews FOR SELECT USING (true);
CREATE POLICY "anyone can read salaries" ON company_salaries FOR SELECT USING (true);
CREATE POLICY "anyone can read interviews" ON company_interviews FOR SELECT USING (true);
CREATE POLICY "anyone can read fit ratings" ON company_fit_ratings FOR SELECT USING (true);

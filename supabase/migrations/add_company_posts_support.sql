-- Company ownership: who can post on behalf of a company
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_uuid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Link posts to companies + track actual poster (separate from sender email)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS posted_by_uuid UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Index for fast lookup of posts by company
CREATE INDEX IF NOT EXISTS idx_posts_company_id ON posts(company_id) WHERE company_id IS NOT NULL;

-- Index for fast lookup of companies by owner
CREATE INDEX IF NOT EXISTS idx_companies_owner_uuid ON companies(owner_uuid) WHERE owner_uuid IS NOT NULL;

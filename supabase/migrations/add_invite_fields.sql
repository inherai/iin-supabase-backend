ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS acquaintance_source TEXT,
  ADD COLUMN IF NOT EXISTS terms_accepted     BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS terms_accepted_at  TIMESTAMPTZ;

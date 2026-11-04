-- Admin-granted invitation allowances. Lives in its own table rather than on users,
-- because members can update their own users row and must not be able to grant
-- themselves invites. RLS on with no policies: only the service role reads or writes it.
CREATE TABLE IF NOT EXISTS invite_allowances (
  user_id           UUID PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
  unlimited         BOOLEAN     NOT NULL DEFAULT false,
  -- Extra invites on top of the weekly limit, valid only for the calendar week
  -- that starts at week_bonus_start (same week boundary as routes/invite.ts)
  week_bonus        INTEGER     NOT NULL DEFAULT 0 CHECK (week_bonus >= 0),
  week_bonus_start  TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        UUID
);

ALTER TABLE invite_allowances ENABLE ROW LEVEL SECURITY;

-- Explicit, since newer projects no longer grant table access to API roles by default
REVOKE ALL ON invite_allowances FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON invite_allowances TO service_role;

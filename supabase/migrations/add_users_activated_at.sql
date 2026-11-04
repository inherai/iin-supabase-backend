-- ============================================================
-- When a member finished onboarding (status onboarding → Active). Run in Supabase SQL Editor. Safe to re-run.
-- Set by PUT /api/me/status. Used by the welcome email's hourly catch-up (email plan, B4):
-- a welcome that couldn't go out at once (night, Shabbat) is sent within 3 days of this time.
-- Existing members stay NULL, so they never get a late welcome.
-- ============================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE INDEX IF NOT EXISTS users_activated_at ON public.users (activated_at) WHERE activated_at IS NOT NULL;

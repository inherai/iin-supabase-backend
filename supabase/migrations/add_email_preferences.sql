-- ============================================================
-- Email preferences + suppression list (email plan, phase 0a).
-- Run in Supabase SQL Editor. Safe to re-run.
--
--   * email_preferences — one row per (member, email category) she changed
--     from the default. No row = the category's default applies. The special
--     category '_all' with frequency 'off' means "no non-essential email".
--   * email_suppressions — addresses we must not email at all (non-members
--     who asked to stop, hard bounces, spam complaints, manual admin blocks).
--     Keyed by email so it works for people who have no account.
--
-- Both tables are written only by the API with the service role; RLS is on
-- so the anon/authenticated keys can't read or change them directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.email_preferences (
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category    text        NOT NULL,
  frequency   text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,                       -- null = the member herself; else the admin who changed it
  PRIMARY KEY (user_id, category),
  CONSTRAINT email_preferences_frequency_chk
    CHECK (frequency IN ('instant', 'daily', 'twice_weekly', 'weekly', 'biweekly', 'on', 'off'))
);

ALTER TABLE public.email_preferences ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.email_suppressions (
  email       text        PRIMARY KEY,    -- always stored lower-cased and trimmed
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                       -- admin who added it, when manual
  note        text,
  CONSTRAINT email_suppressions_reason_chk
    CHECK (reason IN ('unsubscribe_invites', 'unsubscribe_all', 'bounce', 'complaint', 'admin')),
  CONSTRAINT email_suppressions_lowercase_chk
    CHECK (email = lower(btrim(email)))
);

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: only the service role (the API) touches these tables.

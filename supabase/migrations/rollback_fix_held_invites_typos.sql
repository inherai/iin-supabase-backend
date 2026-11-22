-- ============================================================
-- Undo fix_held_invites_typos_safe.sql: every changed invitation back to its saved state.
-- (Any email the timer sent meanwhile to a corrected address has gone out; that can't be undone.)
-- ============================================================
BEGIN;

UPDATE invites i SET
  recipient_email  = b.recipient_email,
  token            = b.token,
  status           = b.status,
  expires_at       = b.expires_at,
  email_sent_at    = b.email_sent_at,
  reminder_sent_at = b.reminder_sent_at,
  send_skipped     = b.send_skipped,
  views_count      = b.views_count,
  last_viewed_at   = b.last_viewed_at
FROM public.held_invite_typo_fix_backup b WHERE b.id = i.id;

DROP TABLE public.held_invite_typo_fix_backup;

COMMIT;

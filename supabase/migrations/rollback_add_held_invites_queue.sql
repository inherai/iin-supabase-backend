-- ============================================================
-- Undo add_held_invites_queue_safe.sql. Run in the SQL Editor, BEFORE going back to the API that
-- emails imported invitations at import time.
-- Invitations still queued (never emailed) stay in the table; with the old API they will not be
-- sent — delete them from the Invitations page, or import them again.
-- admin_create_held_invites keeps its new body (same signature); re-run add_held_invites_safe.sql
-- after this file to restore the original one.
-- ============================================================
BEGIN;

DROP FUNCTION IF EXISTS public.admin_held_invites(text, text, integer, integer);
DROP FUNCTION IF EXISTS public.admin_held_invites_summary();
DROP FUNCTION IF EXISTS public.held_invites_rows();

DROP INDEX IF EXISTS public.invites_held_queue;
ALTER TABLE public.invites
  DROP COLUMN IF EXISTS email_sent_at,
  DROP COLUMN IF EXISTS reminder_sent_at,
  DROP COLUMN IF EXISTS send_skipped;

COMMIT;

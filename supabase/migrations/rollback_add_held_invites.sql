-- ============================================================
-- Undo add_held_invites_safe.sql. Run in the SQL Editor.
-- Members still waiting are let in (status Active), so nobody is left on a status the app no
-- longer knows. The invitation columns are dropped with their data (sender names of the imports).
-- ============================================================
BEGIN;

DROP TRIGGER IF EXISTS hold_invited_user_for_review ON public.users;
UPDATE public.users SET status = 'Active', activated_at = coalesce(activated_at, now()) WHERE status = 'pending_review';

DROP FUNCTION IF EXISTS public.hold_invited_user_for_review();
DROP FUNCTION IF EXISTS public.admin_create_held_invites(text[], text, text, integer);
DROP FUNCTION IF EXISTS public.admin_pending_review_users();
DROP FUNCTION IF EXISTS public.admin_approve_pending_users(uuid[]);

DROP INDEX IF EXISTS public.invites_held_email;
ALTER TABLE public.invites
  DROP COLUMN IF EXISTS hold_for_review,
  DROP COLUMN IF EXISTS inviter_display_name,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by;

COMMIT;

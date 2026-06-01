-- Fix: Users created via Google OAuth always got role='community' because the
-- handle_new_user auth trigger ran before the invite-callback edge function.
-- This BEFORE INSERT trigger fires during that very INSERT and overrides the
-- role with whatever the pending invite says, so the row lands correctly from
-- the start — no race condition, no post-hoc patch needed.

CREATE OR REPLACE FUNCTION public.correct_role_from_invite()
RETURNS trigger AS $$
DECLARE
  invite_role TEXT;
BEGIN
  SELECT i.role INTO invite_role
  FROM public.invites i
  WHERE LOWER(TRIM(i.recipient_email)) = LOWER(TRIM(NEW.email))
    AND i.status = 'pending'
    AND (i.expires_at IS NULL OR i.expires_at > NOW())
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF invite_role IS NOT NULL AND invite_role != 'community' THEN
    NEW.role := invite_role;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS correct_role_on_user_insert ON public.users;

CREATE TRIGGER correct_role_on_user_insert
  BEFORE INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.correct_role_from_invite();

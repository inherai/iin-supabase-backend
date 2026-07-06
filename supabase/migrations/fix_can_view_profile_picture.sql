-- Align can_view_profile_picture with the API's privacy semantics.
--
-- Two changes vs the previous DB version:
--   1. NULL privacy_picture returned TRUE (open to everyone) while every API
--      flag computation (profile.ts privacyArrayAllows) and EditPrivacyDialog.tsx
--      treat a missing array as "not shared with anyone". Now fail-closed.
--   2. The special rule "viewer 'feed_participant' counts as 'community'" is
--      REMOVED. Product decision (2026-07): reciprocity — a user who chose to be
--      anonymous sees others as anonymous too. Privacy arrays never contain
--      'feed_participant', so anonymous viewers match nothing but themselves.
--
-- Must stay in sync with privacyArrayAllows in functions/api/routes/profile.ts.

create or replace function public.can_view_profile_picture(target_user_id uuid, viewer_role text)
returns boolean
language plpgsql
security definer
as $function$
declare
  target_privacy_settings text[];
begin
  select privacy_picture into target_privacy_settings
  from users
  where uuid = target_user_id;

  if not found then
    return false;
  end if;

  -- Fail-closed: no privacy array (or an empty one) means "not shared with anyone"
  if target_privacy_settings is null or array_length(target_privacy_settings, 1) is null then
    return false;
  end if;

  return viewer_role = any(target_privacy_settings);
end;
$function$;

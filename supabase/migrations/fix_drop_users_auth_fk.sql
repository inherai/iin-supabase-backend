-- The admin delete flow anonymizes public.users (step 6) then deletes auth.users (step 7).
-- The FK public.users.uuid → auth.users(id) blocks step 7 because the anonymized row stays.
-- Drop the FK so auth deletion can proceed; the uuid value is still kept for post attribution.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_uuid_fkey;

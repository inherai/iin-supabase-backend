-- ============================================================
-- Rollback of add_talent_v2_safe.sql (2026-11-18). Run in the SQL Editor.
-- Deploy the previous API first (talent.ts and profile-access-request.ts from before talent v2).
--
-- Puts can_message() back exactly as secure_chat_safe.sql wrote it, removes the search and degree
-- functions, and DROPS the recruiters' projects, stages and notes (their content is lost — export
-- first if any was written). profile_access_requests.context_title is dropped too (the "about"
-- line of outreach sent since; the messages themselves stay).
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.can_message(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b AND (
    EXISTS (
      SELECT 1 FROM connections
      WHERE status = 'accepted'
        AND ((requester_id = p_a AND receiver_id = p_b) OR (requester_id = p_b AND receiver_id = p_a))
    )
    OR EXISTS (
      -- one of them applied through duallin to a page the other manages as owner / recruiter
      SELECT 1 FROM job_submissions s
      JOIN company_admins a ON a.company_id = s.company_id AND a.role IN ('owner', 'recruiter')
      WHERE (s.user_id = p_a AND a.user_id = p_b) OR (s.user_id = p_b AND a.user_id = p_a)
    )
  )
$function$;
REVOKE ALL ON FUNCTION public.can_message(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_message(uuid, uuid) TO authenticated, service_role;

DROP TABLE IF EXISTS public.talent_notes;
DROP TABLE IF EXISTS public.talent_project_candidates;
DROP TABLE IF EXISTS public.talent_projects;
DROP FUNCTION IF EXISTS public.talent_is_recruiter();
DROP FUNCTION IF EXISTS public.talent_search(uuid, text, vector, text[], boolean, text, text[], text[], integer, integer, text[], text, boolean, text[], double precision, text, integer, integer, timestamptz);
DROP FUNCTION IF EXISTS public.talent_degree_level(text);
DROP FUNCTION IF EXISTS public.talent_overview(uuid);

ALTER TABLE public.profile_access_requests DROP CONSTRAINT IF EXISTS profile_access_requests_context_title_len;
ALTER TABLE public.profile_access_requests DROP CONSTRAINT IF EXISTS profile_access_requests_message_len;
ALTER TABLE public.profile_access_requests DROP COLUMN IF EXISTS context_title;
DROP TRIGGER IF EXISTS trg_profile_access_requests_contact ON public.profile_access_requests;
DROP FUNCTION IF EXISTS public.profile_access_requests_contact();
ALTER TABLE public.profile_access_requests DROP COLUMN IF EXISTS contact_accepted_at;
ALTER TABLE public.users DROP COLUMN IF EXISTS job_seeking_visibility;

-- NOT undone on purpose: the closing of talent_search_view to anon / authenticated. Re-opening it
-- would expose every member's raw e-mail and phone through the public key.

COMMIT;

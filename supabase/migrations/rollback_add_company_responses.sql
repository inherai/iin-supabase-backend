-- Undo add_company_responses_safe.sql: the companies' answers, their notifications and record lines.
BEGIN;
DROP TABLE IF EXISTS public.company_responses;   -- takes its triggers and policies with it
DROP FUNCTION IF EXISTS public.company_responses_guard();
DROP FUNCTION IF EXISTS public.company_responses_after_change();
DELETE FROM public.notifications WHERE type = 'COMPANY_RESPONSE';
DELETE FROM public.company_audit_log WHERE action IN ('response_insert', 'response_update', 'response_delete');
COMMIT;

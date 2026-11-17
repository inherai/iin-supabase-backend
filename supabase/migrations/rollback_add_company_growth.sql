-- Undo add_company_growth_safe.sql: invitations to follow and alerts to employees.
-- The follows that came from accepted invitations stay (they are ordinary follows).
-- Invitations already counted toward this month's limit stay counted in usage_counters.
BEGIN;
DROP FUNCTION IF EXISTS public.notify_page_employees(text);
DROP FUNCTION IF EXISTS public.company_employee_alert_status(integer);
DROP FUNCTION IF EXISTS public.company_employee_recipients(integer);
DROP TABLE IF EXISTS public.company_employee_alerts;
DROP FUNCTION IF EXISTS public.company_invited_member_ids(integer);
DROP TABLE IF EXISTS public.company_follow_invites;   -- takes its triggers and policies with it
DROP FUNCTION IF EXISTS public.company_follow_invites_guard();
DROP FUNCTION IF EXISTS public.company_follow_invites_notify();
DELETE FROM public.notifications WHERE type IN ('COMPANY_FOLLOW_INVITE', 'COMPANY_EMPLOYEE_POST');
DELETE FROM public.company_audit_log WHERE action = 'employees_notified';
COMMIT;

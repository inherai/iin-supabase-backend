-- Undo add_company_analytics_safe.sql: the page's numbers and the recorded looks.
-- The looks recorded so far are deleted with the table. Nothing else depended on them.
BEGIN;
DROP FUNCTION IF EXISTS public.company_page_stats(integer, integer);
DROP TABLE IF EXISTS public.company_views;
COMMIT;

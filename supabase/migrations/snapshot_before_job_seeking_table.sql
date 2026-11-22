-- READ-ONLY. Run in the SQL Editor BEFORE add_member_job_seeking_safe.sql and save the single
-- JSON result as snapshot_before_job_seeking_table.json (the rollback is checked against it).
SELECT jsonb_pretty(jsonb_build_object(
  'taken_at', now(),
  'functions', (SELECT jsonb_object_agg(p.oid::regprocedure::text, pg_get_functiondef(p.oid))
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND (p.proname IN ('talent_search', 'talent_overview')
                   OR p.prosrc ~ 'job_seeking_(status|visibility)')),
  'function_grants', (SELECT jsonb_agg(jsonb_build_object('fn', routine_name, 'grantee', grantee, 'priv', privilege_type))
                      FROM information_schema.routine_privileges
                      WHERE routine_schema = 'public' AND routine_name IN ('talent_search', 'talent_overview')),
  'view', pg_get_viewdef('public.talent_search_view'::regclass),
  'view_grants', (SELECT jsonb_agg(jsonb_build_object('grantee', grantee, 'priv', privilege_type))
                  FROM information_schema.table_privileges
                  WHERE table_schema = 'public' AND table_name = 'talent_search_view'),
  'columns', (SELECT jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type, 'nullable', is_nullable, 'default', column_default))
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name LIKE 'job_seeking%'),
  'constraints', (SELECT jsonb_agg(jsonb_build_object('name', conname, 'def', pg_get_constraintdef(oid)))
                  FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND conname LIKE '%job_seeking%'),
  'indexes', (SELECT jsonb_agg(indexdef) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'users' AND indexdef ~ 'job_seeking'),
  'dependent_views', (SELECT jsonb_agg(DISTINCT v.relname)
                      FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class v ON v.oid = r.ev_class
                      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                      WHERE d.refobjid = 'public.users'::regclass AND a.attname LIKE 'job_seeking%'),
  'counts', (SELECT jsonb_object_agg(coalesce(job_seeking_status, 'null') || '/' || coalesce(job_seeking_visibility, 'null'), n)
             FROM (SELECT job_seeking_status, job_seeking_visibility, count(*) n FROM users GROUP BY 1, 2) c)
)) AS snapshot;

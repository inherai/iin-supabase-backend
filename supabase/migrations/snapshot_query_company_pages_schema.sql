-- Snapshot query (READ-ONLY) — run before any company-pages migration.
-- Returns one JSON document describing the exact current state of every table the
-- company-pages work touches: columns, constraints, indexes, RLS, policies, grants,
-- triggers, function bodies, views and storage. Rollbacks are built from this output.
--
-- Run in the Supabase SQL Editor and save the single result cell as
-- migrations/snapshot_before_company_pages.json

WITH t(name) AS (
  SELECT unnest(ARRAY[
    'companies', 'company_requests', 'posts', 'comments', 'likes', 'notifications',
    'connections', 'open_position', 'job_applications', 'articles',
    'article_company_follows', 'article_author_follows', 'conversations', 'messages',
    'saved_resources', 'feed_cache', 'scheduled_posts', 'post_impressions',
    'post_reports', 'users'
  ])
),
rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN t ON t.name = c.relname
  WHERE c.relnamespace = 'public'::regnamespace
)
SELECT jsonb_pretty(jsonb_build_object(
  'taken_at', now(),

  'missing_tables', (
    SELECT coalesce(jsonb_agg(t.name ORDER BY t.name), '[]'::jsonb)
    FROM t WHERE NOT EXISTS (SELECT 1 FROM rel WHERE rel.relname = t.name)
  ),

  'rls', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', relname, 'kind', relkind,
      'rls_enabled', relrowsecurity, 'rls_forced', relforcerowsecurity
    ) ORDER BY relname)
    FROM rel
  ),

  'columns', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', table_name, 'column', column_name, 'type', data_type, 'udt', udt_name,
      'nullable', is_nullable, 'default', column_default
    ) ORDER BY table_name, ordinal_position)
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN (SELECT name FROM t)
  ),

  'constraints', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', rel.relname, 'name', con.conname, 'type', con.contype,
      'def', pg_get_constraintdef(con.oid)
    ) ORDER BY rel.relname, con.conname)
    FROM pg_constraint con JOIN rel ON rel.oid = con.conrelid
  ),

  'indexes', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', indexname, 'def', indexdef
    ) ORDER BY tablename, indexname)
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN (SELECT name FROM t)
  ),

  'policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'permissive', permissive,
      'roles', roles, 'cmd', cmd, 'using', qual, 'with_check', with_check
    ) ORDER BY tablename, policyname)
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN (SELECT name FROM t)
  ),

  'grants', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', table_name, 'grantee', grantee, 'privileges', privileges
    ) ORDER BY table_name, grantee)
    FROM (
      SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN (SELECT name FROM t)
        AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
      GROUP BY table_name, grantee
    ) g
  ),

  'triggers', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', rel.relname, 'name', tg.tgname, 'enabled', tg.tgenabled,
      'function', tg.tgfoid::regproc::text, 'def', pg_get_triggerdef(tg.oid)
    ) ORDER BY rel.relname, tg.tgname)
    FROM pg_trigger tg JOIN rel ON rel.oid = tg.tgrelid
    WHERE NOT tg.tgisinternal
  ),

  'functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
      'security_definer', p.prosecdef, 'def', pg_get_functiondef(p.oid)
    ) ORDER BY p.proname)
    FROM pg_proc p
    WHERE p.prokind = 'f'
      AND (
        p.oid IN (
          SELECT tg.tgfoid FROM pg_trigger tg JOIN rel ON rel.oid = tg.tgrelid
          WHERE NOT tg.tgisinternal
        )
        OR (
          p.pronamespace = 'public'::regnamespace
          AND p.proname IN (
            'handle_new_like', 'handle_new_comment', 'notify_article_comment',
            'extract_mention_ids', 'get_stabilized_feed', 'get_uuid_by_email',
            'get_user_email_by_uuid', 'people_search_companies', 'people_search_company_key',
            'get_post_impressions_chart'
          )
        )
      )
  ),

  'views', (
    SELECT jsonb_agg(jsonb_build_object('name', viewname, 'def', definition) ORDER BY viewname)
    FROM pg_views
    WHERE schemaname = 'public'
      AND viewname IN ('companies_ranked', 'public_users_view', 'talent_search_view')
  ),

  'storage_buckets', (
    SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'public', public,
      'file_size_limit', file_size_limit, 'allowed_mime_types', allowed_mime_types
    ) ORDER BY id)
    FROM storage.buckets
  ),

  'storage_policies', (
    SELECT jsonb_agg(jsonb_build_object(
      'table', tablename, 'name', policyname, 'roles', roles, 'cmd', cmd,
      'using', qual, 'with_check', with_check
    ) ORDER BY tablename, policyname)
    FROM pg_policies
    WHERE schemaname = 'storage'
  )
)) AS snapshot;

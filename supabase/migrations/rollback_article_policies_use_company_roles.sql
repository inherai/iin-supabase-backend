-- ============================================================
-- UNDO article_policies_use_company_roles_safe.sql — the three rules ask about
-- companies.owner_uuid again, exactly as in production on 2026-11-11.
-- Deploy the API from before lib/companyAccess.ts together with this, so both ask the same question.
-- ============================================================
BEGIN;

DROP POLICY IF EXISTS articles_read_published_or_own ON public.articles;
CREATE POLICY articles_read_published_or_own ON public.articles FOR SELECT
  USING ((deleted_at IS NULL) AND ((status = 'published'::text) OR (author_uuid = auth.uid()) OR (EXISTS ( SELECT 1
     FROM companies
    WHERE ((companies.id = articles.company_id) AND (companies.owner_uuid = auth.uid()))))));

DROP POLICY IF EXISTS articles_author_write ON public.articles;
CREATE POLICY articles_author_write ON public.articles FOR ALL
  USING ((author_uuid = auth.uid()) OR (EXISTS ( SELECT 1
     FROM companies
    WHERE ((companies.id = articles.company_id) AND (companies.owner_uuid = auth.uid())))));

DROP POLICY IF EXISTS article_skills_author_write ON public.article_skills;
CREATE POLICY article_skills_author_write ON public.article_skills FOR ALL
  USING (EXISTS ( SELECT 1
     FROM articles
    WHERE ((articles.id = article_skills.article_id) AND ((articles.author_uuid = auth.uid()) OR (EXISTS ( SELECT 1
             FROM companies
            WHERE ((companies.id = articles.company_id) AND (companies.owner_uuid = auth.uid()))))))));

COMMIT;

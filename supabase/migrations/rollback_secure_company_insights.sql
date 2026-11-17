-- Undo secure_company_insights_step1_safe.sql and step2, back to the state captured in
-- snapshot_before_secure_company_insights.json (2026-11-17). No row is touched.
BEGIN;

-- company_reviews
DROP POLICY IF EXISTS "A member reads her own reviews" ON public.company_reviews;
DROP POLICY IF EXISTS "A member submits her own reviews" ON public.company_reviews;
DROP POLICY IF EXISTS "Authenticated users can submit reviews" ON public.company_reviews;
CREATE POLICY "Authenticated users can submit reviews" ON public.company_reviews AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS "anyone can read reviews" ON public.company_reviews;
CREATE POLICY "anyone can read reviews" ON public.company_reviews AS PERMISSIVE FOR SELECT TO public USING (true);
GRANT ALL ON public.company_reviews TO anon, authenticated, service_role;
DROP VIEW IF EXISTS public.company_reviews_public;

-- company_interviews
DROP POLICY IF EXISTS "A member reads her own interview reports" ON public.company_interviews;
DROP POLICY IF EXISTS "A member submits her own interview reports" ON public.company_interviews;
DROP POLICY IF EXISTS "Authenticated users can submit interviews" ON public.company_interviews;
CREATE POLICY "Authenticated users can submit interviews" ON public.company_interviews AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS "anyone can read interviews" ON public.company_interviews;
CREATE POLICY "anyone can read interviews" ON public.company_interviews AS PERMISSIVE FOR SELECT TO public USING (true);
GRANT ALL ON public.company_interviews TO anon, authenticated, service_role;
DROP VIEW IF EXISTS public.company_interviews_public;

-- company_fit_ratings
DROP POLICY IF EXISTS "A member reads her own fit ratings" ON public.company_fit_ratings;
DROP POLICY IF EXISTS "A member submits her own fit ratings" ON public.company_fit_ratings;
DROP POLICY IF EXISTS "Authenticated users can submit fit ratings" ON public.company_fit_ratings;
CREATE POLICY "Authenticated users can submit fit ratings" ON public.company_fit_ratings AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS "anyone can read fit ratings" ON public.company_fit_ratings;
CREATE POLICY "anyone can read fit ratings" ON public.company_fit_ratings AS PERMISSIVE FOR SELECT TO public USING (true);
GRANT ALL ON public.company_fit_ratings TO anon, authenticated, service_role;
DROP VIEW IF EXISTS public.company_fit_ratings_public;

-- company_salaries
DROP POLICY IF EXISTS "A member reads her own salaries" ON public.company_salaries;
DROP POLICY IF EXISTS "A member submits her own salaries" ON public.company_salaries;
DROP POLICY IF EXISTS "Authenticated users can submit salaries" ON public.company_salaries;
CREATE POLICY "Authenticated users can submit salaries" ON public.company_salaries AS PERMISSIVE FOR INSERT TO public WITH CHECK ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS "anyone can read salaries" ON public.company_salaries;
CREATE POLICY "anyone can read salaries" ON public.company_salaries AS PERMISSIVE FOR SELECT TO public USING (true);
GRANT ALL ON public.company_salaries TO anon, authenticated, service_role;
DROP VIEW IF EXISTS public.company_salaries_public;

-- the company-response guard as it was
CREATE OR REPLACE FUNCTION public.company_responses_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item_company integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.target_type, NEW.target_id, NEW.company_id) IS DISTINCT FROM (OLD.target_type, OLD.target_id, OLD.company_id) THEN
      RAISE EXCEPTION 'an answer stays on its item' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND page_status = 'claimed') THEN
      RAISE EXCEPTION 'page_not_active' USING ERRCODE = '42501';
    END IF;
    IF (SELECT enabled FROM entitlement_value('company', NEW.company_id::text, 'reviews.respond')) IS NOT TRUE THEN
      RAISE EXCEPTION 'not_in_plan' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_item_company := CASE NEW.target_type
      WHEN 'review'     THEN (SELECT company_id FROM company_reviews     WHERE id = NEW.target_id)
      WHEN 'interview'  THEN (SELECT company_id FROM company_interviews  WHERE id = NEW.target_id)
      WHEN 'fit_rating' THEN (SELECT company_id FROM company_fit_ratings WHERE id = NEW.target_id)
    END;
    IF v_item_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'item_not_about_this_page' USING ERRCODE = '42501';
    END IF;
    NEW.responded_by := auth.uid();
    NEW.created_at := now();
  ELSE
    NEW.responded_by := coalesce(auth.uid(), OLD.responded_by);
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  NEW.body := btrim(NEW.body);
  RETURN NEW;
END;
$function$;

COMMIT;

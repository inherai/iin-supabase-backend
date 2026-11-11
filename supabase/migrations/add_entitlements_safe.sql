-- ============================================================
-- Plans, entitlements and billing records — SELF-CHECKING (2026-11-11). Run in the SQL Editor.
-- Needs add_company_pages_core_safe.sql (uses has_company_role / is_platform_admin / company_audit_log).
--
-- Everything is free today: one plan, 'free', with every feature on. No payment provider
-- is connected and nothing here charges anyone. What this adds is the place every "may this
-- page do X?" question is answered from, so that changing what is free later is a change of
-- rows, not of code.
--
--   features               the catalogue of things a plan can allow
--                            boolean  on / off
--                            limit    how many may exist at once (NULL = no limit)
--                            metered  how many per period (NULL = no limit)
--   plans, plan_features   what each plan allows
--   products, prices       what can be bought, separate from what it allows: monthly / yearly
--                          subscription, one-time, per seat, per unit, credit packs. Empty for now.
--   subscriptions          which plan a page (or, later, a person) is on. Nobody has one today:
--                          without a subscription the default plan applies.
--   entitlement_overrides  hand-made exceptions: a gift, a trial, a block — with an expiry
--   usage_counters         what was used in the current period (metered features)
--   credit_ledger          credits granted and spent (pay-per-item: one job, one promotion)
--
-- Every table is keyed by subject_type ('company' | 'user') + subject_id, so the same
-- machinery can later serve plans for recruiters or members.
--
-- Who may do what — enforced by row-level security, no service role involved:
--   * any signed-in member reads the catalogue (features, plans, products, prices)
--   * a page's managers read their page's subscription, exceptions, usage and credits;
--     a person reads their own
--   * only a Duallin admin, in her own session, changes any of it
-- Five small functions run with the table owner's rights (SECURITY DEFINER), each for one
-- narrow job a member must not do directly:
--   entitlement_value    the effective answer for ONE feature of ONE subject (on/off + limit).
--                        Callable for any page, because rules elsewhere (and other members'
--                        screens) need the answer; it gives away nothing else.
--   entitlements_for     the full list with usage — only to the subject's managers / admins
--   entitlement_consume  counts one use of a metered feature, refusing past the limit
--   credits_spend        spends credits, refusing past the balance
--   entitlement_audit    writes the page's audit line when its plan, exceptions or credits change
-- (The one future exception to "no service role": a payment provider's webhook has no
--  signed-in person. It does not exist yet and will be presented before it is written.)
--
-- The checks run in the SAME transaction with throw-away test rows: if any fails, everything
-- is undone and nothing changes. To go back later: rollback_add_entitlements.sql
-- Safe to re-run.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Catalogue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.features (
  key         text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  kind        text        NOT NULL CHECK (kind IN ('boolean', 'limit', 'metered')),
  period      text                 CHECK (period IN ('day', 'week', 'month', 'year')),
  unit        text,
  description text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'metered') = (period IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.plans (
  key          text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_]+$'),
  name         text        NOT NULL,
  subject_type text        NOT NULL CHECK (subject_type IN ('company', 'user')),
  is_default   boolean     NOT NULL DEFAULT false,
  active       boolean     NOT NULL DEFAULT true,
  sort_order   integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- one default plan per kind of subject
CREATE UNIQUE INDEX IF NOT EXISTS plans_one_default_per_subject ON public.plans (subject_type) WHERE is_default;

CREATE TABLE IF NOT EXISTS public.plan_features (
  plan_key    text    NOT NULL REFERENCES public.plans(key)    ON DELETE CASCADE ON UPDATE CASCADE,
  feature_key text    NOT NULL REFERENCES public.features(key) ON DELETE CASCADE ON UPDATE CASCADE,
  enabled     boolean NOT NULL DEFAULT true,
  limit_value integer          CHECK (limit_value IS NULL OR limit_value >= 0),   -- NULL = no limit
  PRIMARY KEY (plan_key, feature_key)
);

CREATE TABLE IF NOT EXISTS public.products (
  id         bigserial   PRIMARY KEY,
  key        text        NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]+$'),
  name       text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('subscription', 'one_time', 'credits', 'seat', 'usage')),
  plan_key   text                 REFERENCES public.plans(key) ON DELETE SET NULL ON UPDATE CASCADE,  -- the plan a subscription product gives
  credits    integer              CHECK (credits IS NULL OR credits > 0),                             -- size of a credit pack
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.prices (
  id                bigserial   PRIMARY KEY,
  product_id        bigint      NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  currency          text        NOT NULL DEFAULT 'ILS' CHECK (currency ~ '^[A-Z]{3}$'),
  unit_amount       integer     NOT NULL CHECK (unit_amount >= 0),          -- in the currency's smallest unit (agorot)
  billing_interval  text                 CHECK (billing_interval IN ('month', 'year')),   -- NULL = charged once
  per_unit          text,                                                   -- what one unit is, when charged per seat / per item
  provider_price_id text,
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON public.prices (product_id);

-- ------------------------------------------------------------
-- 2. Per-subject records
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       bigserial   PRIMARY KEY,
  subject_type             text        NOT NULL CHECK (subject_type IN ('company', 'user')),
  subject_id               text        NOT NULL,
  plan_key                 text        NOT NULL REFERENCES public.plans(key) ON UPDATE CASCADE,
  status                   text        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  current_period_start     timestamptz NOT NULL DEFAULT now(),
  current_period_end       timestamptz,                    -- NULL = open-ended
  seats                    integer     CHECK (seats IS NULL OR seats > 0),
  source                   text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider')),
  provider                 text,
  provider_subscription_id text,
  note                     text,
  created_by               uuid        DEFAULT auth.uid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (CASE subject_type WHEN 'company' THEN subject_id ~ '^[0-9]+$'
                           ELSE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' END)
);
-- a subject is on one plan at a time
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_subject
  ON public.subscriptions (subject_type, subject_id) WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE IF NOT EXISTS public.entitlement_overrides (
  id           bigserial   PRIMARY KEY,
  subject_type text        NOT NULL CHECK (subject_type IN ('company', 'user')),
  subject_id   text        NOT NULL,
  feature_key  text        NOT NULL REFERENCES public.features(key) ON DELETE CASCADE ON UPDATE CASCADE,
  enabled      boolean     NOT NULL,
  limit_value  integer     CHECK (limit_value IS NULL OR limit_value >= 0),
  reason       text,
  expires_at   timestamptz,                                -- NULL = until removed
  created_by   uuid        DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, feature_key),
  CHECK (CASE subject_type WHEN 'company' THEN subject_id ~ '^[0-9]+$'
                           ELSE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' END)
);

CREATE TABLE IF NOT EXISTS public.usage_counters (
  subject_type text    NOT NULL CHECK (subject_type IN ('company', 'user')),
  subject_id   text    NOT NULL,
  feature_key  text    NOT NULL REFERENCES public.features(key) ON DELETE CASCADE ON UPDATE CASCADE,
  period_start date    NOT NULL,
  used         integer NOT NULL CHECK (used >= 0),
  PRIMARY KEY (subject_type, subject_id, feature_key, period_start)
);

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id           bigserial   PRIMARY KEY,
  subject_type text        NOT NULL CHECK (subject_type IN ('company', 'user')),
  subject_id   text        NOT NULL,
  delta        integer     NOT NULL CHECK (delta <> 0),    -- + granted / bought, − spent
  reason       text        NOT NULL,
  ref_type     text,                                       -- what it was spent on: 'job', 'promotion', ...
  ref_id       text,
  created_by   uuid        DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (CASE subject_type WHEN 'company' THEN subject_id ~ '^[0-9]+$'
                           ELSE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' END)
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_subject ON public.credit_ledger (subject_type, subject_id, created_at DESC);

-- ------------------------------------------------------------
-- 3. Who sees a subject's records: the page's managers, the person herself, a Duallin admin.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entitlement_subject_visible(p_subject_type text, p_subject_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR CASE p_subject_type
           WHEN 'company' THEN p_subject_id ~ '^[0-9]{1,9}$' AND public.has_company_role(p_subject_id::integer)
           WHEN 'user'    THEN p_subject_id = auth.uid()::text
           ELSE false
         END
$$;

-- May the caller use up the subject's quota / credits? The managers who act for the page.
CREATE OR REPLACE FUNCTION public.entitlement_subject_actor(p_subject_type text, p_subject_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR CASE p_subject_type
           WHEN 'company' THEN p_subject_id ~ '^[0-9]{1,9}$'
                               AND public.has_company_role(p_subject_id::integer, ARRAY['owner', 'content', 'recruiter'])
           WHEN 'user'    THEN p_subject_id = auth.uid()::text
           ELSE false
         END
$$;

DO $$
DECLARE t text;
BEGIN
  -- catalogue: everyone signed in reads, admins write
  FOREACH t IN ARRAY ARRAY['features', 'plans', 'plan_features', 'products', 'prices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members read the catalogue" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Members read the catalogue" ON public.%I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins change the catalogue" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Admins change the catalogue" ON public.%I FOR ALL TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin())', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
  -- per-subject records: the subject's own people read, admins write
  FOREACH t IN ARRAY ARRAY['subscriptions', 'entitlement_overrides', 'usage_counters', 'credit_ledger'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "A subject''s own people read its records" ON public.%I', t);
    EXECUTE format('CREATE POLICY "A subject''s own people read its records" ON public.%I FOR SELECT TO authenticated USING (public.entitlement_subject_visible(subject_type, subject_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins change a subject''s records" ON public.%I', t);
    EXECUTE format('CREATE POLICY "Admins change a subject''s records" ON public.%I FOR ALL TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin())', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
-- the ledger is a record: lines are added, never edited or removed
REVOKE UPDATE, DELETE ON TABLE public.credit_ledger FROM authenticated;

REVOKE ALL ON SEQUENCE public.products_id_seq, public.prices_id_seq, public.subscriptions_id_seq,
                       public.entitlement_overrides_id_seq, public.credit_ledger_id_seq FROM PUBLIC, anon;
GRANT USAGE ON SEQUENCE public.products_id_seq, public.prices_id_seq, public.subscriptions_id_seq,
                        public.entitlement_overrides_id_seq, public.credit_ledger_id_seq TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. The answer: an exception if there is one, else the subject's plan, else the default
--    plan. A feature the plan doesn't mention is off.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entitlement_value(p_subject_type text, p_subject_id text, p_feature text)
RETURNS TABLE (enabled boolean, limit_value integer, source text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT x.enabled, x.limit_value, x.source
  FROM (
    SELECT o.enabled, o.limit_value, 'override' AS source, 1 AS ord
    FROM entitlement_overrides o
    WHERE o.subject_type = p_subject_type AND o.subject_id = p_subject_id AND o.feature_key = p_feature
      AND (o.expires_at IS NULL OR o.expires_at > now())
    UNION ALL
    SELECT coalesce(pf.enabled, false), pf.limit_value, 'plan:' || s.plan_key, 2
    FROM subscriptions s
    LEFT JOIN plan_features pf ON pf.plan_key = s.plan_key AND pf.feature_key = p_feature
    WHERE s.subject_type = p_subject_type AND s.subject_id = p_subject_id
      AND s.status IN ('trialing', 'active', 'past_due')
      AND (s.current_period_end IS NULL OR s.current_period_end > now())
    UNION ALL
    SELECT pf.enabled, pf.limit_value, 'default:' || p.key, 3
    FROM plans p
    JOIN plan_features pf ON pf.plan_key = p.key AND pf.feature_key = p_feature
    WHERE p.is_default AND p.subject_type = p_subject_type
    UNION ALL
    SELECT false, NULL::integer, 'none', 4
  ) x
  ORDER BY x.ord
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.entitlement_value(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entitlement_value(text, text, text) TO authenticated, service_role;

-- When does the current period of a metered feature start?
CREATE OR REPLACE FUNCTION public.entitlement_period_start(p_period text)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT date_trunc(p_period, now() AT TIME ZONE 'Asia/Jerusalem')::date
$$;

-- The full list for one subject, with what was used this period — for its managers' screens.
CREATE OR REPLACE FUNCTION public.entitlements_for(p_subject_type text, p_subject_id text)
RETURNS TABLE (feature_key text, kind text, period text, enabled boolean, limit_value integer, used integer, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.entitlement_subject_visible(p_subject_type, p_subject_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT f.key, f.kind, f.period, v.enabled, v.limit_value,
           CASE WHEN f.kind = 'metered' THEN coalesce((
             SELECT u.used FROM usage_counters u
             WHERE u.subject_type = p_subject_type AND u.subject_id = p_subject_id
               AND u.feature_key = f.key AND u.period_start = public.entitlement_period_start(f.period)), 0) END,
           v.source
    FROM features f
    CROSS JOIN LATERAL public.entitlement_value(p_subject_type, p_subject_id, f.key) v
    ORDER BY f.key;
END;
$$;
REVOKE ALL ON FUNCTION public.entitlements_for(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entitlements_for(text, text) TO authenticated, service_role;

-- Count a use of a metered feature. Returns how many are left this period (NULL = no limit).
-- Refuses — and counts nothing — when the feature is off or the limit would be passed.
CREATE OR REPLACE FUNCTION public.entitlement_consume(p_subject_type text, p_subject_id text, p_feature text, p_amount integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period text; v_enabled boolean; v_limit integer; v_used integer;
BEGIN
  IF NOT public.entitlement_subject_actor(p_subject_type, p_subject_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive' USING ERRCODE = 'check_violation';
  END IF;
  SELECT f.period INTO v_period FROM features f WHERE f.key = p_feature AND f.kind = 'metered';
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'Not a metered feature: %', p_feature USING ERRCODE = 'check_violation';
  END IF;

  SELECT v.enabled, v.limit_value INTO v_enabled, v_limit FROM public.entitlement_value(p_subject_type, p_subject_id, p_feature) v;
  IF NOT v_enabled THEN
    RAISE EXCEPTION 'entitlement_not_included: %', p_feature USING ERRCODE = 'P0001';
  END IF;
  IF v_limit IS NOT NULL AND p_amount > v_limit THEN
    RAISE EXCEPTION 'entitlement_limit_reached: %', p_feature USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO usage_counters AS u (subject_type, subject_id, feature_key, period_start, used)
  VALUES (p_subject_type, p_subject_id, p_feature, public.entitlement_period_start(v_period), p_amount)
  ON CONFLICT (subject_type, subject_id, feature_key, period_start)
  DO UPDATE SET used = u.used + EXCLUDED.used
     WHERE v_limit IS NULL OR u.used + EXCLUDED.used <= v_limit
  RETURNING u.used INTO v_used;
  IF v_used IS NULL THEN
    RAISE EXCEPTION 'entitlement_limit_reached: %', p_feature USING ERRCODE = 'P0001';
  END IF;
  RETURN v_limit - v_used;
END;
$$;
REVOKE ALL ON FUNCTION public.entitlement_consume(text, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entitlement_consume(text, text, text, integer) TO authenticated, service_role;

-- Credits: the balance, and spending from it. Returns the balance left.
CREATE OR REPLACE FUNCTION public.credit_balance(p_subject_type text, p_subject_id text)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(sum(delta), 0)::integer FROM credit_ledger
  WHERE subject_type = p_subject_type AND subject_id = p_subject_id
$$;

CREATE OR REPLACE FUNCTION public.credits_spend(p_subject_type text, p_subject_id text, p_amount integer,
                                                p_reason text, p_ref_type text DEFAULT NULL, p_ref_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.entitlement_subject_actor(p_subject_type, p_subject_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'A positive amount and a reason are required' USING ERRCODE = 'check_violation';
  END IF;
  -- one spend at a time per subject, so two at once can't both pass the balance check
  PERFORM pg_advisory_xact_lock(hashtextextended('credits:' || p_subject_type || ':' || p_subject_id, 0));
  SELECT coalesce(sum(delta), 0) INTO v_balance FROM credit_ledger
  WHERE subject_type = p_subject_type AND subject_id = p_subject_id;
  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'credits_insufficient: balance %, needed %', v_balance, p_amount USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO credit_ledger (subject_type, subject_id, delta, reason, ref_type, ref_id, created_by)
  VALUES (p_subject_type, p_subject_id, -p_amount, p_reason, p_ref_type, p_ref_id, auth.uid());
  RETURN v_balance - p_amount;
END;
$$;
REVOKE ALL ON FUNCTION public.credits_spend(text, text, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credits_spend(text, text, integer, text, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. A page's plan, exceptions and credits are part of its history.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entitlement_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb := to_jsonb(coalesce(NEW, OLD));
BEGIN
  IF v_row ->> 'subject_type' = 'company' THEN
    INSERT INTO company_audit_log (company_id, actor_id, action, details)
    VALUES ((v_row ->> 'subject_id')::integer, auth.uid(),
            CASE TG_TABLE_NAME WHEN 'subscriptions' THEN 'plan' WHEN 'entitlement_overrides' THEN 'exception' ELSE 'credits' END
              || '_' || lower(TG_OP),
            jsonb_strip_nulls(v_row - ARRAY['id', 'subject_type', 'subject_id', 'created_by', 'created_at', 'updated_at']));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.entitlement_audit() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_subscriptions_audit ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_audit AFTER INSERT OR UPDATE OR DELETE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.entitlement_audit();
DROP TRIGGER IF EXISTS trg_entitlement_overrides_audit ON public.entitlement_overrides;
CREATE TRIGGER trg_entitlement_overrides_audit AFTER INSERT OR UPDATE OR DELETE ON public.entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.entitlement_audit();
DROP TRIGGER IF EXISTS trg_credit_ledger_audit ON public.credit_ledger;
CREATE TRIGGER trg_credit_ledger_audit AFTER INSERT ON public.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.entitlement_audit();

-- ------------------------------------------------------------
-- 6. Today's catalogue: every feature, and the free plan that includes them all.
--    Existing rows are left as they are, so re-running never undoes an admin's change.
-- ------------------------------------------------------------
INSERT INTO public.features (key, kind, period, unit, description) VALUES
  ('page.admins.max',               'limit',   NULL,    'managers',    'How many managers a page may have'),
  ('page.verified_badge',           'boolean', NULL,    NULL,          'The page may carry the verified badge'),
  ('page.follow_invites.monthly',   'metered', 'month', 'invitations', 'Invitations to follow the page, per month'),
  ('posts.as_company',              'boolean', NULL,    NULL,          'Publish posts in the page''s name'),
  ('posts.scheduled',               'boolean', NULL,    NULL,          'Schedule the page''s posts'),
  ('comments.as_company',           'boolean', NULL,    NULL,          'Comment and react in the page''s name'),
  ('articles.as_company',           'boolean', NULL,    NULL,          'Publish articles in the page''s name'),
  ('reviews.respond',               'boolean', NULL,    NULL,          'Reply officially to reviews, interview reports and fit ratings'),
  ('jobs.active.max',               'limit',   NULL,    'jobs',        'How many jobs may be open at once'),
  ('jobs.internal_applications',    'boolean', NULL,    NULL,          'Receive applications inside Duallin'),
  ('jobs.featured',                 'boolean', NULL,    NULL,          'Feature a job on the careers board'),
  ('analytics.basic',               'boolean', NULL,    NULL,          'Page views, followers and post reach'),
  ('analytics.advanced',            'boolean', NULL,    NULL,          'Breakdowns and comparisons'),
  ('talent.search',                 'boolean', NULL,    NULL,          'Search the community for candidates'),
  ('promotions.enabled',            'boolean', NULL,    NULL,          'Run sponsored promotions')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plans (key, name, subject_type, is_default, sort_order)
VALUES ('free', 'Free', 'company', true, 0)
ON CONFLICT (key) DO NOTHING;

-- Everything on, nothing limited — except invitations to follow, which are capped so a page
-- can't flood members (100 a month; change the row to change the cap).
INSERT INTO public.plan_features (plan_key, feature_key, enabled, limit_value)
SELECT 'free', f.key, true, CASE f.key WHEN 'page.follow_invites.monthly' THEN 100 END
FROM public.features f
ON CONFLICT (plan_key, feature_key) DO NOTHING;

-- ------------------------------------------------------------
-- Checks (test rows are undone; a failure undoes the whole migration)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_problems text := '';
  v_company integer; v_cid text; v_a uuid; v_a_email text; v_b uuid; v_b_email text;
  v_n bigint; v_ok boolean; v_limit integer; v_src text; v_left integer; v_features bigint;
BEGIN
  SELECT count(*) INTO v_features FROM features;
  IF (SELECT count(*) FROM plan_features WHERE plan_key = 'free' AND enabled) <> v_features THEN
    v_problems := v_problems || ' the free plan does not include every feature;';
  END IF;

  SELECT id INTO v_company FROM companies c WHERE name IS NOT NULL AND owner_uuid IS NULL AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.company_id = c.id) ORDER BY id LIMIT 1;
  v_cid := v_company::text;
  SELECT uuid, email INTO v_a, v_a_email FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;
  SELECT uuid, email INTO v_b, v_b_email FROM users u WHERE status = 'Active' AND email NOT LIKE 'deleted_%' AND uuid <> v_a AND NOT EXISTS (SELECT 1 FROM company_admins a WHERE a.user_id = u.uuid) ORDER BY uuid LIMIT 1;

  BEGIN
    -- A manages the page (as a claim approval will make her); B is an ordinary member
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO company_admins (company_id, user_id, role) VALUES (v_company, v_a, 'owner');

    -- ===== B, an ordinary member =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- 1. reads the catalogue
    SELECT count(*) INTO v_n FROM plan_features;
    IF v_n < v_features THEN v_problems := v_problems || ' a member cannot read the catalogue;'; END IF;
    -- 2. with no subscription, a page is on the free plan: everything on
    SELECT enabled, source INTO v_ok, v_src FROM entitlement_value('company', v_cid, 'jobs.featured');
    IF v_ok IS NOT TRUE OR v_src <> 'default:free' THEN v_problems := v_problems || format(' free plan not applied (%s, %s);', v_ok, v_src); END IF;
    SELECT enabled INTO v_ok FROM entitlement_value('company', v_cid, 'no.such_feature');
    IF v_ok IS NOT FALSE THEN v_problems := v_problems || ' an unknown feature is not off;'; END IF;
    -- 3. cannot change the catalogue or give a page anything
    UPDATE plan_features SET enabled = false WHERE plan_key = 'free';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN v_problems := v_problems || ' a member changed the free plan;'; END IF;
    BEGIN
      INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled) VALUES ('company', v_cid, 'jobs.featured', true);
      v_problems := v_problems || ' a member gave a page an exception;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES ('company', v_cid, 100, 'self');
      v_problems := v_problems || ' a member granted credits;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- 4. cannot see or use up a page she doesn't manage
    BEGIN
      PERFORM * FROM entitlements_for('company', v_cid);
      v_problems := v_problems || ' a member read another page''s entitlements;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM entitlement_consume('company', v_cid, 'page.follow_invites.monthly');
      v_problems := v_problems || ' a member used up another page''s quota;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- ===== a Duallin admin, in her own session =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_b, 'email', v_b_email, 'role', 'authenticated', 'app_metadata', json_build_object('is_admin', true))::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      -- 5. an exception turns a feature off; once expired it no longer counts
      INSERT INTO entitlement_overrides (subject_type, subject_id, feature_key, enabled, reason) VALUES ('company', v_cid, 'jobs.featured', false, 'check');
      SELECT enabled, source INTO v_ok, v_src FROM entitlement_value('company', v_cid, 'jobs.featured');
      IF v_ok IS NOT FALSE OR v_src <> 'override' THEN v_problems := v_problems || ' an exception did not win over the plan;'; END IF;
      UPDATE entitlement_overrides SET expires_at = now() - interval '1 minute' WHERE subject_type = 'company' AND subject_id = v_cid;
      SELECT enabled INTO v_ok FROM entitlement_value('company', v_cid, 'jobs.featured');
      IF v_ok IS NOT TRUE THEN v_problems := v_problems || ' an expired exception still applies;'; END IF;
      -- 6. a paid plan: its limits apply, and what it leaves out is off — not inherited from free
      INSERT INTO plans (key, name, subject_type) VALUES ('check_plan', 'Check', 'company');
      INSERT INTO plan_features (plan_key, feature_key, enabled, limit_value) VALUES ('check_plan', 'jobs.active.max', true, 3), ('check_plan', 'page.follow_invites.monthly', true, 2);
      INSERT INTO subscriptions (subject_type, subject_id, plan_key) VALUES ('company', v_cid, 'check_plan');
      SELECT enabled, limit_value, source INTO v_ok, v_limit, v_src FROM entitlement_value('company', v_cid, 'jobs.active.max');
      IF v_ok IS NOT TRUE OR v_limit IS DISTINCT FROM 3 OR v_src <> 'plan:check_plan' THEN v_problems := v_problems || ' the subscribed plan''s limit was not applied;'; END IF;
      SELECT enabled INTO v_ok FROM entitlement_value('company', v_cid, 'talent.search');
      IF v_ok IS NOT FALSE THEN v_problems := v_problems || ' a feature missing from the subscribed plan is on;'; END IF;
      -- 7. one live plan per page
      BEGIN
        INSERT INTO subscriptions (subject_type, subject_id, plan_key) VALUES ('company', v_cid, 'free');
        v_problems := v_problems || ' a page got two live subscriptions;';
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
      -- 8. credits granted
      INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES ('company', v_cid, 5, 'check grant');
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' an admin action failed: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    -- ===== A, the page's owner =====
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'email', v_a_email, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      -- 9. sees her page's plan, usage and credits
      SELECT count(*) INTO v_n FROM subscriptions WHERE subject_type = 'company' AND subject_id = v_cid;
      IF v_n <> 1 THEN v_problems := v_problems || ' a manager cannot see her page''s plan;'; END IF;
      SELECT count(*) INTO v_n FROM entitlements_for('company', v_cid);
      IF v_n <> v_features THEN v_problems := v_problems || format(' the full list has %s features, expected %s;', v_n, v_features); END IF;
      -- 10. metered: two invitations allowed, the third refused and not counted
      v_left := entitlement_consume('company', v_cid, 'page.follow_invites.monthly');
      v_left := entitlement_consume('company', v_cid, 'page.follow_invites.monthly');
      IF v_left IS DISTINCT FROM 0 THEN v_problems := v_problems || format(' %s invitations left after using 2 of 2;', v_left); END IF;
      BEGIN
        PERFORM entitlement_consume('company', v_cid, 'page.follow_invites.monthly');
        v_problems := v_problems || ' the limit was passed;';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
      END;
      SELECT used INTO v_n FROM entitlements_for('company', v_cid) WHERE feature_key = 'page.follow_invites.monthly';
      IF v_n <> 2 THEN v_problems := v_problems || format(' usage shows %s, expected 2;', v_n); END IF;
      -- 11. only metered features are counted
      BEGIN
        PERFORM entitlement_consume('company', v_cid, 'jobs.featured');
        v_problems := v_problems || ' a non-metered feature was consumed;';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      -- 12. credits: spends 3 of 5, cannot spend 3 more, cannot grant herself any
      v_left := credits_spend('company', v_cid, 3, 'check spend', 'job', '1');
      IF v_left <> 2 OR credit_balance('company', v_cid) <> 2 THEN v_problems := v_problems || ' credit balance is wrong after spending;'; END IF;
      BEGIN
        PERFORM credits_spend('company', v_cid, 3, 'check spend');
        v_problems := v_problems || ' more credits were spent than the balance;';
      EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
      END;
      BEGIN
        INSERT INTO credit_ledger (subject_type, subject_id, delta, reason) VALUES ('company', v_cid, 100, 'self');
        v_problems := v_problems || ' a manager granted her page credits;';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
      -- 13. the plan, the exception and the credits are in the page's history
      SELECT count(DISTINCT action) INTO v_n FROM company_audit_log
      WHERE company_id = v_company AND action IN ('plan_insert', 'exception_insert', 'exception_update', 'credits_insert');
      IF v_n <> 4 THEN v_problems := v_problems || format(' history has %s of the 4 expected kinds of lines;', v_n); END IF;
    EXCEPTION WHEN OTHERS THEN v_problems := v_problems || ' a manager action failed: ' || SQLERRM || ';';
    END;
    RESET ROLE;

    -- ===== signed-out visitor =====
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM 1 FROM plans LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read the plans;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM 1 FROM subscriptions LIMIT 1;
      v_problems := v_problems || ' signed-out visitors can read subscriptions;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM * FROM entitlement_value('company', v_cid, 'jobs.featured');
      v_problems := v_problems || ' signed-out visitors can ask about entitlements;';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'undo the test rows';
  EXCEPTION
    WHEN SQLSTATE 'P0002' THEN RESET ROLE;   -- every test row above is undone here
    WHEN OTHERS THEN RESET ROLE; v_problems := v_problems || ' a check stopped unexpectedly: ' || SQLERRM || ';';
  END;
  PERFORM set_config('request.jwt.claims', '', true);

  IF EXISTS (SELECT 1 FROM plans WHERE key = 'check_plan') OR EXISTS (SELECT 1 FROM credit_ledger WHERE reason LIKE 'check %') THEN
    v_problems := v_problems || ' test rows were left behind;';
  END IF;

  IF v_problems <> '' THEN
    RAISE EXCEPTION 'NOTHING WAS CHANGED — a check failed:%', v_problems;
  END IF;
  RAISE NOTICE 'All checks passed: % features, all included in the free plan; exceptions, plans, limits and credits enforced; signed-out blocked.', v_features;
END $$;

COMMIT;

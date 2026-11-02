-- ============================================================
-- People search for the inner-circle page ("המעגל הפנימי").
-- Run in Supabase SQL Editor.
--
-- LinkedIn-style search over members: free text (name, title, skills,
-- companies, education...), job-function chips (QA, data, product...),
-- company filter (current / past), recruiters-only and has-mutuals.
--
-- Design:
--   * people_search_index — one precomputed row per searchable member,
--     maintained by a trigger on users. Searching never parses the
--     experience jsonb at query time.
--   * job_function_terms — the field mapping (Hebrew + English synonyms).
--     A member's job_functions are inferred from headline + current titles
--     (like LinkedIn's "Job Function"), falling back to skills. Editing
--     this table rebuilds the index automatically.
--   * Privacy: anonymous / deleted / feed_participant members are NEVER
--     indexed — public_users_view masks all their text fields, so they must
--     not be findable by them either. Last names are indexed only when
--     privacy_lastname is NULL (visible to everyone in the view).
-- ============================================================

-- ------------------------------------------------------------
-- 0. Re-runs: pause the auto-rebuild triggers while this script redefines
--    the functions they call. Otherwise seeding the tables below fires a
--    rebuild through the PREVIOUS function versions mid-script (and their
--    cached plans). Recreated in section 4; one rebuild runs at the end.
-- ------------------------------------------------------------
DO $$
BEGIN
  -- Encoding guard: this file is full of Hebrew. If it reached the SQL editor
  -- through a non-UTF-8 copy, Hebrew turns into "◊û◊©..." and would be stored
  -- that way. Stop before changing anything. (Written with chr() so the check
  -- itself survives a bad copy: chr(1488) = א.)
  IF 'א' <> chr(1488) THEN
    RAISE EXCEPTION 'people search migration: Hebrew text is garbled (file copied with the wrong encoding). Nothing was changed - paste the file again as UTF-8.';
  END IF;

  IF to_regclass('public.job_function_terms') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_people_search_terms ON public.job_function_terms;
    -- Rows stored by an earlier garbled run: every real term is plain ASCII or
    -- contains Hebrew letters (chr(1488)-chr(1514) = א-ת); garbled Hebrew is
    -- neither ("û©®ì..."). Built with chr() so it survives a bad copy too.
    DELETE FROM public.job_function_terms
    WHERE term ~ '[^[:ascii:]]' AND term !~ ('[' || chr(1488) || '-' || chr(1514) || ']');
  END IF;
  IF to_regclass('public.company_aliases') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_people_search_company_aliases ON public.company_aliases;
    DELETE FROM public.company_aliases
    WHERE (alias ~ '[^[:ascii:]]' AND alias !~ ('[' || chr(1488) || '-' || chr(1514) || ']'))
       OR (canonical ~ '[^[:ascii:]]' AND canonical !~ ('[' || chr(1488) || '-' || chr(1514) || ']'));
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Text helpers
-- ------------------------------------------------------------

-- Lowercase, drop quote marks (מנכ"ל → מנכל, ג'וניור → גוניור), turn
-- separators into spaces (front-end → front end, ci/cd → ci cd). Keeps
-- . # + so c#, c++, node.js, .net survive.
CREATE OR REPLACE FUNCTION people_search_normalize(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(lower(COALESCE(p, '')), '״׳"''`’‘“”', ''),
      '[-_/\\|,;:()\[\]{}<>!?*~^=@&•·–—־]+', ' ', 'g'),
    '\s+', ' ', 'g'));
$$;

-- Company identity key — same idea as normalizeCompanyName in routes/admin.ts:
-- strip domains, legal suffixes and punctuation so "Wix.com Ltd", "wix.com"
-- and "Wix" all collide.
CREATE OR REPLACE FUNCTION people_search_company_key(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(COALESCE(p, ''))),
          '\.(com|co\.il|org\.il|io|ai|net|org|co)\M', '', 'g'),
        '\m(inc|ltd|llc|co|corp|gmbh|bv|sa|plc|israel)\M', '', 'g'),
      '(בע"מ|בע״מ|בעמ|\sישראל)\s*$', '', 'g'),
    '[^a-z0-9א-ת]', '', 'g');
$$;

CREATE OR REPLACE FUNCTION people_search_regex_escape(p TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(p, '([^[:alnum:][:space:]])', '\\\1', 'g');
$$;

-- Does p_term occur in p_hay?
--   contains — plain substring. Default for Hebrew: one stem covers the
--              ה/ו/ב/ל/ש prefixes and gender/plural forms (מפתח → מפתחת, מפתחים).
--   prefix   — starts at a word boundary (developer → developers).
--   word     — whole word only (qa, bi, ux, java ≠ javascript).
-- The strpos pre-check keeps the regex off the hot path.
CREATE OR REPLACE FUNCTION people_search_term_matches(p_hay TEXT, p_term TEXT, p_mode TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT strpos(p_hay, p_term) > 0 AND CASE p_mode
    WHEN 'contains' THEN TRUE
    WHEN 'word' THEN p_hay ~ ('(^|[^[:alnum:]])' || people_search_regex_escape(p_term) || '($|[^[:alnum:]])')
    ELSE p_hay ~ ('(^|[^[:alnum:]])' || people_search_regex_escape(p_term))
  END;
$$;

CREATE OR REPLACE FUNCTION people_search_contains_all(p_hay TEXT, p_tokens TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM unnest(p_tokens) t WHERE strpos(p_hay, t) = 0);
$$;

-- All string leaves of a jsonb document (education / certifications / projects).
CREATE OR REPLACE FUNCTION people_search_jsonb_strings(p JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(string_agg(v #>> '{}', ' '), '')
  FROM jsonb_path_query(COALESCE(p, 'null'::jsonb), 'strict $.**') AS v
  WHERE jsonb_typeof(v) = 'string';
$$;

-- ------------------------------------------------------------
-- 2. Job-function mapping
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_function_terms (
  function_key TEXT NOT NULL,
  term         TEXT NOT NULL,   -- stored normalized (people_search_normalize)
  mode         TEXT NOT NULL CHECK (mode IN ('contains', 'prefix', 'word')),
  PRIMARY KEY (function_key, term)
);

ALTER TABLE job_function_terms ENABLE ROW LEVEL SECURITY;

-- Seed. One row per field; terms are normalized on insert, so write them the
-- way people do (quotes, hyphens, geresh are fine: ג'וניור = גוניור, front-end
-- = front end). Hebrew terms match as substrings, so one stem covers gender,
-- plural and ה/ו/ב/ל/ש prefixes (מפתח → מפתחת, המפתחים). Include both full and
-- defective spelling (תוכנה/תכנה, פרויקט/פרוייקט) and Hebrew transliterations
-- of English titles (דבלופר, טסטרית, פרודקט).
-- mode is automatic: Hebrew → contains; Latin ≤ 4 chars → word (qa, bi, java);
-- longer Latin → prefix (developer → developers); leading '.' → contains.
-- Exceptions where the automatic mode would over-match are in seed_modes.
WITH seed(function_key, terms) AS (VALUES
  -- פיתוח תוכנה (anyone who writes code; specializations also imply it)
  ('software_dev', ARRAY[
    'developer', 'software engineer', 'software developer', 'software development', 'software engineering',
    'programmer', 'programming', 'coder', 'coding', 'sw engineer', 'sw developer', 'swe', 'dev',
    'r&d engineer', 'application developer', 'applications developer', 'c++', 'rpa',
    'מפתח', 'מתכנת', 'תכנות', 'תיכנות', 'פיתוח תוכנה', 'פיתוח תכנה', 'הנדסת תוכנה', 'הנדסת תכנה',
    'מהנדסת תוכנה', 'מהנדס תוכנה', 'מהנדסת תכנה', 'הנדסאית תוכנה', 'הנדסאי תוכנה', 'דבלופר', 'דיבלופר',
    'פיתוח מערכות', 'תוכניתנ', 'תכניתנ', 'מתכנתת',
    -- frequent misspellings seen in real profiles
    'programer', 'developper', 'develop', 'softwear', 'softwer', 'sofware', 'software engeneer',
    'software engenier', 'software engnieer', 'software enginner', 'software engeener', 'software enginer',
    'software architect', 'solution architect', 'solutions architect', 'system architect',
    'computer science', 'ארכיטקט תוכנה', 'ארכיטקטית תוכנה', 'ארכיטקט מערכות', 'ארכיטקטית מערכות',
    'מדעי המחשב']),

  ('frontend', ARRAY[
    'frontend', 'front end', 'react', 'react.js', 'reactjs', 'angular', 'angularjs', 'vue', 'vue.js', 'vuejs',
    'next.js', 'nextjs', 'svelte', 'web developer', 'web development', 'ui developer', 'javascript', 'js',
    'typescript', 'html', 'css', 'sass', 'tailwind', 'jquery', 'wordpress', 'webflow',
    'פרונט', 'צד לקוח', 'מפתחת ווב', 'פיתוח ווב', 'פיתוח אתרים', 'בניית אתרים', 'בונת אתרים', 'בונה אתרים',
    'וורדפרס', 'ורדפרס', 'ריאקט', 'אנגולר', 'ג''אווהסקריפט', 'ג''אווה סקריפט', 'גאווהסקריפט', 'טייפסקריפט']),

  ('backend', ARRAY[
    'backend', 'back end', 'server side', 'node.js', 'nodejs', 'node', 'java', 'spring', 'spring boot',
    '.net', 'dotnet', 'asp.net', 'c#', 'python', 'django', 'flask', 'fastapi', 'golang', 'go developer',
    'php', 'laravel', 'ruby', 'rails', 'scala', 'microservices', 'api development', 'rest api', 'graphql',
    'mongodb', 'abap', 'cobol', 'rpg', 'mainframe', 'as400', 'as/400',
    'בקאנד', 'בק אנד', 'בקנד', 'צד שרת', 'פייתון', 'פיתון', 'דוט נט', 'סי שארפ', 'קובול', 'מיינפריים']),

  ('fullstack', ARRAY[
    'fullstack', 'full stack', 'mern', 'mean stack', 'fall stack', 'full stak', 'fullstak', 'ful stack',
    'פולסטאק', 'פול סטאק', 'פולסטק', 'פול סטק']),

  ('mobile', ARRAY[
    'mobile', 'android', 'ios', 'swift', 'swiftui', 'kotlin', 'flutter', 'react native', 'xamarin', 'ionic',
    'app developer', 'מובייל', 'אנדרואיד', 'אפליקציות', 'פיתוח אפליקציות']),

  ('qa', ARRAY[
    'qa', 'q.a', 'quality assurance', 'quality engineer', 'qa engineer', 'qa automation', 'test engineer',
    'test automation', 'testing', 'tester', 'sdet', 'automation engineer', 'automation developer',
    'automation tester', 'manual qa', 'manual testing', 'selenium', 'playwright', 'cypress', 'appium',
    'jmeter', 'postman', 'qc', 'istqb', 'api testing', 'load testing', 'performance testing', 'automation',
    'בודק', 'בדיקות', 'בדיקות תוכנה', 'הבטחת איכות', 'אבטחת איכות', 'איכות תוכנה', 'אוטומציה',
    'אוטומציית בדיקות', 'קיו איי', 'קיואיי', 'טסטר', 'טסטינג', 'אוטומיישן', 'בדיקות ידניות',
    'בדיקות אוטומטיות']),

  ('data', ARRAY[
    'data', 'data analyst', 'data analysis', 'data analytics', 'data scientist', 'data science',
    'data engineer', 'data engineering', 'data warehouse', 'dwh', 'bi', 'b.i', 'bi developer',
    'business intelligence', 'analytics', 'sql', 't-sql', 'pl/sql', 'power bi', 'powerbi', 'tableau',
    'looker', 'qlik', 'qlikview', 'ssis', 'ssrs', 'etl', 'big data', 'spark', 'hadoop', 'snowflake',
    'databricks', 'dba', 'database', 'statistics', 'statistician', 'pandas',
    'דאטה', 'דטה', 'ניתוח נתונים', 'ניתוח דאטה', 'אנליסטית נתונים', 'אנליסט נתונים', 'אנליסטית דאטה',
    'דאטה אנליסט', 'מדעית נתונים', 'מדען נתונים', 'מדעני נתונים', 'הנדסת נתונים', 'מהנדסת נתונים',
    'בינה עסקית', 'ביג דאטה', 'סטטיסטיק', 'מסדי נתונים', 'בסיסי נתונים', 'אנליטיקה']),

  ('ai_ml', ARRAY[
    'machine learning', 'ml', 'mlops', 'ml engineer', 'deep learning', 'ai', 'a.i', 'artificial intelligence',
    'nlp', 'computer vision', 'llm', 'llms', 'genai', 'gen ai', 'generative ai', 'data scientist', 'pytorch',
    'tensorflow', 'keras', 'scikit', 'prompt engineer', 'prompt engineering', 'algorithm', 'ai engineer',
    'ai developer', 'langchain',
    'אלגוריתם', 'אלגוריתמיקאי', 'בינה מלאכותית', 'למידת מכונה', 'למידה עמוקה', 'ראייה ממוחשבת',
    'ראיה ממוחשבת', 'עיבוד שפה טבעית']),

  ('devops', ARRAY[
    'devops', 'dev ops', 'devsecops', 'sre', 'site reliability', 'cloud', 'aws', 'amazon web services',
    'azure', 'gcp', 'google cloud', 'kubernetes', 'k8s', 'docker', 'terraform', 'ci/cd', 'cicd', 'jenkins',
    'gitlab ci', 'ansible', 'helm', 'infrastructure', 'platform engineer', 'linux', 'unix', 'finops',
    'דבאופס', 'דב אופס', 'ענן', 'מחשוב ענן', 'תשתיות', 'לינוקס', 'קוברנטיס']),

  ('cyber', ARRAY[
    'cyber', 'cybersecurity', 'security', 'information security', 'infosec', 'appsec', 'application security',
    'soc', 'soc analyst', 'pentest', 'pen test', 'penetration', 'red team', 'blue team', 'ciso', 'grc',
    'siem', 'vulnerability', 'malware', 'threat intelligence', 'incident response', 'cissp', 'ceh',
    'סייבר', 'אבטחת מידע', 'אבטחת סייבר', 'הגנת סייבר', 'אבטחת מערכות', 'בודקת חוסן', 'בדיקות חדירות',
    'בדיקות חדירה', 'מבדקי חדירה']),

  ('it', ARRAY[
    'it manager', 'it support', 'it specialist', 'it administrator', 'it technician', 'it team', 'head of it',
    'it project', 'it operations', 'system administrator', 'systems administrator', 'sysadmin',
    'system engineer', 'systems engineer', 'helpdesk', 'help desk', 'service desk', 'technical support',
    'tech support', 'desktop support', 'network engineer', 'network administrator', 'networking', 'noc',
    'crm', 'erp', 'sap', 'salesforce', 'office 365', 'microsoft 365', 'active directory', 'ccna', 'mcsa',
    'מערכות מידע', 'תמיכה טכנית', 'תמיכת משתמשים', 'מחשוב', 'הלפדסק', 'סיסטם', 'רשתות תקשורת',
    'תקשורת נתונים', 'מנהלת רשת', 'מנהל רשת', 'מנמ"ר', 'פריוריטי', 'טכנאית מחשבים', 'טכנאי מחשבים',
    'אחראית מחשוב', 'אחראי מחשוב', 'מיישמ', 'יישום מערכות', 'הטמעת מערכות', 'system implementation',
    'implementer', 'implementation specialist', 'implementation consultant']),

  ('system_analysis', ARRAY[
    'system analyst', 'systems analyst', 'business analyst', 'business analysis', 'functional analyst',
    'requirements', 'process analyst',
    'מנתחת מערכות', 'מנתח מערכות', 'ניתוח מערכות', 'אנליסטית מערכות', 'אנליסט מערכות', 'אפיון',
    'מאפיינת', 'מאפיין', 'כתיבת אפיונים', 'ניתוח תהליכים', 'מנתחת תהליכים', 'ביזנס אנליסט']),

  ('hardware', ARRAY[
    'embedded', 'firmware', 'hardware', 'fpga', 'asic', 'vlsi', 'verilog', 'vhdl', 'verification engineer',
    'design verification', 'chip design', 'electrical engineer', 'electronics', 'electronic engineer', 'pcb',
    'rtos', 'board design', 'iot', 'microcontroller', 'plc', 'robotics', 'hardwer', 'hw', 'hw engineer',
    'validation', 'silicon', 'post silicon', 'pre silicon', 'dft', 'physical design', 'asic design',
    'חומרה', 'אלקטרוניקה', 'הנדסת חשמל', 'מהנדסת חשמל', 'מהנדס חשמל', 'הנדסאית חשמל',
    'הנדסאית אלקטרוניקה', 'משובצ', 'שבבים', 'קושחה', 'רובוטיקה', 'בקרים', 'תכן לוגי', 'אימות שבבים',
    'ולידציה', 'הנדסת אלקטרוניקה']),

  ('ux_ui', ARRAY[
    'ux', 'ui', 'user experience', 'user interface', 'product designer', 'ux designer', 'ui designer',
    'designer', 'graphic design', 'graphic designer', 'web design', 'web designer', 'interaction design',
    'visual design', 'figma', 'adobe xd', 'ux writer', 'ux writing', 'ux research', 'usability', 'uxui', 'uiux',
    'עיצוב', 'מעצב', 'חוויית משתמש', 'חווית משתמש', 'ממשק משתמש', 'ממשקי משתמש', 'אפיון ממשק',
    'אפיון חווי', 'גרפיקה', 'גרפיקאי', 'עיצוב גרפי', 'יו אקס', 'יואקס', 'יו איי', 'מחקר משתמשים',
    'פיגמה']),

  ('product', ARRAY[
    'product manager', 'product management', 'product owner', 'product lead', 'head of product',
    'vp product', 'director of product', 'cpo', 'pm', 'apm', 'product analyst',
    'מנהלת מוצר', 'מנהל מוצר', 'ניהול מוצר', 'מנהלות מוצר', 'פרודקט', 'אחראית מוצר']),

  ('project_management', ARRAY[
    'project manager', 'project management', 'program manager', 'programme manager', 'project coordinator',
    'scrum master', 'pmo', 'pmp', 'delivery manager', 'agile coach', 'release manager',
    'implementation manager',
    'ניהול פרויקט', 'ניהול פרוייקט', 'מנהלת פרויקט', 'מנהלת פרוייקט', 'מנהל פרויקט', 'מנהל פרוייקט',
    'רכזת פרויקט', 'רכזת פרוייקט', 'רכז פרויקט', 'סקראם', 'סקרם', 'פרויקטור', 'פרוייקטור',
    'מנהלת הטמעה', 'מנהלת יישום']),

  ('tech_writing', ARRAY[
    'technical writer', 'technical writing', 'tech writer', 'documentation', 'technical documentation',
    'api documentation',
    'כתיבה טכנית', 'כותבת טכנית', 'כותב טכני', 'תיעוד', 'תיעוד טכני', 'כתיבת מדריכים',
    'כותבת תוכן טכני']),

  ('marketing', ARRAY[
    'marketing', 'digital marketing', 'performance marketing', 'product marketing', 'ppc', 'seo', 'sem',
    'aso', 'content writer', 'content manager', 'content marketing', 'content creator', 'copywriter',
    'copywriting', 'social media', 'community manager', 'growth', 'brand', 'campaign', 'pr',
    'public relations', 'email marketing', 'affiliate', 'media buyer', 'media buying', 'google ads',
    'facebook ads',
    'שיווק', 'משווק', 'תוכן', 'כותבת תוכן', 'קופירייט', 'סושיאל', 'רשתות חברתיות', 'מדיה חברתית',
    'קמפיינ', 'מיתוג', 'דוברות', 'דוברת', 'יחסי ציבור', 'קידום אתרים', 'קידום ממומן', 'קידום דיגיטלי',
    'ניהול קהילה', 'מנהלת קהילה', 'פרסום', 'מדיה', 'content editor', 'editor', 'digital manager',
    'עורכת', 'עריכת תוכן']),

  ('sales_cs', ARRAY[
    'sales', 'sales manager', 'account manager', 'account executive', 'key account', 'customer success',
    'csm', 'business development', 'bizdev', 'presales', 'pre sales', 'sales engineer', 'solutions engineer',
    'sdr', 'bdr', 'customer support', 'customer service', 'customer experience', 'cx', 'client success',
    'inside sales',
    'מכירות', 'אשת מכירות', 'נציגת מכירות', 'נציגת שירות', 'נציג שירות', 'הצלחת לקוח', 'פיתוח עסקי',
    'שירות לקוחות', 'תמיכת לקוחות', 'מנהלת לקוחות', 'תיקי לקוחות', 'טלמרקטינג', 'מוקדנ',
    'קשרי לקוחות']),

  ('hr', ARRAY[
    'hr', 'h.r', 'human resources', 'recruiter', 'recruiting', 'recruitment', 'talent acquisition',
    'talent manager', 'sourcer', 'sourcing', 'people partner', 'hrbp', 'people operations',
    'people & culture', 'employer branding', 'hr manager',
    'משאבי אנוש', 'מש"א', 'גיוס', 'מגייס', 'השמה', 'רכזת גיוס', 'רכז גיוס', 'פיתוח ארגוני',
    'יועצת ארגונית', 'רווחת עובדים', 'חוויית עובד', 'הון אנושי', 'career coach', 'career counselor',
    'career consultant', 'יועצת תעסוקתית', 'יועץ תעסוקתי', 'ייעוץ תעסוקתי', 'הכוונה תעסוקתית',
    'מאבחנת תעסוקתית', 'מציאת עבודה', 'השמת עובדים']),

  ('finance', ARRAY[
    'finance', 'financial', 'accountant', 'accounting', 'bookkeep', 'controller', 'cfo', 'payroll',
    'economist', 'auditor', 'treasury', 'financial analyst', 'cpa', 'banker', 'banking', 'mortgage',
    'insurance', 'בנקאי', 'משכנתא', 'משכנתאות', 'ביטוח',
    'כספים', 'פיננס', 'חשבונאות', 'רואת חשבון', 'רואה חשבון', 'רו"ח', 'הנהלת חשבונות',
    'מנהלת חשבונות', 'מנהל חשבונות', 'חשבת', 'חשב שכר', 'כלכלנ', 'שכר', 'ביקורת פנים', 'מבקרת פנים',
    'גזבר', 'בקרה תקציבית', 'תקציבים', 'מיסים']),

  ('operations', ARRAY[
    'operations', 'office manager', 'office administrator', 'administrative', 'administration',
    'executive assistant', 'personal assistant', 'admin assistant', 'back office', 'procurement',
    'purchasing', 'logistics', 'supply chain', 'facility',
    'תפעול', 'מנהלת משרד', 'מנהלת משרדים', 'אדמיניסטר', 'מזכיר', 'עוזרת אישית', 'עוזרת מנכ"ל', 'רכש',
    'לוגיסטיקה', 'שרשרת אספקה', 'בק אופיס', 'בקאופיס', 'מנהלה', 'מנהלנ', 'פקידה', 'אחזקה']),

  ('management', ARRAY[
    'team lead', 'team leader', 'tech lead', 'technical lead', 'group manager', 'group leader',
    'engineering manager', 'r&d manager', 'rnd manager', 'director', 'vp', 'cto', 'ceo', 'coo', 'cio',
    'head of', 'founder', 'co founder', 'cofounder', 'entrepreneur', 'general manager',
    'managing director', 'chief', 'division manager', 'department manager', 'innovation lead',
    'ראש צוות', 'ראשת צוות', 'מנהלת צוות', 'מנהל צוות', 'ראש קבוצה', 'ראשת קבוצה', 'מנהלת קבוצה',
    'מנהלת פיתוח', 'מנהל פיתוח', 'מנהלת מו"פ', 'מנכ"ל', 'סמנכ"ל', 'מנהלת מחלקה', 'מנהל מחלקה',
    'מייסד', 'יזמת', 'יזמות', 'יזם', 'בעלת עסק', 'מנהלת אגף', 'ראש אגף', 'ראש תחום', 'ראשת תחום',
    'מנהלת תחום', 'מנהלת חטיבה', 'מנהל חטיבה']),

  ('education', ARRAY[
    'teacher', 'lecturer', 'trainer', 'instructor', 'tutor', 'mentor', 'coach', 'educator',
    'instructional design', 'e-learning', 'elearning', 'learning and development', 'training manager',
    'מורה', 'מורות', 'מרצה', 'מדריכ', 'הדרכה', 'הוראה', 'חינוך', 'מנטור', 'מאמנת', 'מלמד', 'מתרגל',
    'פיתוח הדרכה', 'לומדה', 'לומדות', 'גננת']),

  ('research', ARRAY[
    'researcher', 'research', 'scientist', 'phd', 'ph.d', 'postdoc', 'research assistant',
    'חוקר', 'מחקר', 'דוקטורנט', 'דוקטורט', 'מדענ', 'עוזרת מחקר']),

  ('entry_level', ARRAY[
    'junior', 'jr', 'entry level', 'intern', 'internship', 'student', 'recent graduate', 'new graduate',
    'fresh graduate', 'career change', 'career changer', 'first job', 'bootcamp', 'trainee', 'apprentice',
    'open to work', 'looking for a job', 'looking for my first', 'looking for a position',
    'ג''וניור', 'לומדת', 'סטודנט', 'בוגרת קורס', 'בוגר קורס', 'בוגרת מסלול', 'בוגרת תוכנית',
    'בוגרת בוטקמפ', 'בוטקמפ', 'הסבה', 'משרה ראשונה', 'עבודה ראשונה', 'ללא ניסיון', 'מחפשת עבודה',
    'מחפשת משרה', 'בחיפוש עבודה', 'בחיפוש משרה', 'מתלמדת', 'סטאז', 'בוגרת סמינר', 'בוגרת מגמת',
    'מגמת תוכנה', 'מגמת הנדסת תוכנה', 'מגמת מחשבים'])
),
-- Where the automatic mode over-matches: whole word only.
seed_modes(function_key, term, mode) AS (VALUES
  ('backend', 'scala', 'word'),      -- not "scalable"
  ('backend', 'spring', 'word'),     -- not "springboard"
  ('mobile', 'swift', 'word'),       -- not "swiftly"
  ('sales_cs', 'sales', 'word'),     -- not "salesforce"
  ('entry_level', 'intern', 'word'), -- not "international"
  ('data', 'spark', 'word'),         -- not "sparkling"
  ('data', 'database', 'word'),
  ('software_dev', 'develop', 'word'), -- not "development" (business development)
  ('hardware', 'validation', 'prefix'),
  ('management', 'chief', 'word'),
  ('management', 'יזם', 'word'),     -- not "מיזם"
  ('hr', 'מש"א', 'word'),            -- not "משאבים", "משאית"
  ('finance', 'רו"ח', 'word')        -- not "רוח"
),
normalized AS (
  SELECT s.function_key, people_search_normalize(t) AS term
  FROM seed s, unnest(s.terms) t
)
INSERT INTO job_function_terms (function_key, term, mode)
SELECT DISTINCT ON (n.function_key, n.term)
  n.function_key,
  n.term,
  COALESCE(m.mode, CASE
    WHEN n.term LIKE '.%' THEN 'contains'
    WHEN n.term ~ '^[a-z0-9 .#+&]+$' AND length(n.term) <= 4 THEN 'word'
    WHEN n.term ~ '^[a-z0-9 .#+&]+$' THEN 'prefix'
    ELSE 'contains'
  END)
FROM normalized n
LEFT JOIN seed_modes m
  ON m.function_key = n.function_key AND people_search_normalize(m.term) = n.term
WHERE n.term <> ''
ON CONFLICT (function_key, term) DO UPDATE SET mode = EXCLUDED.mode;

-- ------------------------------------------------------------
-- 3. The index
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people_search_index (
  user_uuid            UUID PRIMARY KEY,
  role                 TEXT,
  name_text            TEXT   NOT NULL DEFAULT '',   -- first name + public last name
  title_text           TEXT   NOT NULL DEFAULT '',   -- headline + current titles
  skills_text          TEXT   NOT NULL DEFAULT '',
  company_text         TEXT   NOT NULL DEFAULT '',   -- current + past company names
  search_text          TEXT   NOT NULL DEFAULT '',   -- everything searchable
  current_titles       TEXT[] NOT NULL DEFAULT '{}', -- display (match reason)
  skills               TEXT[] NOT NULL DEFAULT '{}', -- display (match reason)
  current_companies    JSONB  NOT NULL DEFAULT '[]', -- [{key, name, id}]
  past_companies       JSONB  NOT NULL DEFAULT '[]',
  current_company_keys TEXT[] NOT NULL DEFAULT '{}',
  past_company_keys    TEXT[] NOT NULL DEFAULT '{}',
  job_functions        TEXT[] NOT NULL DEFAULT '{}',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE people_search_index ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_people_search_functions   ON people_search_index USING GIN (job_functions);
CREATE INDEX IF NOT EXISTS idx_people_search_cur_company ON people_search_index USING GIN (current_company_keys);
CREATE INDEX IF NOT EXISTS idx_people_search_past_company ON people_search_index USING GIN (past_company_keys);
CREATE INDEX IF NOT EXISTS idx_people_search_role        ON people_search_index (role);

-- Resolving a typed company name to a companies row happens per experience
-- entry on every profile save — needs an index on the normalized name.
CREATE INDEX IF NOT EXISTS idx_companies_people_search_key
  ON companies (people_search_company_key(name));

-- ------------------------------------------------------------
-- 3b. Company aliases — Hebrew / English / former names of one workplace
-- ------------------------------------------------------------
-- "אינטל", "Intel Israel" and "Intel" are the same company. canonical is the
-- name shown in the company filter; when it normalizes like a companies row
-- (Wix ≈ "Wix.com Ltd") that row's logo is used. Add a row here whenever the
-- company filter shows one workplace twice. Edits rebuild the index.
-- canonical '' means "not a company" (Freelance, עצמאית...): such entries
-- are dropped from the member's workplaces.
CREATE TABLE IF NOT EXISTS company_aliases (
  alias     TEXT PRIMARY KEY,   -- as people write it
  canonical TEXT NOT NULL
);

-- Normalized keys precomputed once — they're compared on every profile save.
ALTER TABLE company_aliases
  ADD COLUMN IF NOT EXISTS alias_key TEXT GENERATED ALWAYS AS (people_search_company_key(alias)) STORED;
ALTER TABLE company_aliases
  ADD COLUMN IF NOT EXISTS canonical_key TEXT GENERATED ALWAYS AS (people_search_company_key(canonical)) STORED;

ALTER TABLE company_aliases ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_company_aliases_alias_key ON company_aliases (alias_key);
CREATE INDEX IF NOT EXISTS idx_company_aliases_canonical_key2 ON company_aliases (canonical_key);

INSERT INTO company_aliases (alias, canonical)
SELECT a, v.canonical
FROM (VALUES
  ('Intel', ARRAY['אינטל', 'אינטל ישראל']),
  ('Microsoft', ARRAY['מיקרוסופט', 'מייקרוסופט', 'MSFT']),
  ('Google', ARRAY['גוגל', 'Alphabet', 'אלפבית']),
  ('Amazon', ARRAY['אמזון', 'AWS', 'Amazon Web Services']),
  ('Apple', ARRAY['אפל', 'אפל ישראל']),
  ('Meta', ARRAY['מטא', 'Facebook', 'פייסבוק']),
  ('NVIDIA', ARRAY['אנבידיה', 'אנווידיה', 'נבידיה', 'Mellanox', 'מלאנוקס']),
  ('IBM', ARRAY['יבמ', 'אי בי אם', 'איי בי אם']),
  ('Oracle', ARRAY['אורקל']),
  ('Salesforce', ARRAY['סיילספורס']),
  ('Cisco', ARRAY['סיסקו']),
  ('HP', ARRAY['Hewlett Packard', 'Hewlett-Packard', 'HPE', 'Hewlett Packard Enterprise', 'אייץ'' פי']),
  ('Dell', ARRAY['דל', 'Dell EMC', 'EMC']),
  ('Qualcomm', ARRAY['קוואלקום', 'קואלקום']),
  ('Marvell', ARRAY['מרוול']),
  ('Applied Materials', ARRAY['אפלייד', 'אפלייד מטיריאלס', 'אפלייד מטריאלס']),
  ('KLA', ARRAY['KLA-Tencor', 'קיי אל איי']),
  ('Tower Semiconductor', ARRAY['Tower', 'טאואר', 'טאואר סמיקונדקטור']),
  ('Mobileye', ARRAY['מובילאיי', 'מובילאי']),
  ('Check Point', ARRAY['Checkpoint', 'Check Point Software', 'צ''ק פוינט', 'צק פוינט', 'צ''קפוינט']),
  ('CyberArk', ARRAY['סייברארק', 'סייבר ארק']),
  ('Palo Alto Networks', ARRAY['פאלו אלטו', 'פאלו אלטו נטוורקס']),
  ('Wiz', ARRAY['וויז']),
  ('Waze', ARRAY['וייז', 'ווייז']),
  ('Wix', ARRAY['וויקס', 'ויקס', 'Wix.com']),
  ('monday.com', ARRAY['Monday', 'מאנדיי', 'מנדיי', 'מאנדיי דוט קום']),
  ('Fiverr', ARRAY['פייבר', 'פייבר אינטרנשיונל']),
  ('Payoneer', ARRAY['פיוניר', 'פאיוניר']),
  ('Playtika', ARRAY['פלייטיקה']),
  ('eToro', ARRAY['איטורו', 'אי טורו']),
  ('JFrog', ARRAY['ג''יי פרוג', 'גיי פרוג', 'ג''ייפרוג']),
  ('Amdocs', ARRAY['אמדוקס']),
  ('NICE', ARRAY['נייס', 'NICE Systems', 'נייס סיסטמס']),
  ('Sapiens', ARRAY['סאפיינס']),
  ('Magic Software', ARRAY['מג''יק', 'מגיק', 'Magic']),
  ('Formula Systems', ARRAY['פורמולה', 'פורמולה מערכות']),
  ('Matrix', ARRAY['מטריקס', 'Matrix IT', 'מטריקס IT']),
  ('Ness', ARRAY['נס', 'נס טכנולוגיות', 'Ness Technologies']),
  ('Malam Team', ARRAY['מלם תים', 'מלם-תים', 'מלם', 'Malam']),
  ('Hilan', ARRAY['חילן']),
  ('Priority Software', ARRAY['פריוריטי', 'פריוריטי תוכנה']),
  ('Taboola', ARRAY['טאבולה']),
  ('Outbrain', ARRAY['אאוטבריין', 'אווטבריין']),
  ('Similarweb', ARRAY['סימילרווב', 'סימילר ווב']),
  ('Lightricks', ARRAY['לייטריקס']),
  ('Riskified', ARRAY['ריסקיפייד']),
  ('Gong', ARRAY['גונג']),
  ('Kaltura', ARRAY['קלטורה']),
  ('Varonis', ARRAY['ורוניס']),
  ('Imperva', ARRAY['אימפרבה']),
  ('SolarEdge', ARRAY['סולאראדג''', 'סולאר אדג''', 'סולארדג''']),
  ('Lemonade', ARRAY['למונייד']),
  ('Elbit Systems', ARRAY['Elbit', 'אלביט', 'אלביט מערכות']),
  ('Rafael', ARRAY['רפאל', 'Rafael Advanced Defense Systems', 'רפאל מערכות לחימה מתקדמות']),
  ('Israel Aerospace Industries', ARRAY['IAI', 'התעשייה האווירית', 'תעשייה אווירית', 'התעשיה האוירית', 'תע"א']),
  ('Teva', ARRAY['טבע', 'Teva Pharmaceuticals', 'טבע תעשיות פרמצבטיות']),
  ('Bezeq', ARRAY['בזק']),
  ('Cellcom', ARRAY['סלקום']),
  ('Partner Communications', ARRAY['Partner', 'פרטנר', 'פרטנר תקשורת']),
  ('Bank Leumi', ARRAY['Leumi', 'לאומי', 'בנק לאומי']),
  ('Bank Hapoalim', ARRAY['Hapoalim', 'הפועלים', 'בנק הפועלים']),
  ('Discount Bank', ARRAY['Israel Discount Bank', 'דיסקונט', 'בנק דיסקונט']),
  ('Mizrahi Tefahot', ARRAY['Mizrahi', 'מזרחי', 'מזרחי טפחות', 'בנק מזרחי', 'בנק מזרחי טפחות']),
  ('Clalit', ARRAY['כללית', 'שירותי בריאות כללית', 'Clalit Health Services']),
  ('Maccabi', ARRAY['מכבי', 'מכבי שירותי בריאות', 'Maccabi Healthcare']),
  ('Meuhedet', ARRAY['מאוחדת', 'קופת חולים מאוחדת']),
  ('Ness', ARRAY['Ness Technologies | נס טכנולוגיות', 'Ness Israel']),
  ('Malam Team', ARRAY['MalamTeam', 'מלם תים בע"מ']),
  ('Elad Software Systems', ARRAY['Elad', 'Elad Systems', 'אלעד', 'אלעד מערכות', 'אלעד מערכות תוכנה']),
  ('Aman Group', ARRAY['Aman', 'אמן', 'קבוצת אמן', 'אמן מחשבים', 'אמן תוכנה']),
  ('Migdal Group', ARRAY['Migdal', 'מגדל', 'מגדל ביטוח', 'מגדל אחזקות ביטוח ופיננסים', 'קבוצת מגדל']),
  ('Genpact', ARRAY['ג''נפקט', 'גנפקט']),
  ('Verint', ARRAY['ורינט', 'Verint Systems']),
  ('AudioCodes', ARRAY['אודיוקודס', 'Audio Codes']),
  ('Innoviz Technologies', ARRAY['Innoviz', 'אינוביז']),
  ('SQLink Group', ARRAY['SQLink', 'אס קיו לינק']),
  ('Tipalti', ARRAY['טיפלטי']),
  ('Prologic', ARRAY['Prologic Ltd.', 'פרולוג''יק', 'פרולוגיק']),
  ('ONE Technologies', ARRAY['ONE', 'וואן', 'וואן טכנולוגיות', 'One Technologies Ltd']),
  ('Toga Networks', ARRAY['Toga Networks-a Huawei Company', 'Toga', 'טוגה']),
  ('VAST Data', ARRAY['Vast', 'ואסט']),
  ('NextSilicon', ARRAY['Next Silicon', 'נקסט סיליקון']),
  ('Infinidat', ARRAY['אינפינידט']),
  ('Panaya', ARRAY['פנאיה']),
  ('Skyvar', ARRAY['סקייבר']),
  ('Ready Group', ARRAY['Ready', 'רדי']),
  -- government
  ('משרד החינוך', ARRAY['Ministry of Education', 'Ministry of Education (Israel)', 'Ministry of Education of Israel', 'Israel Ministry of Education']),
  ('משרד המשפטים', ARRAY['Ministry of Justice', 'Israel Ministry of Justice', 'Ministry of Justice (Israel)']),
  ('רשות המסים', ARRAY['Israel Tax Authority', 'רשות המסים בישראל', 'רשות המיסים', 'מס הכנסה']),
  ('הלשכה המרכזית לסטטיסטיקה', ARRAY['Israel Central Bureau of Statistics', 'Central Bureau of Statistics', 'למ"ס', 'הלמ"ס']),
  ('מערך הדיגיטל הלאומי', ARRAY['Israel National Digital Agency', 'National Digital Agency', 'מערך הדיגיטל']),
  ('משטרת ישראל', ARRAY['Israel Police', 'משטרה']),
  ('צה"ל', ARRAY['IDF', 'Israel Defense Forces', 'צהל']),
  ('משרד הביטחון', ARRAY['Ministry of Defense', 'Israel Ministry of Defense', 'IMOD', 'משהב"ט']),
  ('ביטוח לאומי', ARRAY['National Insurance Institute', 'Bituach Leumi', 'המוסד לביטוח לאומי']),
  ('משרד האנרגיה', ARRAY['Israel Ministry of Energy and Infrastructure', 'Ministry of Energy', 'משרד האנרגיה והתשתיות', 'משרד האנרגיה והמים']),
  -- not a company
  ('', ARRAY['Freelance', 'Freelancer', 'Self-employed', 'Self Employed', 'Independent', 'Private',
             'None', 'N/A', 'Student', 'Unemployed', 'עצמאית', 'עצמאי', 'פרילנס', 'פרילנסרית',
             'פרילנסר', 'עבודה עצמאית', 'סטודנטית'])
) AS v(canonical, aliases), unnest(v.aliases) a
ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical;

-- Canonical name for a typed company name (the name itself when unknown;
-- '' when it isn't a company). Bilingual names in one field are common
-- ("Ness Technologies | נס טכנולוגיות", "Bank Leumi בנק לאומי", "Israel Police -
-- משטרת ישראל"), so besides the whole name it tries each part and the Latin /
-- Hebrew halves, against both aliases and canonical names.
CREATE OR REPLACE FUNCTION people_search_canonical_company(p TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT people_search_company_key(c) AS k, ord
    FROM (
      SELECT p AS c, 0 AS ord
      UNION ALL
      SELECT t.part, 1 + t.n / 1000.0
      FROM regexp_split_to_table(COALESCE(p, ''), '\s*[|/–—(),]\s*|\s+-\s+') WITH ORDINALITY AS t(part, n)
      UNION ALL
      SELECT regexp_replace(COALESCE(p, ''), '[א-ת"״׳'']+', ' ', 'g'), 2
      UNION ALL
      SELECT regexp_replace(COALESCE(p, ''), '[A-Za-z]+', ' ', 'g'), 3
    ) s
  )
  SELECT COALESCE(
    (SELECT hit.canonical
     FROM candidates c
     CROSS JOIN LATERAL (
       SELECT ca.canonical, 0 AS pref FROM company_aliases ca WHERE ca.alias_key = c.k
       UNION ALL
       SELECT ca.canonical, 1 FROM company_aliases ca WHERE ca.canonical_key = c.k
     ) hit
     WHERE c.k <> ''
     ORDER BY c.ord, hit.pref
     LIMIT 1),
    p);
$$;

-- ------------------------------------------------------------
-- 4. Building one member's row
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION people_search_refresh_user(p_uuid UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u                RECORD;
  e                JSONB;
  comp             JSONB;
  v_exp            JSONB;
  v_is_current     BOOLEAN;
  v_title          TEXT;
  v_raw_name       TEXT;
  v_company_id     BIGINT;
  v_linked_id      BIGINT;
  v_linked_name    TEXT;
  v_key            TEXT;
  v_entry          JSONB;
  v_cur_titles     TEXT[] := '{}';
  v_past_titles    TEXT[] := '{}';
  v_cur_companies  JSONB  := '[]';
  v_past_companies JSONB  := '[]';
  v_latest_title   TEXT;
  v_latest_start   TEXT   := '';
  v_skills         TEXT[];
  v_name_text      TEXT;
  v_title_text     TEXT;
  v_skills_text    TEXT;
  v_company_text   TEXT;
  v_functions      TEXT[];
BEGIN
  SELECT * INTO u FROM users WHERE uuid = p_uuid;

  IF NOT FOUND
     OR COALESCE(u.is_anonymous, FALSE)
     OR COALESCE(u.email, '') ILIKE '%@deleted.local'
     OR u.role::TEXT = 'feed_participant' THEN
    DELETE FROM people_search_index WHERE user_uuid = p_uuid;
    RETURN;
  END IF;

  v_exp := CASE WHEN jsonb_typeof(u.experience) = 'array' THEN u.experience ELSE '[]'::jsonb END;

  FOR e IN SELECT value FROM jsonb_array_elements(v_exp) LOOP
    CONTINUE WHEN jsonb_typeof(e) <> 'object';

    v_is_current := (e->>'current') = 'true';   -- boolean true and the string "true"
    v_title      := NULLIF(btrim(COALESCE(e->>'title', '')), '');

    -- experience.company is string | number (companies.id) | {id, name}
    comp := e->'company';
    v_raw_name := NULL;
    v_company_id := NULL;
    IF jsonb_typeof(comp) = 'string' THEN
      v_raw_name := people_search_canonical_company(btrim(comp #>> '{}'));
    ELSIF jsonb_typeof(comp) = 'number' THEN
      v_company_id := (comp #>> '{}')::NUMERIC::BIGINT;
    ELSIF jsonb_typeof(comp) = 'object' THEN
      v_raw_name := people_search_canonical_company(btrim(COALESCE(comp->>'name', '')));
      IF (comp->>'id') ~ '^\d+$' THEN v_company_id := (comp->>'id')::BIGINT; END IF;
    END IF;

    v_linked_id := NULL;
    v_linked_name := NULL;
    IF v_company_id IS NOT NULL THEN
      SELECT c.id, c.name INTO v_linked_id, v_linked_name FROM companies c WHERE c.id = v_company_id;
      v_linked_name := people_search_canonical_company(v_linked_name);
    END IF;
    IF v_linked_id IS NULL AND COALESCE(v_raw_name, '') <> '' THEN
      SELECT c.id, c.name INTO v_linked_id, v_linked_name FROM companies c
      WHERE people_search_company_key(c.name) = people_search_company_key(v_raw_name)
      ORDER BY c.id
      LIMIT 1;
    END IF;

    -- '' = not a company (canonical '' alias), so no workplace entry
    v_key := people_search_company_key(COALESCE(v_linked_name, v_raw_name));
    v_entry := CASE WHEN v_key <> '' THEN jsonb_build_object(
      'key',  v_key,
      'name', COALESCE(v_linked_name, v_raw_name),
      'id',   v_linked_id
    ) END;

    IF v_is_current THEN
      IF v_title IS NOT NULL THEN v_cur_titles := v_cur_titles || v_title; END IF;
      IF v_entry IS NOT NULL THEN v_cur_companies := v_cur_companies || jsonb_build_array(v_entry); END IF;
    ELSE
      IF v_title IS NOT NULL THEN v_past_titles := v_past_titles || v_title; END IF;
      IF v_entry IS NOT NULL THEN v_past_companies := v_past_companies || jsonb_build_array(v_entry); END IF;
    END IF;

    IF v_title IS NOT NULL AND COALESCE(e->>'startDate', '') >= v_latest_start THEN
      v_latest_start := COALESCE(e->>'startDate', '');
      v_latest_title := v_title;
    END IF;
  END LOOP;

  v_skills := COALESCE(u.skills, '{}');

  v_name_text := people_search_normalize(concat_ws(' ',
    u.first_name,
    CASE WHEN u.privacy_lastname IS NULL THEN u.last_name END));

  -- No current position → the most recent one still describes what they do.
  v_title_text := people_search_normalize(concat_ws(' | ',
    u.headline,
    array_to_string(CASE WHEN cardinality(v_cur_titles) > 0 THEN v_cur_titles
                         ELSE ARRAY[v_latest_title] END, ' | ')));

  v_skills_text := people_search_normalize(array_to_string(v_skills, ' | '));

  -- Names plus every alias of those companies, so "אינטל" finds "Intel".
  v_company_text := people_search_normalize(concat_ws(' | ',
    (SELECT string_agg(x->>'name', ' | ') FROM jsonb_array_elements(v_cur_companies) x),
    (SELECT string_agg(x->>'name', ' | ') FROM jsonb_array_elements(v_past_companies) x),
    (SELECT string_agg(ca.alias, ' | ') FROM company_aliases ca
     WHERE ca.canonical_key IN (
       SELECT x->>'key' FROM jsonb_array_elements(v_cur_companies || v_past_companies) x))));

  -- Job functions: from headline + titles (LinkedIn infers "Job Function" from
  -- titles). Members with no title signal (students, career changers with an
  -- empty headline) fall back to skills, requiring two distinct hits.
  SELECT COALESCE(array_agg(DISTINCT jt.function_key), '{}') INTO v_functions
  FROM job_function_terms jt
  WHERE people_search_term_matches(v_title_text, jt.term, jt.mode);

  IF cardinality(v_functions) = 0 AND v_skills_text <> '' THEN
    SELECT COALESCE(array_agg(fk), '{}') INTO v_functions
    FROM (
      SELECT jt.function_key AS fk
      FROM job_function_terms jt
      WHERE people_search_term_matches(v_skills_text, jt.term, jt.mode)
      GROUP BY jt.function_key
      HAVING COUNT(*) >= 2
    ) s;
  END IF;

  -- Specializations imply the parent field: a React developer is a developer.
  IF v_functions && ARRAY['frontend', 'backend', 'fullstack', 'mobile']
     AND NOT v_functions @> ARRAY['software_dev'] THEN
    v_functions := v_functions || 'software_dev'::TEXT;
  END IF;

  INSERT INTO people_search_index AS i (
    user_uuid, role, name_text, title_text, skills_text, company_text, search_text,
    current_titles, skills, current_companies, past_companies,
    current_company_keys, past_company_keys, job_functions, updated_at
  ) VALUES (
    p_uuid,
    u.role::TEXT,
    v_name_text,
    v_title_text,
    v_skills_text,
    v_company_text,
    people_search_normalize(concat_ws(' | ',
      v_name_text, v_title_text, v_skills_text, v_company_text,
      array_to_string(v_past_titles, ' | '),
      u.location,
      u.about,
      people_search_jsonb_strings(u.education),
      people_search_jsonb_strings(u.certifications),
      people_search_jsonb_strings(u.projects))),
    v_cur_titles,
    v_skills,
    v_cur_companies,
    v_past_companies,
    ARRAY(SELECT DISTINCT x->>'key' FROM jsonb_array_elements(v_cur_companies) x),
    ARRAY(SELECT DISTINCT x->>'key' FROM jsonb_array_elements(v_past_companies) x),
    v_functions,
    now()
  )
  ON CONFLICT (user_uuid) DO UPDATE SET
    role                 = EXCLUDED.role,
    name_text            = EXCLUDED.name_text,
    title_text           = EXCLUDED.title_text,
    skills_text          = EXCLUDED.skills_text,
    company_text         = EXCLUDED.company_text,
    search_text          = EXCLUDED.search_text,
    current_titles       = EXCLUDED.current_titles,
    skills               = EXCLUDED.skills,
    current_companies    = EXCLUDED.current_companies,
    past_companies       = EXCLUDED.past_companies,
    current_company_keys = EXCLUDED.current_company_keys,
    past_company_keys    = EXCLUDED.past_company_keys,
    job_functions        = EXCLUDED.job_functions,
    updated_at           = EXCLUDED.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION people_search_rebuild()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
BEGIN
  DELETE FROM people_search_index i WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.uuid = i.user_uuid);
  FOR r IN SELECT uuid FROM users LOOP
    PERFORM people_search_refresh_user(r.uuid);
  END LOOP;
END;
$$;

-- Keep the index in sync with profile edits. A failure here must never
-- block a profile save — it only logs.
CREATE OR REPLACE FUNCTION people_search_users_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM people_search_index WHERE user_uuid = OLD.uuid;
    RETURN OLD;
  END IF;
  BEGIN
    PERFORM people_search_refresh_user(NEW.uuid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'people_search_refresh_user(%) failed: %', NEW.uuid, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_people_search_users ON users;
CREATE TRIGGER trg_people_search_users
  AFTER INSERT OR DELETE OR UPDATE OF
    first_name, last_name, privacy_lastname, headline, experience, skills,
    education, certifications, projects, about, location, is_anonymous, email, role
  ON users
  FOR EACH ROW EXECUTE FUNCTION people_search_users_trigger();

-- Editing the mapping re-derives everyone's job_functions.
CREATE OR REPLACE FUNCTION people_search_terms_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM people_search_rebuild();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_people_search_terms ON job_function_terms;
CREATE TRIGGER trg_people_search_terms
  AFTER INSERT OR UPDATE OR DELETE ON job_function_terms
  FOR EACH STATEMENT EXECUTE FUNCTION people_search_terms_trigger();

DROP TRIGGER IF EXISTS trg_people_search_company_aliases ON company_aliases;
CREATE TRIGGER trg_people_search_company_aliases
  AFTER INSERT OR UPDATE OR DELETE ON company_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION people_search_terms_trigger();

-- ------------------------------------------------------------
-- 5. Matching (internal — called by the RPCs below)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION people_search_tokens(p_query TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT t), '{}')
  FROM unnest(string_to_array(people_search_normalize(p_query), ' ')) t
  WHERE length(t) >= 2
    AND t <> ALL (ARRAY[
      -- connective words: "QA בתחום", "מפתחת בחברת Wix", "developer at Intel"
      'של', 'את', 'עם', 'על', 'או', 'גם', 'אצל', 'עבור', 'כמו', 'רק',
      'בתחום', 'תחום', 'מתחום', 'בחברת', 'חברת', 'בחברה', 'חברה', 'לתפקיד', 'תפקיד', 'בתפקיד',
      'משרת', 'עובדת', 'עובד', 'שעובדת', 'שעובד', 'מישהי', 'מישהו', 'מחפשת', 'מחפש',
      'and', 'or', 'the', 'of', 'in', 'at', 'for', 'with', 'to', 'an', 'as', 'on', 'from', 'who', 'works']);
$$;

-- Per query token: the job functions whose terms appear in the query AND
-- overlap the token (a multi-word term like "full stack" covers both tokens).
-- Generic words ("תוכנה" in "בודקת תוכנה", "engineer", "senior") don't
-- describe a field on their own: once another token resolved to a field,
-- they're satisfied by it too, so "בודקת תוכנה" still finds "QA Engineer".
CREATE OR REPLACE FUNCTION people_search_token_functions(p_query TEXT)
RETURNS TABLE (token TEXT, functions TEXT[])
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      tok,
      COALESCE(array_agg(DISTINCT jt.function_key) FILTER (WHERE jt.function_key IS NOT NULL), '{}') AS funcs
    FROM unnest(people_search_tokens(p_query)) tok
    LEFT JOIN job_function_terms jt
      ON people_search_term_matches(people_search_normalize(p_query), jt.term, jt.mode)
     AND (strpos(jt.term, tok) > 0 OR strpos(tok, jt.term) > 0)
    GROUP BY tok
  ),
  all_funcs AS (
    SELECT COALESCE(array_agg(DISTINCT f), '{}') AS funcs
    FROM base, unnest(base.funcs) f
  )
  SELECT
    b.tok,
    CASE
      WHEN cardinality(b.funcs) = 0 AND b.tok = ANY (ARRAY[
        'תוכנה', 'תכנה', 'software', 'sw', 'engineer', 'engineering', 'מהנדסת', 'מהנדס', 'הנדסת',
        'הנדסאית', 'הנדסאי', 'specialist', 'expert', 'מומחית', 'מומחה', 'senior', 'sr', 'סניור', 'בכירה',
        'בכיר', 'lead', 'מובילה', 'מוביל', 'professional', 'מקצועית', 'manager', 'מנהלת', 'מנהל', 'team',
        'צוות', 'אחראית', 'אחראי', 'רכזת', 'רכז', 'אשת', 'איש', 'נציגת', 'נציג', 'consultant', 'יועצת',
        'יועץ', 'freelance', 'freelancer', 'פרילנס', 'פרילנסרית', 'עצמאית', 'remote', 'מהבית', 'hybrid',
        'היברידי'])
      THEN a.funcs
      ELSE b.funcs
    END
  FROM base b, all_funcs a;
$$;

-- Every token of the free-text query must be satisfied, either literally
-- (substring of search_text) or through a job function it maps to — so
-- "בודקת תוכנה" also finds "QA Engineer", and "מפתחת react" needs both a
-- developer and react (or frontend). match_rank says where the match came
-- from: 100 name, 80 title, 60 skill, 50 company, 40 job function,
-- 20 elsewhere in the profile, 0 no free text (filters only).
--
-- The per-token conditions are generated once per call as plain strpos /
-- array-overlap expressions, so the scan does no jsonb work per row.
DROP FUNCTION IF EXISTS people_search_matches(TEXT, TEXT[], TEXT, TEXT, TEXT[], UUID[]);
CREATE FUNCTION people_search_matches(
  p_query         TEXT   DEFAULT NULL,
  p_functions     TEXT[] DEFAULT NULL,
  p_company_key   TEXT   DEFAULT NULL,
  p_company_scope TEXT   DEFAULT 'current',
  p_roles         TEXT[] DEFAULT NULL,
  p_within        UUID[] DEFAULT NULL
)
RETURNS TABLE (user_uuid UUID, match_rank INT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  tf            RECORD;
  v_has_tokens  BOOLEAN := FALSE;
  v_q_functions TEXT[]  := '{}';
  v_all         TEXT    := 'TRUE';
  v_name        TEXT    := 'TRUE';
  v_title       TEXT    := 'TRUE';
  v_skills      TEXT    := 'TRUE';
  v_company     TEXT    := 'TRUE';
  v_full        TEXT    := 'TRUE';
BEGIN
  FOR tf IN SELECT * FROM people_search_token_functions(p_query) LOOP
    v_has_tokens  := TRUE;
    v_q_functions := v_q_functions || tf.functions;
    v_all     := v_all     || format(' AND (strpos(i.search_text, %L) > 0 OR i.job_functions && %L::TEXT[])', tf.token, tf.functions);
    v_name    := v_name    || format(' AND strpos(i.name_text, %L) > 0', tf.token);
    v_title   := v_title   || format(' AND strpos(i.title_text, %L) > 0', tf.token);
    v_skills  := v_skills  || format(' AND strpos(i.skills_text, %L) > 0', tf.token);
    v_company := v_company || format(' AND strpos(i.company_text, %L) > 0', tf.token);
    v_full    := v_full    || format(' AND strpos(i.search_text, %L) > 0', tf.token);
  END LOOP;

  RETURN QUERY EXECUTE format($q$
    SELECT
      i.user_uuid,
      CASE
        WHEN NOT %s THEN 0
        WHEN %s THEN 100
        WHEN %s THEN 80
        WHEN %s THEN 60
        WHEN %s THEN 50
        WHEN NOT (%s) OR i.job_functions && $1 THEN 40
        ELSE 20
      END
    FROM people_search_index i
    WHERE ($2::UUID[] IS NULL OR i.user_uuid = ANY ($2))
      AND ($3::TEXT[] IS NULL OR i.role = ANY ($3))
      AND ($4::TEXT[] IS NULL OR i.job_functions && $4)
      AND ($5::TEXT IS NULL
           OR i.current_company_keys @> ARRAY[$5]
           OR ($6 = 'any' AND i.past_company_keys @> ARRAY[$5]))
      AND %s
  $q$, CASE WHEN v_has_tokens THEN 'TRUE' ELSE 'FALSE' END, v_name, v_title, v_skills, v_company, v_full, v_all)
  USING
    v_q_functions,
    p_within,
    NULLIF(p_roles, '{}'),
    NULLIF(p_functions, '{}'),
    NULLIF(btrim(COALESCE(p_company_key, '')), ''),
    p_company_scope;
END;
$$;

-- Why did this member match? ("skill: Selenium", "past company: Intel"...)
-- Only ever called for the rows of the page being returned.
CREATE OR REPLACE FUNCTION people_search_explain(
  p_user_uuid   UUID,
  p_rank        INT,
  p_query       TEXT,
  p_functions   TEXT[],
  p_company_key TEXT
)
RETURNS TABLE (match_kind TEXT, match_text TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  i           people_search_index%ROWTYPE;
  v_tokens    TEXT[] := people_search_tokens(p_query);
  v_functions TEXT[] := NULLIF(p_functions, '{}');
  v_company   TEXT   := NULLIF(btrim(COALESCE(p_company_key, '')), '');
BEGIN
  SELECT * INTO i FROM people_search_index WHERE user_uuid = p_user_uuid;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_rank = 100 THEN
    match_kind := 'name';
  ELSIF p_rank = 80 THEN
    match_kind := 'title';
    match_text := (SELECT t FROM unnest(i.current_titles) t
                   WHERE people_search_contains_all(people_search_normalize(t), v_tokens) LIMIT 1);
  ELSIF p_rank = 60 THEN
    match_kind := 'skill';
    match_text := (SELECT sk FROM unnest(i.skills) sk
                   WHERE strpos(people_search_normalize(sk), v_tokens[1]) > 0 LIMIT 1);
  ELSIF p_rank = 50 OR (p_rank = 0 AND v_functions IS NULL AND v_company IS NOT NULL) THEN
    -- current before past; the filtered company, else the one named in the query
    SELECT c.kind, c.name INTO match_kind, match_text
    FROM (
      SELECT 'company'::TEXT AS kind, x->>'name' AS name, x->>'key' AS key, 0 AS ord
      FROM jsonb_array_elements(i.current_companies) x
      UNION ALL
      SELECT 'past_company', x->>'name', x->>'key', 1
      FROM jsonb_array_elements(i.past_companies) x
    ) c
    WHERE (v_company IS NOT NULL AND c.key = v_company)
       OR (v_company IS NULL AND (
             people_search_contains_all(people_search_normalize(c.name), v_tokens)
             -- searched by another name of the company ("אינטל" → Intel)
             OR EXISTS (SELECT 1 FROM company_aliases ca
                        WHERE ca.canonical_key = c.key
                          AND people_search_contains_all(people_search_normalize(ca.alias), v_tokens))))
    ORDER BY c.ord
    LIMIT 1;
  ELSIF p_rank = 40 OR (p_rank = 0 AND v_functions IS NOT NULL) THEN
    match_kind := 'function';
    match_text := (SELECT f FROM unnest(i.job_functions) f
                   WHERE f = ANY (COALESCE(v_functions,
                                           ARRAY(SELECT unnest(functions) FROM people_search_token_functions(p_query))))
                   LIMIT 1);
  ELSIF p_rank = 20 THEN
    match_kind := 'other';
  END IF;

  RETURN NEXT;
END;
$$;

-- ------------------------------------------------------------
-- 6. RPC: search the whole community (suggestions tab)
-- ------------------------------------------------------------
-- Excludes the viewer and people already connected (they live in the
-- connections tab). Pending requests stay — the card shows their state.
CREATE OR REPLACE FUNCTION search_people(
  p_viewer_id       UUID,
  p_query           TEXT    DEFAULT NULL,
  p_functions       TEXT[]  DEFAULT NULL,
  p_company_key     TEXT    DEFAULT NULL,
  p_company_scope   TEXT    DEFAULT 'current',
  p_recruiters_only BOOLEAN DEFAULT FALSE,
  p_mutual_only     BOOLEAN DEFAULT FALSE,
  p_limit           INT     DEFAULT 10,
  p_offset          INT     DEFAULT 0
)
RETURNS TABLE (
  user_uuid       UUID,
  match_kind      TEXT,
  match_text      TEXT,
  mutual_count    BIGINT,
  current_company TEXT,
  total_count     BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_my_connections UUID[];
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_viewer_id THEN
    RAISE EXCEPTION 'search_people: viewer mismatch';
  END IF;

  SELECT COALESCE(array_agg(other_id), '{}') INTO v_my_connections
  FROM get_accepted_connection_ids(p_viewer_id);

  RETURN QUERY
  WITH m AS (
    SELECT * FROM people_search_matches(
      p_query, p_functions, p_company_key, p_company_scope,
      CASE WHEN p_recruiters_only THEN ARRAY['recruiters'] END,
      NULL)
  ),
  -- Second-degree counts in one pass over my connections' connections.
  -- Two index-friendly directions instead of a per-connection function call
  -- (inside plpgsql that lateral call isn't inlined: ~50× slower at 20k members).
  mutuals AS (
    SELECT d.uid, COUNT(*) AS cnt
    FROM (
      SELECT c.receiver_id AS uid FROM connections c
      WHERE c.status = 'accepted' AND c.requester_id = ANY (v_my_connections)
      UNION ALL
      SELECT c.requester_id FROM connections c
      WHERE c.status = 'accepted' AND c.receiver_id = ANY (v_my_connections)
    ) d
    GROUP BY d.uid
  ),
  page AS (
    SELECT
      m.user_uuid AS uid,
      m.match_rank AS rank,
      COALESCE(mu.cnt, 0) AS mutuals,
      i.current_companies->0->>'name' AS company,
      i.updated_at AS touched,
      COUNT(*) OVER () AS total
    FROM m
    JOIN people_search_index i ON i.user_uuid = m.user_uuid
    LEFT JOIN mutuals mu ON mu.uid = m.user_uuid
    WHERE m.user_uuid <> p_viewer_id
      AND m.user_uuid <> ALL (v_my_connections)
      AND (NOT p_mutual_only OR mu.cnt > 0)
    ORDER BY m.match_rank DESC, COALESCE(mu.cnt, 0) DESC, i.updated_at DESC, m.user_uuid
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT p.uid, ex.match_kind, ex.match_text, p.mutuals, p.company, p.total
  FROM page p
  LEFT JOIN LATERAL people_search_explain(p.uid, p.rank, p_query, p_functions, p_company_key) ex ON TRUE
  ORDER BY p.rank DESC, p.mutuals DESC, p.touched DESC, p.uid;
END;
$$;

-- ------------------------------------------------------------
-- 7. RPC: get_accepted_connections — now with the same filters
-- ------------------------------------------------------------
-- Signature grows, so drop the old one first (an overload would make
-- PostgREST's named-argument resolution ambiguous). p_search keeps its old
-- name-only meaning (used by @mentions); the people-search filters are new.
DROP FUNCTION IF EXISTS get_accepted_connections(UUID, TEXT, INT, INT);

CREATE OR REPLACE FUNCTION get_accepted_connections(
  p_user_id         UUID,
  p_search          TEXT    DEFAULT NULL,
  p_limit           INT     DEFAULT 20,
  p_offset          INT     DEFAULT 0,
  p_query           TEXT    DEFAULT NULL,
  p_functions       TEXT[]  DEFAULT NULL,
  p_company_key     TEXT    DEFAULT NULL,
  p_company_scope   TEXT    DEFAULT 'current',
  p_recruiters_only BOOLEAN DEFAULT FALSE,
  p_mutual_only     BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id                       UUID,
  requester_id             UUID,
  receiver_id              UUID,
  status                   TEXT,
  created_at               TIMESTAMPTZ,
  requester                JSONB,
  receiver                 JSONB,
  mutual_connections_count BIGINT,
  match_kind               TEXT,
  match_text               TEXT,
  current_company          TEXT,
  count                    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
#variable_conflict use_column
DECLARE
  -- Computed exactly once per call (not once per row) — this is the set
  -- every row's mutual_connections_count gets intersected against.
  v_my_connections UUID[];
  v_query_only     BOOLEAN;
  v_filtering      BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'get_accepted_connections: viewer mismatch';
  END IF;

  SELECT COALESCE(ARRAY_AGG(other_id), ARRAY[]::UUID[])
  INTO v_my_connections
  FROM get_accepted_connection_ids(p_user_id);

  v_query_only := COALESCE(btrim(p_query), '') <> ''
    AND COALESCE(cardinality(p_functions), 0) = 0
    AND COALESCE(btrim(p_company_key), '') = ''
    AND NOT COALESCE(p_recruiters_only, FALSE);
  v_filtering := COALESCE(btrim(p_query), '') <> ''
    OR COALESCE(cardinality(p_functions), 0) > 0
    OR COALESCE(btrim(p_company_key), '') <> ''
    OR COALESCE(p_recruiters_only, FALSE);

  RETURN QUERY
  WITH m AS (
    SELECT * FROM people_search_matches(
      p_query, p_functions, p_company_key, p_company_scope,
      CASE WHEN p_recruiters_only THEN ARRAY['recruiters'] END,
      v_my_connections)
    WHERE v_filtering
  ),
  page AS (
    SELECT r.*, COUNT(*) OVER () AS total
    FROM (
      SELECT
        c.id AS conn_id,
        c.requester_id AS req_id,
        c.receiver_id AS rec_id,
        c.status::TEXT AS conn_status,
        c.created_at AS connected_at,
        jsonb_build_object(
          'uuid',       req.uuid,
          'first_name', req.first_name,
          'last_name',  req.last_name,
          'image',      req.image,
          'headline',   req.headline,
          'role',       req.role
        ) AS req_json,
        jsonb_build_object(
          'uuid',       rec.uuid,
          'first_name', rec.first_name,
          'last_name',  rec.last_name,
          'image',      rec.image,
          'headline',   rec.headline,
          'role',       rec.role
        ) AS rec_json,
        (
          SELECT COUNT(*)
          FROM get_accepted_connection_ids(other.uuid) theirs
          WHERE theirs.other_id = ANY(v_my_connections)
        ) AS mutuals,
        other.uuid AS other_uuid,
        m.match_rank AS matched_rank,             -- NULL = matched by name via the view
        COALESCE(m.match_rank, 100) AS rank,
        idx.current_companies->0->>'name' AS company
      FROM connections c
      JOIN public_users_view req ON req.uuid = c.requester_id
      JOIN public_users_view rec ON rec.uuid = c.receiver_id
      CROSS JOIN LATERAL (
        SELECT
          CASE WHEN c.requester_id = p_user_id THEN rec.uuid       ELSE req.uuid       END AS uuid,
          CASE WHEN c.requester_id = p_user_id THEN rec.first_name ELSE req.first_name END AS first_name,
          CASE WHEN c.requester_id = p_user_id THEN rec.last_name  ELSE req.last_name  END AS last_name
      ) other
      LEFT JOIN m ON m.user_uuid = other.uuid
      LEFT JOIN people_search_index idx ON idx.user_uuid = other.uuid
      WHERE
        c.status = 'accepted'
        AND (c.requester_id = p_user_id OR c.receiver_id = p_user_id)
        AND (
          p_search IS NULL OR p_search = '' OR (
            other.first_name ILIKE '%' || p_search || '%'
            OR other.last_name ILIKE '%' || p_search || '%'
            OR CONCAT(COALESCE(other.first_name, ''), ' ', COALESCE(other.last_name, ''))
                 ILIKE '%' || p_search || '%'
          )
        )
        AND (
          NOT v_filtering
          OR m.user_uuid IS NOT NULL
          -- The index only holds publicly visible last names; a connection may
          -- see a privacy-restricted one, so fall back to the view for names.
          OR (v_query_only AND CONCAT(COALESCE(other.first_name, ''), ' ', COALESCE(other.last_name, ''))
                                 ILIKE '%' || btrim(p_query) || '%')
        )
    ) r
    WHERE NOT COALESCE(p_mutual_only, FALSE) OR r.mutuals > 0
    ORDER BY r.rank DESC, r.connected_at DESC
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT
    p.conn_id, p.req_id, p.rec_id, p.conn_status, p.connected_at,
    p.req_json, p.rec_json, p.mutuals,
    CASE WHEN NOT v_filtering THEN NULL
         WHEN p.matched_rank IS NULL THEN 'name'
         ELSE ex.match_kind END,
    ex.match_text,
    p.company,
    p.total
  FROM page p
  LEFT JOIN LATERAL people_search_explain(p.other_uuid, p.matched_rank, p_query, p_functions, p_company_key) ex
    ON v_filtering AND p.matched_rank IS NOT NULL
  ORDER BY p.rank DESC, p.connected_at DESC;
END;
$$;

-- ------------------------------------------------------------
-- 8. RPC: companies in my circle / in the community
-- ------------------------------------------------------------
-- Powers the company picker and the "companies in my circle" list:
-- each workplace with how many members work there now / worked there before.
-- Scope 'connections' = my connections; 'all' = everyone the suggestions tab
-- can return (the community minus me and my connections), so counts match results.
CREATE OR REPLACE FUNCTION people_search_companies(
  p_viewer_id UUID,
  p_scope     TEXT DEFAULT 'connections',   -- 'connections' | 'all'
  p_query     TEXT DEFAULT NULL,
  p_limit     INT  DEFAULT 30
)
RETURNS TABLE (
  company_key   TEXT,
  name          TEXT,
  company_id    BIGINT,
  logo          TEXT,
  current_count BIGINT,
  past_count    BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_mine   UUID[];
  v_within UUID[];
  v_except UUID[];
  v_q      TEXT := people_search_normalize(p_query);
  v_q_key  TEXT := people_search_company_key(p_query);
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_viewer_id THEN
    RAISE EXCEPTION 'people_search_companies: viewer mismatch';
  END IF;

  SELECT COALESCE(array_agg(other_id), '{}') INTO v_mine
  FROM get_accepted_connection_ids(p_viewer_id);
  IF p_scope = 'connections' THEN v_within := v_mine; ELSE v_except := v_mine; END IF;

  RETURN QUERY
  WITH entries AS (
    SELECT i.user_uuid, x->>'key' AS key, x->>'name' AS name,
           NULLIF(x->>'id', '')::BIGINT AS cid, TRUE AS is_current
    FROM people_search_index i, jsonb_array_elements(i.current_companies) x
    WHERE (v_within IS NULL OR i.user_uuid = ANY (v_within))
      AND (v_except IS NULL OR i.user_uuid <> ALL (v_except))
      AND i.user_uuid <> p_viewer_id
    UNION ALL
    SELECT i.user_uuid, x->>'key', x->>'name', NULLIF(x->>'id', '')::BIGINT, FALSE
    FROM people_search_index i, jsonb_array_elements(i.past_companies) x
    WHERE (v_within IS NULL OR i.user_uuid = ANY (v_within))
      AND (v_except IS NULL OR i.user_uuid <> ALL (v_except))
      AND i.user_uuid <> p_viewer_id
  ),
  per_member AS (
    -- someone who worked there before and works there now counts once, as current
    SELECT key, user_uuid, bool_or(is_current) AS is_current
    FROM entries
    GROUP BY key, user_uuid
  ),
  agg AS (
    SELECT
      e.key,
      mode() WITHIN GROUP (ORDER BY e.name) AS name,   -- most common spelling
      max(e.cid) AS cid
    FROM entries e
    GROUP BY e.key
  )
  SELECT
    a.key,
    COALESCE(a.name, co.name),   -- canonical spelling ("Ness", not "Ness Technologies | נס טכנולוגיות")
    a.cid,
    co.logo::TEXT,
    COUNT(*) FILTER (WHERE pm.is_current),
    COUNT(*) FILTER (WHERE NOT pm.is_current)
  FROM agg a
  JOIN per_member pm ON pm.key = a.key
  LEFT JOIN companies co ON co.id = a.cid
  WHERE v_q = ''
     OR strpos(people_search_normalize(COALESCE(a.name, '')), v_q) > 0
     OR strpos(people_search_normalize(COALESCE(co.name, '')), v_q) > 0
     OR (v_q_key <> '' AND strpos(a.key, v_q_key) > 0)
     OR EXISTS (SELECT 1 FROM company_aliases ca
                WHERE ca.canonical_key = a.key
                  AND strpos(people_search_normalize(ca.alias), v_q) > 0)
  GROUP BY a.key, co.name, a.name, a.cid, co.logo
  ORDER BY COUNT(*) FILTER (WHERE pm.is_current) DESC, COUNT(*) DESC, COALESCE(a.name, co.name)
  LIMIT p_limit;
END;
$$;

-- ------------------------------------------------------------
-- 8b. RPC: how many members per job function (counts in the field filter)
-- ------------------------------------------------------------
-- Same scopes as people_search_companies.
CREATE OR REPLACE FUNCTION people_search_function_counts(
  p_viewer_id UUID,
  p_scope     TEXT DEFAULT 'connections'   -- 'connections' | 'all'
)
RETURNS TABLE (function_key TEXT, member_count BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_mine UUID[];
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_viewer_id THEN
    RAISE EXCEPTION 'people_search_function_counts: viewer mismatch';
  END IF;

  SELECT COALESCE(array_agg(other_id), '{}') INTO v_mine
  FROM get_accepted_connection_ids(p_viewer_id);

  RETURN QUERY
  SELECT f, COUNT(*)
  FROM people_search_index i, unnest(i.job_functions) f
  WHERE i.user_uuid <> p_viewer_id
    AND CASE WHEN p_scope = 'connections' THEN i.user_uuid = ANY (v_mine)
             ELSE i.user_uuid <> ALL (v_mine) END
  GROUP BY f;
END;
$$;

-- ------------------------------------------------------------
-- 9. Permissions
-- ------------------------------------------------------------
-- Internal helpers and writers: never callable through PostgREST.
REVOKE ALL ON FUNCTION people_search_refresh_user(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION people_search_rebuild() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION people_search_matches(TEXT, TEXT[], TEXT, TEXT, TEXT[], UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION people_search_explain(UUID, INT, TEXT, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE people_search_index FROM anon, authenticated;
REVOKE ALL ON TABLE job_function_terms FROM anon, authenticated;
REVOKE ALL ON TABLE company_aliases FROM anon, authenticated;

-- RPCs: signed-in members only (each checks auth.uid() = viewer).
REVOKE ALL ON FUNCTION search_people(UUID, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, BOOLEAN, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION search_people(UUID, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, BOOLEAN, INT, INT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION people_search_companies(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION people_search_companies(UUID, TEXT, TEXT, INT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION people_search_function_counts(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION people_search_function_counts(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_accepted_connections(UUID, TEXT, INT, INT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 10. Initial build
-- ------------------------------------------------------------
SELECT people_search_rebuild();

NOTIFY pgrst, 'reload schema';

import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import OpenAI from 'https://esm.sh/openai@4'
import {
  getEmbedding,
  extractSkillsFromJd,
  stripHtml,
  computeMatchScore,
} from './_matchHelpers.ts'

const app = new Hono()
const allowedCategories = new Set(['Development', 'QA', 'Data', 'Management', 'Product'])

const SENIORITY_LEVEL_MAP: Record<string, string[]> = {
  Internship: ['Internship'],
  Junior: ['Junior', 'Entry level', '0+ years', '1+ years', '2+ years', 'Associate'],
  Mid: ['Mid', 'Associate', 'Mid-Senior level', '2+ years', '3+ years', '4+ years'],
  Senior: ['Senior', 'Mid-Senior level', '5+ years', '6+ years', '7+ years', '8+ years'],
  Management: ['Management', 'Director', 'Executive'],
}

app.get('/', async (c) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    // קבלת המשתמש המחובר (בהנחה שיש auth middleware)
    const currentUser = c.get('user');
    const userId = currentUser?.id;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Secrets')
    }

    const supabaseClient = createClient(supabaseUrl, supabaseKey)

    const rawTextSearch = (c.req.query('query') ?? c.req.query('search') ?? '').trim()
    const rawCategory = (c.req.query('category') ?? c.req.query('categories') ?? '').trim()
    const rawSeniorityLevels = (c.req.query('seniority_levels') ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const id = c.req.query('id')
    const companyId = c.req.query('company_id')

    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '25')
    const from = (page - 1) * limit

    let result
    let totalCount = 0

    if (id) {
        // --- תרחיש א': שליפת משרה בודדת ---
        const { data, error } = await supabaseClient
            .from('open_position')
            .select('*, companies:company_id(id, name, logo, website, linkedin_url)')
            .eq('job_id', id)
            .single();
        
        if (error) throw error;
        
        // בדיקה אם המשרה הבודדת שמורה
        let isSaved = false;
        if (userId && data) {
            const { data: saveEntry } = await supabaseClient
                .from('saved_resources')
                .select('id')
                .eq('user_id', userId)
                .eq('saved_resource_id', data.job_id)
                .eq('saved_resource_type', 'position')
                .maybeSingle();
            isSaved = !!saveEntry;
        }

        result = data ? { ...data, is_saved: isSaved } : null;
        totalCount = data ? 1 : 0;
    } else {
      const to = from + limit - 1
      const textSearch = rawTextSearch.replace(/[%_(),]/g, ' ').trim()
      const category = rawCategory.trim()

      let query = supabaseClient
        .from('open_position')
        .select('job_id, job_title, company_name, company_id, location, time_posted, created_at, employment_type, seniority_level, companies(id, name, logo)', { count: 'exact' })
        .not('job_description_html', 'is', null)
        .order('created_at', { ascending: false })

      if (textSearch) {
        query = query.textSearch('fts_tokens', textSearch, {
          config: 'simple',
          type: 'websearch'
        })
      }

      if (category) {
        if (!allowedCategories.has(category)) {
          return c.json(
            {
              error: `Invalid category. Allowed values: ${Array.from(allowedCategories).join(', ')}`,
              success: false,
            },
            400,
          )
        }

        query = query.contains('categories', [category])
      }

      if (rawSeniorityLevels.length) {
        const dbValues = rawSeniorityLevels.flatMap((level: string) => {
          const mapped = SENIORITY_LEVEL_MAP[level]
          if (!mapped) throw new Error(`Invalid seniority_level: ${level}`)
          return mapped
        })
        query = query.in('seniority_level', [...new Set(dbValues)])
      }

      if (companyId) {
        query = query.eq('company_id', parseInt(companyId))
      }

        const { data, count, error } = await query.range(from, to);

        if (error) throw error;
        
        result = data;

        // --- העשרה: בדיקה אילו משרות שמורות (Batch Check) ---
        if (userId && data && data.length > 0) {
            const jobIds = data.map((j: any) => j.job_id);
            const { data: userSaves } = await supabaseClient
                .from('saved_resources')
                .select('saved_resource_id')
                .eq('user_id', userId)
                .eq('saved_resource_type', 'position')
                .in('saved_resource_id', jobIds);

            const savedSet = new Set(userSaves?.map((s: any) => s.saved_resource_id));
            
            result = data.map((job: any) => ({
                ...job,
                is_saved: savedSet.has(job.job_id)
            }));
        } else {
            result = data?.map((job: any) => ({ ...job, is_saved: false }));
        }

        totalCount = count || 0;
    }

    c.header('Cache-Control', 'private, max-age=300');
    return c.json({
        data: result,
        meta: {
            page: page,
            limit: limit,
            total: totalCount,
            has_more: id ? false : (result.length === limit && (from + result.length) < totalCount)
        },
        success: true
    });

  } catch (error: any) {
    return c.json({ error: error.message, success: false }, 500);
  }
})

// ====================================================================
// GET /api/jobs/:jobId/match-profile — candidate self-match against a job
// ====================================================================
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}

app.get('/:jobId/match-profile', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  // Feature is for candidates and admins; recruiters are excluded
  if (user.app_metadata?.role === 'recruiters') return c.json({ error: 'Forbidden' }, 403)

  const jobId = c.req.param('jobId')
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1. User embedding — same users_vectors as talent search → guaranteed consistency
  const { data: userVector } = await supabaseAdmin
    .from('users_vectors').select('vector').eq('user_id', user.id).maybeSingle()
  if (!userVector?.vector) {
    return c.json({ match_score: null, reason: 'no_profile_embedding' })
  }

  // 2. Job
  const { data: job } = await supabaseAdmin
    .from('open_position')
    .select('job_id, job_description_html, job_title')
    .eq('job_id', jobId)
    .single()
  if (!job) return c.json({ error: 'Job not found' }, 404)

  // 3. Job embedding — reuse job_embeddings cache (shared with recruiter talent search)
  let jobEmbedding: number[]
  const { data: cached } = await supabaseAdmin
    .from('job_embeddings').select('embedding').eq('job_id', jobId).single()
  if (cached?.embedding) {
    jobEmbedding = cached.embedding
  } else {
    const text = stripHtml(job.job_description_html ?? '') + ' ' + job.job_title
    try {
      jobEmbedding = await getEmbedding(text)
      await supabaseAdmin.from('job_embeddings').upsert({ job_id: jobId, embedding: jobEmbedding })
    } catch {
      return c.json({ error: 'Embedding service unavailable' }, 503)
    }
  }

  // 4. Cosine similarity — single pair, no index scan needed
  const rawSimilarity = cosineSimilarity(userVector.vector, jobEmbedding)

  // 5. Skills extraction + user profile fetch (parallel)
  const jdText = stripHtml(job.job_description_html ?? '') + ' ' + job.job_title
  const [jdSkills, userRow] = await Promise.all([
    extractSkillsFromJd(jdText),
    supabaseAdmin
      .from('talent_search_view')
      .select('skills, experience_years')
      .eq('uuid', user.id)
      .single(),
  ])

  const userSkills: string[] = userRow.data?.skills ?? []
  const experienceYears: number = userRow.data?.experience_years ?? 0

  // 6. Score — same computeMatchScore as talent search → identical result for same candidate+job
  const result = computeMatchScore(rawSimilarity, userSkills, jdSkills, experienceYears)
  return c.json(result)
})

// ====================================================================
// POST /api/jobs/:jobId/match-explanation — LLM narrative on match result
// Client sends the already-computed match result; we generate an expert explanation.
// ====================================================================
app.post('/:jobId/match-explanation', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  if (user.app_metadata?.role === 'recruiters') return c.json({ error: 'Forbidden' }, 403)

  const jobId = c.req.param('jobId')

  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  const {
    match_score,
    required = [],
    preferred = [],
    nice_to_have = [],
    experience_years_candidate,
    experience_years_required,
    lang = 'en',
  } = body

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Fetch job + candidate profile in parallel
  const [jobResult, profileResult] = await Promise.all([
    supabaseAdmin
      .from('open_position')
      .select('job_title, job_description_html')
      .eq('job_id', jobId)
      .single(),
    supabaseAdmin
      .from('talent_search_view')
      .select('headline, about, skills, experience, education, certifications, languages, experience_years')
      .eq('uuid', user.id)
      .single(),
  ])

  const job = jobResult.data
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const profile = profileResult.data
  const profileSkills: string[] = profile?.skills ?? []
  const profileExp: any[] = profile?.experience ?? []
  const profileEdu: any[] = profile?.education ?? []
  const profileCerts: any[] = profile?.certifications ?? []
  const profileLangs: any[] = profile?.languages ?? []

  // Build a concrete profile snapshot for the AI
  const profileSnapshot = [
    `Headline: ${profile?.headline || '(empty)'}`,
    `Bio (About): ${profile?.about ? `"${String(profile.about).slice(0, 250)}"` : '(empty — not filled in)'}`,
    `Skills section (${profileSkills.length}/20 slots used): ${profileSkills.join(', ') || '(none)'}`,
    `Experience (${profileExp.length} roles): ${
      profileExp.map((e: any) => {
        const co = typeof e.company === 'object' ? e.company?.name ?? '' : (e.company ?? '')
        const hasDesc = e.description && String(e.description).trim().length > 0
        return `"${e.title}" at ${co}${hasDesc ? '' : ' [NO DESCRIPTION]'}`
      }).join(', ') || '(none)'
    }`,
    `Education: ${profileEdu.map((e: any) => `${e.degree} in ${e.field}, ${e.institution}`).join('; ') || '(none)'}`,
    `Certifications: ${profileCerts.length > 0 ? profileCerts.map((c: any) => c.name).join(', ') : '(none)'}`,
    `Languages: ${profileLangs.map((l: any) => `${l.name} (${l.level})`).join(', ') || '(none)'}`,
  ].join('\n')

  const isHebrew = lang === 'he'
  const jdSnippet = stripHtml(job.job_description_html ?? '').slice(0, 500)

  const skillLines = (skills: { skill: string; has: boolean }[], label: string) =>
    skills.length
      ? `${label}:\n${skills.map(s => `  ${s.has ? '✓' : '✗'} ${s.skill}`).join('\n')}`
      : ''

  const expLine = experience_years_required != null
    ? (isHebrew
        ? `ניסיון: יש לך ${experience_years_candidate ?? 0} שנים, נדרש ${experience_years_required}+`
        : `Experience: you have ${experience_years_candidate ?? 0} years, role requires ${experience_years_required}+`)
    : ''

  const systemPrompt = isHebrew
    ? `את מנהלת בכירה בתחום משאבי אנוש ומיועצת קריירה ותיקה עם ניסיון של מעל 20 שנה בגיוס טכנולוגי, ניהול ארגוני ופיתוח הון אנושי בחברות טכנולוגיה. את משלבת אינטואיציה חדה של HR עם הבנה טכנית עמוקה. דברי ישירות, מקצועית ובצורה בונה — כמו יועצת מהימנה, לא כמי שמייצרת דו"חות. פני למועמדת בגוף נקבה ובלשון נוכח: "יש לך", "את מביאה", "כדאי לך", "הפרופיל שלך".`
    : `You are a veteran talent executive and career strategist with over 20 years spanning technical recruiting, people operations, and organizational leadership at high-growth technology companies. You combine razor-sharp HR instincts with deep technical fluency across software engineering, product, and management. Speak directly, professionally, and constructively — like a trusted advisor, not a report generator. Address the candidate in second person: "you have", "your profile", "your experience".`

  const userPrompt = isHebrew
    ? `נתחי את התאמת המועמדת למשרה בהתאם לפרופיל האמיתי שלה. כתבי הערכה מקצועית. החזירי JSON בלבד (ללא markdown). פני למועמדת בגוף נקבה ובלשון נוכח.

=== פרטי המשרה ===
משרה: ${job.job_title}
ציון: ${match_score}/98
${expLine}

${skillLines(required, 'כישורים חובה')}
${skillLines(preferred, 'כישורים יתרון')}
${skillLines(nice_to_have, 'נחמד שיש')}

תיאור המשרה: "${jdSnippet}..."

=== הפרופיל האמיתי של המועמדת ===
${profileSnapshot}

=== כללים לצעדים ===
לפחות 2 מתוך 3 הצעדים חייבים להיות המלצות ספציפיות לשיפור הפרופיל — עם ציון שם הסקשיין בפרופיל (Skills, Bio, Experience, Education, Certifications).
לדוגמה: "הוסיפי Docker לסקשיין Skills — יש לך עוד ${20 - profileSkills.length} מקומות פנויים"
לדוגמה: "הביוגרפיה שלך ריקה — הוסיפי פסקה שמציינת ניסיון ב-X שמופיע כדרישת חובה"
לדוגמה: "לתפקיד ב-${job.job_title} אין תיאור — הוסיפי נקודות בולט שמציגות ניסיון רלוונטי"
צעד אחד לפיתוח מקצועי חיצוני (קורס, סרטיפיקציה, פרויקט).
אל תמציאי — התבססי אך ורק על נתוני הפרופיל שניתנו.

{
  "summary": "2-3 משפטים: הערכה מקצועית של רמת ההתאמה והתמונה הכוללת, בלשון נוכח ונקבה",
  "strengths": "1-2 משפטים: מה ספציפית חיזק את הציון — מדויק לגבי כישורים וניסיון",
  "gaps": "1-2 משפטים: מה ספציפית הוריד את הציון — בונה ומדויק",
  "steps": ["שיפור פרופיל 1 ספציפי (ציון שם הסקשיין)", "שיפור פרופיל 2 ספציפי (ציון שם הסקשיין)", "פיתוח מקצועי חיצוני"]
}`
    : `Analyze this candidate's job match using their REAL profile data. Write a professional assessment. Return ONLY valid JSON (no markdown). Address the candidate in second person.

=== Job Details ===
Role: ${job.job_title}
Score: ${match_score}/98
${expLine}

${skillLines(required, 'Required Skills')}
${skillLines(preferred, 'Preferred Skills')}
${skillLines(nice_to_have, 'Nice-to-have')}

Job context: "${jdSnippet}..."

=== Candidate's Real Profile ===
${profileSnapshot}

=== Steps Rules ===
At least 2 of 3 steps must be specific profile improvement tips — naming the exact profile section (Skills, Bio/About, Experience, Education, Certifications).
Example: "Add Docker to your Skills section — you have ${20 - profileSkills.length} slots remaining"
Example: "Your Bio is empty — add a paragraph highlighting your X experience, which appears as a required skill"
Example: "Your ${job.job_title} role has no description — add bullet points showcasing relevant work"
One step for external professional development (course, certification, side project).
Do NOT invent anything — base all advice strictly on the profile data provided above.

{
  "summary": "2-3 sentences: professional assessment of fit quality and the overall picture",
  "strengths": "1-2 sentences: what specifically elevated the score — precise about skills and experience",
  "gaps": "1-2 sentences: what specifically reduced the score — constructive, specific, no filler",
  "steps": ["Specific profile improvement 1 (name the section)", "Specific profile improvement 2 (name the section)", "External professional development"]
}`

  try {
    const openai = new OpenAI({ apiKey: Deno.env.get('TEST_OPENAI_API_KEY') })

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.35,
      max_tokens: 700,
    })

    const raw = completion.choices[0].message.content || '{}'
    const explanation = JSON.parse(raw)
    return c.json(explanation)
  } catch (e) {
    console.error('match-explanation error:', e)
    return c.json({ error: 'Explanation service unavailable' }, 503)
  }
})

export default app

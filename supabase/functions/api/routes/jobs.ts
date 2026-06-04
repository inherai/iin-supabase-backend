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

  const { data: job } = await supabaseAdmin
    .from('open_position')
    .select('job_title, job_description_html')
    .eq('job_id', jobId)
    .single()
  if (!job) return c.json({ error: 'Job not found' }, 404)

  const isHebrew = lang === 'he'
  const jdSnippet = stripHtml(job.job_description_html ?? '').slice(0, 500)

  const skillLines = (skills: { skill: string; has: boolean }[], label: string) =>
    skills.length
      ? `${label}:\n${skills.map(s => `  ${s.has ? '✓' : '✗'} ${s.skill}`).join('\n')}`
      : ''

  const expLine = experience_years_required != null
    ? `Experience: candidate has ${experience_years_candidate ?? 0} years, role requires ${experience_years_required}+`
    : ''

  const systemPrompt = isHebrew
    ? `את יועצת קריירה בכירה עם ניסיון של מעל 20 שנה בגיוס טכנולוגי. פני תמיד למועמדת בגוף נקבה ובלשון נוכח: "יש לך", "את מביאה", "כדאי לך". ללא מבוא, ללא חזרות. כל משפט חייב לשאת ערך.`
    : `You are a veteran talent executive with 20+ years in technical recruiting. Address the candidate directly in second person. Be sharp and brief — no preamble, no filler. Every sentence must carry weight.`

  const userPrompt = isHebrew
    ? `הערכת התאמה — החזירי JSON בלבד (ללא markdown). כל שדה: משפט אחד, קצר ומדויק, בלשון נוכח ונקבה.

משרה: ${job.job_title}
ציון: ${match_score}/98
${expLine}

${skillLines(required, 'חובה')}
${skillLines(preferred, 'יתרון')}
${skillLines(nice_to_have, 'נחמד')}

הקשר: "${jdSnippet}..."

כללים לצעדים: לפחות 2 מתוך 3 צעדים חייבים להיות המלצות לשיפור הפרופיל (כגון: הדגשת ניסיון X, הוספת כישור Y לפרופיל, שינוי ניסוח Z). צעד אחד לפיתוח מקצועי חיצוני.

{
  "summary": "משפט אחד — רמת ההתאמה הכוללת",
  "strengths": "משפט אחד — מה ספציפית חיזק את הציון",
  "gaps": "משפט אחד — מה ספציפית הוריד את הציון",
  "steps": ["המלצה לשיפור פרופיל 1", "המלצה לשיפור פרופיל 2", "פיתוח מקצועי"]
}`
    : `Job match assessment — return ONLY valid JSON (no markdown). Each field: one sentence, direct second person ("you have", "your experience").

Role: ${job.job_title}
Score: ${match_score}/98
${expLine}

${skillLines(required, 'Required')}
${skillLines(preferred, 'Preferred')}
${skillLines(nice_to_have, 'Nice-to-have')}

Context: "${jdSnippet}..."

Steps rule: at least 2 of 3 steps must be profile improvement tips (e.g. highlight skill X on your profile, add certification Y, reword experience Z). One step for external professional development.

{
  "summary": "One sentence — overall fit quality",
  "strengths": "One sentence — what specifically boosted your score",
  "gaps": "One sentence — what specifically reduced your score",
  "steps": ["Profile improvement tip 1", "Profile improvement tip 2", "Professional development"]
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
      temperature: 0.25,
      max_tokens: 450,
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

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// ── Enrichment worker for open_position rows ────────────────────────────────
// Triggered by the `process_job_ai_v3` Database Webhook (INSERT on open_position)
// and (recommended) by a pg_cron safety-net every few minutes.
//
// It fills job_description_html + categories for jobs that have a raw
// job_description but no HTML yet. The career page only shows jobs where
// job_description_html IS NOT NULL, so an un-enriched job is invisible.
//
// Fixes vs the previous version:
//  • SELECT now requires job_description IS NOT NULL. Previously a cluster of
//    rows with a NULL job_description clogged the `LIMIT 10` fetch (no ORDER BY),
//    got skipped via `continue`, were never marked, and blocked every enrichable
//    job behind them — stalling the whole pipeline.
//  • Drains in an internal loop (bounded by a wall-clock budget) instead of the
//    old unauthenticated, fire-and-forget `fetch(req.url)` self-invoke that
//    silently 401'd and never advanced the queue.
//  • Best-effort rescue: for rows whose job_description is NULL, try to recover
//    the description text from original_source_json (the full Apify item) so a
//    scraper field-name change doesn't permanently hide jobs.
//  • Surfaces processed/failed counts in the response and logs, so a future
//    breakage is visible instead of silently returning 200.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const BATCH_SIZE = 20           // rows fetched per query
const CONCURRENCY = 3           // parallel OpenAI calls
const TIME_BUDGET_MS = 90_000   // stop starting new work after this (stay under the platform wall-clock limit)

const SYSTEM_PROMPT = `System Role: You are a specialist tech recruiter for "iin", a professional network for the Haredi community. Your goal is to transform raw job descriptions into a respectful, professional, and legally safe format.
Task:
1. Rewrite (English): Paraphrase completely, keep professional tone.
2. Translate (Hebrew): Professional translation, culturally appropriate for Haredi community (standard professional male/neutral addressing).
3. Format (HTML): Wrap in <h3>, <ul>, <li>, and <p>.
4. Categorize:
You MUST return ONLY categories from this EXACT list:
[Development, QA, Data, Management, Product]
Rules:
- Do NOT invent new categories.
- If no category matches, return [].


Output Format: Return ONLY a JSON object: {
  "english_html": "...",
  "hebrew_html": "...",
  "categories": ["Category1", "Category2"]
}`

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

// Pull a usable description out of the raw Apify item when the mapped
// job_description column is empty (e.g. the actor renamed its output field).
// Tries known keys first, then falls back to the longest string in the object.
function extractDescriptionFromJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  const KNOWN_KEYS = [
    'job_description', 'description', 'descriptionText', 'description_text',
    'jobDescription', 'job_description_text', 'descriptionHtml', 'description_html',
  ]
  for (const key of KNOWN_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim().length > 50) return v
  }
  // Heuristic fallback: the job description is almost always the longest text field.
  let longest = ''
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.length > longest.length) longest = v
  }
  return longest.trim().length > 200 ? longest : null
}

async function enrichOne(supabase: any, openaiApiKey: string, job: any): Promise<'ok' | 'failed'> {
  try {
    const source: string | null =
      (typeof job.job_description === 'string' && job.job_description.trim().length > 0)
        ? job.job_description
        : extractDescriptionFromJson(job.original_source_json)

    if (!source) {
      console.warn(`⚠️ job ${job.job_id}: no usable description (skipped)`)
      return 'failed'
    }

    const aiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Job Description: ${source}` },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => '')
      throw new Error(`OpenAI ${aiRes.status} ${aiRes.statusText} ${detail.slice(0, 200)}`)
    }

    const aiJson = await aiRes.json()
    const content = JSON.parse(aiJson.choices[0].message.content)
    const htmlContent =
      `<div dir="ltr">${content.english_html}</div><hr/><div dir="rtl">${content.hebrew_html}</div>`

    const { error: updateError } = await supabase
      .from('open_position')
      .update({ job_description_html: htmlContent, categories: content.categories })
      .eq('job_id', job.job_id)
    if (updateError) throw updateError

    return 'ok'
  } catch (err) {
    console.error(`❌ job ${job.job_id}:`, (err as Error).message)
    return 'failed'
  }
}

Deno.serve(async () => {
  const startedAt = Date.now()
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Prefer a real production key; fall back to the legacy secret name.
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY') || Deno.env.get('TEST_OPENAI_API_KEY')
    if (!openaiApiKey) {
      console.error('Critical: no OpenAI API key configured')
      return new Response(JSON.stringify({ error: 'missing_openai_key' }), { status: 500 })
    }

    let processed = 0
    let failed = 0
    let rescued = 0

    // Rescue pass FIRST: rows with a NULL or EMPTY job_description may still
    // carry the text inside original_source_json (the full Apify item). Recover
    // it into job_description so the drain loop below can enrich them this run.
    // Newest first, bounded to one batch — never blocks the main drain.
    const { data: maybeOrphans } = await supabase
      .from('open_position')
      .select('job_id, job_description, original_source_json')
      .is('job_description_html', null)
      .order('created_at', { ascending: false })
      .limit(BATCH_SIZE)
    for (const row of (maybeOrphans || []) as any[]) {
      if (typeof row.job_description === 'string' && row.job_description.trim().length > 0) continue
      const recovered = extractDescriptionFromJson(row.original_source_json)
      if (!recovered) continue
      const { error } = await supabase
        .from('open_position')
        .update({ job_description: recovered })
        .eq('job_id', row.job_id)
      if (!error) rescued++
    }

    // Drain enrichable rows until empty or out of time. Excluding NULL *and*
    // empty-string job_description is what unclogs the queue: content-less rows
    // can no longer monopolise the LIMIT fetch and stall everything. Ordering by
    // created_at DESC processes the newest (user-relevant) jobs first, so any
    // residual junk sits at the back and is never reached within a batch.
    while (Date.now() - startedAt < TIME_BUDGET_MS) {
      const { data: jobs, error: fetchError } = await supabase
        .from('open_position')
        .select('job_id, job_description, original_source_json')
        .is('job_description_html', null)
        .not('job_description', 'is', null)
        .neq('job_description', '')
        .order('created_at', { ascending: false })
        .limit(BATCH_SIZE)
      if (fetchError) throw fetchError
      if (!jobs || jobs.length === 0) break

      for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const chunk = jobs.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          chunk.map((j: any) => enrichOne(supabase, openaiApiKey, j)),
        ) as Array<'ok' | 'failed'>
        processed += results.filter((r) => r === 'ok').length
        failed += results.filter((r) => r === 'failed').length
        await delay(300)
      }
    }

    const summary = { processed, failed, rescued, elapsed_ms: Date.now() - startedAt }
    console.log('✅ enrichment run complete', summary)
    // Non-2xx when nothing succeeded but work was attempted, so failures are visible.
    const allFailed = processed === 0 && failed > 0
    return new Response(JSON.stringify(summary), { status: allFailed ? 500 : 200 })
  } catch (err) {
    console.error('Critical Error:', (err as Error).message)
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 })
  }
})

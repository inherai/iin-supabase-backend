import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    const apifyToken = Deno.env.get('APIFY_TOKEN')

    const body = await req.json().catch(() => ({}))
    const { search_term, location, jobs_entries, date_posted } = body

    // קריאה ל-Apify (נשאר בדיוק אותו דבר)
    const runResponse = await fetch(`https://api.apify.com/v2/acts/JkfTWxtpgfvcRQn3p/runs?token=${apifyToken}&waitForFinish=60`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        "location": location || "Israel",
        "search_term": search_term || "Engineer",
        "jobs_entries": jobs_entries || 5,
        "date_posted": date_posted || "past_week"
      })
    })

    const runData = await runResponse.json()
    const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${runData.data.defaultDatasetId}/items?token=${apifyToken}`)
    const items = await itemsResponse.json()

    if (!items || !items.length) return new Response(JSON.stringify({ message: "No jobs" }), { status: 200 })

    // מיפוי נתונים - שימי לב ש-job_description_html נשלח כ-null
    const jobsToInsert = items.map((item) => ({
      job_id: String(item.job_id),
      job_title: item.job_title,
      company_name: item.company_name,
      icon: item.company_logo_url,
      location: item.location,
      apply_link: item.apply_url,
      employment_type: item.employment_type,
      source: "LinkedIn", // או Glassdoor בהתאם לפונקציה
      time_posted: item.time_posted,
      job_description: item.job_description,
      job_description_html: null, // חשוב! זה מה שיפעיל את ה-Webhook
      seniority_level: item.seniority_level,
      salary_range: item.salary_range,
      created_at: new Date().toISOString(),
      original_source_json: item
    }))

    const { error: dbError } = await supabase.from('open_position').upsert(jobsToInsert, { onConflict: 'job_id' })
    if (dbError) throw dbError

    return new Response(JSON.stringify({ success: true, count: jobsToInsert.length }), { status: 200 })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
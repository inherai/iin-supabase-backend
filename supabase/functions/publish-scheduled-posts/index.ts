import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const API_URL = `${SUPABASE_URL}/functions/v1/api`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Find all scheduled posts whose time has arrived
    const { data: toPublish, error } = await supabaseAdmin
      .from('scheduled_posts')
      .select('id')
      .lte('scheduled_at', new Date().toISOString())

    if (error) throw error
    if (!toPublish || toPublish.length === 0) {
      return new Response(JSON.stringify({ published: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let published = 0
    let failed = 0

    for (const sp of toPublish) {
      try {
        const res = await fetch(`${API_URL}/posts/publish-scheduled`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scheduled_post_id: sp.id }),
        })

        if (res.ok) {
          published++
        } else {
          const body = await res.json().catch(() => ({}))
          console.error(`[publish-scheduled-posts] failed for id=${sp.id}:`, body)
          failed++
        }
      } catch (err) {
        console.error(`[publish-scheduled-posts] exception for id=${sp.id}:`, err)
        failed++
      }
    }

    return new Response(JSON.stringify({ published, failed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[publish-scheduled-posts] fatal error:', err)
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

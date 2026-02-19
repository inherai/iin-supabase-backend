import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const app = new Hono()
const allowedCategories = new Set(['Development', 'QA', 'Data', 'Management', 'Product'])

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
    const id = c.req.query('id')

    const page = parseInt(c.req.query('page') || '1')
    const limit = parseInt(c.req.query('limit') || '25')
    const from = (page - 1) * limit

    let result
    let totalCount = 0

    if (id) {
        // --- תרחיש א': שליפת משרה בודדת ---
        const { data, error } = await supabaseClient
            .from('open_position')
            .select('*')
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

      result = data
      totalCount = data ? 1 : 0
    } else {
      const to = from + limit - 1
      const textSearch = rawTextSearch.replace(/[%_(),]/g, ' ').trim()
      const category = rawCategory.trim()

      let query = supabaseClient
        .from('open_position')
        .select('*', { count: 'exact' })
        .not('job_description_html', 'is', null)
        .order('created_at', { ascending: false })

      if (textSearch) {
        query = query.or(`job_title.ilike.%${textSearch}%,company_name.ilike.%${textSearch}%`)
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

export default app

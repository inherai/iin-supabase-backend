// supabase/functions/api/routes/jobs.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const app = new Hono()

app.get('/', async (c) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
        throw new Error("Missing Secrets");
    }

    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    const searchTerm = c.req.query('search');
    const id = c.req.query('id');
    
    // --- התיקון כאן ---
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '25');
    // הורדנו את ההערה והגדרנו את from כאן כדי שיהיה מוכר בכל הפונקציה
    const from = (page - 1) * limit;

    let result;
    let totalCount = 0;

    if (id) {
        // --- תרחיש א': שליפת משרה בודדת ---
        const { data, error } = await supabaseClient
            .from('open_position')
            .select('*')
            .eq('job_id', id)
            .single();
        
        if (error) throw error;
        result = data;
        totalCount = data ? 1 : 0;

    } else {
        // --- תרחיש ב': רשימה עם דפדוף וחיפוש ---
        
        // לא צריך להגדיר את from שוב, הוא כבר מוגדר למעלה
        const to = from + limit - 1;

        let query = supabaseClient
            .from('open_position')
            .select('*', { count: 'exact' })
            .not('job_description_html', 'is', null)
            .order('created_at', { ascending: false });

        if (searchTerm) {
            query = query.or(`job_title.ilike.%${searchTerm}%,company_name.ilike.%${searchTerm}%`);
        }

        const { data, count, error } = await query.range(from, to);

        if (error) throw error;
        
        result = data;
        totalCount = count || 0;
    }

    // 3. החזרת התשובה
    return c.json({
        data: result,
        meta: {
            page: page,
            limit: limit,
            total: totalCount,
            // עכשיו from מוכר כאן ולא תהיה שגיאה
            has_more: id ? false : (result.length === limit && (from + result.length) < totalCount)
        },
        success: true
    });

  } catch (error: any) {
    return c.json({ 
        error: error.message, 
        success: false 
    }, 500);
  }
})

export default app
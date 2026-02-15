// supabase/functions/api/routes/jobs.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const app = new Hono()

// GET /api/jobs
app.get('/', async (c) => {
  try {
    // 1. הגדרת הקליינט
    // שימרתי את הלוגיקה שלך שמשתמשת ב-Service Role Key
    // זה אומר שהפונקציה רצה עם הרשאות אדמין (קריאה של כל המשרות)
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
        throw new Error("Missing Secrets");
    }

    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    // 2. קבלת הפרמטרים מה-URL (ב-Hono זה ממש פשוט)
    const searchTerm = c.req.query('search');
    const id = c.req.query('id');
    
    // המרה למספרים עם ברירת מחדל
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '25');

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
        
        // במשרה בודדת הספירה היא 1 או 0
        totalCount = data ? 1 : 0;

    } else {
        // --- תרחיש ב': רשימה עם דפדוף וחיפוש ---
        
        // חישוב הטווח
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let query = supabaseClient
            .from('open_position')
            .select('*', { count: 'exact' }) // מבקש גם את הספירה הכוללת
            .not('job_description_html', 'is', null)
            .order('created_at', { ascending: false });

        // סינון לפי חיפוש אם קיים
        if (searchTerm) {
            query = query.or(`job_title.ilike.%${searchTerm}%,company_name.ilike.%${searchTerm}%`);
        }

        // ביצוע השליפה בטווח המבוקש
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
            // חישוב אם יש עוד דפים (רק אם זה רשימה)
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
// supabase/functions/api/routes/summary.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// GET /api/summary
app.get('/', async (c) => {
  try {
    // מקבלים את הקליינט המאומת מה-Middleware הראשי
    const supabase = c.get('supabase')

    // 2. השליפה - הסיכום האחרון
    const { data, error } = await supabase
      .from('community_summaries') 
      .select('*')
      .order('created_at', { ascending: false }) // הכי חדש ראשון
      .limit(1)
      .single()

    // 3. טיפול במצב שאין נתונים (PGRST116)
    if (error) {
      if (error.code === 'PGRST116') {
        // מחזירים תשובה תקינה (200) עם null, בדיוק כמו בקוד המקורי
        return c.json({ data: null, message: "No summaries yet" })
      }
      // אם זו שגיאה אחרת (אמיתית), זורקים אותה ל-catch
      throw error
    }

    // 4. החזרת התשובה
    return c.json({ data })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app
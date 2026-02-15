// supabase/functions/api/routes/like.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

app.post('/', async (c) => {
  try {
    // 1. שליפת המשתמש המחובר מה-Middleware
    const user = c.get('user')
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // 2. שליפת הלקוח מה-Middleware (כבר מוגדר עם הטוקן של המשתמש)
    const supabase = c.get('supabase')

    // 3. קבלת הנתונים מהבקשה (אנחנו לא צריכים user_id, אנחנו יודעים מי זה!)
    const { target_id, target_type } = await c.req.json()

    if (!target_id || !target_type) {
      return c.json({ error: 'Missing target_id or target_type' }, 400)
    }

    // 4. בדיקה אם כבר קיים לייק
    const { data: existingLike, error: fetchError } = await supabase
      .from('likes')
      .select('id')
      .eq('user_id', user.id) // שימוש ב-ID הבטוח מהטוקן
      .eq('target_id', target_id)
      .maybeSingle()

    if (fetchError) {
      throw fetchError
    }

    // 5. לוגיקת Toggle (הוספה/הסרה)
    if (existingLike) {
      // --- הסרת לייק ---
      const { error: deleteError } = await supabase
        .from('likes')
        .delete()
        .eq('id', existingLike.id)

      if (deleteError) throw deleteError

      return c.json({ action: 'removed', target_id })
    } else {
      // --- הוספת לייק ---
      const { data: insertData, error: insertError } = await supabase
        .from('likes')
        .insert([{ 
          user_id: user.id, // שימוש ב-ID הבטוח
          target_id, 
          target_type 
        }])
        .select()
        .single()

      if (insertError) throw insertError

      return c.json({ action: 'added', data: insertData }, 201)
    }

  } catch (err) {
    console.error('Like error:', err)
    return c.json({ error: err.message }, 500)
  }
})

export default app
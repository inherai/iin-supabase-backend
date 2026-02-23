// supabase/functions/api/routes/like.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// Valid reaction types (like LinkedIn)
const VALID_REACTIONS = ['like', 'celebrate', 'support', 'love'] as const
type ReactionType = typeof VALID_REACTIONS[number]

app.post('/', async (c) => {
  try {
    // 1. שליפת המשתמש המחובר מה-Middleware
    const user = c.get('user')
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // 2. שליפת הלקוח מה-Middleware (כבר מוגדר עם הטוקן של המשתמש)
    const supabase = c.get('supabase')

    // 3. קבלת הנתונים מהבקשה - כולל reaction_type
    const { target_id, target_type, reaction_type = 'like' } = await c.req.json()

    if (!target_id || !target_type) {
      return c.json({ error: 'Missing target_id or target_type' }, 400)
    }

    // Validate reaction_type
    if (!VALID_REACTIONS.includes(reaction_type as ReactionType)) {
      return c.json({ error: `Invalid reaction_type. Must be one of: ${VALID_REACTIONS.join(', ')}` }, 400)
    }

    // בדיקה אם כבר קיימת ריאקציה מהסוג הזה
    const { data: existingReaction } = await supabase
      .from('likes')
      .select('id')
      .eq('user_id', user.id)
      .eq('target_id', target_id)
      .eq('target_type', target_type)
      .eq('reaction_type', reaction_type)
      .maybeSingle()

    if (existingReaction) {
      // אם קיימת - מחק אותה (toggle off)
      await supabase
        .from('likes')
        .delete()
        .eq('id', existingReaction.id)

      return c.json({ 
        action: 'removed', 
        target_id, 
        target_type,
        reaction_type 
      })
    }

    // אם לא קיימת - הוסף ריאקציה חדשה
    const { data: insertData, error: insertError } = await supabase
      .from('likes')
      .insert([{ 
        user_id: user.id,
        target_id, 
        target_type,
        reaction_type 
      }])
      .select()
      .single()

    if (insertError) throw insertError

    return c.json({ 
      action: 'added', 
      target_id,
      target_type,
      reaction_type,
      data: insertData 
    }, 201)

  } catch (err) {
    console.error('Reaction error:', err)
    return c.json({ error: err.message }, 500)
  }
})

export default app
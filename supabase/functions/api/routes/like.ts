// supabase/functions/api/routes/like.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// Valid reaction types (like LinkedIn)
const VALID_REACTIONS = ['like', 'celebrate', 'thank', 'love'] as const
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
    
    console.log('Received reaction request:', { user_id: user.id, target_id, target_type, reaction_type })

    if (!target_id || !target_type) {
      return c.json({ error: 'Missing target_id or target_type' }, 400)
    }

    // Validate reaction_type
    if (!VALID_REACTIONS.includes(reaction_type as ReactionType)) {
      return c.json({ error: `Invalid reaction_type. Must be one of: ${VALID_REACTIONS.join(', ')}` }, 400)
    }

    // בדיקה אם כבר קיימת ריאקציה על אותו יעד
    const { data: existingReaction, error: existingReactionError } = await supabase
      .from('likes')
      .select('id, reaction_type')
      .eq('user_id', user.id)
      .eq('target_id', target_id)
      .eq('target_type', target_type)
      .maybeSingle()

    if (existingReactionError) throw existingReactionError

    if (existingReaction) {
      // אם נבחר אותו סוג שוב - מחק (toggle off)
      if (existingReaction.reaction_type === reaction_type) {
        const { error: deleteError } = await supabase
          .from('likes')
          .delete()
          .eq('id', existingReaction.id)

        if (deleteError) throw deleteError

        return c.json({
          action: 'removed',
          target_id,
          target_type,
          reaction_type
        })
      }

      // אם נבחר סוג אחר - עדכן את הריאקציה הקיימת
      const { data: updatedData, error: updateError } = await supabase
        .from('likes')
        .update({ reaction_type })
        .eq('id', existingReaction.id)
        .select()
        .single()

      if (updateError) throw updateError

      return c.json({
        action: 'updated',
        target_id,
        target_type,
        reaction_type,
        data: updatedData
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

// GET /api/like?target_id=...&target_type=post[&reaction_type=like][&limit=100]
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supabase = c.get('supabase')

    const target_id = c.req.query('target_id')
    const target_type = c.req.query('target_type') // post | comment
    const reaction_type = c.req.query('reaction_type') as ReactionType | null
    const limitRaw = Number(c.req.query('limit') || '100')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100

    if (!target_id || !target_type) {
      return c.json({ error: 'Missing target_id or target_type' }, 400)
    }

    if (!['post', 'comment'].includes(target_type)) {
      return c.json({ error: 'Invalid target_type. Must be post or comment' }, 400)
    }

    if (reaction_type && !VALID_REACTIONS.includes(reaction_type)) {
      return c.json({ error: `Invalid reaction_type. Must be one of: ${VALID_REACTIONS.join(', ')}` }, 400)
    }

    let query = supabase
      .from('likes')
      .select('user_id,reaction_type,created_at')
      .eq('target_id', target_id)
      .eq('target_type', target_type)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (reaction_type) {
      query = query.eq('reaction_type', reaction_type)
    }

    const { data, error } = await query
    if (error) throw error

    const rows = data || []

    // Dedup by user_id just in case
    const seen = new Set<string>()
    const reaction_users = rows
      .filter((r: any) => {
        if (!r?.user_id) return false
        if (seen.has(r.user_id)) return false
        seen.add(r.user_id)
        return true
      })
      .map((r: any) => ({
        user_id: r.user_id,
        reaction_type: r.reaction_type as ReactionType,
      }))

    const reaction_counts = reaction_users.reduce((acc: Record<string, number>, r: any) => {
      acc[r.reaction_type] = (acc[r.reaction_type] || 0) + 1
      return acc
    }, {})

    return c.json({
      target_id,
      target_type,
      total_count: reaction_users.length,
      reaction_counts,
      reaction_users,
    })
  } catch (err: any) {
    console.error('Get reactions error:', err)
    return c.json({ error: err.message }, 500)
  }
})

export default app

// supabase/functions/api/middleware.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Context, Next } from 'https://deno.land/x/hono/mod.ts'

export const authMiddleware = async (c: Context, next: Next) => {
  // 1. דילוג מהיר על בקשות CORS Preflight
  if (c.req.method === 'OPTIONS') {
    return await next();
  }

  const authHeader = c.req.header('Authorization');
  
  // --- עצירה מוקדמת: אין טוקן בכלל ---
  if (!authHeader) {
    return c.json({ error: 'Unauthorized: Missing authentication token' }, 401);
  }

  // יש טוקן - ניצור קליינט של סופאבייס
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  
  // בדיקה מול סופאבייס: האם הטוקן באמת תקין ולא פג תוקף?
  const { data, error } = await supabaseClient.auth.getUser();
  
  // --- עצירה מוקדמת: הטוקן מזויף, שגוי או פג תוקף ---
  if (error || !data.user) {
    return c.json({ error: 'Unauthorized: Invalid or expired token' }, 401);
  }

  // הכל תקין! מזריקים לקונטקסט וממשיכים הלאה
  c.set('supabase', supabaseClient);
  c.set('user', data.user);

  await next();
}
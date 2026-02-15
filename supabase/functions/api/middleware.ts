// supabase/functions/api/middleware.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Context, Next } from 'https://deno.land/x/hono/mod.ts'

export const authMiddleware = async (c: Context, next: Next) => {
  // 1. דילוג מהיר על בקשות CORS Preflight (חוסך זמן ומשאבים)
  if (c.req.method === 'OPTIONS') {
    return await next();
  }

  const authHeader = c.req.header('Authorization');
  
  let supabaseClient;
  let user = null;

  if (authHeader) {
    // --- תרחיש א': יש טוקן ---
    supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    
    // בדיקה מהירה: האם הטוקן באמת תקין?
    const { data, error } = await supabaseClient.auth.getUser();
    if (!error && data.user) {
        user = data.user;
    }
  } else {
    // --- תרחיש ב': אין טוקן ---
    supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );
  }

  // הזרקה לקונטקסט
  c.set('supabase', supabaseClient);
  c.set('user', user);

  await next();
}
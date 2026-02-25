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

  // חסימת feed_participant מרואוטים מסוימים
  const role = data.user?.app_metadata?.role;
  if (role === 'feed_participant') {
    const path = c.req.path;
    const allowed = [
      '/api/me',
      '/api/posts',
      '/api/summary',     
      '/api/search-ai',    
      '/api/jobs',
      '/api/profile',
      '/api/like',
      '/api/companies',
      '/api/interests',
      '/api/work-preferences',
      '/api/languages',
      '/api/locations',
      '/api/educational-institutions',
      '/api/skills',
      '/api/degrees',
      '/api/fields-of-study',
      '/api/activity',     
      '/api/avatar',       
      '/api/saved-resources' 
    ];
    if (!allowed.some(p => path === p || path.startsWith(p + '/'))) {
      return c.json({ error: 'Access denied for anonymous users' }, 403);
    }
  }

  await next();
}
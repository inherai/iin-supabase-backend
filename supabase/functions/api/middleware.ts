// supabase/functions/api/middleware.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Context, Next } from 'https://deno.land/x/hono/mod.ts'
import * as jose from "https://deno.land/x/jose@v4.14.4/index.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// JWKS supports both ECC (P-256) and legacy HS256 keys automatically.
// jose caches the key set in memory — fetched once on cold start, not per request.
const JWKS = jose.createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

// Singleton admin client — created once per cold start, reused across all requests
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// In-memory cache: userId → timestamp of last successful users-table check
// Persists within the same Edge Function instance; TTL prevents stale entries
const userExistsCache = new Map<string, number>();
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function isUserActive(userId: string): Promise<boolean> {
  const cached = userExistsCache.get(userId);
  if (cached && Date.now() - cached < USER_CACHE_TTL_MS) return true;

  const { data } = await supabaseAdmin
    .from('users')
    .select('uuid')
    .eq('uuid', userId)
    .maybeSingle();

  if (data) userExistsCache.set(userId, Date.now());
  return !!data;
}

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

  const token = authHeader.replace('Bearer ', '');

  // אימות JWT עם JWKS — תומך ב-ECC (P-256) וב-legacy HS256, ללא בקשת רשת ל-GoTrue
  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, JWKS);
    payload = result.payload;
  } catch {
    return c.json({ error: 'Unauthorized: Invalid or expired token' }, 401);
  }

  const userId = payload.sub;
  if (!userId) {
    return c.json({ error: 'Unauthorized: Missing user ID in token' }, 401);
  }

  // בדיקת קיום משתמש בטבלת users — עם cache של 5 דקות
  const active = await isUserActive(userId);
  if (!active) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    return c.json({ error: 'User not found, deleted from auth' }, 404);
  }

  // בניית אובייקט user מה-JWT claims (מקביל ל-data.user מ-getUser())
  const user = {
    id: userId,
    email: payload.email as string ?? '',
    app_metadata: (payload.app_metadata as Record<string, any>) ?? {},
    user_metadata: (payload.user_metadata as Record<string, any>) ?? {},
  };

  // קליינט עם JWT של המשתמש לצורך RLS בשאילתות
  // persistSession: false נדרש ב-Edge Functions כדי שה-JWT יישלח נכון ל-PostgREST
  const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // הכל תקין! מזריקים לקונטקסט וממשיכים הלאה
  c.set('supabase', supabaseClient);
  c.set('user', user);

  // אדמינים עוקפים את כל בדיקות הרול
  if (user.app_metadata?.is_admin === true) {
    return await next();
  }

  // חסימת feed_participant מרואוטים מסוימים
  const role = user.app_metadata?.role;
  const path = c.req.path;
  const method = c.req.method;

  if (role === 'feed_participant') {
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
      '/api/saved-resources',
      '/api/company-insights'
    ];
    if (!allowed.some(p => path === p || path.startsWith(p + '/'))) {
      return c.json({ error: 'Access denied for anonymous users' }, 403);
    }
  }

  // חסימת recruiters מעדכון הגדרות פרטיות
  if (role === 'recruiters' && path.startsWith('/api/profile/privacy') && method === 'PUT') {
    return c.json({ error: 'Recruiters cannot update privacy settings' }, 403);
  }

  await next();
}

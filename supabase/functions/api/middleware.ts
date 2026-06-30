// supabase/functions/api/middleware.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Context, Next } from 'https://deno.land/x/hono/mod.ts'
import * as jose from "https://deno.land/x/jose@v4.14.4/index.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Hardcoded ECC P-256 public key — eliminates the JWKS network call on every cold start.
// Each cold start previously fetched /auth/v1/.well-known/jwks.json (counted as an auth
// request in the Supabase dashboard). With the key baked in, verification is purely local.
// If Supabase rotates the key (manual action in the dashboard), jwtVerify throws
// JWKSNoMatchingKey → verifyJwt falls back to REMOTE_JWKS automatically.
const LOCAL_JWKS = jose.createLocalJWKSet({
  keys: [{
    alg: "ES256", crv: "P-256", ext: true, key_ops: ["verify"],
    kid: "ebbce9be-0a05-4597-918e-cfa6d8c1a075", kty: "EC", use: "sig",
    x: "wN8h_jGdSCjqGoxSoqPGGiRH-w5fmUycc8T5sWgJ170",
    y: "Fo_zDCZgO_8lNXVclgNWaGyfQ1qGnW0fZ42-FNwhl7U",
  }],
});

const REMOTE_JWKS = jose.createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

async function verifyJwt(token: string): Promise<jose.JWTPayload> {
  try {
    const { payload } = await jose.jwtVerify(token, LOCAL_JWKS);
    return payload;
  } catch (err) {
    // Only fall back if the key is unrecognized (key rotation in Supabase dashboard).
    // Other errors (expired token, bad signature) are re-thrown immediately.
    if (err instanceof jose.errors.JWKSNoMatchingKey) {
      const { payload } = await jose.jwtVerify(token, REMOTE_JWKS);
      return payload;
    }
    throw err;
  }
}

// ⚠️  ADMIN CLIENT — bypasses ALL Supabase RLS policies.
// Use only for operations that cannot be done with the user's JWT (e.g. writing
// auth metadata, sending notifications, or reading data that the user is
// legitimately entitled to but that RLS intentionally hides from the client).
// Before adding any new usage: confirm with a second developer that there is no
// RLS-safe alternative, that the caller's entitlement has been verified in
// application code, and that no private data leaks to an unauthorised party.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// In-memory cache: userId → timestamp of last successful users-table check
// Persists within the same Edge Function instance; TTL prevents stale entries
const userExistsCache = new Map<string, number>();
const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes — aligns with JWT lifetime

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

  // Public routes — no authentication required
  if (c.req.path === '/api/platform-join-request' || c.req.path.startsWith('/api/platform-join-request/')) {
    return await next();
  }

  // Public profile share links — viewed by logged-out visitors outside the platform
  if (c.req.path === '/api/public-profile' || c.req.path.startsWith('/api/public-profile/')) {
    return await next();
  }

  // Internal cron endpoint — authenticated via service role key inside the handler
  if (c.req.path === '/api/posts/publish-scheduled') {
    return await next();
  }

  const authHeader = c.req.header('Authorization');

  // --- עצירה מוקדמת: אין טוקן בכלל ---
  if (!authHeader) {
    return c.json({ error: 'Unauthorized: Missing authentication token' }, 401);
  }

  const token = authHeader.replace('Bearer ', '');

  let payload: jose.JWTPayload;
  try {
    payload = await verifyJwt(token);
  } catch {
    return c.json({ error: 'Unauthorized: Invalid or expired token' }, 401);
  }

  const userId = payload.sub;
  if (!userId) {
    return c.json({ error: 'Unauthorized: Missing user ID in token' }, 401);
  }

  // בדיקת קיום משתמש בטבלת users — עם cache של 60 דקות (מתואם לתוקף ה-JWT)
  const active = await isUserActive(userId);
  if (!active) {
    return c.json({ error: 'Unauthorized' }, 401);
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
      '/api/company-insights',
      '/api/market-stats'
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

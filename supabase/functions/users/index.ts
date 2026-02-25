import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// פונקציית עזר לבדיקת תוקף ההזמנה
const isInviteExpired = (expiresAtValue: string | null) => {
  if (!expiresAtValue) return false; // אם אין תאריך תפוגה, היא תמיד ולידית
  const expiresAtMs = new Date(expiresAtValue).getTime();
  return expiresAtMs <= Date.now();
};

Deno.serve(async (req) => {
  // טיפול ב-CORS עבור ה-Frontend
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No Authorization header" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    // 1. אימות המשתמש מול ה-JWT (קבלת המייל וה-ID ישירות מסופאבייס)
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: authData, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "Invalid JWT token" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const userEmailFromJwt = authData.user.email?.toLowerCase().trim();
    const userIdFromJwt = authData.user.id;

    // 2. שליפת הטוקן מה-Body שנשלח מה-Frontend (ה-Callback)
    const { invite_token } = await req.json().catch(() => ({}));
    const cleanToken = invite_token?.trim();

    if (!cleanToken) {
      return new Response(JSON.stringify({ error: "invite_token is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    // 3. יצירת קליינט Admin (עם Service Role) לביצוע שינויים בטבלאות
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // 4. בדיקת ההזמנה בטבלת ה-invites
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from("invites")
      .select("id, recipient_email, status, expires_at")
      .eq("token", cleanToken)
      .maybeSingle();

    if (inviteError || !invite) {
      return new Response(JSON.stringify({ error: "Invite not found or invalid" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    // 5. בדיקת התאמת מייל (JWT מול ההזמנה)
    if (invite.recipient_email.toLowerCase().trim() !== userEmailFromJwt) {
      return new Response(JSON.stringify({ error: "This invite belongs to a different email" }), {
        status: 403,
        headers: jsonHeaders,
      });
    }

    // 6. בדיקת סטטוס ותוקף
    if (invite.status !== "pending") {
      return new Response(JSON.stringify({ error: "Invite has already been accepted" }), {
        status: 409,
        headers: jsonHeaders,
      });
    }

    if (isInviteExpired(invite.expires_at)) {
      return new Response(JSON.stringify({ error: "Invite has expired" }), {
        status: 410,
        headers: jsonHeaders,
      });
    }

    // --- הכל תקין! מבצעים את השינויים ---

    // 7. יצירת המשתמש בטבלת public.users
    const { error: insertError } = await supabaseAdmin
      .from("users")
      .upsert({ // שימוש ב-upsert למניעת קריסה במקרה של Refresh
        uuid: userIdFromJwt,
        email: userEmailFromJwt,
        status: "onboarding",
      });

    if (insertError) {
      throw new Error(`Failed to create user profile: ${insertError.message}`);
    }

    // 8. עדכון סטטוס ההזמנה
    const { error: updateError } = await supabaseAdmin
      .from("invites")
      .update({ status: "accepted" })
      .eq("token", cleanToken);

    if (updateError) {
      throw new Error(`Failed to update invite status: ${updateError.message}`);
    }

    return new Response(
      JSON.stringify({ message: "Registration completed", status: "onboarding" }),
      { status: 200, headers: jsonHeaders }
    );

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
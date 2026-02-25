import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const isInviteExpired = (expiresAtValue: string | null) => {
  if (!expiresAtValue) return false;
  const expiresAtMs = new Date(expiresAtValue).getTime();
  return expiresAtMs <= Date.now();
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  // הגדרת קליינט אדמין מראש כדי שיהיה זמין למחיקה במקרה של שגיאה
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  let currentUserId: string | null = null;

  // פונקציית עזר למחיקת המשתמש מה-Auth במקרה של כישלון
  const deleteAuthUser = async (id: string | null) => {
    if (id) {
      await supabaseAdmin.auth.admin.deleteUser(id);
      console.log(`User ${id} deleted from Auth due to failed validation.`);
    }
  };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No Authorization header" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

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

    currentUserId = authData.user.id;
    const userEmailFromJwt = authData.user.email?.toLowerCase().trim();

    const { invite_token } = await req.json().catch(() => ({}));
    const cleanToken = invite_token?.trim();

    if (!cleanToken) {
      await deleteAuthUser(currentUserId); // מחיקה כי אין טוקן
      return new Response(JSON.stringify({ error: "invite_token is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const { data: invite, error: inviteError } = await supabaseAdmin
      .from("invites")
      .select("id, recipient_email, status, expires_at")
      .eq("token", cleanToken)
      .maybeSingle();

    if (inviteError || !invite) {
      await deleteAuthUser(currentUserId); // מחיקה כי ההזמנה לא נמצאה
      return new Response(JSON.stringify({ error: "Invite not found or invalid" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    if (invite.recipient_email.toLowerCase().trim() !== userEmailFromJwt) {
      await deleteAuthUser(currentUserId); // מחיקה כי המייל לא תואם
      return new Response(JSON.stringify({ error: "Email does not match this invite" }), {
        status: 403,
        headers: jsonHeaders,
      });
    }

    if (invite.status !== "pending") {
      await deleteAuthUser(currentUserId); // מחיקה כי ההזמנה נוצלה
      return new Response(JSON.stringify({ error: "Invite has already been accepted" }), {
        status: 409,
        headers: jsonHeaders,
      });
    }

    if (isInviteExpired(invite.expires_at)) {
      await deleteAuthUser(currentUserId); // מחיקה כי פג תוקף
      return new Response(JSON.stringify({ error: "Invite has expired" }), {
        status: 410,
        headers: jsonHeaders,
      });
    }

    const { error: insertError } = await supabaseAdmin
      .from("users")
      .upsert({
        uuid: currentUserId,
        email: userEmailFromJwt,
        status: "onboarding",
      });

    if (insertError) throw insertError;

    const { error: updateError } = await supabaseAdmin
      .from("invites")
      .update({ status: "accepted" })
      .eq("token", cleanToken);

    if (updateError) throw updateError;

    return new Response(
      JSON.stringify({ message: "Registration completed", status: "onboarding" }),
      { status: 200, headers: jsonHeaders }
    );

  } catch (error: any) {
    // במקרה של שגיאה לא צפויה בשרת, ננסה למחוק את המשתמש ליתר ביטחון
    if (currentUserId) await deleteAuthUser(currentUserId);
    
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
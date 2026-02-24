import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const isInviteExpired = (expiresAtValue: string | null) => {
  if (!expiresAtValue) return true;
  const expiresAtMs = new Date(expiresAtValue).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
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

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: authData, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const normalizedUserEmail = authData.user.email?.trim()?.toLowerCase();
    if (!normalizedUserEmail) {
      return new Response(JSON.stringify({ error: "Email is missing in auth token" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const body = await req.json().catch(() => ({}));
    const inviteToken = body?.invite_token?.trim()?.toLowerCase();

    if (!inviteToken) {
      return new Response(JSON.stringify({ error: "invite_token is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: invite, error: inviteError } = await supabaseAdmin
      .from("invites")
      .select("id, recipient_email, status, expires_at")
      .eq("token", inviteToken)
      .maybeSingle();

    if (inviteError) {
      return new Response(JSON.stringify({ error: inviteError.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    if (!invite) {
      return new Response(JSON.stringify({ error: "Invite was not found" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }

    if ((invite.recipient_email ?? "").toLowerCase() !== normalizedUserEmail) {
      return new Response(JSON.stringify({ error: "Email does not match this invite" }), {
        status: 403,
        headers: jsonHeaders,
      });
    }

    if (invite.status !== "pending") {
      return new Response(JSON.stringify({ error: "Invite is no longer active" }), {
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

    const { error: insertUserError } = await supabaseAdmin
      .from("users")
      .insert([
        {
          uuid: authData.user.id,
          email: normalizedUserEmail,
          status: "onboarding",
        },
      ]);

    if (insertUserError) {
      return new Response(JSON.stringify({ error: insertUserError.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    const { error: updateError } = await supabaseAdmin
      .from("invites")
      .update({ status: "accepted" })
      .eq("token", inviteToken)
      .eq("status", "pending");

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    return new Response(
      JSON.stringify({
        message: "User created successfully",
        user: {
          uuid: authData.user.id,
          email: normalizedUserEmail,
          status: "onboarding",
        },
      }),
      {
        status: 200,
        headers: jsonHeaders,
      },
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});


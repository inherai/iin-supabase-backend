import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = new Hono();

const isInviteExpired = (expiresAtValue: string | null) => {
  if (!expiresAtValue) return true;
  const expiresAtMs = new Date(expiresAtValue).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs <= Date.now();
};

app.post("/", async (c) => {
  try {
    const user = c.get("user");

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const normalizedUserEmail = user.email?.trim()?.toLowerCase();
    if (!normalizedUserEmail) {
      return c.json({ error: "Email is missing in auth token" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const inviteToken = body?.invite_token?.trim()?.toLowerCase();

    if (!inviteToken) {
      return c.json({ error: "invite_token is required" }, 400);
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
      return c.json({ error: inviteError.message }, 500);
    }

    if (!invite) {
      return c.json({ error: "Invite was not found" }, 404);
    }

    if ((invite.recipient_email ?? "").toLowerCase() !== normalizedUserEmail) {
      return c.json({ error: "Email does not match this invite" }, 403);
    }

    if (invite.status !== "pending") {
      return c.json({ error: "Invite is no longer active" }, 409);
    }

    if (isInviteExpired(invite.expires_at)) {
      return c.json({ error: "Invite has expired" }, 410);
    }

    const { error: insertUserError } = await supabaseAdmin
      .from("users")
      .insert([
        {
          uuid: user.id,
          email: normalizedUserEmail,
          status: "onboarding",
        },
      ]);

    if (insertUserError) {
      return c.json({ error: insertUserError.message }, 500);
    }

    const { data: acceptedInvite, error: updateError } = await supabaseAdmin
      .from("invites")
      .update({ status: "accepted" })
      .eq("token", inviteToken)
      .eq("status", "pending")
      .select("id, status")
      .maybeSingle();

    if (updateError) {
      return c.json({ error: updateError.message }, 500);
    }

    if (!acceptedInvite) {
      return c.json({ error: "Invite is no longer active" }, 409);
    }

    return c.json(
      {
        message: "User created successfully",
        user: {
          uuid: user.id,
          email: normalizedUserEmail,
          status: "onboarding",
        },
      },
      200,
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;


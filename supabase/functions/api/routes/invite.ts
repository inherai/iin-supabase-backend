import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

app.post("/", async (c) => {
  try {
    const user = c.get("user");
    const supabase = c.get("supabase");

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const recipientEmail = body?.recipient_email?.trim();

    if (!recipientEmail) {
      return c.json({ error: "recipient_email is required" }, 400);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt);
    expiresAt.setDate(expiresAt.getDate() + 7);

    const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
    const token = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const invitePayload = {
      id: crypto.randomUUID(),
      inviter_id: user.id,
      token,
      recipient_email: recipientEmail,
      status: "pending",
      views_count: 0,
      last_viewed_at: null,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    const { data, error } = await supabase
      .from("invites")
      .insert([invitePayload])
      .select("*")
      .single();

    if (error) {
      return c.json({ error: error.message }, 400);
    }

    return c.json(data, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;

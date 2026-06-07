import { Hono } from "https://deno.land/x/hono/mod.ts";
import { sendInviteEmail } from "../lib/email.ts";

const app = new Hono();

const sanitizeEmail = (email: string) =>
  email.replace(/[​-‏‪-‮﻿­]/g, "").trim().toLowerCase();

// GET / — list invitations sent by the current user
app.get("/", async (c) => {
  try {
    const user = c.get("user");
    const supabase = c.get("supabase");

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { data, error } = await supabase
      .from("invites")
      .select("id, recipient_email, status, created_at, acquaintance_source")
      .eq("inviter_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    return c.json(data ?? []);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// POST / — create a new invitation
app.post("/", async (c) => {
  try {
    const user = c.get("user");
    const supabase = c.get("supabase");

    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const recipientEmail = body?.recipient_email ?? "";
    const personalNote = body?.personal_note?.trim();
    const acquaintanceSource = body?.acquaintance_source?.trim();
    const termsAccepted = body?.terms_accepted;

    if (!recipientEmail.trim()) {
      return c.json({ error: "recipient_email is required" }, 400);
    }
    if (!acquaintanceSource) {
      return c.json({ error: "acquaintance_source is required" }, 400);
    }
    if (termsAccepted !== true) {
      return c.json({ error: "terms_accepted must be true" }, 400);
    }

    const normalizedRecipientEmail = sanitizeEmail(recipientEmail);

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("uuid")
      .eq("email", normalizedRecipientEmail)
      .maybeSingle();

    if (existingUserError) {
      return c.json({ error: existingUserError.message }, 500);
    }
    if (existingUser) {
      return c.json({ error: "recipient already exists" }, 409);
    }

    // Rate limit: max 5 invitations per 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { count, error: countError } = await supabase
      .from("invites")
      .select("id", { count: "exact", head: true })
      .eq("inviter_id", user.id)
      .gte("created_at", sevenDaysAgo.toISOString());

    if (countError) {
      return c.json({ error: countError.message }, 500);
    }
    if ((count ?? 0) >= 5) {
      return c.json({ error: "Weekly invitation limit reached" }, 429);
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
      recipient_email: normalizedRecipientEmail,
      personal_note: personalNote || null,
      acquaintance_source: acquaintanceSource,
      terms_accepted: true,
      terms_accepted_at: createdAt.toISOString(),
      status: "pending",
      role: "community",
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

    // Fetch inviter name for the email
    const { data: inviterProfile } = await supabase
      .from("users")
      .select("name")
      .eq("uuid", user.id)
      .maybeSingle();

    const inviterName = inviterProfile?.name ?? "A Duallin member";

    // Send invitation email — failure is logged but does not fail the request
    sendInviteEmail({
      to: normalizedRecipientEmail,
      inviterName,
      token,
      personalNote: personalNote || null,
      expiresAt: expiresAt.toISOString(),
    }).catch((err) => {
      console.error("Failed to send invite email:", err.message);
    });

    return c.json(data, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;

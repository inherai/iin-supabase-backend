import { Hono } from "https://deno.land/x/hono/mod.ts";
import { sendInviteEmail } from "../lib/email.ts";
import { calculateProfileStrength, calculateActivityScore, getWeeklyLimit } from "./_scoreHelpers.ts";

const app = new Hono();

const sanitizeEmail = (email: string) =>
  email.replace(/[​-‏‪-‮﻿­]/g, "").trim().toLowerCase();

function startOfCalendarWeek(): Date {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const start = new Date(now);
  start.setDate(now.getDate() - day);
  start.setHours(0, 0, 0, 0);
  return start;
}

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

// GET /count — weekly usage for the current user
app.get("/count", async (c) => {
  try {
    const user = c.get("user");
    const supabase = c.get("supabase");
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const [countRes, cacheRes] = await Promise.all([
      supabase
        .from("invites")
        .select("id", { count: "exact", head: true })
        .eq("inviter_id", user.id)
        .gte("created_at", startOfCalendarWeek().toISOString()),
      supabase
        .from("users")
        .select("profile_strength_cache, activity_score_cache, scores_cached_at")
        .eq("uuid", user.id)
        .single(),
    ]);

    if (countRes.error) return c.json({ error: countRes.error.message }, 500);

    const cacheData = cacheRes.data;
    const cacheAge = cacheData?.scores_cached_at
      ? Date.now() - new Date(cacheData.scores_cached_at).getTime()
      : Infinity;
    const cacheWarm = cacheAge < 4 * 60 * 60 * 1000
      && cacheData?.profile_strength_cache != null
      && cacheData?.activity_score_cache != null;

    let profilePct: number;
    let activityScore: number;

    if (cacheWarm) {
      profilePct    = cacheData.profile_strength_cache;
      activityScore = cacheData.activity_score_cache;
    } else {
      const { data: userData } = await supabase
        .from("users")
        .select("created_at")
        .eq("uuid", user.id)
        .single();
      const actualDays = userData?.created_at
        ? Math.floor((Date.now() - new Date(userData.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      const [strength, activity] = await Promise.all([
        calculateProfileStrength(supabase, user.id),
        calculateActivityScore(supabase, user.id, user.email, actualDays),
      ]);
      profilePct    = strength.percentage;
      activityScore = activity.score;
      supabase.from("users").update({
        profile_strength_cache: profilePct,
        activity_score_cache: activityScore,
        scores_cached_at: new Date().toISOString(),
      }).eq("uuid", user.id).then(() => {});
    }

    const limit = getWeeklyLimit(activityScore, profilePct);
    return c.json({ used: countRes.count ?? 0, limit });
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

    const inviterRole = user.app_metadata?.role;
    if (inviterRole === "recruiters" || inviterRole === "feed_participant") {
      return c.json({ error: "Forbidden" }, 403);
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

    const { data: existingInvite, error: existingInviteError } = await supabase
      .from("invites")
      .select("id")
      .eq("recipient_email", normalizedRecipientEmail)
      .eq("status", "pending")
      .maybeSingle();

    if (existingInviteError) {
      return c.json({ error: existingInviteError.message }, 500);
    }
    if (existingInvite) {
      return c.json({ error: "recipient already invited" }, 409);
    }

    // Gate check: account age, profile strength, activity score
    const { data: inviterData, error: inviterDataError } = await supabase
      .from("users")
      .select("created_at, profile_strength_cache, activity_score_cache, scores_cached_at")
      .eq("uuid", user.id)
      .single();

    if (inviterDataError) {
      return c.json({ error: inviterDataError.message }, 500);
    }

    const actualDays = inviterData?.created_at
      ? Math.floor((Date.now() - new Date(inviterData.created_at).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    if (actualDays < 10) {
      return c.json({ error: "invite_gate_failed", reason: "new_user", daysLeft: 10 - actualDays }, 403);
    }

    const cacheAge = inviterData?.scores_cached_at
      ? Date.now() - new Date(inviterData.scores_cached_at).getTime()
      : Infinity;
    const cacheWarm = cacheAge < 4 * 60 * 60 * 1000
      && inviterData?.profile_strength_cache != null
      && inviterData?.activity_score_cache != null;

    let profilePct: number;
    let activityScore: number;

    if (cacheWarm) {
      profilePct    = inviterData.profile_strength_cache;
      activityScore = inviterData.activity_score_cache;
    } else {
      const [strength, activity] = await Promise.all([
        calculateProfileStrength(supabase, user.id),
        calculateActivityScore(supabase, user.id, user.email, actualDays),
      ]);
      profilePct    = strength.percentage;
      activityScore = activity.score;
      supabase.from("users").update({
        profile_strength_cache: profilePct,
        activity_score_cache: activityScore,
        scores_cached_at: new Date().toISOString(),
      }).eq("uuid", user.id).then(() => {});
    }

    if (profilePct < 70) {
      return c.json({ error: "invite_gate_failed", reason: "profile" }, 403);
    }
    if (activityScore < 31) {
      return c.json({ error: "invite_gate_failed", reason: "activity" }, 403);
    }

    // Rate limit: dynamic weekly limit based on scores
    const weeklyLimit = getWeeklyLimit(activityScore, profilePct);
    const { count, error: countError } = await supabase
      .from("invites")
      .select("id", { count: "exact", head: true })
      .eq("inviter_id", user.id)
      .gte("created_at", startOfCalendarWeek().toISOString());

    if (countError) {
      return c.json({ error: countError.message }, 500);
    }
    if ((count ?? 0) >= weeklyLimit) {
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
      .select("first_name, last_name")
      .eq("uuid", user.id)
      .maybeSingle();

    const inviterName = inviterProfile
      ? [inviterProfile.first_name, inviterProfile.last_name].filter(Boolean).join(" ")
      : "a duallin member";

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

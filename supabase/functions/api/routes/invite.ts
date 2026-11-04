import { Hono } from "https://deno.land/x/hono/mod.ts";
import { sendInviteEmail } from "../lib/email.ts";
import { calculateProfileStrength, calculateActivityScore, getWeeklyLimit, startOfCalendarWeek, activeWeekBonus } from "./_scoreHelpers.ts";
import { supabaseAdmin } from "../middleware.ts";

const app = new Hono();

const sanitizeEmail = (email: string) =>
  email.replace(/[​-‏‪-‮﻿­]/g, "").trim().toLowerCase();

const isInviteExpired = (expiresAtValue: string | null) => {
  if (!expiresAtValue) return true;
  const expiresAtMs = new Date(expiresAtValue).getTime();
  if (Number.isNaN(expiresAtMs)) return true;
  return expiresAtMs <= Date.now();
};

type GateFailure = { reason: "new_user"; daysLeft: number } | { reason: "profile" } | { reason: "activity" };

type InviteQuota = {
  unlimited: boolean;
  weekBonus: number;
  scoreLimit: number; // getWeeklyLimit of the scores, even while a gate fails (0 for new users)
  gateFailure: GateFailure | null;
};

// Invites allowed this week: the score-based limit (none while a gate fails) plus any
// admin-granted bonus for this week. An admin grant also lifts the gates.
const effectiveLimit = (quota: InviteQuota) =>
  (quota.gateFailure ? 0 : quota.scoreLimit) + quota.weekBonus;

async function getInviteQuota(supabase: any, user: any): Promise<InviteQuota> {
  // invite_allowances is service-role only, so members cannot grant themselves invites
  const [inviterRes, allowanceRes] = await Promise.all([
    supabase
      .from("users")
      .select("created_at, profile_strength_cache, activity_score_cache, scores_cached_at")
      .eq("uuid", user.id)
      .single(),
    supabaseAdmin
      .from("invite_allowances")
      .select("unlimited, week_bonus, week_bonus_start")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (inviterRes.error) throw new Error(inviterRes.error.message);
  // A failed read only loses the admin grant; the member falls back to the normal rules
  if (allowanceRes.error) console.error("invite_allowances read failed:", allowanceRes.error.message);
  const allowance = allowanceRes.error ? null : allowanceRes.data;

  const unlimited = allowance?.unlimited === true;
  const weekBonus = activeWeekBonus(allowance);
  if (unlimited) return { unlimited, weekBonus, scoreLimit: 0, gateFailure: null };

  const inviterData = inviterRes.data;
  const actualDays = inviterData?.created_at
    ? Math.floor((Date.now() - new Date(inviterData.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  if (actualDays < 7) {
    return { unlimited, weekBonus, scoreLimit: 0, gateFailure: { reason: "new_user", daysLeft: 7 - actualDays } };
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

  const scoreLimit = getWeeklyLimit(activityScore, profilePct);
  if (profilePct < 70) {
    return { unlimited, weekBonus, scoreLimit, gateFailure: { reason: "profile" } };
  }
  if (activityScore < 31) {
    return { unlimited, weekBonus, scoreLimit, gateFailure: { reason: "activity" } };
  }
  return { unlimited, weekBonus, scoreLimit, gateFailure: null };
}

const countInvitesThisWeek = (supabase: any, userId: string) =>
  supabase
    .from("invites")
    .select("id", { count: "exact", head: true })
    .eq("inviter_id", userId)
    .gte("created_at", startOfCalendarWeek().toISOString());

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
      .select("id, recipient_email, status, created_at, expires_at, acquaintance_source, personal_note")
      .eq("inviter_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    // Pending invites past their expiry are only flipped to "expired" in the DB
    // when someone opens the link, so derive the effective status here
    const invites = (data ?? []).map((inv: any) =>
      inv.status === "pending" && isInviteExpired(inv.expires_at)
        ? { ...inv, status: "expired" }
        : inv
    );

    // Flag recipients who joined in the meantime (e.g. via someone else's invite),
    // so the client can show "joined" instead of offering a pointless re-invite
    const recipientEmails = [...new Set(invites.map((inv: any) => inv.recipient_email))];
    let memberEmails = new Set<string>();
    if (recipientEmails.length > 0) {
      const { data: members } = await supabase
        .from("users")
        .select("email")
        .in("email", recipientEmails);
      memberEmails = new Set((members ?? []).map((m: any) => m.email));
    }

    return c.json(invites.map((inv: any) => ({
      ...inv,
      recipient_is_member: memberEmails.has(inv.recipient_email),
    })));
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

    const [countRes, quota] = await Promise.all([
      countInvitesThisWeek(supabase, user.id),
      getInviteQuota(supabase, user),
    ]);

    if (countRes.error) return c.json({ error: countRes.error.message }, 500);

    return c.json({
      used: countRes.count ?? 0,
      // Without a grant, the gates are the client's to show (its scores are fresher than
      // this cache), so the limit stays score-based rather than dropping to 0
      limit: quota.gateFailure && quota.weekBonus === 0 ? quota.scoreLimit : effectiveLimit(quota),
      week_bonus: quota.weekBonus,
      unlimited: quota.unlimited,
    });
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

    const isAdmin = user.app_metadata?.is_admin === true;
    const inviterRole = user.app_metadata?.role;
    if (!isAdmin && (inviterRole === "recruiters" || inviterRole === "feed_participant")) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const recipientEmail = body?.recipient_email ?? "";
    const personalNote = body?.personal_note?.trim();
    const acquaintanceSource = body?.acquaintance_source?.trim();
    const termsAccepted = body?.terms_accepted;
    const requestedRole = body?.role === "recruiters" ? "recruiters" : "community";

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

    const { data: pendingInvites, error: existingInviteError } = await supabase
      .from("invites")
      .select("id, expires_at")
      .eq("recipient_email", normalizedRecipientEmail)
      .eq("status", "pending");

    if (existingInviteError) {
      return c.json({ error: existingInviteError.message }, 500);
    }

    const hasActiveInvite = (pendingInvites ?? []).some(
      (inv: any) => !isInviteExpired(inv.expires_at),
    );
    if (hasActiveInvite) {
      return c.json({ error: "recipient already invited" }, 409);
    }

    // Any remaining pending invites are past expiry — mark them expired so the
    // recipient can be re-invited as if she was never invited
    const staleInviteIds = (pendingInvites ?? []).map((inv: any) => inv.id);
    if (staleInviteIds.length > 0) {
      const { error: expireError } = await supabase
        .from("invites")
        .update({ status: "expired" })
        .in("id", staleInviteIds);
      if (expireError) {
        return c.json({ error: expireError.message }, 500);
      }
    }

    if (!isAdmin) {
      const [quota, countRes] = await Promise.all([
        getInviteQuota(supabase, user),
        countInvitesThisWeek(supabase, user.id),
      ]);

      if (!quota.unlimited) {
        // Gate check: account age, profile strength, activity score — lifted by an admin bonus
        if (quota.gateFailure && quota.weekBonus === 0) {
          return c.json({ error: "invite_gate_failed", ...quota.gateFailure }, 403);
        }

        // Rate limit: dynamic weekly limit based on scores, plus this week's admin bonus
        if (countRes.error) {
          return c.json({ error: countRes.error.message }, 500);
        }
        if ((countRes.count ?? 0) >= effectiveLimit(quota)) {
          return c.json({ error: "Weekly invitation limit reached" }, 429);
        }
      }
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
      role: isAdmin ? requestedRole : "community",
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

import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateProfileStrength, calculateActivityScore, getWeeklyLimit } from './_scoreHelpers.ts';
import OpenAI from "https://esm.sh/openai@4";
import { sendInviteEmail } from '../lib/email.ts';

const app = new Hono();

const getAdminClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

const sanitizeEmail = (email: string) =>
  email.replace(/[​-‏‪-‮﻿­]/g, "").trim().toLowerCase();

// Admin guard — 404 to avoid revealing the endpoint exists
app.use("*", async (c, next) => {
  const user = c.get("user");
  if (!user?.app_metadata?.is_admin) {
    return c.json({ error: "Not Found" }, 404);
  }
  await next();
});

// ==================== DASHBOARD ====================

app.get("/dashboard", async (c) => {
  const db = getAdminClient();
  const [
    { count: usersCount },
    { count: pendingInvitesCount },
    { count: acceptedInvitesCount },
    { count: companiesCount },
  ] = await Promise.all([
    db.from("users").select("*", { count: "exact", head: true }),
    db.from("invites").select("*", { count: "exact", head: true }).eq("status", "pending"),
    db.from("invites").select("*", { count: "exact", head: true }).eq("status", "accepted"),
    db.from("companies").select("*", { count: "exact", head: true }),
  ]);

  return c.json({
    users_count: usersCount || 0,
    pending_invitations_count: pendingInvitesCount || 0,
    accepted_invitations_count: acceptedInvitesCount || 0,
    companies_count: companiesCount || 0,
  });
});

// ==================== ANALYTICS ====================

// PostgREST caps unranged selects at db-max-rows (1000) — page through to get every row.
async function fetchAllRows(db: ReturnType<typeof getAdminClient>, table: string, select: string, applyFilters?: (q: any) => any) {
  const PAGE_SIZE = 1000;
  const rows: any[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = db.from(table).select(select);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

app.get("/analytics", async (c) => {
  try {
  const db = getAdminClient();

  const [activities, users, invites, postAuthors, commentAuthors, jobAppliers, jobSavers, reactionRows] = await Promise.all([
    fetchAllRows(db, "user_activity", "*"),
    fetchAllRows(
      db,
      "users",
      "uuid, first_name, last_name, email, created_at, status, profile_strength_cache, activity_score_cache, experience",
      (q) => q.not("email", "like", "deleted_%@deleted.local")
    ),
    fetchAllRows(db, "invites", "id, inviter_id, recipient_email, status, created_at"),
    // Source tables — full history, unlike user_activity counters which only run since tracking launch
    // posts have no created_at — publish date is sent_at
    fetchAllRows(db, "posts", "posted_by_uuid, sent_at", (q) =>
      q.not("posted_by_uuid", "is", null).not("post_type", "is", null).neq("post_type", "email")
    ),
    // comments have no posted_by_uuid column — authors are identified by sender email
    fetchAllRows(db, "comments", "sender, created_at", (q) => q.not("sender", "is", null)),
    fetchAllRows(db, "job_applications", "user_id, job_id, status, applied_at, apply_clicked_at"),
    fetchAllRows(db, "saved_resources", "user_id", (q) => q.eq("saved_resource_type", "position")),
    fetchAllRows(db, "likes", "user_id, created_at"),
  ]);

  const userMap = new Map(users.map((u) => [u.uuid, u]));

  const merged = activities.map((a) => {
    const u = userMap.get(a.user_id);
    return {
      ...a,
      name: [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Unknown",
      email: u?.email ?? null,
    };
  });

  const now = Date.now();
  const D = 86_400_000;
  const isActive = (u: any, days: number) =>
    u.last_active_at && now - new Date(u.last_active_at).getTime() < days * D;

  const dau = merged.filter((u) => isActive(u, 1)).length;
  const wau = merged.filter((u) => isActive(u, 7)).length;
  const mau = merged.filter((u) => isActive(u, 30)).length;
  const mauUsers = merged.filter((u) => isActive(u, 30));

  const totalUsers = users.length;
  const newUsers7d = users.filter(
    (u) => u.created_at && now - new Date(u.created_at).getTime() < 7 * D
  ).length;

  const usersByStatus = {
    active: users.filter((u) => u.status === "Active").length,
    onboarding: users.filter((u) => u.status === "onboarding").length,
    inactive: users.filter((u) => u.status === "Inactive").length,
  };

  const sumField = (arr: any[], key: string) =>
    arr.reduce((s, u) => s + (Number(u[key]) || 0), 0);

  const totalFeedTimeSec = sumField(merged, "total_feed_time_seconds");
  const totalPosts = sumField(merged, "total_posts");
  const totalComments = sumField(merged, "total_comments");
  const totalConnectionsRaw = sumField(merged, "total_connections");
  const totalFeedVisits = sumField(merged, "total_feed_visits");

  // User segments
  const powerUsers = merged.filter(
    (u) => u.current_streak_days >= 3 && u.total_posts >= 1 && u.total_connections >= 3
  ).length;
  const atRisk = merged.filter((u) => {
    if (!u.last_active_at) return false;
    const age = now - new Date(u.last_active_at).getTime();
    return age >= 7 * D && age < 30 * D;
  }).length;
  const dormant = merged.filter(
    (u) => u.last_active_at && now - new Date(u.last_active_at).getTime() >= 30 * D
  ).length;
  const neverInActivity = merged.filter((u) => !u.last_active_at).length;
  const neverActive = Math.max(0, totalUsers - merged.length) + neverInActivity;

  // Streaks
  const streakUsers = merged.filter((u) => u.current_streak_days > 0);
  const longestPlatform = merged.reduce(
    (m, u) => Math.max(m, u.longest_streak_days || 0), 0
  );

  // Distribution helper
  const bucket = (key: string, ranges: [string, number, number][]) =>
    ranges.map(([label, lo, hi]) => ({
      label,
      count: merged.filter((u) => {
        const v = Number(u[key]) || 0;
        return v >= lo && (hi === Infinity ? true : v <= hi);
      }).length,
    }));

  // Leaderboard helper
  const leaderboard = (key: string) =>
    [...merged]
      .sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0))
      .slice(0, 10)
      .map((u) => ({
        user_id: u.user_id,
        name: u.name,
        email: u.email,
        current_streak_days: u.current_streak_days || 0,
        longest_streak_days: u.longest_streak_days || 0,
        total_posts: u.total_posts || 0,
        total_comments: u.total_comments || 0,
        total_connections: u.total_connections || 0,
        total_feed_visits: u.total_feed_visits || 0,
        total_feed_time_seconds: u.total_feed_time_seconds || 0,
        total_reactions_received: u.total_reactions_received || 0,
        total_comments_received: u.total_comments_received || 0,
        last_active_at: u.last_active_at || null,
      }));

  // ── Invitations ──
  const invitesAccepted = invites.filter((i) => i.status === "accepted").length;
  const invitesPending = invites.filter((i) => i.status === "pending").length;

  // Per-day series, last 30 days, zero-filled; each day's invites split by current status
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const perDayMap = new Map<string, { accepted: number; pending: number; other: number }>();
  for (let i = 29; i >= 0; i--) {
    perDayMap.set(dayKey(new Date(now - i * D)), { accepted: 0, pending: 0, other: 0 });
  }
  for (const inv of invites) {
    if (!inv.created_at) continue;
    const entry = perDayMap.get(dayKey(new Date(inv.created_at)));
    if (!entry) continue;
    if (inv.status === "accepted") entry.accepted++;
    else if (inv.status === "pending") entry.pending++;
    else entry.other++;
  }
  const invitesPerDay = [...perDayMap.entries()].map(([date, v]) => ({ date, ...v }));

  // Top inviters (all time)
  const byInviter = new Map<string, { sent: number; accepted: number }>();
  for (const inv of invites) {
    if (!inv.inviter_id) continue;
    const e = byInviter.get(inv.inviter_id) ?? { sent: 0, accepted: 0 };
    e.sent++;
    if (inv.status === "accepted") e.accepted++;
    byInviter.set(inv.inviter_id, e);
  }
  const inviterName = (uuid: string) => {
    const u = userMap.get(uuid);
    return {
      name: [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Unknown",
      email: u?.email ?? null,
    };
  };
  const topInviters = [...byInviter.entries()]
    .sort((a, b) => b[1].sent - a[1].sent)
    .slice(0, 10)
    .map(([uuid, v]) => ({ user_id: uuid, ...inviterName(uuid), sent: v.sent, accepted: v.accepted }));

  // Unused weekly quotas — same calendar-week window as the invite route (Sunday start)
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekStartMs = weekStart.getTime();

  const usedThisWeek = new Map<string, number>();
  let invitesThisWeek = 0;
  for (const inv of invites) {
    if (!inv.created_at || new Date(inv.created_at).getTime() < weekStartMs) continue;
    invitesThisWeek++;
    if (inv.inviter_id) usedThisWeek.set(inv.inviter_id, (usedThisWeek.get(inv.inviter_id) ?? 0) + 1);
  }

  const quotas = users
    .filter((u) => u.status === "Active")
    .map((u) => {
      const hasCache = u.activity_score_cache != null && u.profile_strength_cache != null;
      const weeklyLimit = getWeeklyLimit(u.activity_score_cache ?? 0, u.profile_strength_cache ?? 0);
      const used = usedThisWeek.get(u.uuid) ?? 0;
      return {
        user_id: u.uuid,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || "Unknown",
        email: u.email ?? null,
        weekly_limit: weeklyLimit,
        used_this_week: used,
        remaining: Math.max(0, weeklyLimit - used),
        estimated: !hasCache,
      };
    })
    .filter((q) => q.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || b.used_this_week - a.used_this_week);

  const unusedQuotaTotal = quotas.reduce((s, q) => s + q.remaining, 0);

  // ── Unique participation ──
  // Historical counts come straight from the source tables (all-time, distinct users);
  // only excludes deleted users (absent from userMap).
  const distinctUsers = (rows: any[], key: string) =>
    new Set(rows.map((r) => r[key]).filter((id) => id && userMap.has(id))).size;
  const userEmails = new Set(
    users.map((u) => (u.email || "").toLowerCase()).filter(Boolean)
  );
  const countWhere = (fn: (u: any) => boolean) => merged.filter(fn).length;
  const appliedRows = jobAppliers.filter((r) => r.status === "applied");
  const participation = {
    unique_posters: distinctUsers(postAuthors, "posted_by_uuid"),
    unique_commenters: new Set(
      commentAuthors
        .map((r) => (r.sender || "").toLowerCase())
        .filter((e) => userEmails.has(e))
    ).size,
    job_apply_clickers: distinctUsers(jobAppliers, "user_id"),
    job_appliers: distinctUsers(appliedRows, "user_id"),
    job_savers: distinctUsers(jobSavers, "user_id"),
    // The three below run on new tracking (record_job_activity) — counted since it was deployed
    job_board_users: countWhere(
      (u) => (u.total_job_board_visits || 0) > 0 || (u.total_job_searches || 0) > 0
    ),
    job_searchers: countWhere((u) => (u.total_job_searches || 0) > 0),
    job_viewers: countWhere((u) => (u.total_job_views || 0) > 0),
  };

  // ── Job applications over time (30d) ──
  // applied rows dated by applied_at, click-only rows by apply_clicked_at
  const appsPerDayMap = new Map<string, { applied: number; clicked: number }>();
  for (let i = 29; i >= 0; i--) {
    appsPerDayMap.set(dayKey(new Date(now - i * D)), { applied: 0, clicked: 0 });
  }
  for (const a of jobAppliers) {
    const isApplied = a.status === "applied";
    const ts = isApplied ? (a.applied_at ?? a.apply_clicked_at) : a.apply_clicked_at;
    if (!ts) continue;
    const e = appsPerDayMap.get(dayKey(new Date(ts)));
    if (!e) continue;
    if (isApplied) e.applied++;
    else e.clicked++;
  }
  // ── Top jobs & companies by applications ──
  const byJob = new Map<string, { clicks: number; applied: number }>();
  for (const a of jobAppliers) {
    if (a.job_id == null) continue;
    const key = String(a.job_id);
    const e = byJob.get(key) ?? { clicks: 0, applied: 0 };
    e.clicks++;
    if (a.status === "applied") e.applied++;
    byJob.set(key, e);
  }

  // Resolve job titles/companies only for jobs that have applications (chunked .in to keep URLs short)
  const appliedJobIds = [...byJob.keys()];
  const positions: any[] = [];
  for (let i = 0; i < appliedJobIds.length; i += 200) {
    const { data, error } = await db
      .from("open_position")
      .select("id, job_title, company_name, companies:company_id(name)")
      .in("id", appliedJobIds.slice(i, i + 200));
    if (error) throw error;
    positions.push(...(data ?? []));
  }
  const posMap = new Map(positions.map((p) => [String(p.id), p]));
  const companyOf = (p: any) => p?.companies?.name ?? p?.company_name ?? "Unknown";

  const topJobsByApplications = [...byJob.entries()]
    .sort((a, b) => b[1].clicks - a[1].clicks)
    .slice(0, 10)
    .map(([id, v]) => {
      const p = posMap.get(id);
      return {
        job_id: id,
        title: p?.job_title ?? "Unknown position",
        company: companyOf(p),
        clicks: v.clicks,
        applied: v.applied,
      };
    });

  const byCompany = new Map<string, { clicks: number; applied: number }>();
  for (const [id, v] of byJob) {
    const name = companyOf(posMap.get(id));
    const e = byCompany.get(name) ?? { clicks: 0, applied: 0 };
    e.clicks += v.clicks;
    e.applied += v.applied;
    byCompany.set(name, e);
  }
  const topCompaniesByApplications = [...byCompany.entries()]
    .sort((a, b) => b[1].clicks - a[1].clicks)
    .slice(0, 10)
    .map(([company, v]) => ({ company, ...v }));

  // Most viewed jobs — soft-fail while the views_count migration hasn't run yet
  let topViewedJobs: { job_id: string; title: string; company: string; views: number }[] = [];
  try {
    const { data: viewed, error } = await db
      .from("open_position")
      .select("job_id, job_title, company_name, views_count, companies:company_id(name)")
      .gt("views_count", 0)
      .order("views_count", { ascending: false })
      .limit(10);
    if (!error) {
      topViewedJobs = (viewed ?? []).map((p: any) => ({
        job_id: p.job_id,
        title: p.job_title ?? "Unknown position",
        company: companyOf(p),
        views: p.views_count,
      }));
    }
  } catch (_) { /* column not migrated yet */ }

  const jobApplications = {
    total_clicks: jobAppliers.length,
    total_applied: appliedRows.length,
    per_day: [...appsPerDayMap.entries()].map(([date, v]) => ({ date, ...v })),
    top_jobs: topJobsByApplications,
    top_companies: topCompaniesByApplications,
    top_viewed: topViewedJobs,
  };

  // ── Experience distribution ──
  // Mirrors calculate_experience_years (talent search): year-only precision,
  // any role with a valid startDate counts as at least 1 year
  const nowYear = new Date().getFullYear();
  const expYears = (exp: any): number => {
    if (!Array.isArray(exp) || exp.length === 0) return 0;
    let total = 0;
    for (const e of exp) {
      const startYear = parseInt(String(e?.startDate ?? "").slice(0, 4), 10);
      if (!Number.isFinite(startYear) || startYear <= 0) continue;
      if (e?.current === true || String(e?.current) === "true") {
        total += Math.max(nowYear - startYear, 1);
      } else if (e?.endDate) {
        const endYear = parseInt(String(e.endDate).slice(0, 4), 10);
        total += Math.max((Number.isFinite(endYear) ? endYear : nowYear) - startYear, 1);
      }
    }
    return total;
  };
  const userYears = users.map((u) => expYears(u.experience));
  const withExp = userYears.filter((y) => y > 0);
  const experienceAnalytics = {
    with_experience: withExp.length,
    avg_years: withExp.length
      ? Math.round((withExp.reduce((s, y) => s + y, 0) / withExp.length) * 10) / 10
      : 0,
    distribution: ([
      ["Not listed", 0, 0],
      ["1–2y", 1, 2],
      ["3–5y", 3, 5],
      ["6–9y", 6, 9],
      ["10y+", 10, Infinity],
    ] as [string, number, number][]).map(([label, lo, hi]) => ({
      label,
      count: userYears.filter((y) => y >= lo && (hi === Infinity || y <= hi)).length,
    })),
  };

  // ── Content activity per day (30d): posts, comments, reactions + who posted ──
  const contentPerDay = new Map<
    string,
    { posts: number; comments: number; reactions: number; posterIds: Set<string> }
  >();
  for (let i = 29; i >= 0; i--) {
    contentPerDay.set(dayKey(new Date(now - i * D)), {
      posts: 0, comments: 0, reactions: 0, posterIds: new Set(),
    });
  }
  for (const p of postAuthors) {
    if (!p.sent_at) continue;
    const e = contentPerDay.get(dayKey(new Date(p.sent_at)));
    if (!e) continue;
    e.posts++;
    if (p.posted_by_uuid) e.posterIds.add(p.posted_by_uuid);
  }
  for (const cm of commentAuthors) {
    if (!cm.created_at) continue;
    const e = contentPerDay.get(dayKey(new Date(cm.created_at)));
    if (e) e.comments++;
  }
  for (const r of reactionRows) {
    if (!r.created_at) continue;
    const e = contentPerDay.get(dayKey(new Date(r.created_at)));
    if (e) e.reactions++;
  }
  const contentActivity = {
    total_posts_all_time: postAuthors.length,
    total_comments_all_time: commentAuthors.length,
    total_reactions_all_time: reactionRows.length,
    per_day: [...contentPerDay.entries()].map(([date, v]) => ({
      date,
      posts: v.posts,
      comments: v.comments,
      reactions: v.reactions,
      posters: [...v.posterIds].map((id) => {
        const u = userMap.get(id);
        return [u?.first_name, u?.last_name].filter(Boolean).join(" ") || "Unknown";
      }),
    })),
  };

  return c.json({
    generated_at: new Date().toISOString(),
    total_users: totalUsers,
    user_statuses: usersByStatus,
    total_in_activity: merged.length,
    dau,
    wau,
    mau,
    stickiness_pct: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : 0,
    new_users_7d: newUsers7d,
    total_feed_visits: totalFeedVisits,
    total_feed_time_hours: Math.round((totalFeedTimeSec / 3600) * 10) / 10,
    avg_feed_time_per_mau_minutes:
      mauUsers.length > 0
        ? Math.round((sumField(mauUsers, "total_feed_time_seconds") / mauUsers.length / 60) * 10) / 10
        : 0,
    avg_feed_visits_per_mau:
      mauUsers.length > 0
        ? Math.round((sumField(mauUsers, "total_feed_visits") / mauUsers.length) * 10) / 10
        : 0,
    total_posts: totalPosts,
    total_comments: totalComments,
    avg_posts_per_mau:
      mauUsers.length > 0
        ? Math.round((sumField(mauUsers, "total_posts") / mauUsers.length) * 10) / 10
        : 0,
    total_connections_pairs: Math.floor(totalConnectionsRaw / 2),
    avg_connections_per_user:
      merged.length > 0
        ? Math.round((totalConnectionsRaw / merged.length) * 10) / 10
        : 0,
    users_with_streak: streakUsers.length,
    users_7plus_streak: merged.filter((u) => u.current_streak_days >= 7).length,
    avg_streak_active:
      streakUsers.length > 0
        ? Math.round((sumField(streakUsers, "current_streak_days") / streakUsers.length) * 10) / 10
        : 0,
    longest_streak_platform: longestPlatform,
    segments: {
      power_users: powerUsers,
      active_7d: wau,
      at_risk: atRisk,
      dormant,
      never_active: neverActive,
    },
    feed_time_distribution: bucket("total_feed_time_seconds", [
      ["< 1 min", 0, 59],
      ["1–5 min", 60, 299],
      ["5–30 min", 300, 1799],
      ["30m–2h", 1800, 7199],
      ["2h+", 7200, Infinity],
    ]),
    streak_distribution: bucket("current_streak_days", [
      ["0 days", 0, 0],
      ["1–2", 1, 2],
      ["3–6", 3, 6],
      ["7–13", 7, 13],
      ["14+", 14, Infinity],
    ]),
    posts_distribution: bucket("total_posts", [
      ["0", 0, 0],
      ["1–2", 1, 2],
      ["3–9", 3, 9],
      ["10–24", 10, 24],
      ["25+", 25, Infinity],
    ]),
    top_streaks: leaderboard("current_streak_days"),
    top_posters: leaderboard("total_posts"),
    top_feed_time: leaderboard("total_feed_time_seconds"),
    top_connectors: leaderboard("total_connections"),
    top_received_reactions: leaderboard("total_reactions_received"),
    participation,
    job_applications: jobApplications,
    content_activity: contentActivity,
    experience: experienceAnalytics,
    invites: {
      total: invites.length,
      unique_inviters: byInviter.size,
      accepted: invitesAccepted,
      pending: invitesPending,
      acceptance_rate_pct:
        invites.length > 0 ? Math.round((invitesAccepted / invites.length) * 1000) / 10 : 0,
      this_week: invitesThisWeek,
      per_day: invitesPerDay,
      top_inviters: topInviters,
      unused_quota_total: unusedQuotaTotal,
      quotas: quotas.slice(0, 100),
    },
  });
  } catch (err: any) {
    console.error("analytics error:", err);
    return c.json({ error: err?.message ?? "analytics failed" }, 500);
  }
});

// ==================== USERS ====================

app.get("/users", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";
  const status = c.req.query("status") || "";
  const role = c.req.query("role") || "";
  const sortBy = c.req.query("sortBy") || "created_at";
  const sortDir = c.req.query("sortDir") === "asc";
  const offset = (page - 1) * limit;

  let query = db.from("users").select("*", { count: "exact" })
    .not("email", "like", "deleted_%@deleted.local");

  if (search) {
    query = query.or(
      `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
    );
  }
  if (status) query = query.eq("status", status);
  if (role) query = query.eq("role", role);

  const sortableColumns = ["created_at", "first_name", "last_name", "email", "status", "role", "company"];
  const safeSort = sortableColumns.includes(sortBy) ? sortBy : "created_at";

  const { data: users, error, count } = await query
    .order(safeSort, { ascending: sortDir })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const uuids = (users || []).map((u: any) => u.uuid);
  const emails = (users || []).map((u: any) => u.email).filter(Boolean);

  const [
    { data: posts },
    { data: comments },
    { data: likes },
    { data: connections },
  ] = await Promise.all([
    emails.length > 0
      ? db.from("posts").select("sender").in("sender", emails)
          .not("post_type", "is", null).neq("post_type", "email")
      : Promise.resolve({ data: [] }),
    emails.length > 0
      ? db.from("comments").select("sender, posts!inner(post_type)").in("sender", emails)
          .not("posts.post_type", "is", null).neq("posts.post_type", "email")
      : Promise.resolve({ data: [] }),
    uuids.length > 0
      ? db.from("likes").select("user_id").in("user_id", uuids)
      : Promise.resolve({ data: [] }),
    uuids.length > 0
      ? db.from("connections").select("requester_id,receiver_id").in("requester_id", uuids).eq("status", "accepted")
      : Promise.resolve({ data: [] }),
  ]);

  const postsMap = new Map<string, number>();
  const commentsMap = new Map<string, number>();
  const likesMap = new Map<string, number>();
  const connectionsMap = new Map<string, number>();

  for (const p of posts || []) {
    postsMap.set(p.sender, (postsMap.get(p.sender) || 0) + 1);
  }
  for (const cm of comments || []) {
    commentsMap.set(cm.sender, (commentsMap.get(cm.sender) || 0) + 1);
  }
  for (const l of likes || []) {
    likesMap.set(l.user_id, (likesMap.get(l.user_id) || 0) + 1);
  }
  for (const conn of connections || []) {
    connectionsMap.set(conn.requester_id, (connectionsMap.get(conn.requester_id) || 0) + 1);
  }

  // Also count received connections
  const { data: receivedConnections } = uuids.length > 0
    ? await db.from("connections").select("receiver_id").in("receiver_id", uuids).eq("status", "accepted")
    : { data: [] };

  for (const conn of receivedConnections || []) {
    connectionsMap.set(conn.receiver_id, (connectionsMap.get(conn.receiver_id) || 0) + 1);
  }

  const enriched = (users || []).map((u: any) => ({
    ...u,
    posts_count: postsMap.get(u.email) || 0,
    comments_count: commentsMap.get(u.email) || 0,
    likes_count: likesMap.get(u.uuid) || 0,
    connections_count: connectionsMap.get(u.uuid) || 0,
  }));

  return c.json({
    users: enriched,
    pagination: { page, limit, total: count, totalPages: Math.ceil((count || 0) / limit) },
  });
});

app.get("/users/:id", async (c) => {
  const db = getAdminClient();
  const userId = c.req.param("id");

  const { data: user, error } = await db
    .from("users")
    .select("*")
    .eq("uuid", userId)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!user) return c.json({ error: "User not found" }, 404);

  const email = user.email;

  const [
    { count: postsCount },
    { count: commentsCount },
    { count: likesCount },
    { count: connectionsCount },
    { count: viewsCount },
  ] = await Promise.all([
    db.from("posts").select("*", { count: "exact", head: true }).eq("sender", email)
      .not("post_type", "is", null).neq("post_type", "email"),
    db.from("comments").select("id, posts!inner(post_type)", { count: "exact", head: true }).eq("sender", email)
      .not("posts.post_type", "is", null).neq("posts.post_type", "email"),
    db.from("likes").select("*", { count: "exact", head: true }).eq("user_id", userId),
    db.from("connections").select("*", { count: "exact", head: true })
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq("status", "accepted"),
    db.from("profile_views").select("*", { count: "exact", head: true }).eq("viewed_id", userId),
  ]);

  return c.json({
    ...user,
    posts_count: postsCount || 0,
    comments_count: commentsCount || 0,
    likes_count: likesCount || 0,
    connections_count: connectionsCount || 0,
    views_count: viewsCount || 0,
  });
});

app.post("/users/:id/refresh-scores", async (c) => {
  const db = getAdminClient();
  const userId = c.req.param("id");

  const { data: user, error } = await db
    .from("users")
    .select("uuid,email,created_at")
    .eq("uuid", userId)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!user) return c.json({ error: "User not found" }, 404);

  const actualDays = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));

  const [strengthResult, activityResult] = await Promise.all([
    calculateProfileStrength(db, userId),
    calculateActivityScore(db, userId, user.email, actualDays),
  ]);

  const cachedAt = new Date().toISOString();
  await db.from("users").update({
    profile_strength_cache: strengthResult.percentage,
    activity_score_cache: activityResult.score,
    scores_cached_at: cachedAt,
  }).eq("uuid", userId);

  return c.json({
    profile_strength: strengthResult.percentage,
    activity_score: activityResult.score,
    scores_cached_at: cachedAt,
  });
});

app.delete("/users/:id", async (c) => {
  const db = getAdminClient();
  const userId = c.req.param("id");

  // 1. Fetch user — need full details for log + email/image for downstream ops
  const { data: user, error: fetchErr } = await db
    .from("users").select("uuid,email,image,cover_image_url,first_name,last_name,role,status,created_at").eq("uuid", userId).maybeSingle();
  if (fetchErr) return c.json({ error: fetchErr.message }, 500);
  if (!user) return c.json({ error: "User not found" }, 404);

  const oldEmail = user.email;
  const deletedEmail = `deleted_${userId}@deleted.local`;

  // 1b. Log deletion before touching any data
  const admin = c.get("user");
  await db.from("deleted_users_log").insert({
    deleted_by_admin_uuid: admin.id,
    user_uuid: user.uuid,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    role: user.role,
    status: user.status,
    joined_at: user.created_at,
  });

  // 2. Re-key posts/comments FIRST — before users.email changes
  if (oldEmail) {
    await db.from("posts").update({ sender: deletedEmail }).eq("sender", oldEmail);
    await db.from("comments").update({ sender: deletedEmail }).eq("sender", oldEmail);
  }

  // 3. Storage cleanup (best-effort, non-fatal)
  const getStoragePath = (fullUrl: string | null, bucketName: string): string | null => {
    if (!fullUrl) return null;
    const marker = `/${bucketName}/`;
    const idx = fullUrl.indexOf(marker);
    if (idx === -1) return null;
    return decodeURIComponent(fullUrl.slice(idx + marker.length));
  };
  const imagePath = getStoragePath(user.image, "profile-images");
  const coverPath = getStoragePath(user.cover_image_url, "profile-headers");

  await Promise.allSettled([
    imagePath ? db.storage.from("profile-images").remove([imagePath]) : Promise.resolve(),
    coverPath ? db.storage.from("profile-headers").remove([coverPath]) : Promise.resolve(),
    db.storage.from("attachments").list(userId).then(({ data: files }) => {
      if (files?.length) {
        const paths = files.map((f: any) => `${userId}/${f.name}`);
        return db.storage.from("attachments").remove(paths);
      }
    }),
  ]);

  // 4. Hard delete activity/relationship data (parallel — users row still exists, no FK issues)
  //    messages kept for chat history but sender_id nullified (FK to auth.users is NO ACTION)
  await Promise.all([
    db.from("messages").update({ sender_id: null }).eq("sender_id", userId),
    db.from("post_impressions").delete().eq("user_id", userId),
    db.from("saved_resources").delete().eq("user_id", userId),
    db.from("profile_views").delete().or(`viewer_id.eq.${userId},viewed_id.eq.${userId}`),
    db.from("likes").delete().eq("user_id", userId),
    db.from("connections").delete().or(`requester_id.eq.${userId},receiver_id.eq.${userId}`),
    db.from("notifications").delete().or(`user_id.eq.${userId},actor_id.eq.${userId}`),

    db.from("users_vectors").delete().eq("user_id", userId),
  ]);

  // 5. Remove from companies.employees array
  const { data: companiesWithUser } = await db
    .from("companies").select("id,employees").contains("employees", [userId]);
  if (companiesWithUser?.length) {
    await Promise.all(companiesWithUser.map((co: any) =>
      db.from("companies").update({
        employees: co.employees.filter((e: string) => e !== userId),
      }).eq("id", co.id)
    ));
  }

  // 6. Anonymize user row — keep it so posts resolve to "duallin Member [deleted]"
  //    NOTE: is_anonymous intentionally omitted — setting it triggers handle_anonymous_transition()
  //    which can roll back the entire update if it errors internally.
  const { error: updateErr } = await db.from("users").update({
    // identity
    first_name: "duallin Member",
    last_name: "[deleted]",
    name: null,
    email: deletedEmail,
    // nullable text fields → null
    headline: null,
    about: null,
    location: null,
    phone: null,
    image: null,
    cover_image_url: null,
    // nullable arrays → null
    skills: null,
    interests: null,
    work_preferences: null,
    privacy_picture: null,
    privacy_lastname: null,
    privacy_contact_details: null,
    // a deleted account's public profile link (if any) must stop resolving
    public_profile_enabled: false,
    // NOT NULL jsonb fields → empty array (cannot be null)
    languages: [],
    experience: [],
    education: [],
    certifications: [],
  }).eq("uuid", userId);
  if (updateErr) return c.json({ error: updateErr.message }, 500);

  // 7. Delete auth user LAST — public.users FK was dropped via migration fix_drop_users_auth_fk.sql
  //    so no constraint blocks this. If auth user was already deleted (e.g. retry), skip gracefully.
  const { error: authErr } = await db.auth.admin.deleteUser(userId);
  if (authErr) {
    const msg = authErr.message.toLowerCase();
    if (!msg.includes("not found")) {
      // Auth deletion failed but public data is already anonymized — log and surface the partial failure
      console.error(`[admin-delete] auth.deleteUser failed for ${userId}: ${authErr.message}`);
      return c.json({ error: authErr.message, partial: true }, 500);
    }
  }

  return c.json({ success: true });
});

// ==================== DELETED USERS LOG ====================

app.get("/deleted-users", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const offset = (page - 1) * limit;

  const { data, error, count } = await db
    .from("deleted_users_log")
    .select("*", { count: "exact" })
    .order("deleted_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    deleted_users: data || [],
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
});

// ==================== INVITATIONS ====================

app.get("/invitations", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";
  const status = c.req.query("status") || "";
  const sortBy = c.req.query("sortBy") || "created_at";
  const sortDir = c.req.query("sortDir") === "asc";
  const offset = (page - 1) * limit;

  let query = db.from("invites").select("*", { count: "exact" });

  if (search) query = query.ilike("recipient_email", `%${search}%`);
  if (status) query = query.eq("status", status);

  const sortableColumns = ["created_at", "expires_at", "views_count", "recipient_email", "status"];
  const safeSort = sortableColumns.includes(sortBy) ? sortBy : "created_at";

  const { data: invites, error, count } = await query
    .order(safeSort, { ascending: sortDir })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const inviterIds = [...new Set((invites || []).map((i: any) => i.inviter_id).filter(Boolean))];
  const acceptedEmails = (invites || [])
    .filter((i: any) => i.status === "accepted")
    .map((i: any) => i.recipient_email)
    .filter(Boolean);

  const [invitersResult, redeemersResult] = await Promise.all([
    inviterIds.length > 0
      ? db.from("users").select("uuid,first_name,last_name,email").in("uuid", inviterIds)
      : Promise.resolve({ data: [] }),
    acceptedEmails.length > 0
      ? db.from("users").select("uuid,first_name,last_name,email,created_at").in("email", acceptedEmails)
      : Promise.resolve({ data: [] }),
  ]);

  const invitersMap = new Map((invitersResult.data || []).map((u: any) => [u.uuid, u]));
  const redeemerMap = new Map((redeemersResult.data || []).map((u: any) => [u.email, u]));

  const enriched = (invites || []).map((inv: any) => ({
    ...inv,
    inviter: invitersMap.get(inv.inviter_id) || null,
    redeemer: redeemerMap.get(inv.recipient_email) || null,
  }));

  return c.json({
    invitations: enriched,
    pagination: { page, limit, total: count, totalPages: Math.ceil((count || 0) / limit) },
  });
});

app.post("/invitations", async (c) => {
  const db = getAdminClient();
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const recipientEmail = body?.recipient_email ?? "";
  const personalNote = body?.personal_note?.trim();
  const allowedRoles = ["community", "recruiters"];
  const role = allowedRoles.includes(body?.role) ? body.role : "community";

  if (!recipientEmail.trim()) return c.json({ error: "recipient_email is required" }, 400);

  const normalizedEmail = sanitizeEmail(recipientEmail);

  const [{ data: existingUser }, { data: existingInvite }] = await Promise.all([
    db.from("users").select("uuid").eq("email", normalizedEmail).maybeSingle(),
    db.from("invites").select("id").eq("recipient_email", normalizedEmail).eq("status", "pending").maybeSingle(),
  ]);

  if (existingUser) return c.json({ error: "User already exists in the system" }, 409);
  if (existingInvite) return c.json({ error: "A pending invitation already exists for this email" }, 409);

  const createdAt = new Date();
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + 7);

  const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  const { data, error } = await db
    .from("invites")
    .insert([{
      id: crypto.randomUUID(),
      inviter_id: user.id,
      token,
      recipient_email: normalizedEmail,
      personal_note: personalNote || null,
      status: "pending",
      role,
      views_count: 0,
      last_viewed_at: null,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }])
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  const { data: inviterProfile } = await db.from("users").select("first_name,last_name").eq("uuid", user.id).maybeSingle();
  const inviterName = inviterProfile
    ? [inviterProfile.first_name, inviterProfile.last_name].filter(Boolean).join(" ") || "a duallin member"
    : "a duallin member";

  sendInviteEmail({ to: normalizedEmail, inviterName, token, personalNote: personalNote || null, expiresAt: expiresAt.toISOString() })
    .catch((err: any) => { console.error("Failed to send admin invite email:", err.message); });

  return c.json(data, 201);
});

app.put("/invitations/:id", async (c) => {
  const db = getAdminClient();
  const inviteId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const { data: invite, error: fetchError } = await db
    .from("invites")
    .select("*")
    .eq("id", inviteId)
    .maybeSingle();

  if (fetchError) return c.json({ error: fetchError.message }, 500);
  if (!invite) return c.json({ error: "Invitation not found" }, 404);

  const updates: Record<string, any> = {};
  if (body.status !== undefined) updates.status = body.status;
  if (body.recipient_email !== undefined) updates.recipient_email = sanitizeEmail(body.recipient_email);
  if (body.personal_note !== undefined) updates.personal_note = body.personal_note;
  const allowedRoles = ["community", "recruiters"];
  if (body.role !== undefined && allowedRoles.includes(body.role)) updates.role = body.role;

  const { data, error } = await db
    .from("invites")
    .update(updates)
    .eq("id", inviteId)
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  return c.json(data);
});

app.delete("/invitations/:id", async (c) => {
  const db = getAdminClient();
  const inviteId = c.req.param("id");

  const { error } = await db.from("invites").delete().eq("id", inviteId);

  if (error) return c.json({ error: error.message }, 400);

  return c.json({ success: true });
});

// ==================== COMPANIES ====================

app.get("/companies", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";
  const active = c.req.query("active");
  const sortBy = c.req.query("sortBy") || "name";
  const sortDir = c.req.query("sortDir") === "desc";
  const offset = (page - 1) * limit;

  let query = db
    .from("companies")
    .select("id,name,active,description,universal_name,website,phone,logo,tagline,locations,industries,specialities,employee_count_range,founded_on,created_at,employees,owner_uuid", { count: "exact" });

  if (search) query = query.ilike("name", `%${search}%`);
  if (active === "true") query = query.eq("active", true);
  if (active === "false") query = query.eq("active", false);

  const sortableColumns = ["name", "created_at", "active", "website"];
  const safeSort = sortableColumns.includes(sortBy) ? sortBy : "name";

  const { data: companies, error, count } = await query
    .order(safeSort, { ascending: !sortDir })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  // Resolve owner_uuid → owner_email for companies that have an owner
  const ownerUuids = [...new Set((companies || []).map((c: any) => c.owner_uuid).filter(Boolean))] as string[];
  const ownerEmailMap = new Map<string, string>();
  for (const uuid of ownerUuids) {
    const { data: email } = await db.rpc('get_user_email_by_uuid', { p_uuid: uuid });
    if (email) ownerEmailMap.set(uuid, email);
  }

  const enriched = (companies || []).map((company: any) => ({
    ...company,
    employees_count: Array.isArray(company.employees) ? company.employees.filter(Boolean).length : 0,
    owner_email: company.owner_uuid ? (ownerEmailMap.get(company.owner_uuid) ?? null) : null,
  }));

  return c.json({
    companies: enriched,
    pagination: { page, limit, total: count, totalPages: Math.ceil((count || 0) / limit) },
  });
});

app.get("/companies/:id", async (c) => {
  const db = getAdminClient();
  const companyId = parseInt(c.req.param("id"));

  const { data: company, error } = await db
    .from("companies")
    .select("*")
    .eq("id", companyId)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 500);
  if (!company) return c.json({ error: "Company not found" }, 404);

  return c.json(company);
});

app.post("/companies", async (c) => {
  const db = getAdminClient();
  const body = await c.req.json().catch(() => ({}));

  if (!body.name) return c.json({ error: "name is required" }, 400);

  const { id, created_at, owner_email, ...insertData } = body;

  // Resolve owner_email → owner_uuid
  if (owner_email) {
    const { data: resolvedUuid, error: rpcError } = await db.rpc('get_uuid_by_email', { p_email: owner_email.trim() });
    if (rpcError || !resolvedUuid) return c.json({ error: `User not found for email: ${owner_email}` }, 404);
    insertData.owner_uuid = resolvedUuid;
  }

  const { data, error } = await db
    .from("companies")
    .insert([insertData])
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  return c.json(data, 201);
});

app.put("/companies/:id", async (c) => {
  const db = getAdminClient();
  const companyId = parseInt(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));

  const { id, created_at, owner_email, ...updates } = body;

  // Resolve owner_email → owner_uuid via RPC (queries auth.users directly, includes anonymous users)
  if (owner_email !== undefined) {
    if (!owner_email) {
      updates.owner_uuid = null;
    } else {
      const { data: resolvedUuid, error: rpcError } = await db.rpc('get_uuid_by_email', { p_email: owner_email.trim() });
      if (rpcError || !resolvedUuid) return c.json({ error: `User not found for email: ${owner_email}` }, 404);
      updates.owner_uuid = resolvedUuid;
    }
  }

  const { data, error } = await db
    .from("companies")
    .update(updates)
    .eq("id", companyId)
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  return c.json(data);
});

app.delete("/companies/:id", async (c) => {
  const db = getAdminClient();
  const companyId = parseInt(c.req.param("id"));

  const { error } = await db.from("companies").delete().eq("id", companyId);

  if (error) return c.json({ error: error.message }, 400);

  return c.json({ success: true });
});

// ==================== COMPANY REQUESTS ====================

// Normalize a company name for grouping: lowercase, remove punctuation + common suffixes
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|co|corp|gmbh|bv|sa|plc|בע"מ|בעמ|בע״מ|ישראל|israel)\b/g, '')
    .replace(/[^a-z0-9֐-׿]/g, '')
    .trim();
}

// GET /admin/company-requests — list pending requests grouped by similarity
app.get("/company-requests", async (c) => {
  const db = getAdminClient();

  const { data: requests, error } = await db
    .from("company_requests")
    .select("id, requested_name, requested_by, status, created_at, resolved_company_id")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 500);

  // Resolve user info from public.users by UUID
  const userIds = [...new Set((requests || []).map((r: any) => r.requested_by).filter(Boolean))];
  const { data: usersData } = userIds.length > 0
    ? await db.from("users").select("uuid, first_name, last_name, email").in("uuid", userIds)
    : { data: [] };
  const usersMap = new Map((usersData || []).map((u: any) => [u.uuid, u]));

  // Group by normalized name in JS
  const groups = new Map<string, { normalized: string; requests: any[] }>();
  for (const req of requests || []) {
    const normalized = normalizeCompanyName(req.requested_name);
    if (!groups.has(normalized)) {
      groups.set(normalized, { normalized, requests: [] });
    }
    groups.get(normalized)!.requests.push({
      id: req.id,
      requested_name: req.requested_name,
      requested_by: req.requested_by,
      created_at: req.created_at,
      user: usersMap.get(req.requested_by) ?? null,
    });
  }

  // For each group, find similar companies in our DB using ilike on the most common name
  const groupList = await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const representativeName = group.requests[0].requested_name;
      // Try ilike match on first word (most likely the unique identifier)
      const firstWord = representativeName.trim().split(/\s+/)[0];
      const { data: suggestions } = await db
        .from("companies")
        .select("id, name, logo, website")
        .ilike("name", `%${firstWord}%`)
        .limit(3);

      return {
        normalized: group.normalized,
        representative_name: representativeName,
        requests: group.requests,
        count: group.requests.length,
        existing_suggestions: suggestions || [],
      };
    })
  );

  // Sort: largest groups first
  groupList.sort((a, b) => b.count - a.count);

  return c.json({ groups: groupList });
});

// POST /admin/company-requests/search-online — use GPT-4o to fetch company info from web
app.post("/company-requests/search-online", async (c) => {
  const db = getAdminClient();
  const body = await c.req.json().catch(() => ({}));
  const companyName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!companyName) return c.json({ error: 'name is required' }, 400);

  const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });

  let completion: any;
  try {
    completion = await openai.chat.completions.create({
      model: "gpt-4o-search-preview",
      messages: [{
        role: "user",
        content: `Find companies named "${companyName}" that are headquartered in Israel or have a verified office or active operation in Israel, using reliable current public sources.
Return a JSON array of matching companies (up to 5), ordered by relevance to Israel. Do not return a company unless you can verify an Israeli headquarters, office, or operation.
For every company, return as much verified information as possible using exactly this shape:
{
  "official_name": string,
  "website": string|null,
  "description": string|null,
  "tagline": string|null,
  "linkedin_url": string|null,
  "phone": string|null,
  "logo_url": string|null,
  "locations": [{ "city": string|null, "country": "IL", "is_hq": boolean }],
  "industries": [{ "name": string }],
  "specialities": string[],
  "employee_count_range": { "start": number|null, "end": number|null }|null,
  "founded_on": { "year": number }|null
}
The description should be a factual 2-4 sentence overview covering the product or service, market, and its connection to Israel.
Include at least one verified Israeli location in locations and use the ISO country code "IL".
Use an empty array or null for information that cannot be verified. Do not invent values.
If no Israeli company or verified Israeli operation can be identified, return: { "error": "no verified Israeli company found" }
You MUST respond with raw JSON only — no markdown, no explanations, no text outside the JSON.`
      }],
    } as any);
  } catch (err: any) {
    console.error('[search-online] OpenAI error:', err?.message);
    return c.json({ error: `OpenAI error: ${err?.message ?? 'unknown'}` }, 500);
  }

  const raw = completion.choices[0]?.message?.content?.trim() ?? '';
  // Extract JSON array or object from response
  const jsonMatch = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  let parsed: any;
  try {
    if (!jsonMatch) throw new Error('no JSON found');
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.error('[search-online] JSON parse failed, raw:', raw);
    return c.json({ error: 'Could not parse response', raw });
  }

  // If error object returned
  if (!Array.isArray(parsed) && parsed.error) return c.json(parsed);

  // Normalize to array
  const results: any[] = Array.isArray(parsed) ? parsed : [parsed];

  // Normalize the result into the JSON shapes used by the companies UI.
  for (const item of results) {
    if (typeof item.website === 'string' && item.website.trim()) {
      item.website = item.website.trim();
      if (item.website.startsWith('http://')) {
        item.website = item.website.replace('http://', 'https://');
      } else if (!/^https?:\/\//i.test(item.website)) {
        item.website = `https://${item.website}`;
      }
    }
    if (typeof item.linkedin_url === 'string' && item.linkedin_url.trim()) {
      item.linkedin_url = item.linkedin_url.trim();
      if (item.linkedin_url.startsWith('http://')) {
        item.linkedin_url = item.linkedin_url.replace('http://', 'https://');
      } else if (!/^https?:\/\//i.test(item.linkedin_url)) {
        item.linkedin_url = `https://${item.linkedin_url}`;
      }
    }

    item.locations = Array.isArray(item.locations)
      ? item.locations
        .filter((location: any) => location && (location.city || location.country))
        .map((location: any) => ({
          city: typeof location.city === 'string' ? location.city.trim() || null : null,
          country: typeof location.country === 'string' &&
            ['il', 'israel', 'ישראל'].includes(location.country.trim().toLocaleLowerCase())
            ? 'IL'
            : null,
          is_hq: location.is_hq === true,
        }))
        .filter((location: any) => location.country === 'IL')
      : [];

    // Only Israeli results are eligible for creation in the admin flow.
    item.is_israeli = item.locations.length > 0;

    item.industries = Array.isArray(item.industries)
      ? item.industries
        .map((industry: any) => typeof industry === 'string' ? industry : industry?.name)
        .filter((name: any) => typeof name === 'string' && name.trim())
        .map((name: string) => ({ name: name.trim() }))
      : [];
    item.industry = item.industries.map((industry: any) => industry.name).join(', ') || null;
    item.country = item.locations.find((location: any) => location.is_hq)?.country
      || item.locations[0]?.country
      || null;

    item.specialities = Array.isArray(item.specialities)
      ? item.specialities.filter((value: any) => typeof value === 'string' && value.trim())
      : [];

    const rawStart = item.employee_count_range?.start;
    const rawEnd = item.employee_count_range?.end;
    const start = typeof rawStart === 'number' && Number.isFinite(rawStart) ? rawStart : null;
    const end = typeof rawEnd === 'number' && Number.isFinite(rawEnd) ? rawEnd : null;
    item.employee_count_range = start !== null || end !== null
      ? {
        start,
        end,
      }
      : null;

    const foundedYear = Number(item.founded_on?.year);
    item.founded_on = Number.isInteger(foundedYear) && foundedYear > 1700
      ? { year: foundedYear }
      : null;

    if (!item.logo_url && item.website) {
      try {
        const domain = new URL(item.website).hostname;
        item.logo_url = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
      } catch {
        item.logo_url = null;
      }
    }
  }

  const israeliResults = results.filter((item: any) => item.is_israeli);
  if (israeliResults.length === 0) {
    return c.json({ error: 'No verified Israeli company found' });
  }

  // Search our DB for each result's official name
  const dbMatches: any[] = [];
  const seen = new Set<number>();

  for (const item of israeliResults) {
    const officialName: string = item.official_name || '';
    if (!officialName) continue;

    const words = officialName.split(/\s+/).filter((w: string) => w.length > 2);
    const searchTerms = [...new Set([officialName, words[0], words[words.length - 1]])].filter(Boolean);

    await Promise.all(
      searchTerms.map(async (term: string) => {
        const { data } = await db.from('companies').select('id, name, logo, website').ilike('name', `%${term}%`).limit(5);
        for (const co of data || []) {
          if (!seen.has(co.id)) { seen.add(co.id); dbMatches.push(co); }
        }
      })
    );
  }

  return c.json({ results: israeliResults, db_matches: dbMatches });
});

// POST /admin/company-requests/resolve — link requests to a company or dismiss them
app.post("/company-requests/resolve", async (c) => {
  const db = getAdminClient();
  const body = await c.req.json().catch(() => ({}));

  // request_ids: number[]
  // action: 'link' | 'dismiss'
  // company_id?: number (required for 'link')
  const { request_ids, action, company_id } = body;

  if (!Array.isArray(request_ids) || request_ids.length === 0) {
    return c.json({ error: 'request_ids is required' }, 400);
  }
  if (!['link', 'dismiss'].includes(action)) {
    return c.json({ error: 'action must be link or dismiss' }, 400);
  }
  if (action === 'link' && !company_id) {
    return c.json({ error: 'company_id is required for link action' }, 400);
  }

  const newStatus = action === 'link' ? 'resolved' : 'dismissed';

  // Fetch the requests so we know which users + names are involved
  const { data: requests, error: fetchErr } = await db
    .from("company_requests")
    .select("id, requested_name, requested_by")
    .in("id", request_ids);

  if (fetchErr) return c.json({ error: fetchErr.message }, 500);
  if (!requests?.length) return c.json({ error: 'No requests found' }, 404);

  // Mark requests as resolved/dismissed
  const { error: updateErr } = await db
    .from("company_requests")
    .update({ status: newStatus, resolved_company_id: action === 'link' ? company_id : null })
    .in("id", request_ids);

  if (updateErr) return c.json({ error: updateErr.message }, 500);

  // If linking: update matching experience entries for each user
  if (action === 'link') {
    const { data: company } = await db
      .from("companies")
      .select("id, name, logo, website")
      .eq("id", company_id)
      .maybeSingle();

    if (company) {
      const companyObj = { id: company.id, name: company.name, logo: company.logo ?? null, website: company.website ?? null };

      await Promise.all(requests.map(async (req: any) => {
        const { data: user } = await db
          .from("users")
          .select("uuid, experience")
          .eq("uuid", req.requested_by)
          .maybeSingle();

        if (!user?.experience) return;

        const requestedLower = req.requested_name.toLowerCase();
        let changed = false;
        const updatedExp = (user.experience as any[]).map((entry: any) => {
          const companyField = entry.company;
          // Only replace if it's a plain string matching the requested name
          if (typeof companyField === 'string' && companyField.toLowerCase() === requestedLower) {
            changed = true;
            return { ...entry, company: companyObj };
          }
          return entry;
        });

        if (changed) {
          await db.from("users").update({ experience: updatedExp }).eq("uuid", user.uuid);
        }
      }));
    }
  }

  return c.json({ ok: true, updated: requests.length });
});

// ==================== JOBS ====================

app.get("/jobs", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";
  const noCompany = c.req.query("no_company") === "true";
  const sortBy = c.req.query("sortBy") || "created_at";
  const sortDir = c.req.query("sortDir") === "asc";
  const offset = (page - 1) * limit;

  let query = db
    .from("open_position")
    .select("job_id,job_title,company_name,company_id,location,time_posted,employment_type,created_at,companies:company_id(id,name,logo)", { count: "exact" });

  if (search) {
    query = query.or(`job_title.ilike.%${search}%,company_name.ilike.%${search}%`);
  }
  if (noCompany) {
    query = query.is("company_id", null);
  }

  const sortableColumns = ["created_at", "job_title", "company_name", "time_posted"];
  const safeSort = sortableColumns.includes(sortBy) ? sortBy : "created_at";

  const { data: jobs, error, count } = await query
    .order(safeSort, { ascending: sortDir })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({
    jobs: jobs || [],
    pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
  });
});

app.put("/jobs/:id", async (c) => {
  const db = getAdminClient();
  const jobId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const { data: currentJob, error: currentJobError } = await db
    .from("open_position")
    .select("job_id,company_name,company_id")
    .eq("job_id", jobId)
    .maybeSingle();

  if (currentJobError) return c.json({ error: currentJobError.message }, 500);
  if (!currentJob) return c.json({ error: "Job not found" }, 404);

  const updates: Record<string, any> = {};
  let linkedJobsCount = 1;
  if (body.company_id === undefined) {
    return c.json({ error: "company_id is required" }, 400);
  }

  {
    const companyId = body.company_id === null ? null : parseInt(body.company_id);
    if (companyId !== null && !Number.isFinite(companyId)) {
      return c.json({ error: "Invalid company_id" }, 400);
    }
    updates.company_id = companyId;

    if (companyId !== null) {
      const { data: company } = await db.from("companies").select("name").eq("id", companyId).maybeSingle();
      if (!company) return c.json({ error: "Company not found" }, 404);
      updates.company_name = company.name;

      // Link only unlinked jobs whose listed company name is exactly identical.
      if (currentJob.company_id === null && currentJob.company_name) {
        const { data: unlinkedJobs, error: unlinkedError } = await db
          .from("open_position")
          .select("job_id,company_name")
          .is("company_id", null)
          .eq("company_name", currentJob.company_name);

        if (unlinkedError) return c.json({ error: unlinkedError.message }, 500);

        const matchingJobIds = (unlinkedJobs || [])
          .filter((job: any) =>
            typeof job.company_name === "string" &&
            job.company_name === currentJob.company_name
          )
          .map((job: any) => job.job_id);

        if (matchingJobIds.length > 0) {
          const { error: bulkUpdateError } = await db
            .from("open_position")
            .update(updates)
            .in("job_id", matchingJobIds);

          if (bulkUpdateError) return c.json({ error: bulkUpdateError.message }, 400);
          linkedJobsCount = matchingJobIds.length;
        }
      }
    } else {
      updates.company_name = null;
    }
  }

  const { data, error } = await db
    .from("open_position")
    .update(updates)
    .eq("job_id", jobId)
    .select("job_id,job_title,company_name,company_id,location,time_posted,employment_type,created_at,companies:company_id(id,name,logo)")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  return c.json({ ...data, linked_jobs_count: linkedJobsCount });
});

// ==================== CONTENT REPORTS ====================

app.get("/reports", async (c) => {
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const status = c.req.query("status") || "all"; // "all" | "unresolved" | "resolved"
  const offset = (page - 1) * limit;

  let query = db
    .from("post_reports")
    .select(`
      id,
      post_id,
      reporter_id,
      reason,
      created_at,
      is_resolved,
      resolved_at,
      resolved_by,
      resolution_note,
      posts!post_id ( subject, message, sender ),
      reporter:users!reporter_id ( first_name, last_name, email ),
      resolver:users!resolved_by ( first_name, last_name, email )
    `, { count: "exact" })
    .order("created_at", { ascending: false });

  if (status === "resolved") query = query.eq("is_resolved", true);
  if (status === "unresolved") query = query.eq("is_resolved", false);

  const { data: reports, error, count } = await query.range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const mapped = (reports || []).map((r: any) => ({
    id: r.id,
    post_id: r.post_id,
    reporter_id: r.reporter_id,
    reason: r.reason,
    created_at: r.created_at,
    is_resolved: r.is_resolved ?? false,
    resolved_at: r.resolved_at ?? null,
    resolved_by: r.resolved_by ?? null,
    resolution_note: r.resolution_note ?? null,
    post_subject: r.posts?.subject ?? null,
    post_message: r.posts?.message ?? null,
    post_sender: r.posts?.sender ?? null,
    reporter_name: r.reporter
      ? [r.reporter.first_name, r.reporter.last_name].filter(Boolean).join(' ') || null
      : null,
    reporter_email: r.reporter?.email ?? null,
    resolver_name: r.resolver
      ? [r.resolver.first_name, r.resolver.last_name].filter(Boolean).join(' ') || null
      : null,
    resolver_email: r.resolver?.email ?? null,
  }));

  return c.json({
    reports: mapped,
    pagination: {
      page,
      limit,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
    },
  });
});

app.patch("/reports/:id", async (c) => {
  const db = getAdminClient();
  const adminUser = c.get("user");
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));

  const { is_resolved, resolution_note } = body;

  const updates: Record<string, any> = {
    is_resolved: !!is_resolved,
    resolution_note: resolution_note?.trim() || null,
    resolved_by: is_resolved ? adminUser.id : null,
    resolved_at: is_resolved ? new Date().toISOString() : null,
  };

  const { data, error } = await db
    .from("post_reports")
    .update(updates)
    .eq("id", id)
    .select(`
      id,
      post_id,
      reporter_id,
      reason,
      created_at,
      is_resolved,
      resolved_at,
      resolved_by,
      resolution_note,
      posts!post_id ( subject, message, sender ),
      reporter:users!reporter_id ( first_name, last_name, email ),
      resolver:users!resolved_by ( first_name, last_name, email )
    `)
    .single();

  if (error) return c.json({ error: error.message }, 500);

  const r = data as any;
  return c.json({
    id: r.id,
    post_id: r.post_id,
    reporter_id: r.reporter_id,
    reason: r.reason,
    created_at: r.created_at,
    is_resolved: r.is_resolved ?? false,
    resolved_at: r.resolved_at ?? null,
    resolved_by: r.resolved_by ?? null,
    resolution_note: r.resolution_note ?? null,
    post_subject: r.posts?.subject ?? null,
    post_message: r.posts?.message ?? null,
    post_sender: r.posts?.sender ?? null,
    reporter_name: r.reporter
      ? [r.reporter.first_name, r.reporter.last_name].filter(Boolean).join(' ') || null
      : null,
    reporter_email: r.reporter?.email ?? null,
    resolver_name: r.resolver
      ? [r.resolver.first_name, r.resolver.last_name].filter(Boolean).join(' ') || null
      : null,
    resolver_email: r.resolver?.email ?? null,
  });
});

// GET /invite-week-stats — per-user invite counts for the last 7 days
app.get("/invite-week-stats", async (c) => {
  try {
    const supabase = c.get("supabase");

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: recentInvites, error } = await supabase
      .from("invites")
      .select("inviter_id")
      .gte("created_at", sevenDaysAgo.toISOString())
      .not("inviter_id", "is", null);

    if (error) return c.json({ error: error.message }, 500);

    const countMap: Record<string, number> = {};
    for (const row of recentInvites ?? []) {
      countMap[row.inviter_id] = (countMap[row.inviter_id] ?? 0) + 1;
    }

    const inviterIds = Object.keys(countMap);
    if (inviterIds.length === 0) return c.json([]);

    const { data: users } = await supabase
      .from("users")
      .select("uuid, first_name, last_name, email")
      .in("uuid", inviterIds);

    const userMap = Object.fromEntries((users ?? []).map((u: any) => [u.uuid, u]));

    const stats = inviterIds
      .map((id) => ({
        inviter_id: id,
        used: countMap[id],
        limit: 5,
        user: userMap[id] ?? null,
      }))
      .sort((a, b) => b.used - a.used);

    return c.json(stats);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ==================== PLATFORM JOIN REQUESTS ====================

app.get("/join-requests", async (c) => {
  try {
    const db = getAdminClient();
    const page     = parseInt(c.req.query("page")    || "1");
    const limit    = parseInt(c.req.query("limit")   || "25");
    const search   = c.req.query("search")   || "";
    const type     = c.req.query("type")     || "";
    const status   = c.req.query("status")   || "";
    const decision = c.req.query("decision") || "";
    const experience = c.req.query("experience") || "";
    const invited  = c.req.query("invited")  || "";
    const sortDir  = c.req.query("sortDir")  || "desc";

    const { data, error } = await db.rpc("admin_join_requests_with_invites", {
      p_search:     search,
      p_type:       type,
      p_status:     status,
      p_decision:   decision,
      p_experience: experience,
      p_invited:    invited,
      p_page:       page,
      p_limit:      limit,
      p_sort_dir:   sortDir,
    });

    if (error) return c.json({ error: error.message }, 500);
    return c.json(data);
  } catch (err: any) {
    return c.json({ error: err?.message ?? String(err) }, 500);
  }
});

app.patch("/join-requests/:id", async (c) => {
  const db = getAdminClient();
  const { id } = c.req.param();
  const body = await c.req.json();

  const updates: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const allowed = ["pending", "reviewed", "contacted"];
    if (!allowed.includes(body.status)) return c.json({ error: "Invalid status" }, 400);
    updates.status = body.status;
  }
  if (body.approved !== undefined) updates.approved = body.approved === null ? null : Boolean(body.approved);
  if (body.admin_note !== undefined) updates.admin_note = body.admin_note ?? null;

  if (Object.keys(updates).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const { error } = await db
    .from("platform_join_requests")
    .update(updates)
    .eq("id", id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

export default app;

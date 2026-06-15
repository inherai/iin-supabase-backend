import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { calculateProfileStrength, calculateActivityScore } from './_scoreHelpers.ts';
import OpenAI from "https://esm.sh/openai@4";

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
        content: `Find all companies named "${companyName}".
Return a JSON array of all matching companies (up to 5), ordered by global prominence.
Each item: { "official_name": string, "website": string|null, "description": string, "industry": string, "country": string, "logo_url": string|null }
If no company can be identified, return: { "error": "not found" }
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

  // Normalize website URLs to https
  for (const item of results) {
    if (typeof item.website === 'string' && item.website.startsWith('http://')) {
      item.website = item.website.replace('http://', 'https://');
    }
  }

  // Search our DB for each result's official name
  const dbMatches: any[] = [];
  const seen = new Set<number>();

  for (const item of results) {
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

  return c.json({ results, db_matches: dbMatches });
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

  const updates: Record<string, any> = {};
  if (body.company_id !== undefined) {
    const companyId = body.company_id === null ? null : parseInt(body.company_id);
    updates.company_id = companyId;

    if (companyId !== null) {
      const { data: company } = await db.from("companies").select("name").eq("id", companyId).maybeSingle();
      if (company?.name) updates.company_name = company.name;
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

  return c.json(data);
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
  const db = getAdminClient();
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "25");
  const search = c.req.query("search") || "";
  const type = c.req.query("type") || "";
  const status = c.req.query("status") || "";
  const decision = c.req.query("decision") || "";
  const experience = c.req.query("experience") || "";
  const offset = (page - 1) * limit;

  let query = db.from("platform_join_requests").select("*", { count: "exact" });

  if (search) {
    query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,company_name.ilike.%${search}%`);
  }
  if (type) query = query.eq("type", type);
  if (status) query = query.eq("status", status);
  if (decision === "approved") query = query.eq("approved", true);
  else if (decision === "rejected") query = query.eq("approved", false);
  else if (decision === "none") query = query.is("approved", null);
  if (experience === "none") query = query.is("years_experience", null);
  else if (experience) query = query.eq("years_experience", experience);

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ requests: data ?? [], total: count ?? 0 });
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

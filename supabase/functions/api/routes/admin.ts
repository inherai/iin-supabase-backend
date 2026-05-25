import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = new Hono();

const getAdminClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

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

  let query = db.from("users").select("*", { count: "exact" });

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
      : Promise.resolve({ data: [] }),
    emails.length > 0
      ? db.from("comments").select("sender").in("sender", emails)
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
    db.from("posts").select("*", { count: "exact", head: true }).eq("sender", email),
    db.from("comments").select("*", { count: "exact", head: true }).eq("sender", email),
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
  const recipientEmail = body?.recipient_email?.trim();
  const personalNote = body?.personal_note?.trim();

  if (!recipientEmail) return c.json({ error: "recipient_email is required" }, 400);

  const normalizedEmail = recipientEmail.toLowerCase();

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
  if (body.recipient_email !== undefined) updates.recipient_email = body.recipient_email.toLowerCase().trim();
  if (body.personal_note !== undefined) updates.personal_note = body.personal_note;

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
    .select("id,name,active,description,universal_name,website,phone,logo,tagline,locations,industries,specialities,employee_count_range,founded_on,created_at,employees", { count: "exact" });

  if (search) query = query.ilike("name", `%${search}%`);
  if (active === "true") query = query.eq("active", true);
  if (active === "false") query = query.eq("active", false);

  const sortableColumns = ["name", "created_at", "active", "website"];
  const safeSort = sortableColumns.includes(sortBy) ? sortBy : "name";

  const { data: companies, error, count } = await query
    .order(safeSort, { ascending: !sortDir })
    .range(offset, offset + limit - 1);

  if (error) return c.json({ error: error.message }, 500);

  const enriched = (companies || []).map((company: any) => ({
    ...company,
    employees_count: Array.isArray(company.employees) ? company.employees.filter(Boolean).length : 0,
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

  const { id, created_at, ...insertData } = body;

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

  const { id, created_at, ...updates } = body;

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
  if (body.company_id !== undefined) updates.company_id = body.company_id === null ? null : parseInt(body.company_id);

  const { data, error } = await db
    .from("open_position")
    .update(updates)
    .eq("job_id", jobId)
    .select("job_id,job_title,company_name,company_id,location,time_posted,employment_type,created_at,companies:company_id(id,name,logo)")
    .single();

  if (error) return c.json({ error: error.message }, 400);

  return c.json(data);
});

export default app;

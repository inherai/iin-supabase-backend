import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

// GET /notifications — list the current user's notifications (most recent 30)
// Enriches with actor name, post subject, and article title server-side.
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { data: rows, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    console.error("GET /notifications error:", error);
    return c.json({ error: "Failed to fetch notifications" }, 500);
  }

  const notifications = rows ?? [];

  // Collect IDs for enrichment
  const actorIds = [...new Set(notifications.map((n: any) => n.actor_id).filter(Boolean))];
  const postIds = [...new Set(
    notifications
      .filter((n: any) => ["POST_LIKE", "POST_COMMENT", "MENTION", "REPLY", "COMMENT_REACTION"].includes(n.type) && n.target_id)
      .map((n: any) => n.target_id)
  )];
  const articleIds = [...new Set(
    notifications
      .filter((n: any) => ["ARTICLE_COMMENT", "ARTICLE_LIKE", "NEW_ARTICLE", "NEW_COMPANY_ARTICLE", "ARTICLE_COMMENT_REACTION", "ARTICLE_MENTION"].includes(n.type) && n.target_id)
      .map((n: any) => n.target_id)
  )];

  // Fetch enrichment data in parallel
  const [actorsRes, postsRes, articlesRes] = await Promise.all([
    actorIds.length > 0
      ? supabase.from("public_users_view").select("uuid, first_name, last_name, image").in("uuid", actorIds)
      : Promise.resolve({ data: [] }),
    postIds.length > 0
      ? supabase.from("posts").select("id, subject").in("id", postIds)
      : Promise.resolve({ data: [] }),
    articleIds.length > 0
      ? supabase.from("articles").select("id, title").in("id", articleIds)
      : Promise.resolve({ data: [] }),
  ]);

  const nameMap = new Map<string, string>();
  const imageMap = new Map<string, string | null>();
  for (const u of (actorsRes.data ?? []) as any[]) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
    if (name) nameMap.set(u.uuid, name);
    imageMap.set(u.uuid, u.image ?? null);
  }

  const subjectMap = new Map<string, string>();
  for (const p of (postsRes.data ?? []) as any[]) {
    if (p.subject) subjectMap.set(p.id, p.subject);
  }

  const articleTitleMap = new Map<string, string>();
  for (const a of (articlesRes.data ?? []) as any[]) {
    if (a.title) articleTitleMap.set(a.id, a.title);
  }

  const enriched = notifications.map((n: any) => ({
    ...n,
    users: n.actor_id ? { name: nameMap.get(n.actor_id) ?? "", has_image: imageMap.get(n.actor_id) ?? null } : undefined,
    posts: ["POST_LIKE", "POST_COMMENT", "MENTION", "REPLY", "COMMENT_REACTION"].includes(n.type) && n.target_id
      ? { subject: subjectMap.get(n.target_id) ?? undefined }
      : null,
    articles: ["ARTICLE_COMMENT", "ARTICLE_LIKE", "NEW_ARTICLE", "NEW_COMPANY_ARTICLE", "ARTICLE_COMMENT_REACTION", "ARTICLE_MENTION"].includes(n.type) && n.target_id
      ? { title: articleTitleMap.get(n.target_id) ?? undefined }
      : null,
  }));

  return c.json({ notifications: enriched });
});

// PATCH /notifications/:id/read — mark a single notification as read
app.patch("/:id/read", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

// PATCH /notifications/read-all — mark all unread notifications as read
app.patch("/read-all", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", user.id)
    .eq("is_read", false);

  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});

export default app;

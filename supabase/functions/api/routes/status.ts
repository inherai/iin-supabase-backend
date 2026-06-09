import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

// GET /api/status?since=<ISO timestamp>
// Returns badge counts for all notification types in a single request.
// Replaces 4 separate Realtime subscriptions with one combined poll.
// All 4 sub-queries run in parallel via Promise.all.
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const since = c.req.query("since");

  const isRecruiter =
    String(user.app_metadata?.role ?? "").toLowerCase().trim() === "recruiters";

  let postsQuery = supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .gt("sent_at", since)
    .not("post_type", "is", null)
    .neq("post_type", "email")
    .neq("sender", user.email);

  if (isRecruiter) {
    postsQuery = postsQuery.neq("community_members_only", true);
  }

  const [
    notificationsResult,
    connectionsResult,
    messagesResult,
    postsResult,
  ] = await Promise.all([
    // Unread notifications count
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false),

    // Pending connection requests (incoming only)
    supabase
      .from("connections")
      .select("id", { count: "exact", head: true })
      .eq("receiver_id", user.id)
      .eq("status", "pending"),

    // Unread messages across all conversations
    supabase
      .from("conversations")
      .select("id")
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .then(async ({ data: convs }) => {
        if (!convs || convs.length === 0) return { count: 0 };
        const convIds = convs.map((conv: any) => conv.id);
        const { count } = await supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .in("conversation_id", convIds)
          .eq("is_read", false)
          .neq("sender_id", user.id);
        return { count: count ?? 0 };
      }),

    // New posts since session start (only if since param provided)
    since
      ? postsQuery
      : Promise.resolve({ count: 0 }),
  ]);

  return c.json({
    unread_notifications: notificationsResult.count ?? 0,
    pending_connections: connectionsResult.count ?? 0,
    unread_messages: messagesResult.count ?? 0,
    new_posts: postsResult.count ?? 0,
  });
});

export default app;

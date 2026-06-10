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
    supabase.rpc("count_unread_messages", { p_user_id: user.id }),

    // New feed activity since session start — includes posts bumped by new comments
    since
      ? supabase.rpc("count_new_feed_activity", {
          p_since: since,
          p_user_email: user.email,
          p_is_recruiter: isRecruiter,
        })
      : Promise.resolve({ data: 0, error: null }),
  ]);

  return c.json({
    unread_notifications: notificationsResult.count ?? 0,
    pending_connections: connectionsResult.count ?? 0,
    unread_messages: (messagesResult.data as number) ?? 0,
    new_posts: (postsResult.data as number) ?? 0,
  });
});

export default app;

import { Hono } from "https://deno.land/x/hono/mod.ts";
import { supabaseAdmin } from "../middleware.ts";

const app = new Hono();

// GET /api/status?since=<ISO timestamp>&mode=<top|recent>
// Returns badge counts for all notification types in a single request.
// In top mode, also returns activity metrics for the smart refresh threshold.
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const since = c.req.query("since");
  const mode = c.req.query("mode");

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

    // New feed activity — skip in top mode (we compute activityScore instead)
    since && mode !== "top"
      ? supabase.rpc("count_new_feed_activity", {
          p_since: since,
          p_user_email: user.email,
          p_is_recruiter: isRecruiter,
        })
      : Promise.resolve({ data: 0, error: null }),
  ]);

  // Top For You mode: compute activity metrics for smart refresh threshold
  if (mode === "top" && since) {
    // Fetch accepted connections + active posts (48h window) in parallel
    const [connectedRes, activePostsRes] = await Promise.all([
      supabase
        .from("connections")
        .select("requester_id, receiver_id")
        .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .eq("status", "accepted"),
      supabase
        .from("feed_cache")
        .select("post_id")
        .gt(
          "effective_date",
          new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
        ),
    ]);

    const connectedUuids: string[] = (connectedRes.data || [])
      .map((c: any) =>
        c.requester_id === user.id ? c.receiver_id : c.requester_id
      )
      .filter(Boolean);

    const activePostIds: string[] = (activePostsRes.data || []).map(
      (p: any) => p.post_id
    );

    if (activePostIds.length === 0) {
      return c.json({
        unread_notifications: notificationsResult.count ?? 0,
        pending_connections: connectionsResult.count ?? 0,
        unread_messages: (messagesResult.data as number) ?? 0,
        new_posts: 0,
        network_comments: 0,
        general_comments: 0,
        network_likes: 0,
        general_likes: 0,
      });
    }

    const hasConnections = connectedUuids.length > 0;

    // comments.posted_by_uuid doesn't exist — the table only stores the
    // commenter's email (sender), so network comments are resolved via
    // connected users' emails instead of a direct uuid filter.
    const connectedEmails: Set<string> = hasConnections
      ? new Set(
          (
            await supabaseAdmin
              .from("users")
              .select("email")
              .in("uuid", connectedUuids)
          ).data?.map((u: any) => (u.email || "").toLowerCase()).filter(Boolean) ?? []
        )
      : new Set();

    const [ncRes, gcRes, nlRes, glRes, npRes] = await Promise.all([
      // Network comments on active posts since $since
      connectedEmails.size > 0
        ? supabase
            .from("comments")
            .select("sender")
            .gt("created_at", since)
            .in("post_id", activePostIds)
            .then(({ data, error }) => ({
              count: (data || []).filter((c: any) =>
                connectedEmails.has((c.sender || "").toLowerCase())
              ).length,
              error,
            }))
        : Promise.resolve({ count: 0, error: null }),

      // All comments on active posts since $since
      supabase
        .from("comments")
        .select("id", { count: "exact", head: true })
        .gt("created_at", since)
        .in("post_id", activePostIds),

      // Network likes on active posts since $since
      hasConnections
        ? supabase
            .from("likes")
            .select("id", { count: "exact", head: true })
            .gt("created_at", since)
            .in("target_id", activePostIds)
            .in("user_id", connectedUuids)
        : Promise.resolve({ count: 0, error: null }),

      // All likes on active posts since $since
      supabase
        .from("likes")
        .select("id", { count: "exact", head: true })
        .gt("created_at", since)
        .in("target_id", activePostIds),

      // New posts since $since (immediate trigger regardless of threshold)
      supabase
        .from("posts")
        .select("id", { count: "exact", head: true })
        .gt("sent_at", since),
    ]);

    return c.json({
      unread_notifications: notificationsResult.count ?? 0,
      pending_connections: connectionsResult.count ?? 0,
      unread_messages: (messagesResult.data as number) ?? 0,
      new_posts: npRes.count ?? 0,
      network_comments: ncRes.count ?? 0,
      general_comments: gcRes.count ?? 0,
      network_likes: nlRes.count ?? 0,
      general_likes: glRes.count ?? 0,
    });
  }

  return c.json({
    unread_notifications: notificationsResult.count ?? 0,
    pending_connections: connectionsResult.count ?? 0,
    unread_messages: (messagesResult.data as number) ?? 0,
    new_posts: (postsResult.data as number) ?? 0,
  });
});

export default app;

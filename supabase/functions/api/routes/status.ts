import { Hono } from "https://deno.land/x/hono/mod.ts";
import { supabaseAdmin } from "../middleware.ts";
import { connectedAmong } from "./_connectionIds.ts";

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
    // Active posts (48h window)
    const activePostsRes = await supabase
      .from("feed_cache")
      .select("post_id")
      .gt(
        "effective_date",
        new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
      );

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

    // Who acted since $since is a short list, while her connections can run into the
    // thousands. So read the actors first and ask which of them she is connected to,
    // instead of loading every connection (cut off at 1000 rows, and far too long to
    // pass back as an .in() filter) on every poll.
    const [commentsRes, gcRes, likesRes, glRes, npRes] = await Promise.all([
      // Who commented on active posts since $since
      supabase
        .from("comments")
        .select("sender")
        .gt("created_at", since)
        .in("post_id", activePostIds),

      // All comments on active posts since $since
      supabase
        .from("comments")
        .select("id", { count: "exact", head: true })
        .gt("created_at", since)
        .in("post_id", activePostIds),

      // Who liked active posts since $since
      supabase
        .from("likes")
        .select("user_id")
        .gt("created_at", since)
        .in("target_id", activePostIds),

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

    const commentSenders: string[] = (commentsRes.data || [])
      .map((cm: any) => (cm.sender || "").toLowerCase())
      .filter(Boolean);
    const likerIds: string[] = (likesRes.data || [])
      .map((l: any) => l.user_id)
      .filter(Boolean);

    // comments.posted_by_uuid doesn't exist — the table only stores the
    // commenter's email (sender), so commenters are resolved to uuids first.
    const uuidByEmail = new Map<string, string>();
    const senderEmails = [...new Set(commentSenders)];
    const EMAIL_CHUNK_SIZE = 100;
    for (let i = 0; i < senderEmails.length; i += EMAIL_CHUNK_SIZE) {
      const { data: senders } = await supabaseAdmin
        .from("users")
        .select("uuid, email")
        .in("email", senderEmails.slice(i, i + EMAIL_CHUNK_SIZE));
      for (const u of senders ?? []) {
        if (u.email) uuidByEmail.set(u.email.toLowerCase(), u.uuid);
      }
    }

    const actorIds = [...new Set([...likerIds, ...uuidByEmail.values()])];
    const { ids: connectedActors } = await connectedAmong(supabase, user.id, actorIds, ["accepted"]);

    const networkComments = commentSenders.filter((email) => {
      const uuid = uuidByEmail.get(email);
      return !!uuid && connectedActors.has(uuid);
    }).length;
    const networkLikes = likerIds.filter((id) => connectedActors.has(id)).length;

    return c.json({
      unread_notifications: notificationsResult.count ?? 0,
      pending_connections: connectionsResult.count ?? 0,
      unread_messages: (messagesResult.data as number) ?? 0,
      new_posts: npRes.count ?? 0,
      network_comments: networkComments,
      general_comments: gcRes.count ?? 0,
      network_likes: networkLikes,
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

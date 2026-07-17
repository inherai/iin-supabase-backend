import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = new Hono();

const getAdminClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // 1. שליפת השיחות
  const { data: convs, error: convError } = await supabase
    .from("conversations")
    .select(`
      *,
      user1:public_users_view!user1_id(uuid, first_name, last_name, image, headline),
      user2:public_users_view!user2_id(uuid, first_name, last_name, image, headline)
    `)
    .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
    .order("updated_at", { ascending: false });

  if (convError) return c.json({ error: convError.message }, 400);

  // 2. שליפת כל הקשרים המאושרים של המשתמש הנוכחי
  const { data: conns, error: connError } = await supabase
    .from("connections")
    .select("requester_id, receiver_id, status")
    .eq("status", "accepted")
    .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`);

  if (connError) return c.json({ error: connError.message }, 400);

  // 3. שליפת ההודעה האחרונה לכל שיחה
  const conversationIds = convs.map(c => c.id);
  const admin = getAdminClient();
  const { data: lastMessages } = await admin
    .from("messages")
    .select("conversation_id, content, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false });

  const lastMessageMap: Record<string, { content: string; created_at: string }> = {};
  for (const msg of lastMessages ?? []) {
    if (!lastMessageMap[msg.conversation_id]) {
      lastMessageMap[msg.conversation_id] = msg;
    }
  }

  // 4. הצלבת הנתונים בקוד
  const enhancedData = convs.map(conv => {
    const partnerId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
    const hasActiveConn = conns.some(conn =>
      (conn.requester_id === partnerId || conn.receiver_id === partnerId)
    );
    const lastMsg = lastMessageMap[conv.id];

    return {
      ...conv,
      last_message: lastMsg?.content ?? conv.last_message ?? null,
      last_message_at: lastMsg?.created_at ?? conv.last_message_at ?? conv.updated_at,
      is_connection_active: hasActiveConn
    };
  });

  return c.json(enhancedData);
});

// POST /api/chat - יצירת שיחה
app.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const partnerId = body?.partner_id;

  if (!partnerId) return c.json({ error: "partner_id is required" }, 400);

  // 1. בדיקה מהירה אם קיים קשר מאושר
  const { data: connection, error: connError } = await supabase
    .from("connections")
    .select("status")
    .or(`and(requester_id.eq.${user.id},receiver_id.eq.${partnerId}),and(requester_id.eq.${partnerId},receiver_id.eq.${user.id})`)
    .eq("status", "accepted")
    .maybeSingle();

  if (connError || !connection) {
    return c.json({ error: "No accepted connection found" }, 403);
  }

  const [u1, u2] = [user.id, partnerId].sort();

  // 2. מציאת או יצירת שיחה
  const conversationSelect = `
    *,
    user1:public_users_view!user1_id(uuid, first_name, last_name, image, headline),
    user2:public_users_view!user2_id(uuid, first_name, last_name, image, headline)
  `;

  const { data: existing, error: findError } = await supabase
    .from("conversations")
    .select(conversationSelect)
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  // At this point we've already verified there's an accepted connection,
  // so always return is_connection_active: true.
  if (existing) return c.json({ ...existing, is_connection_active: true });

  const { data: newConv, error: createError } = await supabase
    .from("conversations")
    .insert([{ user1_id: u1, user2_id: u2 }])
    .select(conversationSelect)
    .single();

  if (createError) return c.json({ error: createError.message }, 400);
  return c.json({ ...newConv, is_connection_active: true }, 201);
});

// GET /api/chat/:id/messages?limit=50&before=<ISO_timestamp>
// Fetch messages for a conversation with cursor-based pagination
app.get("/:id/messages", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  const conversationId = c.req.param("id");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const limitParam = c.req.query('limit');
  const before = c.req.query('before');
  const limit = Math.min(parseInt(limitParam ?? '50', 10) || 50, 100);

  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (before) {
    query = query.lt("created_at", before);
  }

  const { data, error: fetchError } = await query;

  if (fetchError) return c.json({ error: fetchError.message }, 400);

  const hasMore = (data ?? []).length > limit;
  const pageData = (data ?? []).slice(0, limit).reverse();

  const { error: updateError } = await supabase
    .from("messages")
    .update({ is_read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", user.id);

  if (updateError) {
    console.error("Error marking messages as read:", updateError.message);
  }

  // Generate signed URLs for attachments
  const admin = getAdminClient();
  const messages = await Promise.all(
    pageData.map(async (msg) => {
      if (!msg.attachments || msg.attachments.length === 0) return msg;
      const attachmentsWithUrls = await Promise.all(
        msg.attachments.map(async (attachment: any) => {
          const path = attachment.localPath || attachment.url || '';
          if (!path || path.startsWith('http')) return attachment;
          const { data: signed } = await admin.storage
            .from('chat-attachments')
            .createSignedUrl(path, 3600);
          return { ...attachment, url: signed?.signedUrl || '' };
        })
      );
      return { ...msg, attachments: attachmentsWithUrls };
    })
  );

  return c.json({ messages, hasMore });
});

// DELETE /api/chat/:conversationId/messages/:messageId
app.delete("/:conversationId/messages/:messageId", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const admin = getAdminClient();

  const { data: message, error: fetchError } = await admin
    .from("messages")
    .select("id, sender_id, conversation_id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError || !message) return c.json({ error: "Message not found" }, 404);
  if (message.sender_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  // Delete storage files if any
  const attachments: any[] = message.attachments ?? [];
  if (attachments.length > 0) {
    const paths = attachments
      .map((a: any) => a.localPath || a.url || '')
      .filter((p: string) => p && !p.startsWith('http'));
    if (paths.length > 0) {
      await admin.storage.from('chat-attachments').remove(paths);
    }
  }

  const { error } = await admin.from("messages").delete().eq("id", messageId);
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ success: true });
});

// PATCH /api/chat/:conversationId/messages/:messageId
app.patch("/:conversationId/messages/:messageId", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const content = body?.content?.trim();
  if (!content) return c.json({ error: "content is required" }, 400);

  const admin = getAdminClient();

  const { data: message, error: fetchError } = await admin
    .from("messages")
    .select("id, sender_id, conversation_id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError || !message) return c.json({ error: "Message not found" }, 404);
  if (message.sender_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  const { data: updated, error } = await admin
    .from("messages")
    .update({ content, is_edited: true })
    .eq("id", messageId)
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json(updated);
});

// POST /api/chat/:conversationId/messages/:messageId/react
app.post("/:conversationId/messages/:messageId/react", async (c) => {
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const emoji = body?.emoji?.trim();
  if (!emoji) return c.json({ error: "emoji is required" }, 400);

  const admin = getAdminClient();

  // Verify user is a participant in the conversation
  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("user1_id, user2_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conv) return c.json({ error: "Conversation not found" }, 404);
  if (conv.user1_id !== user.id && conv.user2_id !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Fetch current reactions
  const { data: message, error: fetchError } = await admin
    .from("messages")
    .select("id, conversation_id, reactions")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError || !message) return c.json({ error: "Message not found" }, 404);

  const reactions: Record<string, string[]> = message.reactions ?? {};
  const currentIds: string[] = reactions[emoji] ?? [];

  if (currentIds.includes(user.id)) {
    // Remove reaction
    const updated = currentIds.filter((id) => id !== user.id);
    if (updated.length === 0) {
      delete reactions[emoji];
    } else {
      reactions[emoji] = updated;
    }
  } else {
    // Add reaction
    reactions[emoji] = [...currentIds, user.id];
  }

  const { data: updatedMsg, error: updateError } = await admin
    .from("messages")
    .update({ reactions })
    .eq("id", messageId)
    .select("*")
    .single();

  if (updateError) return c.json({ error: updateError.message }, 400);
  return c.json(updatedMsg);
});

export default app;


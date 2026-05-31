import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

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

  // 3. הצלבת הנתונים בקוד
  const enhancedData = convs.map(conv => {
    const partnerId = conv.user1_id === user.id ? conv.user2_id : conv.user1_id;
    
    // בדיקה האם קיים קשר מאושר עם הפרטנר של השיחה הזו
    const hasActiveConn = conns.some(conn => 
      (conn.requester_id === partnerId || conn.receiver_id === partnerId)
    );

    return {
      ...conv,
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
  const { data: existing, error: findError } = await supabase
    .from("conversations")
    .select("*")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  // At this point we've already verified there's an accepted connection,
  // so always return is_connection_active: true.
  if (existing) return c.json({ ...existing, is_connection_active: true });

  const { data: newConv, error: createError } = await supabase
    .from("conversations")
    .insert([{ user1_id: u1, user2_id: u2 }])
    .select()
    .single();

  if (createError) return c.json({ error: createError.message }, 400);
  return c.json({ ...newConv, is_connection_active: true }, 201);
});

// GET /api/chat/:id/messages
// Fetch messages for a conversation and mark them as read
app.get("/:id/messages", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  const conversationId = c.req.param("id");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { data, error: fetchError } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (fetchError) return c.json({ error: fetchError.message }, 400);

  const { error: updateError } = await supabase
    .from("messages")
    .update({ is_read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", user.id);

  if (updateError) {
    // Do not block message fetch if marking as read fails.
    console.error("Error marking messages as read:", updateError.message);
  }

  return c.json(data ?? []);
});

// DELETE /api/chat/:conversationId/messages/:messageId
app.delete("/:conversationId/messages/:messageId", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // Verify the message belongs to this user and conversation
  const { data: message, error: fetchError } = await supabase
    .from("messages")
    .select("id, sender_id, conversation_id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError || !message) return c.json({ error: "Message not found" }, 404);
  if (message.sender_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  const { error } = await supabase.from("messages").delete().eq("id", messageId);
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ success: true });
});

// PATCH /api/chat/:conversationId/messages/:messageId
app.patch("/:conversationId/messages/:messageId", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  const conversationId = c.req.param("conversationId");
  const messageId = c.req.param("messageId");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const content = body?.content?.trim();
  if (!content) return c.json({ error: "content is required" }, 400);

  const { data: message, error: fetchError } = await supabase
    .from("messages")
    .select("id, sender_id, conversation_id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .single();

  if (fetchError || !message) return c.json({ error: "Message not found" }, 404);
  if (message.sender_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  const { data: updated, error } = await supabase
    .from("messages")
    .update({ content, is_edited: true })
    .eq("id", messageId)
    .select("*")
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json(updated);
});

export default app;


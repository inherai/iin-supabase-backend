import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

// GET /api/chat
// Return all conversations for the current user (inbox list)
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { data, error } = await supabase
    .from("conversations")
    .select(`
      *,
      user1:user1_id(uuid, name, image, headline),
      user2:user2_id(uuid, name, image, headline)
    `)
    .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
    .order("updated_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 400);
  return c.json(data ?? []);
});

// POST /api/chat
// Accept partner_id and create/find a conversation
app.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const partnerId = body?.partner_id;

  if (!partnerId || typeof partnerId !== "string") {
    return c.json({ error: "partner_id is required" }, 400);
  }

  const { data: connection, error: connError } = await supabase
    .from("connections")
    .select("status")
    .or(
      `and(requester_id.eq.${user.id},receiver_id.eq.${partnerId}),and(requester_id.eq.${partnerId},receiver_id.eq.${user.id})`,
    )
    .eq("status", "accepted")
    .maybeSingle();

  if (connError || !connection) {
    return c.json(
      { error: "You can only start a conversation with an accepted connection" },
      403,
    );
  }

  // Keep participant ordering stable to avoid duplicates.
  const [u1, u2] = [user.id, partnerId].sort();

  const { data: existing, error: existingError } = await supabase
    .from("conversations")
    .select("*")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  if (existingError) return c.json({ error: existingError.message }, 400);
  if (existing) return c.json(existing);

  const { data: newConv, error: createError } = await supabase
    .from("conversations")
    .insert([{ user1_id: u1, user2_id: u2 }])
    .select()
    .single();

  if (createError) return c.json({ error: createError.message }, 400);
  return c.json(newConv, 201);
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

export default app;


import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();
const ALLOWED_UPDATE_STATUSES = new Set(["accepted", "ignored"]);
const CONNECTION_SELECT = `
  *,
  requester:requester_id(uuid, name, image, headline),
  receiver:receiver_id(uuid, name, image, headline)
`;

// GET /api/connections
// Returns all incoming and outgoing connections for current user
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { data, error } = await supabase
    .from("connections")
    .select(CONNECTION_SELECT)
    .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
    .order("created_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

// GET /api/connections/:id
// Returns only the number of accepted connections for a specific profile user
app.get("/:id", async (c) => {
  const supabase = c.get("supabase");
  const targetId = c.req.param("id");

  const { count, error } = await supabase
    .from("connections")
    .select("id", { count: "exact", head: true })
    .eq("status", "accepted")
    .or(`requester_id.eq.${targetId},receiver_id.eq.${targetId}`);

  if (error) return c.json({ error: error.message }, 400);
  return c.json({ count: count ?? 0 });
});

// POST /api/connections
// Creates a connection request with status='pending' by default
app.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const receiverId = body?.receiver_id;

  if (!receiverId) return c.json({ error: "receiver_id is required" }, 400);
  if (receiverId === user.id) {
    return c.json({ error: "You cannot connect with yourself" }, 400);
  }

  const { data: existing, error: existingError } = await supabase
    .from("connections")
    .select("id, requester_id, receiver_id, status")
    .or(
      `and(requester_id.eq.${user.id},receiver_id.eq.${receiverId}),and(requester_id.eq.${receiverId},receiver_id.eq.${user.id})`,
    )
    .maybeSingle();

  if (existingError) return c.json({ error: existingError.message }, 400);
  if (existing) {
    return c.json({ error: "Connection already exists", data: existing }, 409);
  }

  const { data, error } = await supabase
    .from("connections")
    .insert([
      {
        requester_id: user.id,
        receiver_id: receiverId,
        status: "pending",
      },
    ])
    .select(CONNECTION_SELECT)
    .single();

  if (error) return c.json({ error: error.message }, 400);
  return c.json(data, 201);
});

// PUT /api/connections/:id
// Receiver can set status only to accepted or ignored
app.put("/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const connectionId = c.req.param("id");
  const body = await c.req.json();
  const nextStatus = body?.status;

  if (!ALLOWED_UPDATE_STATUSES.has(nextStatus)) {
    return c.json({ error: "status must be accepted or ignored" }, 400);
  }

  const { data, error } = await supabase
    .from("connections")
    .update({ status: nextStatus })
    .eq("id", connectionId)
    .eq("receiver_id", user.id)
    .eq("status", "pending")
    .select(CONNECTION_SELECT)
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Not found or unauthorized" }, 404);

  return c.json(data);
});

// DELETE /api/connections/:id
// Requester can cancel only pending request
app.delete("/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const connectionId = c.req.param("id");

  const { data, error } = await supabase
    .from("connections")
    .delete()
    .eq("id", connectionId)
    .eq("requester_id", user.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Not found or unauthorized" }, 404);

  return c.json({ message: "Connection request canceled" });
});

export default app;

import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();
const ALLOWED_UPDATE_STATUSES = new Set(["accepted"]);
const CONNECTION_SELECT = `
  *,
  requester:requester_id(uuid, name, image, headline),
  receiver:receiver_id(uuid, name, image, headline)
`;

// GET /api/connections
// Query params:
// - status: 'accepted' (with pagination & search) or 'pending' (incoming requests only)
// - page: page number (for accepted only, default: 1)
// - limit: items per page (for accepted only, default: 20)
// - search: search by name (for accepted only)
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";

  let query = supabase
    .from("connections")
    .select(CONNECTION_SELECT, { count: "exact" });

  // For pending: only incoming requests (where user is receiver)
  if (status === "pending") {
    query = query
      .eq("receiver_id", user.id)
      .eq("status", "pending");
  } 
  // For accepted: both directions with search
  else if (status === "accepted") {
    // Use RPC for efficient search with joins
    if (search) {
      const { data, error } = await supabase.rpc(
        "search_accepted_connections",
        {
          p_user_id: user.id,
          p_search: search,
          p_limit: limit,
          p_offset: (page - 1) * limit,
        }
      );

      if (error) {
        console.error("RPC error:", error);
        return c.json({ error: error.message, details: error }, 400);
      }

      const totalCount = data && data.length > 0 ? Number(data[0].count) : 0;
      
      // Remove count field from each row
      const cleanData = data?.map((row: any) => {
        const { count, ...rest } = row;
        return rest;
      }) ?? [];

      return c.json({
        data: cleanData,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    }

    // Without search, use regular query
    query = query
      .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
      .eq("status", "accepted");

    // Apply pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);
  }
  // No status: all connections (both directions)
  else {
    query = query.or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`);
  }

  query = query.order("created_at", { ascending: false });

  const { data, error, count } = await query;

  if (error) return c.json({ error: error.message }, 400);

  // For accepted with pagination, return structured response
  if (status === "accepted") {
    return c.json({
      data: data ?? [],
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    });
  }

  // For pending or no status filter, return simple array
  return c.json(data ?? []);
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
// Receiver can set status only to accepted
app.put("/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const connectionId = c.req.param("id");
  const body = await c.req.json();
  const nextStatus = body?.status;

  if (!ALLOWED_UPDATE_STATUSES.has(nextStatus)) {
    return c.json({ error: "status must be accepted" }, 400);
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
// Delete connection (pending or accepted) if user is part of it
app.delete("/:id", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const connectionId = c.req.param("id");

  // First, fetch the connection to check ownership
  const { data: connection, error: fetchError } = await supabase
    .from("connections")
    .select("*")
    .eq("id", connectionId)
    .maybeSingle();

  if (fetchError) return c.json({ error: fetchError.message }, 400);
  if (!connection) return c.json({ error: "Connection not found" }, 404);

  // Check if user is part of this connection
  const isRequester = connection.requester_id === user.id;
  const isReceiver = connection.receiver_id === user.id;

  if (!isRequester && !isReceiver) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  // Delete the connection
  const { error: deleteError } = await supabase
    .from("connections")
    .delete()
    .eq("id", connectionId);

  if (deleteError) return c.json({ error: deleteError.message }, 400);

  return c.json({ message: "Connection deleted" });
});

export default app;

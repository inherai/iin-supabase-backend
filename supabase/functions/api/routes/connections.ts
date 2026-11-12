import { Hono } from "https://deno.land/x/hono/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parsePeopleSearchParams } from "./_peopleSearch.ts";
import { connectedAmong, fetchAcceptedConnectionIds, isUuid } from "./_connectionIds.ts";
import {
  asPendingConnections,
  clearDeclinesBetween,
  findDeclinesBetween,
  isBlocking,
  pendingLookingRequests,
  recordDecline,
  refreshBlockedRequest,
  withdrawDeclinedRequest,
} from "./_connectionDeclines.ts";

const app = new Hono();

const getAdminClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

// When a request that carried a note is accepted, seed the note as the first
// chat message so it isn't lost once the request disappears from the UI.
// Inserted as already-read: the receiver saw the note on the request itself.
async function seedChatWithConnectionNote(
  requesterId: string,
  receiverId: string,
  note: string,
) {
  const admin = getAdminClient();
  const [u1, u2] = [requesterId, receiverId].sort();

  const { data: existing, error: findError } = await admin
    .from("conversations")
    .select("id")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  if (findError) throw findError;

  let conversationId = existing?.id ?? null;

  if (!conversationId) {
    const { data: newConv, error: createError } = await admin
      .from("conversations")
      .insert([{ user1_id: u1, user2_id: u2 }])
      .select("id")
      .single();

    if (createError) throw createError;
    conversationId = newConv.id;
  }

  const { error: insertError } = await admin.from("messages").insert([
    {
      conversation_id: conversationId,
      sender_id: requesterId,
      content: note,
      is_read: true,
    },
  ]);

  if (insertError) throw insertError;

  if (existing) {
    await admin
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  }
}
const ALLOWED_UPDATE_STATUSES = new Set(["accepted"]);
const CONNECTION_SELECT = `
  *,
  requester:public_users_view!requester_id(uuid, first_name, last_name, image, headline, role),
  receiver:public_users_view!receiver_id(uuid, first_name, last_name, image, headline, role)
`;

// GET /api/connections
// Query params:
// - status: 'accepted' (with pagination & search), 'pending' (incoming requests only)
//   or 'sent' (my outgoing requests still waiting, incl. declined ones that look pending)
// - user_id: only my connection with this one user (any status)
// - page: page number (for accepted only, default: 1)
// - limit: items per page (for accepted only, default: 20)
// - search: search by name (for accepted only)
// - q / functions / company / company_scope / recruiters / mutual:
//   people-search filters (for accepted only) — see _peopleSearch.ts
app.get("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const status = c.req.query("status");
  const page = parseInt(c.req.query("page") || "1");
  const limit = parseInt(c.req.query("limit") || "20");
  const search = c.req.query("search") || "";
  const withUserId = c.req.query("user_id");

  // The unfiltered list below is cut off at PostgREST's max_rows (1000), so callers that
  // need one specific slice of it ask for that slice instead of filtering the whole list.
  if (!status && withUserId) {
    if (!isUuid(withUserId)) return c.json({ error: "Invalid user_id" }, 400);

    const { data, error } = await supabase
      .from("connections")
      .select(CONNECTION_SELECT)
      .or(`and(requester_id.eq.${user.id},receiver_id.eq.${withUserId}),and(requester_id.eq.${withUserId},receiver_id.eq.${user.id})`);

    if (error) return c.json({ error: error.message }, 400);
    if (data && data.length > 0) return c.json(data);

    // A request of mine that she declined still looks pending to me
    const declined = (await pendingLookingRequests(supabase, user.id))
      .filter((row: any) => row.receiver_id === withUserId);
    return c.json(declined);
  }

  if (status === "sent") {
    const { data, error } = await supabase
      .from("connections")
      .select(CONNECTION_SELECT)
      .eq("requester_id", user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) return c.json({ error: error.message }, 400);

    const rows = data ?? [];
    let declined = await pendingLookingRequests(supabase, user.id);
    if (declined.length > 0) {
      // Same rule as the unfiltered list: skip a declined request when a real row
      // with that person exists (in any status, either direction).
      const { ids: realPartners } = await connectedAmong(
        supabase,
        user.id,
        declined.map((row: any) => row.receiver_id),
      );
      declined = declined.filter((row: any) => !realPartners.has(row.receiver_id));
    }
    if (declined.length === 0) return c.json(rows);

    return c.json(
      [...rows, ...declined].sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    );
  }

  let query = supabase
    .from("connections")
    .select(CONNECTION_SELECT, { count: "exact" });

  // For pending: only incoming requests (where user is receiver)
  if (status === "pending") {
    query = query
      .eq("receiver_id", user.id)
      .eq("status", "pending");
  }
  // For accepted: unified RPC handles both directions, search, pagination
  // and computes a real mutual_connections_count per row.
  else if (status === "accepted") {
    const { data, error } = await supabase.rpc("get_accepted_connections", {
      p_user_id: user.id,
      p_search: search || null,
      p_limit: limit,
      p_offset: (page - 1) * limit,
      ...(parsePeopleSearchParams(c) ?? {}),
    });

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
  // No status: all connections (both directions)
  else {
    query = query.or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`);
  }

  query = query.order("created_at", { ascending: false });

  const { data, error } = await query;

  if (error) return c.json({ error: error.message }, 400);

  // No status: requests of mine that were declined still look pending to me
  if (!status) {
    const rows = data ?? [];
    const realPartners = new Set(
      rows.map((row: any) => row.requester_id === user.id ? row.receiver_id : row.requester_id),
    );
    const declined = (await pendingLookingRequests(supabase, user.id))
      .filter((row: any) => !realPartners.has(row.receiver_id));
    if (declined.length > 0) {
      return c.json(
        [...rows, ...declined].sort((a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        ),
      );
    }
  }

  // For pending or no status filter, return simple array
  return c.json(data ?? []);
});

// GET /api/connections/accepted-ids
// Returns: { ids: string[] } — all accepted connection user IDs for the current user (no pagination)
app.get("/accepted-ids", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const { ids, error } = await fetchAcceptedConnectionIds(supabase, user.id);

  if (error) return c.json({ error: error.message }, 400);

  return c.json({ ids });
});

// GET /api/connections/:id
// Returns only the number of accepted connections for a specific profile user
// GET /api/connections/companies?scope=connections|all&q=...
// Workplaces of my connections (or of the whole community) with how many
// members work there now / worked there before. Powers the company filter.
app.get("/companies", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const scope = c.req.query("scope") === "all" ? "all" : "connections";
  const q = (c.req.query("q") || "").trim().slice(0, 100);
  const limit = Math.min(parseInt(c.req.query("limit") || "30") || 30, 100);

  const { data, error } = await supabase.rpc("people_search_companies", {
    p_viewer_id: user.id,
    p_scope: scope,
    p_query: q || null,
    p_limit: limit,
  });

  if (error) {
    console.error("people_search_companies error:", error);
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    companies: (data ?? []).map((row: any) => ({
      key: row.company_key,
      name: row.name,
      company_id: row.company_id,
      logo: row.logo,
      current_count: Number(row.current_count),
      past_count: Number(row.past_count),
    })),
  });
});

// GET /api/connections/functions?scope=connections|all
// How many members per job function — the counts in the field filter.
app.get("/functions", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const scope = c.req.query("scope") === "all" ? "all" : "connections";
  const { data, error } = await supabase.rpc("people_search_function_counts", {
    p_viewer_id: user.id,
    p_scope: scope,
  });

  if (error) {
    console.error("people_search_function_counts error:", error);
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    counts: Object.fromEntries((data ?? []).map((row: any) => [row.function_key, Number(row.member_count)])),
  });
});

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

// POST /api/connections/batch-status
// Body: { user_ids: string[] }
// Returns: { connected_ids: string[] } — which of the given user IDs are accepted connections
app.post("/batch-status", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const userIds: string[] = body?.user_ids ?? [];

  if (!Array.isArray(userIds) || userIds.length === 0) {
    return c.json({ connected_ids: [] });
  }

  const { ids, error } = await connectedAmong(supabase, user.id, userIds, ["accepted"]);

  if (error) return c.json({ error: error.message }, 400);

  return c.json({ connected_ids: [...ids] });
});

// POST /api/connections
// Creates a connection request with status='pending' by default
app.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const receiverId = body?.receiver_id;
  const rawMessage = typeof body?.message === "string" ? body.message.trim() : "";
  const message = rawMessage.length > 0 ? rawMessage : null;

  if (!receiverId) return c.json({ error: "receiver_id is required" }, 400);
  if (receiverId === user.id) {
    return c.json({ error: "You cannot connect with yourself" }, 400);
  }
  if (message && message.length > 300) {
    return c.json({ error: "Message must be 300 characters or fewer" }, 400);
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

  const declines = await findDeclinesBetween(user.id, receiverId);

  // The receiver declined me before and I may not ask again yet: nothing is
  // sent, but to me the request looks pending like any other.
  const myDeclined = declines.find((d) => d.requester_id === user.id);
  if (myDeclined && isBlocking(myDeclined)) {
    const refreshed = await refreshBlockedRequest(myDeclined, message);
    const [row] = await asPendingConnections(supabase, user.id, [refreshed]);
    if (row) return c.json(row, 201);
    return c.json({ error: "Failed to create connection request" }, 400);
  }

  const { data, error } = await supabase
    .from("connections")
    .insert([
      {
        requester_id: user.id,
        receiver_id: receiverId,
        status: "pending",
        message,
      },
    ])
    .select(CONNECTION_SELECT)
    .single();

  if (error) return c.json({ error: error.message }, 400);

  // I declined this person before and now reach out myself — the slate is clean
  if (declines.some((d) => d.receiver_id === user.id)) {
    await clearDeclinesBetween(user.id, receiverId);
  }

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

  // invalidate score cache for both sides of the connection
  supabase.from("users").update({ scores_cached_at: null })
    .in("uuid", [user.id, data.requester_id]).then(() => {});

  if (data.message) {
    try {
      await seedChatWithConnectionNote(data.requester_id, user.id, data.message);
    } catch (e) {
      // Never fail the accept because of chat seeding
      console.error("Failed to seed chat with connection note:", e);
    }
  }

  await supabase
    .from("notifications")
    .delete()
    .eq("type", "CONN_REQ")
    .eq("actor_id", data.requester_id)
    .eq("user_id", user.id);

  await clearDeclinesBetween(user.id, data.requester_id);

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
  if (!connection) {
    // A request of mine that was declined but still looks pending to me
    if (await withdrawDeclinedRequest(connectionId, user.id)) {
      return c.json({ message: "Connection deleted" });
    }
    return c.json({ error: "Connection not found" }, 404);
  }

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

  // If receiver is declining a pending request, clean up the CONN_REQ notification
  // and remember the decline so the requester cannot simply ask again
  if (isReceiver && connection.status === "pending") {
    await supabase
      .from("notifications")
      .delete()
      .eq("type", "CONN_REQ")
      .eq("actor_id", connection.requester_id)
      .eq("user_id", user.id);

    const resendBlocked = await recordDecline(connection);
    if (resendBlocked) {
      return c.json({ message: "Connection deleted", resend_blocked: resendBlocked });
    }
  }

  return c.json({ message: "Connection deleted" });
});

export default app;

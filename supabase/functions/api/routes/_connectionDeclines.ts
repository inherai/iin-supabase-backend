import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Declined connection requests (migrations/add_connection_declines.sql).
//
// A decline is silent: the requester keeps seeing her request as pending and is
// never told. She cannot reach the receiver again for 6 months after a first
// decline, and never after a second one. The receiver can still reach out herself.
//
// Everything here goes through the service role — the table has no RLS policies,
// so the requester cannot read it. Every helper swallows its own errors and
// falls back to "no decline on record": connections must keep working even if
// this table is unavailable.

const COOLDOWN_MONTHS = 6;
const PERMANENT_AFTER = 2;

export type ResendBlocked = "cooldown" | "permanent";

export interface ConnectionDecline {
  id: string;
  requester_id: string;
  receiver_id: string;
  decline_count: number;
  declined_at: string;
  requested_at: string;
  message: string | null;
  hidden_from_requester: boolean;
}

const getAdminClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

const PROFILE_FIELDS = "uuid, first_name, last_name, image, headline, role";

/** Is the requester still barred from sending this receiver a new request? */
export function isBlocking(decline: ConnectionDecline, now = new Date()): boolean {
  if (decline.decline_count >= PERMANENT_AFTER) return true;
  const cooldownStart = new Date(now);
  cooldownStart.setMonth(cooldownStart.getMonth() - COOLDOWN_MONTHS);
  return new Date(decline.declined_at) > cooldownStart;
}

/** Remember that the receiver declined this pending request. */
export async function recordDecline(connection: {
  requester_id: string;
  receiver_id: string;
  created_at?: string | null;
  message?: string | null;
}): Promise<ResendBlocked | null> {
  try {
    const admin = getAdminClient();
    const { data: previous, error: findError } = await admin
      .from("connection_declines")
      .select("decline_count")
      .eq("requester_id", connection.requester_id)
      .eq("receiver_id", connection.receiver_id)
      .maybeSingle();
    if (findError) throw findError;

    const declineCount = (previous?.decline_count ?? 0) + 1;
    const { error } = await admin.from("connection_declines").upsert(
      {
        requester_id: connection.requester_id,
        receiver_id: connection.receiver_id,
        decline_count: declineCount,
        declined_at: new Date().toISOString(),
        requested_at: connection.created_at ?? new Date().toISOString(),
        message: connection.message ?? null,
        hidden_from_requester: false,
      },
      { onConflict: "requester_id,receiver_id" },
    );
    if (error) throw error;

    return declineCount >= PERMANENT_AFTER ? "permanent" : "cooldown";
  } catch (e) {
    console.error("Failed to record connection decline:", e);
    return null;
  }
}

/** Declines between two users, in either direction. */
export async function findDeclinesBetween(userA: string, userB: string): Promise<ConnectionDecline[]> {
  try {
    const { data, error } = await getAdminClient()
      .from("connection_declines")
      .select("*")
      .or(
        `and(requester_id.eq.${userA},receiver_id.eq.${userB}),and(requester_id.eq.${userB},receiver_id.eq.${userA})`,
      );
    if (error) throw error;
    return data ?? [];
  } catch (e) {
    console.error("Failed to look up connection declines:", e);
    return [];
  }
}

/** Forget any decline between two users (they connected, or the decliner reached out). */
export async function clearDeclinesBetween(userA: string, userB: string): Promise<void> {
  try {
    const { error } = await getAdminClient()
      .from("connection_declines")
      .delete()
      .or(
        `and(requester_id.eq.${userA},receiver_id.eq.${userB}),and(requester_id.eq.${userB},receiver_id.eq.${userA})`,
      );
    if (error) throw error;
  } catch (e) {
    console.error("Failed to clear connection declines:", e);
  }
}

/** Forget every decline a user is part of (account removal / leaving the network). */
export async function clearDeclinesForUser(userId: string): Promise<void> {
  try {
    const { error } = await getAdminClient()
      .from("connection_declines")
      .delete()
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`);
    if (error) throw error;
  } catch (e) {
    console.error("Failed to clear connection declines for user:", e);
  }
}

/**
 * The requester re-sent a request that is still blocked: nothing reaches the
 * receiver, but the request is put back in the requester's pending list.
 */
export async function refreshBlockedRequest(decline: ConnectionDecline, message: string | null): Promise<ConnectionDecline> {
  const refreshed = { requested_at: new Date().toISOString(), message, hidden_from_requester: false };
  try {
    const { error } = await getAdminClient()
      .from("connection_declines")
      .update(refreshed)
      .eq("id", decline.id);
    if (error) throw error;
  } catch (e) {
    console.error("Failed to refresh blocked connection request:", e);
  }
  return { ...decline, ...refreshed };
}

/**
 * The requester withdrew a request she sees as pending but that was already
 * declined. The block stays; the request just leaves her list.
 * Returns false when `id` is not such a request of hers.
 */
export async function withdrawDeclinedRequest(id: string, requesterId: string): Promise<boolean> {
  try {
    const { data, error } = await getAdminClient()
      .from("connection_declines")
      .update({ hidden_from_requester: true })
      .eq("id", id)
      .eq("requester_id", requesterId)
      .select("id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  } catch (e) {
    console.error("Failed to withdraw declined connection request:", e);
    return false;
  }
}

/** Everyone the user has a decline on record with, in either direction. */
export async function declinedUserIds(userId: string): Promise<string[]> {
  try {
    const { data, error } = await getAdminClient()
      .from("connection_declines")
      .select("requester_id, receiver_id")
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`);
    if (error) throw error;
    return (data ?? []).map((d: any) => d.requester_id === userId ? d.receiver_id : d.requester_id);
  } catch (e) {
    console.error("Failed to list declined users:", e);
    return [];
  }
}

/**
 * Shape declines as the pending connection rows the requester expects to see
 * (same shape as CONNECTION_SELECT in connections.ts). `supabase` is the
 * requester's own client, so profiles obey the same visibility as real rows.
 */
export async function asPendingConnections(supabase: any, requesterId: string, declines: ConnectionDecline[]): Promise<any[]> {
  if (declines.length === 0) return [];

  const { data: profiles, error } = await supabase
    .from("public_users_view")
    .select(PROFILE_FIELDS)
    .in("uuid", [requesterId, ...declines.map((d) => d.receiver_id)]);
  if (error) {
    console.error("Failed to load profiles for declined requests:", error);
    return [];
  }

  const byId = new Map((profiles ?? []).map((p: any) => [p.uuid, p]));
  return declines
    .filter((d) => byId.has(d.receiver_id))
    .map((d) => ({
      id: d.id,
      requester_id: d.requester_id,
      receiver_id: d.receiver_id,
      status: "pending",
      message: d.message,
      created_at: d.requested_at,
      requester: byId.get(requesterId) ?? null,
      receiver: byId.get(d.receiver_id),
    }));
}

/** Declined requests the requester should still see as pending. */
export async function pendingLookingRequests(supabase: any, requesterId: string): Promise<any[]> {
  try {
    const { data, error } = await getAdminClient()
      .from("connection_declines")
      .select("*")
      .eq("requester_id", requesterId)
      .eq("hidden_from_requester", false);
    if (error) throw error;
    return await asPendingConnections(supabase, requesterId, (data ?? []).filter((d: ConnectionDecline) => isBlocking(d)));
  } catch (e) {
    console.error("Failed to load declined requests:", e);
    return [];
  }
}

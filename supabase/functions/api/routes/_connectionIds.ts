// PostgREST caps every response at max_rows (1000) and supabase-js reports no error for the
// truncation, so reading a user's connections in one query silently drops the rest once she
// has more than 1000 of them. Read them through these helpers instead.

const PAGE_SIZE = 1000; // keep equal to max_rows in config.toml
const ID_CHUNK_SIZE = 50; // two .in() lists of uuids per request — keeps the URL short

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

type IdsResult<T> = { ids: T; error: { message: string } | null };

/**
 * Everyone the user is connected to. Pages to completion (ordered by id so range
 * pagination is stable) — a single query for anyone under 1000 connections.
 * Prefer connectedAmong() when only a known set of people matters.
 */
export async function fetchAcceptedConnectionIds(supabase: any, userId: string): Promise<IdsResult<string[]>> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("connections")
      .select("requester_id, receiver_id")
      .eq("status", "accepted")
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) return { ids, error };

    for (const row of data ?? []) {
      ids.push(row.requester_id === userId ? row.receiver_id : row.requester_id);
    }
    if (!data || data.length < PAGE_SIZE) return { ids, error: null };
  }
}

/**
 * Which of `candidateIds` the user has a connection row with, in either direction.
 * `statuses` narrows it (e.g. ["accepted"]); omit to match a row in any status.
 * Costs one small query per 50 candidates no matter how many connections she has.
 */
export async function connectedAmong(
  supabase: any,
  userId: string,
  candidateIds: string[],
  statuses?: string[],
): Promise<IdsResult<Set<string>>> {
  const ids = new Set<string>();
  const candidates = [...new Set(candidateIds)].filter((id) => isUuid(id) && id !== userId);

  const chunks: string[] = [];
  for (let i = 0; i < candidates.length; i += ID_CHUNK_SIZE) {
    chunks.push(candidates.slice(i, i + ID_CHUNK_SIZE).join(","));
  }

  const results = await Promise.all(chunks.map((chunk) => {
    let query = supabase
      .from("connections")
      .select("requester_id, receiver_id")
      .or(`and(requester_id.eq.${userId},receiver_id.in.(${chunk})),and(receiver_id.eq.${userId},requester_id.in.(${chunk}))`);
    if (statuses) query = query.in("status", statuses);
    return query;
  }));

  for (const { data, error } of results) {
    if (error) return { ids, error };
    for (const row of data ?? []) {
      ids.add(row.requester_id === userId ? row.receiver_id : row.requester_id);
    }
  }
  return { ids, error: null };
}

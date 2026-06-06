import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// --- Layered in-memory caches (module-level, shared across requests on same instance) ---
type SignalMap = Map<string, number>; // lowercase skill name → count

let popularityCache: { data: SignalMap; expiresAt: number } | null = null;
const roleAffinityCache = new Map<string, { data: SignalMap; expiresAt: number }>();
const suggestionsCache  = new Map<string, { data: { id: number; name: string }[]; expiresAt: number }>();

const TTL_GLOBAL_MS = 30 * 60 * 1000; // 30 min — popularity + role affinity
const TTL_RESULT_MS  =  5 * 60 * 1000; // 5 min  — per-user result

// GET /api/skills/suggestions
// Personalized smart suggestions combining popularity, role affinity, co-occurrence.
// Query params:
//   existing — comma-separated skill names the user currently has (including unsaved)
//   limit    — max results (default 20, max 50)
app.get("/suggestions", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const supabase = c.get("supabase");

  const existingParam = c.req.query("existing") ?? "";
  const existing = existingParam
    ? existingParam.split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  const limit = Math.min(
    parseInt(c.req.query("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT,
    50,
  );

  const now = Date.now();

  // Fast path: full result already cached for this user+skills combo
  const resultKey = `${user.id}|${[...existing].sort().join(",")}`;
  const cachedResult = suggestionsCache.get(resultKey);
  if (cachedResult && cachedResult.expiresAt > now) {
    c.header("Cache-Control", "private, max-age=60");
    return c.json(cachedResult.data);
  }

  // Fetch user's current job title from experience JSONB
  const { data: userRow } = await supabase
    .from("users")
    .select("experience")
    .eq("uuid", user.id)
    .single();

  const experiences: any[] = userRow?.experience ?? [];
  const currentTitle: string | null =
    experiences.find((e: any) => e.current === true || e.current === "true")?.title ?? null;
  const normalizedTitle = currentTitle ? currentTitle.toLowerCase().trim() : null;

  // --- Signal 1: Popularity (global cache, 30 min) ---
  let popMap: SignalMap;
  if (popularityCache && popularityCache.expiresAt > now) {
    popMap = popularityCache.data;
  } else {
    const { data, error } = await supabase.rpc("get_skill_popularity");
    if (error) return c.json({ error: error.message }, 400);
    popMap = new Map<string, number>(
      (data ?? []).map((r: any) => [r.sname as string, Number(r.cnt)]),
    );
    popularityCache = { data: popMap, expiresAt: now + TTL_GLOBAL_MS };
  }

  // --- Signal 2: Role affinity (per-title cache, 30 min) ---
  let roleMap: SignalMap = new Map();
  if (normalizedTitle) {
    const roleCached = roleAffinityCache.get(normalizedTitle);
    if (roleCached && roleCached.expiresAt > now) {
      roleMap = roleCached.data;
    } else {
      const { data, error } = await supabase.rpc("get_role_skill_affinity", {
        p_title: normalizedTitle,
      });
      if (!error) {
        roleMap = new Map<string, number>(
          (data ?? []).map((r: any) => [r.sname as string, Number(r.cnt)]),
        );
        roleAffinityCache.set(normalizedTitle, { data: roleMap, expiresAt: now + TTL_GLOBAL_MS });
      }
    }
  }

  // --- Signal 3: Co-occurrence (always fresh — truly per-user) ---
  let cooccMap: SignalMap = new Map();
  if (existing.length > 0) {
    const { data, error } = await supabase.rpc("get_skill_cooccurrence", {
      p_existing: existing,
      p_user_id: user.id,
    });
    if (!error) {
      cooccMap = new Map<string, number>(
        (data ?? []).map((r: any) => [r.sname as string, Number(r.cnt)]),
      );
    }
  }

  // --- Adaptive weights ---
  const hasSkills = existing.length > 0;
  const hasRole   = normalizedTitle !== null;
  const wPop   = hasSkills && hasRole ? 0.10 : (hasSkills || hasRole) ? 0.20 : 1.0;
  const wRole  = hasSkills && hasRole ? 0.35 : hasRole   ? 0.80 : 0.0;
  const wCoocc = hasSkills && hasRole ? 0.55 : hasSkills ? 0.80 : 0.0;

  const popMax   = Math.max(...popMap.values(),   1);
  const roleMax  = Math.max(...roleMap.values(),  1);
  const cooccMax = Math.max(...cooccMap.values(), 1);

  // --- Score all candidate skills ---
  const { data: allSkills, error: skillsError } = await supabase
    .from("skills")
    .select("id, name");
  if (skillsError) return c.json({ error: skillsError.message }, 400);

  const existingLower = new Set(existing.map((s: string) => s.toLowerCase()));

  // Lift: co-occurrence normalized by popularity — penalizes skills that are
  // universally popular (JavaScript appears with everything) and rewards skills
  // that are specifically correlated with the user's niche (e.g. Jenkins for QA).
  const liftMap = new Map<string, number>();
  for (const [key, cooccCnt] of cooccMap) {
    const popCnt = popMap.get(key) ?? 1;
    liftMap.set(key, cooccCnt / popCnt);
  }
  const liftMax = Math.max(...liftMap.values(), 1);

  const scored = (allSkills ?? [])
    .filter((s: any) => !existingLower.has((s.name as string).toLowerCase()))
    .map((s: any) => {
      const key = (s.name as string).toLowerCase();
      const score =
        ((popMap.get(key)   ?? 0) / popMax)  * wPop  +
        ((roleMap.get(key)  ?? 0) / roleMax) * wRole +
        ((liftMap.get(key)  ?? 0) / liftMax) * wCoocc;
      return { id: s.id as number, name: s.name as string, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ id, name }) => ({ id, name }));

  suggestionsCache.set(resultKey, { data: scored, expiresAt: now + TTL_RESULT_MS });
  c.header("Cache-Control", "private, max-age=60");
  return c.json(scored);
});

// GET /api/skills/rank
// Ranks the caller's own skills by global popularity.
// Query params:
//   skills — comma-separated skill names to rank
// Returns the same list sorted by popularity descending.
app.get("/rank", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const skillsParam = c.req.query("skills") ?? "";
  const skills = skillsParam
    ? skillsParam.split(",").map((s: string) => s.trim()).filter(Boolean)
    : [];
  if (skills.length === 0) return c.json([]);

  const now = Date.now();

  let popMap: SignalMap;
  if (popularityCache && popularityCache.expiresAt > now) {
    popMap = popularityCache.data;
  } else {
    const supabase = c.get("supabase");
    const { data, error } = await supabase.rpc("get_skill_popularity");
    if (error) return c.json({ error: error.message }, 400);
    popMap = new Map<string, number>(
      (data ?? []).map((r: any) => [r.sname as string, Number(r.cnt)]),
    );
    popularityCache = { data: popMap, expiresAt: now + TTL_GLOBAL_MS };
  }

  const ranked = [...skills].sort((a, b) => {
    const aCount = popMap.get(a.toLowerCase()) ?? 0;
    const bCount = popMap.get(b.toLowerCase()) ?? 0;
    return bCount - aCount || a.localeCompare(b);
  });

  c.header("Cache-Control", "private, max-age=300");
  return c.json(ranked);
});

// GET /api/skills
// - without q: returns random skills (via RPC)
// - with q: returns autocomplete suggestions sorted by name
app.get("/", async (c) => {
  try {
    const supabase = c.get("supabase");
    const query = (c.req.query("q") ?? "").trim();
    const limitParam = Number.parseInt(
      c.req.query("limit") ?? `${DEFAULT_LIMIT}`,
      10,
    );

    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let data, error;

    if (query) {
      const result = await supabase
        .from("skills")
        .select("id, name")
        .ilike("name", `%${query}%`)
        .order("name", { ascending: true })
        .limit(limit);
      data = result.data;
      error = result.error;
    } else {
      const result = await supabase.rpc("get_random_skills", { row_limit: limit });
      data = result.data;
      error = result.error;
    }

    if (error) {
      return c.json({ error: error.message }, 400);
    }

    c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
    return c.json(data ?? []);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;

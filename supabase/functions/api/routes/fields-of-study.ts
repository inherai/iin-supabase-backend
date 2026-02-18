import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// GET /api/fields-of-study
// - without q: returns the first values by alphabetical order
// - with q: returns autocomplete suggestions by name
app.get("/", async (c) => {
  try {
    const supabase = c.get("supabase");
    const query = (c.req.query("q") ?? "").trim();
    const limitParam = Number.parseInt(c.req.query("limit") ?? `${DEFAULT_LIMIT}`, 10);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    let request = supabase
      .from("fields_of_study")
      .select("id, name")
      .order("name", { ascending: true });

    if (query) {
      request = request.ilike("name", `%${query}%`);
    }

    const { data, error } = await request.limit(limit);

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

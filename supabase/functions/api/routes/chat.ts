import { Hono } from "https://deno.land/x/hono/mod.ts";

const app = new Hono();

// GET /api/chat
// מחזיר את כל השיחות של המשתמש הנוכחי (עבור רשימת ה-Inbox)
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
    .or(``user1_id.eq`.${`user.id`},`user2_id.eq`.${`user.id`}`)
    .order("updated_at", { ascending: false });

  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

// POST /api/chat
// מקבל partner_id ובודק/יוצר שיחה
app.post("/", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json();
  const partnerId = body?.partner_id;

  if (!partnerId) return c.json({ error: "partner_id is required" }, 400);

  // 1. בדיקה האם יש קונקשן מאושר (חובה לפי הלוגיקה שלך)
  const { data: connection, error: connError } = await supabase
    .from("connections")
    .select("status")
    .or(`and(`requester_id.eq`.${`user.id`},`receiver_id.eq`.${partnerId}),and(`requester_id.eq`.${partnerId},`receiver_id.eq`.${`user.id`})`)
    .eq("status", "accepted")
    .maybeSingle();

  if (connError || !connection) {
    return c.json({ error: "You can only start a conversation with an accepted connection" }, 403);
  }

  // 2. סידור ה-IDs למניעת כפילויות (הקטן תמיד ב-user1)
  const [u1, u2] = [user.id, partnerId].sort();

  // 3. בדיקה אם כבר קיימת שיחה
  const { data: existing, error: existingError } = await supabase
    .from("conversations")
    .select("*")
    .eq("user1_id", u1)
    .eq("user2_id", u2)
    .maybeSingle();

  if (existing) return c.json(existing); // מחזיר את השיחה הקיימת

  // 4. יצירת שיחה חדשה אם לא קיימת
  const { data: newConv, error: createError } = await supabase
    .from("conversations")
    .insert([{ user1_id: u1, user2_id: u2 }])
    .select()
    .single();

  if (createError) return c.json({ error: createError.message }, 400);
  return c.json(newConv, 201);
});

// GET /api/chat/:conversation_id/messages
// שליפת הודעות לשיחה ספציפית וסימון כנקראו
app.get("/:id/messages", async (c) => {
  const supabase = c.get("supabase");
  const user = c.get("user");
  const conversationId = c.req.param("id");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  // 1. שליפת ההודעות עבור השיחה
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) return c.json({ error: error.message }, 400);

  // 2. עדכון ההודעות בשיחה ל is_read=true
  // העדכון חל על הודעות שהמשתמש הנוכחי אינו השולח שלהן
  const { error: updateError } = await supabase
    .from("messages")
    .update({ is_read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", user.id);

  if (updateError) {
    // מומלץ לתעד את השגיאה, אך אין לחסום את שליחת ההודעות למשתמש
    console.error("Error marking messages as read:", updateError.message);
  }
  
  // 3. החזרת ההודעות למשתמש
  return c.json(data);
});

export default app;

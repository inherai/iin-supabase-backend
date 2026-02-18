// supabase/functions/api/routes/posts.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const app = new Hono()

// ====================================================================
// 1. הגדרות ופונקציות עזר (Logic Helpers)
// ====================================================================

function isQualityPost(message: string): boolean {
  if (!message) return false;
  const cleanMsg = message.toLowerCase().trim();
  const noiseWords = ["מקפיצה", "up", "הקפצה", "מעלה", "תודה"];
  const isNoise = noiseWords.some(word => cleanMsg.includes(word));
  const isTooShort = cleanMsg.length < 10;
  return !isNoise && !isTooShort;
}

async function deterministicInt8(seed: string): Promise<number> {
  const data = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) + BigInt(bytes[i]);
  return Number(n & 0x1fffffffffffffn);
}

async function updatePostVector(postId: any) {
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: post, error } = await supabaseAdmin
      .from("posts")
      .select(`subject, message, comments (message)`)
      .eq("id", postId)
      .single();

    if (error || !post) return;

    const subject = post.subject || "";
    const message = post.message || "";
    const commentsText = (post.comments ?? [])
      .map((c: any) => c.message)
      .join("\n");

    const fullText = `Subject: ${subject}\nMessage: ${message}\nComments:\n${commentsText}`.trim();

    const embRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: fullText.slice(0, 8000),
    });

    await supabaseAdmin.from("vectors").upsert({
      postid: postId,
      vector: embRes.data[0].embedding,
    }, { onConflict: 'postid' });

    console.log(` Vector updated for post: ${postId}`);
  } catch (err) {
    console.error(" Error updating vector:", err);
  }
}

async function ensureUserExists(supabase: any, email: string) {
  if (!email || !email.includes('@')) return;
  const cleanEmail = email.toLowerCase().trim();
  const { data } = await supabase.from("users").select("email").eq("email", cleanEmail).maybeSingle();
  if (!data) {
    await supabase.from("users").insert({
      uuid: crypto.randomUUID(),
      email: cleanEmail,
      name: cleanEmail.split('@')[0],
      status: "Inactive"
    }).ignore();
  }
}

// מחזירה Author בלי email
function toAuthor(profileData: any, fallbackEmail: string) {
  if (profileData) {
    return {
      uuid: profileData.uuid,
      name: profileData.name,
      image: profileData.image ?? null,
      role: profileData.role,
      headline: profileData.headline
    };
  }
  return {
    name: fallbackEmail,
    image: null
  };
}

// ====================================================================
// 2. נתיבי API
// ====================================================================

app.get('/', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const current_user_uuid = currentUser?.id

    const last_effective_date = c.req.query('last_effective_date')
    const last_id = c.req.query('last_id')
    const session_start = c.req.query('session_start') || new Date().toISOString()

    const { data: posts, error: postsError } = await supabase.rpc('get_stabilized_feed', {
      p_session_start: session_start,
      p_last_effective_date: last_effective_date || null,
      p_last_id: last_id || null,
      p_limit: 25
    })

    if (postsError) throw postsError
    if (!posts || posts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

    const postIds = posts.map((p: any) => p.id)

    const { data: allPostLikes } = await supabase
      .from('likes')
      .select('target_id, user_id')
      .in('target_id', postIds)

    const emailsToFetch = new Set(posts.map((p: any) => p.sender))

    const { data: comments } = await supabase
      .from('comments')
      .select('*')
      .in('post_id', postIds)
      .lte('created_at', session_start)
      .order('created_at', { ascending: true })

    const commentIds = comments?.map((c: any) => c.id.toString()) || []
    const { data: allCommentLikes } = await supabase
      .from('likes')
      .select('target_id, user_id')
      .in('target_id', commentIds)

    comments?.forEach((c: any) => emailsToFetch.add(c.sender))

    const uniqueEmails = Array.from(emailsToFetch)
    const PROJECT_URL = Deno.env.get('SUPABASE_URL')
    const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile`

    const profileRes = await fetch(PROFILE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': c.req.header('Authorization') || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emails: uniqueEmails })
    })

    if (!profileRes.ok) {
      console.error('Failed to fetch profiles via API', await profileRes.text())
      throw new Error('Failed to fetch user profiles')
    }

    const enrichedUsers = await profileRes.json()
    const usersMap = enrichedUsers.reduce((acc: any, u: any) => ({ ...acc, [u.email.toLowerCase()]: u }), {})

    const commentsByPostId = comments?.reduce((acc: any, comment: any) => {
      const profileData = usersMap?.[comment.sender?.toLowerCase()];
      const author = profileData
        ? { ...profileData,id: profileData.uuid, name: profileData.name || '' }
        : { name: comment.sender, image: null };

      const commentLikes = allCommentLikes?.filter(
        (l: any) => l.target_id === comment.id.toString()
      ) || []

      if (!acc[comment.post_id]) acc[comment.post_id] = []
      acc[comment.post_id].push({
        ...comment, // כולל sender
        author,
        likes_count: commentLikes.length,
        is_liked: commentLikes.some((l: any) => l.user_id === current_user_uuid)
      })
      return acc
    }, {})

    const enrichedPosts = posts.map((post: any) => {
      const postLikes = allPostLikes?.filter((l: any) => l.target_id === post.id) || []
      const profileData = usersMap?.[post.sender?.toLowerCase()];
      const postAuthor = profileData
        ? { ...profileData, name: profileData.name || '' }
        : { name: post.sender, image: null };

      return {
        ...post, // כולל sender
        author: postAuthor,
        comments: commentsByPostId?.[post.id] || [],
        likes_count: postLikes.length,
        is_liked: postLikes.some((l: any) => l.user_id === current_user_uuid)
      }
    })

    const lastPost = posts[posts.length - 1]
    const nextCursor = lastPost ? {
      last_effective_date: lastPost.effective_sort_date,
      last_id: lastPost.id,
      session_start: session_start
    } : null

    return c.json({ data: enrichedPosts, meta: { next_cursor: nextCursor, count: enrichedPosts.length } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (Array.isArray(body)) {
      let processed = 0;
      for (const msg of body) {
        try {
          const senderEmail = msg.sender?.toLowerCase().trim();
          if (!senderEmail) continue;

          await ensureUserExists(supabaseAdmin, senderEmail);
          const postId = await deterministicInt8(msg.googleThreadId);
          const messageUniqueId = msg.googleMessageId;

          const { data: existingPost } = await supabaseAdmin.from("posts").select("id").eq("id", postId).maybeSingle();
          const threadExists = !!existingPost;

          if (threadExists && msg.googleThreadId !== messageUniqueId) {
            const commentId = await deterministicInt8(messageUniqueId + senderEmail);
            await supabaseAdmin.from("comments").upsert({
              id: commentId,
              post_id: postId,
              sender: senderEmail,
              message: msg.message || "",
              attachments: msg.attachments,
              created_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString()
            });
            await updatePostVector(postId);
          } else {
            await supabaseAdmin.from("posts").upsert({
              id: postId,
              sender: senderEmail,
              subject: msg.subject || "",
              message: msg.message || "",
              attachments: msg.attachments,
              sent_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString(),
              post_type: msg.post_type
            });
            await updatePostVector(postId);
          }
          processed++;
        } catch (innerErr) {
          console.error("Error processing script item:", innerErr);
        }
      }
      return c.json({ success: true, processed, mode: "script" });
    } else {
      const user = c.get('user');
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { subject, message, attachments } = body;
      if (!message) return c.json({ error: "Message is required" }, 400);
      const postId = crypto.randomUUID();

      const { data, error } = await supabase.from('posts').insert({
        id: postId,
        sender: user.email,
        subject: subject || "",
        message: message,
        attachments: attachments || [],
        sent_at: new Date().toISOString()
      }).select().single();

      if (error) throw error;
      updatePostVector(data.id);

      return c.json({ success: true, data, mode: "app" });
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
})

app.post('/comments', async (c) => {
  try {
    const supabase = c.get('supabase')
    const user = c.get('user')
    const postId = c.req.query('id')
    const { message, attachments } = await c.req.json()

    if (!user) return c.json({ error: "Unauthorized" }, 401)
    if (!postId) return c.json({ error: "Post ID query param is required" }, 400)
    if (!message) return c.json({ error: "Message is required" }, 400)

    // 1. הכנסת התגובה לטבלת comments
    const { data: commentData, error: commentError } = await supabase
      .from('comments')
      .insert({
        post_id: postId,
        sender: user.email,
        message: message,
        attachments: attachments || [],
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (commentError) throw commentError

    // 2. שליפת ה-uuid של המשתמש מטבלת users לפי המייל
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('uuid')
      .eq('email', user.email)
      .single()

    if (userError) throw userError

    if (isQualityPost(message)) {
      updatePostVector(postId)
    }

    // 3. בניית האובייקט הסופי עם המבנה שביקשת
    return c.json({ 
      success: true, 
      data: {
        ...commentData,
        author: {
          id: userData.uuid
        }
      } 
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
export default app

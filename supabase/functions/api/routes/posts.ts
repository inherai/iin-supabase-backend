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

const RECRUITER_ROLE = 'recruiters';

function isRecruiterViewer(user: any): boolean {
  const role = String(user?.app_metadata?.role ?? '').toLowerCase().trim();
  return role === RECRUITER_ROLE;
}
//support all types of attachment.

const PPTX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/powerpoint',
  'application/x-mspowerpoint',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'png', 'gif', 'bmp', 'dib',
  'webp', 'avif', 'heic', 'heif', 'svg', 'svgz', 'ico', 'tif', 'tiff',
  'apng',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'avi', 'wmv', 'flv', 'f4v', 'mkv', 'webm',
  'mpeg', 'mpg', 'mpe', 'mpv', '3gp', '3gpp', '3g2', 'mts', 'm2ts', 'ts',
  'ogv', 'vob',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'wave', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma',
  'aiff', 'aif', 'aifc', 'amr', 'mid', 'midi',
]);

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function extractExtension(value: string | null): string | null {
  if (!value) return null;
  const cleanValue = value.split('?')[0].split('#')[0];
  const fileName = cleanValue.split('/').pop() ?? cleanValue;
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === fileName.length - 1) return null;
  return fileName.slice(dotIdx + 1).toLowerCase();
}

function deriveFileName(url: string | null): string | null {
  if (!url) return null;
  const cleanValue = url.split('?')[0].split('#')[0];
  const fileName = cleanValue.split('/').pop() ?? cleanValue;
  return fileName || null;
}

function inferAttachmentType(mimeType: string | null, extension: string | null): 'image' | 'video' | 'audio' | 'slides' | 'file' {
  const normalizedMime = mimeType?.toLowerCase().trim() ?? '';
  const normalizedExt = extension?.toLowerCase().trim() ?? '';

  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';

  if (PPTX_MIME_TYPES.has(normalizedMime) || normalizedExt === 'pptx') return 'slides';
  if (normalizedExt && IMAGE_EXTENSIONS.has(normalizedExt)) return 'image';
  if (normalizedExt && VIDEO_EXTENSIONS.has(normalizedExt)) return 'video';
  if (normalizedExt && AUDIO_EXTENSIONS.has(normalizedExt)) return 'audio';
  return 'file';
}

function toOfficeSlidesViewerUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null;
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
  } catch {
    return null;
  }
}

function normalizeAttachment(rawAttachment: any) {
  if (rawAttachment === null || rawAttachment === undefined) return null;

  const base =
    typeof rawAttachment === 'object' && !Array.isArray(rawAttachment)
      ? rawAttachment
      : { url: String(rawAttachment) };

  const url = firstString(
    base.url,
    base.uri,
    base.path,
    base.src,
    base.file_url,
    base.publicUrl,
    base.public_url,
  );

  const name = firstString(
    base.name,
    base.fileName,
    base.filename,
    base.originalName,
    base.original_name,
  ) ?? deriveFileName(url);

  const incomingMimeType = firstString(
    base.mime_type,
    base.mimeType,
    base.type,
    base.contentType,
    base.content_type,
  );

  const extension = extractExtension(name) ?? extractExtension(url);
  const attachmentType = inferAttachmentType(incomingMimeType, extension);

  const display =
    attachmentType === 'slides'
      ? {
        as: 'slides',
        viewer: 'office',
        embed_url: toOfficeSlidesViewerUrl(url),
        has_thumbnail: false,
      }
      : attachmentType === 'image'
      ? {
        as: 'image',
        viewer: 'native',
        has_thumbnail: true,
      }
      : attachmentType === 'video'
      ? {
        as: 'video',
        viewer: 'native',
        has_thumbnail: true,
      }
      : attachmentType === 'audio'
      ? {
        as: 'audio',
        viewer: 'native',
        has_thumbnail: false,
      }
      : {
        as: 'file',
        viewer: 'download',
        has_thumbnail: false,
      };

  return {
    ...base,
    url: url ?? null,
    name: name ?? null,
    mime_type: incomingMimeType?.toLowerCase() ?? null,
    file_extension: extension ?? null,
    attachment_type: attachmentType,
    display,
  };
}

function normalizeAttachments(rawAttachments: any): any[] {
  if (rawAttachments === null || rawAttachments === undefined) return [];
  const attachmentsList = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
  return attachmentsList
    .map((attachment) => normalizeAttachment(attachment))
    .filter((attachment) => attachment !== null);
}
//support all types of attachment.

// ====================================================================
// 2. נתיבי API
// ====================================================================

app.get('/', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const current_user_uuid = currentUser?.id
    const viewerIsRecruiter = isRecruiterViewer(currentUser)

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

    const visiblePosts = viewerIsRecruiter
      ? posts.filter((p: any) => p.community_members_only !== true)
      : posts

    if (visiblePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

    const postIds = visiblePosts.map((p: any) => p.id)

    const { data: allPostLikes } = await supabase
      .from('likes')
      .select('target_id, user_id, reaction_type')
      .in('target_id', postIds)

    const emailsToFetch = new Set<string>()
    visiblePosts.forEach((p: any) => {
      if (p.sender) emailsToFetch.add(p.sender)
    })

    const { data: comments } = await supabase
      .from('comments')
      .select('*')
      .in('post_id', postIds)
      .lte('created_at', session_start)
      .order('created_at', { ascending: true })

    const visibleComments = viewerIsRecruiter
      ? (comments || []).filter((c: any) => c.community_members_only !== true)
      : (comments || [])

    const commentIds = visibleComments.map((c: any) => c.id.toString())
    const { data: allCommentLikes } = await supabase
      .from('likes')
      .select('target_id, user_id, reaction_type')
      .in('target_id', commentIds)

    visibleComments.forEach((c: any) => emailsToFetch.add(c.sender))

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

    const commentsByPostId = visibleComments.reduce((acc: any, comment: any) => {
      const profileData = usersMap?.[comment.sender?.toLowerCase()];
      const author = profileData
        ? { ...profileData,id: profileData.uuid, name: profileData.name || '' }
        : { name: comment.sender, image: null };

      const commentLikes = allCommentLikes?.filter(
        (l: any) => l.target_id === comment.id.toString()
      ) || []

      // ספירת ריאקציות לפי סוג
      const reactionCounts = commentLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})

      // הריאקציות של המשתמש הנוכחי (מערך)
      const userReactions = commentLikes
        .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
        .map((l: any) => l.reaction_type)

      const likedUserIds = Array.from(
        new Set(
          commentLikes
            .map((l: any) => l.user_id)
            .filter((id: any) => id !== null && id !== undefined)
        )
      )

      if (!acc[comment.post_id]) acc[comment.post_id] = []
      acc[comment.post_id].push({
        ...comment, // כולל sender
        attachments: normalizeAttachments(comment.attachments),
        author,
        likes_count: commentLikes.length,
        liked_user_ids: likedUserIds,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null, // backward compatibility
        is_liked: userReactions.length > 0 // backward compatibility
      })
      return acc
    }, {})

    const enrichedPosts = visiblePosts.map((post: any) => {
      const postLikes = allPostLikes?.filter((l: any) => l.target_id === post.id) || []
      const profileData = usersMap?.[post.sender?.toLowerCase()];
      const postAuthor = profileData
        ? { ...profileData, name: profileData.name || '' }
        : { name: post.sender, image: null };

      // ספירת ריאקציות לפי סוג
      const reactionCounts = postLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})

      // הריאקציות של המשתמש הנוכחי (מערך)
      const userReactions = postLikes
        .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
        .map((l: any) => l.reaction_type)

      const likedUserIds = Array.from(
        new Set(
          postLikes
            .map((l: any) => l.user_id)
            .filter((id: any) => id !== null && id !== undefined)
        )
      )

      return {
        ...post, // כולל sender
        attachments: normalizeAttachments(post.attachments),
        author: postAuthor,
        comments: commentsByPostId?.[post.id] || [],
        likes_count: postLikes.length,
        liked_user_ids: likedUserIds,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null, // backward compatibility
        is_liked: userReactions.length > 0 // backward compatibility
      }
    })

    const lastPost = visiblePosts[visiblePosts.length - 1]
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
          const normalizedAttachments = normalizeAttachments(msg.attachments);

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
              attachments: normalizedAttachments,
              community_members_only: typeof msg.community_members_only === 'boolean' ? msg.community_members_only : false,
              created_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString()
            });
            await updatePostVector(postId);
          } else {
            await supabaseAdmin.from("posts").upsert({
              id: postId,
              sender: senderEmail,
              subject: msg.subject || "",
              message: msg.message || "",
              attachments: normalizedAttachments,
              sent_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString(),
              post_type: msg.post_type,
              community_members_only: typeof msg.community_members_only === 'boolean' ? msg.community_members_only : false
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

      const { subject, message, attachments, post_type } = body;
      const communityMembersOnlyInput = body.community_members_only ?? body.communityMembersOnly;

      if (communityMembersOnlyInput !== undefined && typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400);
      }

      const community_members_only = communityMembersOnlyInput === true;

      if (!message) return c.json({ error: "Message is required" }, 400);
      const postId = crypto.randomUUID();
      const normalizedAttachments = normalizeAttachments(attachments);

      const { data, error } = await supabase.from('posts').insert({
        id: postId,
        sender: user.email,
        subject: subject || "",
        message: message,
        attachments: normalizedAttachments,
        sent_at: new Date().toISOString(),
        post_type: post_type || null,
        community_members_only
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
    const { message, attachments, community_members_only, communityMembersOnly } = await c.req.json()
    const communityMembersOnlyInput =
      community_members_only !== undefined ? community_members_only : communityMembersOnly

    if (!user) return c.json({ error: "Unauthorized" }, 401)
    if (!postId) return c.json({ error: "Post ID query param is required" }, 400)
    if (!message) return c.json({ error: "Message is required" }, 400)
    if (communityMembersOnlyInput !== undefined && typeof communityMembersOnlyInput !== 'boolean') {
      return c.json({ error: "community_members_only must be boolean" }, 400)
    }

    const resolvedCommunityMembersOnly = communityMembersOnlyInput === true
    const normalizedAttachments = normalizeAttachments(attachments)

    // 1. הכנסת התגובה לטבלת comments
    const { data: commentData, error: commentError } = await supabase
      .from('comments')
      .insert({
        post_id: postId,
        sender: user.email,
        message: message,
        attachments: normalizedAttachments,
        community_members_only: resolvedCommunityMembersOnly,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (commentError) throw commentError

    // 2. שליפת ה-uuid וה-name מטבלת users לפי המייל
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('uuid, name') // הוספנו כאן את name
      .eq('email', user.email)
      .single()

    if (userError) throw userError

    if (isQualityPost(message)) {
      updatePostVector(postId)
    }

    // 3. החזרת האובייקט המבוקש עם id ושם
    return c.json({ 
      success: true, 
      data: {
        ...commentData,
        author: {
          id: userData.uuid,
          name: userData.name // הוספנו את השם כאן
        }
      } 
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.put('/:id', async (c) => {
  try {
    const user = c.get('user');
    // נוודא שהמשתמש מחובר
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const supabase = c.get('supabase');
    const postId = c.req.param('id'); // שליפת מזהה הפוסט מה-URL
    
    if (!postId) return c.json({ error: "Post ID is required" }, 400);

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // נכין את האובייקט לעדכון. אנחנו מעדכנים רק את מה שהתקבל, 
    // אבל תמיד מעדכנים את זמן העריכה וסטטוס העריכה.
    const updateData: any = {
      updated_at: new Date().toISOString(),
      is_edited: true
    };

    if (body.message !== undefined) updateData.message = body.message;
    if (body.subject !== undefined) updateData.subject = body.subject;
    if (body.post_type !== undefined) updateData.post_type = body.post_type;
    
    // אם נשלחו קבצים מצורפים חדשים, ננרמל אותם
    if (body.attachments !== undefined) {
      updateData.attachments = normalizeAttachments(body.attachments);
    }

    const communityMembersOnlyInput = body.communityMembersOnly;
    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400);
      }
      updateData.community_members_only = communityMembersOnlyInput;
    }

    // ביצוע העדכון במסד הנתונים
    const { data, error } = await supabase
      .from('posts')
      .update(updateData)
      .eq('id', postId)
      .eq('sender', user.email) // הגנה: רק שולח הפוסט המקורי יכול לערוך אותו!
      .select()
      .single();

    if (error) {
      // אם אין תוצאות, כנראה שהפוסט לא קיים או שאינו שייך למשתמש
      if (error.code === 'PGRST116') {
         return c.json({ error: "Post not found or you don't have permission to edit it" }, 404);
      }
      throw error;
    }

    // חשוב! אם שינינו את התוכן, צריך לעדכן את הווקטור כדי שהחיפוש הסמנטי ימשיך לעבוד נכון
    if (body.message !== undefined || body.subject !== undefined) {
      updatePostVector(postId); 
    }

    return c.json({ success: true, data });

  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});


app.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    // נוודא שהמשתמש מחובר
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const supabase = c.get('supabase');
    const postId = c.req.param('id');
    
    if (!postId) return c.json({ error: "Post ID is required" }, 400);

    // מחיקה מהדאטהבייס
    const { error } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)
      .eq('sender', user.email); // הגנה: רק הבעלים יכול למחוק

    if (error) throw error;

    // הערה: אם יש לך וקטורים שמורים בטבלה נפרדת, ייתכן שתצטרך למחוק גם אותם כאן,
    // אלא אם הגדרת On Delete Cascade ב-Supabase (מה שמומלץ לעשות).

    return c.json({ success: true, message: "Post deleted successfully" });

  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app

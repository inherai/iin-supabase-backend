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

function toStoragePath(v: any): string | null {
  if (!v) return null;

  const s = (typeof v === 'string' ? v : (v.localPath || v.url || '')).toString().trim();
  if (!s) return null;

  // אם זה כבר path יחסי
  if (!s.startsWith('http')) return s;

  // אם זה URL מלא - נחלץ את החלק שאחרי /attachments/
  const parts = s.split('/attachments/');
  if (parts.length > 1) return parts[1].trim();

  return null;
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

    const targetUserId = c.req.query('userid') // ה-ID שקיבלנו ב-Query
    let filterEmail = null

if (targetUserId) {
      const { data: email, error: emailError } = await supabase
        .rpc('get_user_email_by_uuid', { p_uuid: targetUserId })

      if (emailError || !email) {
        console.error("Error fetching email:", emailError)
        // אם לא מצאנו אימייל למשתמש הזה, נחזיר פיד ריק
        return c.json({ data: [], meta: { next_cursor: null } })
      }
      filterEmail = email
    }

    const { data: posts, error: postsError } = await supabase.rpc('get_stabilized_feed', {
      p_session_start: session_start,
      p_last_effective_date: last_effective_date || null,
      p_last_id: last_id || null,
      p_limit: 25,
      p_filter_email: filterEmail
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
    const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`

    const profileRes = await fetch(PROFILE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': c.req.header('Authorization') || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emails: uniqueEmails })
    })

    if (!profileRes.ok) {
      const errorText = await profileRes.text()
      console.error('Failed to fetch profiles via API:', errorText)
      console.error('Status:', profileRes.status, 'StatusText:', profileRes.statusText)
      throw new Error('Failed to fetch user profiles')
    }

    const enrichedUsers = await profileRes.json()
    
    // יצירת מפה כפולה: לפי email ולפי uuid
    const usersByEmail = new Map()
    const usersByUuid = new Map()
    
    enrichedUsers.forEach((u: any) => {
      if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u)
      if (u.uuid) usersByUuid.set(u.uuid, u)
    })

    const commentsByPostId = visibleComments.reduce((acc: any, comment: any) => {
      const senderEmail = comment.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase());
      
      let author
      if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, ...cleanProfile } = profileData
        
        author = { 
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        }
      } else {
        author = { 
          first_name: senderEmail, 
          last_name: null, 
          image: null, 
          is_anonymous: false 
        }
      }

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

      const seenCommentReactionUsers = new Set<string>()
      const reactionUsers = commentLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenCommentReactionUsers.has(normalizedUserId)) return false
          seenCommentReactionUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({
          user_id: String(l.user_id),
          reaction_type: l.reaction_type || 'like'
        }))

      if (!acc[comment.post_id]) acc[comment.post_id] = []
      const { sender, ...commentWithoutSender } = comment
      acc[comment.post_id].push({
        ...commentWithoutSender,
        attachments: normalizeAttachments(comment.attachments),
        author,
        likes_count: commentLikes.length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null, // backward compatibility
        is_liked: userReactions.length > 0 // backward compatibility
      })
      return acc
    }, {})

    const enrichedPosts = visiblePosts.map((post: any) => {
      const postLikes = allPostLikes?.filter((l: any) => l.target_id === post.id) || []
      const senderEmail = post.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase());
      
      let postAuthor
      if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, ...cleanProfile } = profileData
        
        postAuthor = { 
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        }
      } else {
        postAuthor = { 
          first_name: senderEmail, 
          last_name: null, 
          image: null,
          is_anonymous: false 
        }
      }

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

      const seenPostReactionUsers = new Set<string>()
      const reactionUsers = postLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenPostReactionUsers.has(normalizedUserId)) return false
          seenPostReactionUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({
          user_id: String(l.user_id),
          reaction_type: l.reaction_type || 'like'
        }))

      const { sender, ...postWithoutSender } = post
      return {
        ...postWithoutSender,
        attachments: normalizeAttachments(post.attachments),
        author: postAuthor,
        comments: commentsByPostId?.[post.id] || [],
        likes_count: postLikes.length,
        reaction_users: reactionUsers,
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

app.get('/:id', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const currentUserUuid = currentUser?.id
    const viewerIsRecruiter = isRecruiterViewer(currentUser)
    const postId = c.req.param('id')

    if (!postId) return c.json({ error: 'Post ID is required' }, 400)

    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .single()

    if (postError) {
      if (postError.code === 'PGRST116') {
        return c.json({ error: 'Post not found' }, 404)
      }
      throw postError
    }

    if (viewerIsRecruiter && post.community_members_only === true) {
      return c.json({ error: 'Post not found' }, 404)
    }

    const { data: postLikes } = await supabase
      .from('likes')
      .select('target_id, user_id, reaction_type')
      .eq('target_id', post.id)

    const { data: savedRow } = await supabase
      .from('saved_resources')
      .select('id')
      .eq('user_id', currentUserUuid)
      .eq('saved_resource_type', 'post')
      .eq('saved_resource_id', String(post.id))
      .maybeSingle()

    const { data: commentsRaw } = await supabase
      .from('comments')
      .select('*')
      .eq('post_id', post.id)
      .order('created_at', { ascending: true })

    const comments = viewerIsRecruiter
      ? (commentsRaw || []).filter((c: any) => c.community_members_only !== true)
      : (commentsRaw || [])

    const commentIds = comments.map((c: any) => c.id.toString())
    const { data: commentLikes } = commentIds.length > 0
      ? await supabase
          .from('likes')
          .select('target_id, user_id, reaction_type')
          .in('target_id', commentIds)
      : { data: [] as any[] }

    const emailsToFetch = new Set<string>()
    if (post.sender) emailsToFetch.add(post.sender)
    comments.forEach((comment: any) => {
      if (comment.sender) emailsToFetch.add(comment.sender)
    })

    const uniqueEmails = Array.from(emailsToFetch)
    const PROJECT_URL = Deno.env.get('SUPABASE_URL')
    const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`

    const profileRes = await fetch(PROFILE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': c.req.header('Authorization') || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emails: uniqueEmails })
    })

    if (!profileRes.ok) {
      const errorText = await profileRes.text()
      console.error('Failed to fetch profiles via API:', errorText)
      throw new Error('Failed to fetch user profiles')
    }

    const enrichedUsers = await profileRes.json()
    const usersByEmail = new Map()
    enrichedUsers.forEach((u: any) => {
      if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u)
    })

    const commentsEnriched = comments.map((comment: any) => {
      const senderEmail = comment.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase())

      let author
      if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, ...cleanProfile } = profileData
        author = {
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        }
      } else {
        author = {
          first_name: senderEmail,
          last_name: null,
          image: null,
          is_anonymous: false
        }
      }

      const currentCommentLikes = (commentLikes || []).filter(
        (l: any) => l.target_id === comment.id.toString()
      )

      const reactionCounts = currentCommentLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})

      const userReactions = currentCommentLikes
        .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
        .map((l: any) => l.reaction_type)

      const seenUsers = new Set<string>()
      const reactionUsers = currentCommentLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenUsers.has(normalizedUserId)) return false
          seenUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({
          user_id: String(l.user_id),
          reaction_type: l.reaction_type || 'like'
        }))

      const { sender, ...commentWithoutSender } = comment
      return {
        ...commentWithoutSender,
        attachments: normalizeAttachments(comment.attachments),
        author,
        likes_count: currentCommentLikes.length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0
      }
    })

    const senderEmail = post.sender
    const profileData = usersByEmail.get(senderEmail?.toLowerCase())
    let postAuthor

    if (profileData) {
      const isAnonymous = profileData.is_anonymous === true
      const { _internal_email_lookup, ...cleanProfile } = profileData
      postAuthor = {
        ...cleanProfile,
        first_name: cleanProfile.first_name,
        last_name: cleanProfile.last_name,
        is_anonymous: isAnonymous
      }
    } else {
      postAuthor = {
        first_name: senderEmail,
        last_name: null,
        image: null,
        is_anonymous: false
      }
    }

    const reactionCounts = (postLikes || []).reduce((acc: any, like: any) => {
      const type = like.reaction_type || 'like'
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {})

    const userReactions = (postLikes || [])
      .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
      .map((l: any) => l.reaction_type)

    const seenPostUsers = new Set<string>()
    const reactionUsers = (postLikes || [])
      .filter((l: any) => {
        const userId = l?.user_id
        if (userId === null || userId === undefined) return false
        const normalizedUserId = String(userId)
        if (seenPostUsers.has(normalizedUserId)) return false
        seenPostUsers.add(normalizedUserId)
        return true
      })
      .map((l: any) => ({
        user_id: String(l.user_id),
        reaction_type: l.reaction_type || 'like'
      }))

    const { sender, ...postWithoutSender } = post

    return c.json({
      success: true,
      data: {
        ...postWithoutSender,
        attachments: normalizeAttachments(post.attachments),
        author: postAuthor,
        comments: commentsEnriched,
        likes_count: (postLikes || []).length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0,
        is_saved: !!savedRow,
        saved_id: savedRow?.id ?? null
      }
    })
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

      // Enrich the post with author data (same as GET endpoint)
      const PROJECT_URL = Deno.env.get('SUPABASE_URL')
      const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`

      const profileRes = await fetch(PROFILE_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': c.req.header('Authorization') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ emails: [user.email] })
      })

      let postAuthor
      if (profileRes.ok) {
        const enrichedUsers = await profileRes.json()
        const profileData = enrichedUsers[0]
        if (profileData) {
          const isAnonymous = profileData.is_anonymous === true
          const { _internal_email_lookup, ...cleanProfile } = profileData
          postAuthor = {
            ...cleanProfile,
            first_name: cleanProfile.first_name,
            last_name: cleanProfile.last_name,
            is_anonymous: isAnonymous
          }
        }
      }

      if (!postAuthor) {
        postAuthor = {
          first_name: user.email,
          last_name: null,
          image: null,
          is_anonymous: false
        }
      }

      const { sender, ...postWithoutSender } = data

      const enrichedPost = {
        ...postWithoutSender,
        attachments: normalizeAttachments(data.attachments),
        author: postAuthor,
        comments: [],
        likes_count: 0,
        reaction_users: [],
        reaction_counts: {},
        user_reactions: [],
        user_reaction: null,
        is_liked: false,
        is_saved: false,
        saved_id: null
      }

      return c.json({ success: true, data: enrichedPost, mode: "app" });
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
})


app.put('/:id', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('id')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    // 1) שליפת הפוסט הקיים כדי להשוות attachments
    const { data: existingPost, error: fetchError } = await supabase
      .from('posts')
      .select('attachments')
      .eq('id', postId)
      .eq('sender', user.email)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return c.json({ error: "Post not found or you don't have permission to edit it" }, 404)
      }
      throw fetchError
    }

    // 2) הכנת אובייקט עדכון
    const updateData: any = {
      updated_at: new Date().toISOString(),
      is_edited: true
    }

    if (body.message !== undefined) updateData.message = body.message
    if (body.subject !== undefined) updateData.subject = body.subject
    if (body.post_type !== undefined) updateData.post_type = body.post_type

    const communityMembersOnlyInput = body.communityMembersOnly
    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400)
      }
      updateData.community_members_only = communityMembersOnlyInput
    }

    // 3) טיפול ב-attachments בצורה בטוחה (URL מלא ↔ path יחסי)
    let filesToDelete: string[] = []

    if (body.attachments !== undefined) {
      const normalizedNewAttachments = (normalizeAttachments(body.attachments) || [])

      // ✅ נוודא שכל localPath נשמר כ-path יחסי בלבד (extracted_attachments/...)
      const cleanedNewAttachments = normalizedNewAttachments.map((a: any) => {
        if (!a || typeof a === 'string') return a

        const p = toStoragePath(a) // מחזיר extracted_attachments/... או null
        if (p) return { ...a, localPath: p }
        return a
      })

      updateData.attachments = cleanedNewAttachments

      const oldAttachments = existingPost.attachments || []

      const newIdentifiers = cleanedNewAttachments
        .map((a: any) => toStoragePath(a))
        .filter(Boolean) as string[]

      // ✅ Fail-safe: אם אי אפשר לגזור מזהים חדשים, לא מוחקים כלום
      if (newIdentifiers.length > 0) {
        for (const oldAtt of oldAttachments) {
          const oldPath = toStoragePath(oldAtt)
          if (oldPath && !newIdentifiers.includes(oldPath)) {
            filesToDelete.push(oldPath)
          }
        }
      } else {
        console.warn("Skipping deletion: could not derive storage paths from new attachments")
      }
    }

    // 4) עדכון DB
    const { data, error } = await supabase
      .from('posts')
      .update(updateData)
      .eq('id', postId)
      .eq('sender', user.email)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Post not found or you don't have permission to edit it" }, 404)
      }
      throw error
    }

    // 5) מחיקה פיזית של קבצים שהוסרו (רק paths יחסיים!)
    if (filesToDelete.length > 0) {
      const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
      if (storageError) console.error("Failed to delete old files from storage:", storageError)
    }

    // 6) עדכון וקטור אם טקסט השתנה
    if (body.message !== undefined || body.subject !== undefined) {
      updatePostVector(postId)
    }

    return c.json({ success: true, data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})


app.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    // נוודא שהמשתמש מחובר
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const supabase = c.get('supabase');
    const postId = c.req.param('id');
    
    if (!postId) return c.json({ error: "Post ID is required" }, 400);

    // 1. מחיקה מהדאטהבייס עם select().single() כדי לקבל את הפוסט שנמחק
    const { data: deletedPost, error } = await supabase
      .from('posts')
      .delete()
      .eq('id', postId)
      .eq('sender', user.email)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
         return c.json({ error: "Post not found or you don't have permission to delete it" }, 404);
      }
      throw error;
    }

    // 2. מחיקת כל הקבצים של הפוסט מהבאקט
    if (deletedPost && deletedPost.attachments && deletedPost.attachments.length > 0) {
      const filesToDelete = deletedPost.attachments
        .map((a: any) => {
          if (typeof a === 'string') return null;
          
          // הכי בטוח ומהיר - להשתמש ב-localPath
          if (a.localPath) return a.localPath;
          
          // גיבוי למקרה שאין localPath אבל יש URL
          if (a.url) {
            const parts = a.url.split('/attachments/');
            return parts.length > 1 ? parts[1] : null;
          }
          
          return null;
        })
        .filter(Boolean); // מסנן ערכים ריקים

      if (filesToDelete.length > 0) {
        const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete);
        if (storageError) console.error("Failed to delete files on post deletion:", storageError);
      }
    }

    return c.json({ success: true, message: "Post and files deleted successfully" });

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
    communityMembersOnly !== undefined ? communityMembersOnly : community_members_only

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

    // 2. שליפת ה-uuid וה-first_name, last_name מטבלת public_users_view לפי המייל
    const { data: userData, error: userError } = await supabase
      .from('public_users_view')
      .select('uuid, first_name, last_name')
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
          first_name: userData.first_name,
          last_name: userData.last_name
        }
      } 
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// // עדכון תגובה
// // עדכון תגובה (כולל טיפול במחיקת קבצים שהוסרו בעריכה)
app.put('/:postId/comments/:commentId', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('postId')
    const commentId = c.req.param('commentId')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)
    if (!commentId) return c.json({ error: "Comment ID is required" }, 400)

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    // 1) שליפת התגובה הקיימת כדי להשוות attachments
    const { data: existingComment, error: fetchError } = await supabase
      .from('comments')
      .select('attachments')
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to edit it" }, 404)
      }
      throw fetchError
    }

    // 2) נכין את האובייקט לעדכון
    const updateData: any = {
      updated_at: new Date().toISOString(),
      is_edited: true
    }

    if (body.message !== undefined) updateData.message = body.message

    const communityMembersOnlyInput =
      body.communityMembersOnly !== undefined ? body.communityMembersOnly : body.community_members_only

    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400)
      }
      updateData.community_members_only = communityMembersOnlyInput
    }

    // 3) טיפול ב-attachments בצורה בטוחה (URL מלא ↔ path יחסי)
    let filesToDelete: string[] = []

    if (body.attachments !== undefined) {
      const normalizedNewAttachments = (normalizeAttachments(body.attachments) || [])

      // ✅ נוודא שכל localPath נשמר כ-path יחסי בלבד
      const cleanedNewAttachments = normalizedNewAttachments.map((a: any) => {
        if (!a || typeof a === 'string') return a
        const p = toStoragePath(a) // extracted_attachments/... או null
        return p ? { ...a, localPath: p } : a
      })

      updateData.attachments = cleanedNewAttachments

      const oldAttachments = existingComment.attachments || []

      // ✅ מזהים חדשים להשוואה: תמיד storage path
      const newIdentifiers = cleanedNewAttachments
        .map((a: any) => toStoragePath(a))
        .filter(Boolean) as string[]

      // ✅ Fail-safe: אם לא הצלחנו לגזור מזהים חדשים, לא מוחקים כלום
      if (newIdentifiers.length > 0) {
        for (const oldAtt of oldAttachments) {
          const oldPath = toStoragePath(oldAtt)
          if (oldPath && !newIdentifiers.includes(oldPath)) {
            filesToDelete.push(oldPath)
          }
        }
      } else {
        console.warn("Skipping deletion: could not derive storage paths from new attachments")
      }
    }

    // 4) ביצוע העדכון במסד הנתונים
    const { data, error } = await supabase
      .from('comments')
      .update(updateData)
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to edit it" }, 404)
      }
      throw error
    }

    // 5) מחיקת הקבצים הפיזיים מהבאקט (רק paths יחסיים!)
    if (filesToDelete.length > 0) {
      const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
      if (storageError) console.error("Failed to delete old files from storage:", storageError)
    }

    // 6) עדכון וקטור אם הטקסט השתנה ואיכותי
    if (body.message !== undefined && isQualityPost(body.message)) {
      updatePostVector(postId)
    }

    return c.json({ success: true, data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// מחיקת תגובה
app.delete('/:postId/comments/:commentId', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('postId')
    const commentId = c.req.param('commentId')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)
    if (!commentId) return c.json({ error: "Comment ID is required" }, 400)

    // 1) מוחקים ומחזירים את השורה כדי שנוכל למחוק קבצים מהבאקט
    const { data: deletedComment, error } = await supabase
      .from('comments')
      .delete()
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .select('id, post_id, attachments')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to delete it" }, 404)
      }
      throw error
    }

    // 2) מחיקת קבצים של התגובה מהבאקט (אם יש)
    if (deletedComment?.attachments?.length > 0) {
      const filesToDelete = deletedComment.attachments
        .map((a: any) => {
          if (typeof a === 'string') return null

          if (a.localPath) return a.localPath

          // גיבוי: אם אין localPath אבל יש URL
          if (a.url) {
            const parts = a.url.split('/attachments/')
            return parts.length > 1 ? parts[1] : null
          }

          return null
        })
        .filter(Boolean)

      if (filesToDelete.length > 0) {
        const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
        if (storageError) console.error("Failed to delete files on comment deletion:", storageError)
      }
    }

    // 3) עדכון הווקטור של הפוסט כדי להסיר את הטקסט של התגובה שנמחקה
    //    חשוב שזה יקרה אחרי המחיקה
    updatePostVector(postId)

    return c.json({ success: true, message: "Comment deleted successfully" })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})



export default app

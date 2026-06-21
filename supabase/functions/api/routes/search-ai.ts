// supabase/functions/api/routes/search-ai.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import OpenAI from "https://esm.sh/openai@4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = new Hono()

const FETCH_K_SQL = 60;
const DECAY_DAYS = 90;
const MAX_BONUS = 0.3;
const STRICT_THRESHOLD = 0.15;
const RECRUITER_ROLE = 'recruiters';

function isRecruiterViewer(user: any): boolean {
  const role = String(user?.app_metadata?.role ?? '').toLowerCase().trim();
  return role === RECRUITER_ROLE;
}

// POST /api/search-ai
app.post('/', async (c) => {
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseUser = c.get('supabase');
    const currentUser = c.get('user');
    const viewerIsRecruiter = isRecruiterViewer(currentUser);

    const { query: rawUserQuery } = await c.req.json();

    // =================================================================
    // שלב 2: חיפוש וקטורי + keyword עם סף דינמי
    // =================================================================
    const wordCount = rawUserQuery.trim().split(/\s+/).length;
    const dynamicThreshold = wordCount <= 1 ? 0.05 : STRICT_THRESHOLD;

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: rawUserQuery,
    });
    const queryVector = emb.data[0].embedding;

    const [{ data: rawMatches, error: rpcError }, { data: keywordMatches, error: kwError }] = await Promise.all([
      supabaseAdmin.rpc('match_posts', {
        query_embedding: queryVector,
        similarity_threshold: dynamicThreshold,
        match_limit: FETCH_K_SQL
      }).select('id, subject, message, sent_at, sender, attachments, community_members_only, similarity'),
      (() => {
        const HEBREW_PREFIXES = /^(שה|מה|לה|כש|וש|ומ|ול|וב|וכ|וה|של|שב|שמ|שכ|בה|כה|לכ|לב|מב|מל|מכ|ל|ב|מ|ה|כ|ו|ש)/;
        const stripPrefix = (w: string) => w.replace(HEBREW_PREFIXES, '') || w;
        const words = rawUserQuery.trim().split(/\s+/)
          .map(stripPrefix)
          .filter(w => w.length > 2);
        const parts = [
          ...words.map(w => `subject.ilike.%${w}%`),
          `message.ilike.%${rawUserQuery}%`
        ].join(',');
        return supabaseAdmin
          .from('posts')
          .select('id, subject, message, sent_at, sender, attachments, community_members_only')
          .or(parts)
          .not('post_type', 'is', null)
          .neq('post_type', 'email')
          .limit(20);
      })()
    ]);

    if (rpcError) throw rpcError;

    console.log(`[search-ai] kwError: ${kwError?.message ?? 'none'}, keywordMatches: ${keywordMatches?.map((p: any) => p.id + ' | ' + p.subject?.slice(0, 40))}`);

    // מיזוג תוצאות סמנטיות + keyword, ללא כפילויות
    const seenIds = new Set<string>((rawMatches || []).map((m: any) => String(m.id)));
    const extraFromKeyword = (keywordMatches || [])
      .filter((p: any) => !seenIds.has(String(p.id)))
      .map((p: any) => ({ ...p, similarity: 0.1 }));

    const mergedMatches = [...(rawMatches || []), ...extraFromKeyword];

    console.log(`[search-ai] semantic: ${rawMatches?.length ?? 0}, keyword extras: ${extraFromKeyword.length}, threshold: ${dynamicThreshold}`);

    // =================================================================
    // שלב 3: דירוג מחדש (Reranking) לפי תאריך
    // =================================================================
    let finalItems: any[] = [];
    if (mergedMatches && mergedMatches.length > 0) {
      const now = new Date();
      const scoredItems = mergedMatches.map((post: any) => {
        const postDateStr = post.sent_at;
        let daysOld = 730;
        if (postDateStr) {
          const diffTime = now.getTime() - new Date(postDateStr).getTime();
          daysOld = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
        }
        const recencyBonus = MAX_BONUS * (1 / (1 + (daysOld / DECAY_DAYS)));
        return {
          ...post,
          final_score: (post.similarity || 0) + recencyBonus,
          days_old: daysOld
        };
      });

      scoredItems.sort((a: any, b: any) => b.final_score - a.final_score);
      finalItems = viewerIsRecruiter
        ? scoredItems.filter((p: any) => p.community_members_only !== true)
        : scoredItems;
    }

    // =================================================================
    // שלב 3.5: העשרת הנתונים (Enrichment)
    // =================================================================
    let enrichedItems: any[] = [];

    if (finalItems.length > 0) {
      const postIds = finalItems.map((p) => p.id);
      const emailsToFetch = new Set<string>();

      finalItems.forEach((p: any) => {
        if (p.sender) emailsToFetch.add(p.sender);
      });

      const [{ data: postTypes }, { data: comments, error: commentsError }] = await Promise.all([
        supabaseUser.from('posts').select('id, post_type').in('id', postIds),
        supabaseUser.from('comments').select('*').in('post_id', postIds).order('created_at', { ascending: true }).limit(200),
      ]);

      const postTypeMap = (postTypes || []).reduce((acc: any, p: any) => {
        acc[p.id] = p.post_type;
        return acc;
      }, {} as Record<string, string>);

      finalItems = finalItems.filter((p: any) => {
        const pt = postTypeMap[p.id];
        return pt && pt !== 'email';
      });

      if (commentsError) throw commentsError;

      const visibleComments = viewerIsRecruiter
        ? (comments || []).filter((c: any) => c.community_members_only !== true)
        : (comments || []);

      visibleComments.forEach((c: any) => {
        if (c.sender) emailsToFetch.add(c.sender);
      });

      const { data: users, error: usersError } = await supabaseUser
        .from('public_users_view')
        .select('uuid, email, first_name, last_name, image, role, headline')
        .in('email', Array.from(emailsToFetch));

      if (usersError) throw usersError;

      const usersMap = users?.reduce((acc: any, user: any) => {
        if (user.email) {
          const displayName = user.first_name
            ? (user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name)
            : null;
          acc[user.email] = {
            uuid: user.uuid,
            email: user.email,
            name: displayName,
            first_name: user.first_name,
            last_name: user.last_name,
            image: user.image === 'true' ? true : null,
            role: user.role,
            headline: user.headline
          };
        }
        return acc;
      }, {} as Record<string, any>);

      const getAuthor = (email: string) => usersMap?.[email] || {
        uuid: null, email: email, name: null, first_name: null, last_name: null, image: null, role: 'unknown'
      };

      const commentsByPostId = visibleComments.reduce((acc: any, comment: any) => {
        const commentWithAuthor = {
          ...comment,
          author: getAuthor(comment.sender)
        };
        if (!acc[comment.post_id]) acc[comment.post_id] = [];
        acc[comment.post_id].push(commentWithAuthor);
        return acc;
      }, {} as Record<string, any[]>);

      enrichedItems = finalItems.map((post: any) => {
        const { comments_text, similarity, final_score, days_old, ...restOfPost } = post;
        return {
          ...restOfPost,
          post_type: postTypeMap[post.id] || null,
          author: getAuthor(post.sender),
          comments: commentsByPostId?.[post.id] || []
        };
      });
    }

    return c.json({
      items: enrichedItems,
      // backward compat — old frontend reads these fields
      all_sources: enrichedItems,
      used_sources: enrichedItems,
      answer: '',
      optimized_query: rawUserQuery,
    });

  } catch (err: any) {
    console.error("Error in SearchAI:", err);
    return c.json({ error: err.message }, 500);
  }
})

export default app

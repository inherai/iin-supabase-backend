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
    // שלב 3.5: העשרה דרך צינור הפיד הרגיל (GET /api/posts?ids=...)
    // אותם מחברים, פרטיות, אנונימיות, ריאקציות, תגובות ו-saved —
    // אחד לאחד עם הפיד. exclude_email שומר על הסינון הקיים של החיפוש.
    // =================================================================
    let enrichedItems: any[] = [];

    if (finalItems.length > 0) {
      const rankedIds = finalItems.map((p: any) => String(p.id)).slice(0, 100);
      const PROJECT_URL = Deno.env.get('SUPABASE_URL');
      const postsRes = await fetch(
        `${PROJECT_URL}/functions/v1/api/posts?ids=${encodeURIComponent(rankedIds.join(','))}&exclude_email=true`,
        {
          headers: {
            'Authorization': c.req.header('Authorization') || '',
            'Content-Type': 'application/json'
          }
        }
      );
      if (!postsRes.ok) {
        console.error('[search-ai] Failed to enrich via feed pipeline:', await postsRes.text());
        return c.json({ error: 'Failed to enrich search results' }, 500);
      }
      const postsJson = await postsRes.json();
      enrichedItems = postsJson.data || [];
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

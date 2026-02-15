// supabase/functions/api/routes/search-ai.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import OpenAI from "https://esm.sh/openai@4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const app = new Hono()

// ====================================================================
// קבועים (כפי שביקשת)
// ====================================================================
const FETCH_K_SQL = 60;        
const DECAY_DAYS = 180;        
const MAX_BONUS = 0.15; 
const STRICT_THRESHOLD = 0.3;        

const SEARCH_INTENT_PROMPT = `
Your task is to generate a concise and explicit search query for semantic retrieval.
Instructions:
- Analyze the user's input.
- Do NOT answer the user.
- Remove emotional language or urgency.
- Output MUST be valid JSON ONLY: {"search_query": "<Hebrew query>"}
`;

const SYSTEM_PROMPT = `
You are a knowledgeable and comprehensive community assistant.
Your goal is to answer user questions based ONLY on the provided email snippets.

Output Format:
You MUST return a valid JSON object with the following structure:
{
  "answer": "The answer in Hebrew text only.",
  "source_indices": [1, 5, 12] // An array of the SOURCE_INDEX numbers you used.
}

━━━━━━━━━━━━━━━━━━━━━━
CORE BEHAVIOR RULES
━━━━━━━━━━━━━━━━━━━━━━
1. **Be Comprehensive:** Do NOT be concise. If the user asks a general question, extract ANY relevant advice, tips, or resources found in the sources.
2. **Synthesize:** Combine partial pieces of information from different sources into a full answer.
3. **Source of Truth:** Use ONLY the provided sources.
4. **Meta-Information:** If absolutely no facts are found, summarize what users are *asking* about instead.

━━━━━━━━━━━━━━━━━━━━━━
RESPONSE GUIDELINES
━━━━━━━━━━━━━━━━━━━━━━
* Construct a helpful, detailed response.
* If you find lists of resources (links, guides) in the sources, mention them in detail.
* The "answer" field must be clean text (no [1] inside).
`;

// POST /api/searchAI
app.post('/', async (c) => {
  try {
    // אתחול OpenAI
    const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });
    
    // שים לב: כאן אנחנו יוצרים קליינט חדש עם Service Role 
    // כדי שיהיה אפשר לחפש בכל הדאטה בייס ללא מגבלות משתמש רגיל
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // קריאת ה-Body דרך Hono
    const { query: rawUserQuery } = await c.req.json();

    // =================================================================
    // שלב 1: ניקוי השאילתה
    // =================================================================
    let optimizedQuery = rawUserQuery;
    try {
      const intentChat = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SEARCH_INTENT_PROMPT },
          { role: "user", content: rawUserQuery }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      });
      const jsonResponse = JSON.parse(intentChat.choices[0].message.content || "{}");
      if (jsonResponse.search_query) optimizedQuery = jsonResponse.search_query;
    } catch (e) {
      console.error("Intent parsing failed");
    }

    console.log(`Original: ${rawUserQuery} | Optimized: ${optimizedQuery}`);

    // =================================================================
    // שלב 2: חיפוש ורטריב עם סף דינמי
    // =================================================================
    const wordCount = optimizedQuery.trim().split(/\s+/).length;
    const dynamicThreshold = wordCount <= 1 ? 0.05 : STRICT_THRESHOLD; 

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: optimizedQuery,
    });
    const queryVector = emb.data[0].embedding;

    const { data: rawMatches, error: rpcError } = await supabase.rpc('match_posts', {
      query_embedding: queryVector,
      similarity_threshold: dynamicThreshold, 
      match_limit: FETCH_K_SQL
    });

    if (rpcError) throw rpcError;

    // =================================================================
    // שלב 3: דירוג מחדש (Reranking) לפי תאריך
    // =================================================================
    let finalItems: any[] = [];
    if (rawMatches && rawMatches.length > 0) {
      const now = new Date();
      const scoredItems = rawMatches.map((post: any) => {
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

      // מיון ראשוני לפי ציון משוקלל (תאריך + דמיון)
      scoredItems.sort((a: any, b: any) => b.final_score - a.final_score);
      finalItems = scoredItems; 
    }

    // =================================================================
    // שלב 3.5: העשרת הנתונים (Enrichment)
    // =================================================================
    let enrichedItems: any[] = [];

    if (finalItems.length > 0) {
        // 1. אוספים את כל ה-IDs והמיילים
        const postIds = finalItems.map((p) => p.id);
        const emailsToFetch = new Set<string>();
        
        finalItems.forEach(p => {
             if (p.sender) emailsToFetch.add(p.sender);
        });

        // 2. שולפים תגובות
        const { data: comments, error: commentsError } = await supabase
          .from('comments')
          .select('*')
          .in('post_id', postIds)
          .order('created_at', { ascending: true });

        if (commentsError) throw commentsError;

        // מוסיפים את המיילים של המגיבים לרשימת המיילים לשליפה
        comments?.forEach((c: any) => {
            if (c.sender) emailsToFetch.add(c.sender);
        });

        // 3. שולפים משתמשים (Users)
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('uuid, email, name, image, role')
            .in('email', Array.from(emailsToFetch));

        if (usersError) throw usersError;

        // 4. יוצרים מפה של משתמשים
        const usersMap = users?.reduce((acc: any, user: any) => {
            if (user.email) acc[user.email] = user;
            return acc;
        }, {} as Record<string, any>);

        const getAuthor = (email: string) => usersMap?.[email] || { 
            uuid: null, email: email, name: email || 'Unknown', image: null, role: 'unknown' 
        };

        // 5. מחברים משתמשים לתגובות ומסדרים לפי פוסט
        const commentsByPostId = comments?.reduce((acc: any, comment: any) => {
            const commentWithAuthor = { 
                ...comment, 
                author: getAuthor(comment.sender) 
            };
            if (!acc[comment.post_id]) acc[comment.post_id] = [];
            acc[comment.post_id].push(commentWithAuthor);
            return acc;
        }, {} as Record<string, any[]>);

        // 6. יוצרים את האובייקטים הסופיים (פוסט + מחבר + תגובות)
        enrichedItems = finalItems.map((post) => {
            const { comments_text, similarity, final_score, days_old, ...restOfPost } = post;
            
            return {
                ...restOfPost,
                author: getAuthor(post.sender), 
                comments: commentsByPostId?.[post.id] || []
            };
        });
    }

    // =================================================================
    // שלב 4: הכנת הקונטקסט (נשאר טקסט נקי למודל)
    // =================================================================
    const fullContext = enrichedItems.length > 0
      ? enrichedItems.map((res: any, index: number) => {
          return `SOURCE_INDEX: ${index + 1}\nתאריך: ${res.sent_at}\nנושא: ${res.subject}\nתוכן: ${res.message}`;
        }).join("\n\n---\n\n")
      : "No relevant information found.";

    // =================================================================
    // שלב 5: יצירת תשובה
    // =================================================================
    const chat = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Context:\n${fullContext}\n\nQuestion: ${rawUserQuery}` }
      ],
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const content = chat.choices[0].message.content || "{}";
    let parsedResult = { answer: "", source_indices: [] };
    try { parsedResult = JSON.parse(content); } catch (e) {}

    // =================================================================
    // שלב 6: עיבוד סופי - החזרת אובייקטים מלאים למשתמש
    // =================================================================
    const cleanAnswer = parsedResult.answer || "לא נמצא מידע רלוונטי.";
    const indices: number[] = Array.isArray(parsedResult.source_indices) ? parsedResult.source_indices : [];
    const usedIndicesSet = new Set<number>(indices.map((i: number) => i - 1));
    
    const usedItems: any[] = [];
    const unusedItems: any[] = [];

    enrichedItems.forEach((item, index) => {
        if (usedIndicesSet.has(index)) {
            usedItems.push(item);
        } else {
            unusedItems.push(item);
        }
    });

    const reorderedAllSources = [...usedItems, ...unusedItems];

    // =================================================================
    // שלב 7: החזרה ללקוח (Hono JSON Response)
    // =================================================================
    return c.json({
      answer: cleanAnswer,
      used_sources: usedItems,          
      all_sources: reorderedAllSources, 
      optimized_query: optimizedQuery
    });

  } catch (err: any) {
    console.error("Error in SearchAI:", err);
    return c.json({ error: err.message }, 500);
  }
})

export default app
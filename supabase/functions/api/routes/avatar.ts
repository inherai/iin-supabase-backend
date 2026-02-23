// supabase/functions/api/routes/avatar.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

app.get('/', async (c) => {
  try {
    // 1. קבלת המשתמש מה-Middleware
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const targetUserId = c.req.query('id');
    if (!targetUserId) {
      return c.json({ error: 'Missing id parameter' }, 400);
    }

    // 2. יצירת קליינט אדמין
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const viewerRole = user.app_metadata.role || 'guest';
    const myUserId = user.id;

    // 3. בדיקת הרשאות (RPC)
    let isAllowed = false;
    if (myUserId === targetUserId) {
      isAllowed = true;
    } else {
      const { data: rpcResult, error: rpcError } = await supabaseAdmin
        .rpc('can_view_profile_picture', { 
          target_user_id: targetUserId, 
          viewer_role: viewerRole 
        });
      
      if (!rpcError && rpcResult === true) isAllowed = true;
    }

    if (!isAllowed) {
      return c.json({ error: 'Access Denied' }, 403);
    }

    // 4. שליפת הנתיב מהדאטהבייס
    const { data: userRecord, error: dbError } = await supabaseAdmin
        .from('users')
        .select('image')
        .eq('uuid', targetUserId)
        .single();

    if (dbError || !userRecord || !userRecord.image) {
        return c.json({ error: 'No image set for user' }, 404);
    }

    // =================================================================
    // 🌟 התיקון הראשון: טיפול ב-ETag ובקשת ה-Cache מהדפדפן (חסכון אדיר בביצועים!)
    // =================================================================
    // מכיוון שכל פעם שמעלים תמונה חדשה ה-URL/נתיב שלה בדאטהבייס משתנה (או מכיל מזהה חדש),
    // אנחנו יכולים פשוט להשתמש בנתיב עצמו כמזהה (ETag) ייחודי לתמונה.
    // נקודד אותו ל-base64 כדי שיהיה תקני, ונוסיף מרכאות כנדרש בתקן HTTP.
    const eTag = `"${btoa(userRecord.image)}"`; 

    // בודקים אם הדפדפן שלח את ה-ETag הישן שלו
    const clientETag = c.req.header('If-None-Match');

    if (clientETag === eTag) {
        // בינגו! התמונה לא השתנתה. 
        // מחזירים 304 מיד! חסכנו גם הורדה מה-Storage וגם שליחת קובץ כבד ברשת!
        return new Response(null, {
            status: 304,
            headers: {
                'ETag': eTag,
                'Cache-Control': 'private, no-cache, must-revalidate'
            }
        });
    }
    // =================================================================

    // 5. חילוץ הנתיב
    const bucketName = 'profile-images';
    const splitPath = userRecord.image.split(`/${bucketName}/`);
    
    if (splitPath.length < 2) {
        return c.json({ error: 'Invalid image URL' }, 500);
    }

    const relativePath = decodeURIComponent(splitPath[1]);

    // 6. הורדה מה-Storage (יקרה רק אם לא החזרנו 304)
    const { data: fileData, error: downloadError } = await supabaseAdmin
      .storage
      .from(bucketName) 
      .download(relativePath);

    if (downloadError) {
      return c.json({ error: 'Image not found in storage' }, 404);
    }

    // 7. המרה ל-ArrayBuffer
    const arrayBuffer = await fileData.arrayBuffer();

    // =================================================================
    // 🌟 התיקון השני: עדכון הכותרות (Headers) שיוחזרו לדפדפן
    // =================================================================
    return c.body(arrayBuffer, 200, {
        'Content-Type': fileData.type || 'image/jpeg',
        'Content-Length': arrayBuffer.byteLength.toString(),
        // שינינו את זה מהגדרת ה-public המקורית לדרישות המדויקות שלך:
        'Cache-Control': 'private, no-cache, must-revalidate',
        // חובה לשלוח את ה-ETag בתשובה כדי שהדפדפן יידע לשמור אותו לפעם הבאה:
        'ETag': eTag 
    });

  } catch (error) {
    console.error("🔥 Avatar Route Error:", error);
    return c.json({ error: error.message }, 500);
  }
})

export default app
// supabase/functions/api/routes/avatar.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

app.get('/', async (c) => {
  try {
    // 1. קבלת המשתמש מה-Middleware
    // המידלוור כבר בדק את הטוקן ושם את היוזר בקונטקסט
    const user = c.get('user');

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const targetUserId = c.req.query('id');
    if (!targetUserId) {
      return c.json({ error: 'Missing id parameter' }, 400);
    }

    // 2. יצירת קליינט אדמין לביצוע הפעולות הרגישות
    // אנחנו משתמשים בזה כדי לא להסתבך עם RLS בטבלאות שאינן של המשתמש
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

    // 5. חילוץ הנתיב
    const bucketName = 'profile-images';
    const splitPath = userRecord.image.split(`/${bucketName}/`);
    
    if (splitPath.length < 2) {
        return c.json({ error: 'Invalid image URL' }, 500);
    }

    const relativePath = decodeURIComponent(splitPath[1]);

    // 6. הורדה מה-Storage
    const { data: fileData, error: downloadError } = await supabaseAdmin
      .storage
      .from(bucketName) 
      .download(relativePath);

    if (downloadError) {
      return c.json({ error: 'Image not found in storage' }, 404);
    }

    // 7. המרה ל-ArrayBuffer (התיקון הקריטי)
    const arrayBuffer = await fileData.arrayBuffer();

    // 8. החזרת התשובה דרך Hono
    // c.body מאפשר להחזיר מידע בינארי
    return c.body(arrayBuffer, 200, {
        'Content-Type': fileData.type || 'image/jpeg',
        'Content-Length': arrayBuffer.byteLength.toString(),
        'Cache-Control': 'public, max-age=3600',
    });

  } catch (error) {
    console.error("🔥 Avatar Route Error:", error);
    return c.json({ error: error.message }, 500);
  }
})

export default app
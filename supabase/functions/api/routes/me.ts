// // supabase/functions/api/routes/me.ts
// import { Hono } from 'https://deno.land/x/hono/mod.ts'

// const app = new Hono()

// // --------------------------------------------------------------------
// // GET /api/me
// // שליפת פרופיל המשתמש המחובר
// // --------------------------------------------------------------------
// app.get('/', async (c) => {
//   const user = c.get('user')

//   // **הגנה קריטית:** אם אין משתמש (למשל סקריפט מנסה לגשת לפה), עוצרים מיד
//   if (!user) {
//     return c.json({ error: 'Unauthorized: You must be logged in to view profile' }, 401)
//   }

//   const supabase = c.get('supabase')

//   const { data, error } = await supabase
//     .from('users')
//     .select('*')
//     .eq('uuid', user.id) // עכשיו בטוח לגשת ל-user.id
//     .single()

//   if (error) {
//     return c.json({ error: error.message }, 400)
//   }

//   return c.json(data)
// })

// // --------------------------------------------------------------------
// // PUT /api/me
// // עדכון פרופיל
// // --------------------------------------------------------------------
// app.put('/', async (c) => {
//   const user = c.get('user')

//   // **הגנה קריטית:** מוודאים שיש משתמש לפני שמנסים לעדכן
//   if (!user) {
//     return c.json({ error: 'Unauthorized: You must be logged in to update profile' }, 401)
//   }

//   const supabase = c.get('supabase')
  
//   // קריאת המידע מהבקשה
//   const payload = await c.req.json()
  
//   // תמיכה גם ב-body ישיר וגם בעטיפת profile (כפי שביקשת)
//   const profileData = payload.profile || payload 

//   const { data, error } = await supabase
//     .from('users')
//     .update({
//         name: profileData.name,
//         headline: profileData.headline,
//         company: profileData.company,
//         location: profileData.location,
//         about: profileData.about,
//         interests: profileData.interests,
//         languages: profileData.languages,
//         work_preferences: profileData.work_preferences,
//         experience: profileData.experience,
//         education: profileData.education,
//         certifications: profileData.certifications,
//         skills: profileData.skills,
//     })
//     .eq('uuid', user.id)
//     .select()
//     .single()

//   if (error) {
//     return c.json({ error: error.message }, 400)
//   }

//   return c.json(data)
// })

// export default app






// supabase/functions/api/routes/me.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// פונקציית עזר לנירמול ה-URL של התמונה
// היא הופכת נתיב גולמי ללינק לפרוקסי שלנו
const transformToProxyUrl = (userRecord: any) => {
  if (!userRecord || !userRecord.image) return userRecord;

  // שליפת כתובת הפרויקט מתוך משתני הסביבה
  const projectUrl = Deno.env.get('SUPABASE_URL'); 
  
  // בניית הלינק לפרוקסי
  // הפרונטנד יצטרך רק להוסיף את הטוקן בסוף: &token=...
  userRecord.image = `${projectUrl}/functions/v1/avatar-proxy?id=${userRecord.uuid}`;
  
  return userRecord;
}

// --------------------------------------------------------------------
// GET /api/me
// שליפת פרופיל המשתמש המחובר
// --------------------------------------------------------------------
app.get('/', async (c) => {
  const user = c.get('user')

  // **הגנה קריטית:** אם אין משתמש, עוצרים מיד
  if (!user) {
    return c.json({ error: 'Unauthorized: You must be logged in to view profile' }, 401)
  }

  const supabase = c.get('supabase')

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('uuid', user.id)
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // כאן הקסם קורה: המרת הנתיב ללינק פרוקסי לפני השליחה לקליינט
  const dataWithProxy = transformToProxyUrl(data);

  return c.json(dataWithProxy)
})

// --------------------------------------------------------------------
// PUT /api/me
// עדכון פרופיל
// --------------------------------------------------------------------
app.put('/', async (c) => {
  const user = c.get('user')

  // **הגנה קריטית:** מוודאים שיש משתמש לפני שמנסים לעדכן
  if (!user) {
    return c.json({ error: 'Unauthorized: You must be logged in to update profile' }, 401)
  }

  const supabase = c.get('supabase')
  
  // קריאת המידע מהבקשה
  const payload = await c.req.json()
  
  // תמיכה גם ב-body ישיר וגם בעטיפת profile
  const profileData = payload.profile || payload 

  const { data, error } = await supabase
    .from('users')
    .update({
        name: profileData.name,
        headline: profileData.headline,
        company: profileData.company,
        location: profileData.location,
        about: profileData.about,
        interests: profileData.interests,
        languages: profileData.languages,
        work_preferences: profileData.work_preferences,
        experience: profileData.experience,
        education: profileData.education,
        certifications: profileData.certifications,
        skills: profileData.skills, 
    })
    .eq('uuid', user.id)
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // גם בעדכון, מחזירים לקליינט את הלינק המעודכן לפרוקסי
  const dataWithProxy = transformToProxyUrl(data);

  return c.json(dataWithProxy)
})

export default app
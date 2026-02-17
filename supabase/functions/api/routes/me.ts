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

  const { data: userData, error } = await supabase
    .from('users')
    .select('*')
    .eq('uuid', user.id)
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // שליפת נתוני חברות עבור כל ה-experiences
  if (userData.experience && Array.isArray(userData.experience)) {
    const companyIds = userData.experience
      .map((exp: any) => exp.company)
      .filter((id: any) => typeof id === 'number')
    
    if (companyIds.length > 0) {
      const { data: companies } = await supabase
        .from('companies')
        .select('id, name, logo')
        .in('id', companyIds)
      
      if (companies) {
        userData.experience = userData.experience.map((exp: any) => ({
          ...exp,
          company: companies.find((c: any) => c.id === exp.company) || exp.company
        }))
      }
    }
  }

  // שליפת החברה הנוכחית
  const currentExp = userData.experience?.find((exp: any) => exp.current === true)
  if (currentExp?.company && typeof currentExp.company === 'object') {
    userData.company = currentExp.company
  }

  const dataWithProxy = transformToProxyUrl(userData);
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
        name:`${profileData.first_name} ${profileData.last_name}`,
        first_name: profileData.first_name,
        last_name: profileData.last_name,
        phone: profileData.phone,
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
        image: profileData.image 
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
// supabase/functions/api/routes/me.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// --------------------------------------------------------------------
// GET /api/me
// שליפת פרופיל המשתמש המחובר
// --------------------------------------------------------------------
app.get('/', async (c) => {
  const user = c.get('user')

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

  // שליפת נתוני חברות עבור ה-experiences
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
          company: companies.find((comp: any) => comp.id === exp.company) || exp.company
        }))
      }
    }
  }

  // שליפת החברה הנוכחית לתצוגה מהירה
  const currentExp = userData.experience?.find((exp: any) => exp.current === true)
  if (currentExp?.company && typeof currentExp.company === 'object') {
    userData.company = currentExp.company
  }

  // --- לוגיקת IMAGE החדשה (כמו ב-PROFILE) ---
  // מחזיר true אם יש ערך ב-image, אחרת null
  userData.image = !!userData.image ? true : null;

  return c.json(userData)
})

// --------------------------------------------------------------------
// PUT /api/me
// עדכון פרופיל
// --------------------------------------------------------------------
app.put('/', async (c) => {
  const user = c.get('user')

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const supabase = c.get('supabase')
  const payload = await c.req.json()
  const profileData = payload.profile || payload 

  const { data, error } = await supabase
    .from('users')
    .update({
        name: `${profileData.first_name} ${profileData.last_name}`,
        first_name: profileData.first_name,
        last_name: profileData.last_name,
        phone: profileData.phone,
        headline: profileData.headline,
        location: profileData.location,
        about: profileData.about,
        interests: profileData.interests,
        languages: profileData.languages,
        work_preferences: profileData.work_preferences,
        experience: profileData.experience,
        education: profileData.education,
        certifications: profileData.certifications,
        skills: profileData.skills,
        image: profileData.image // כאן אנחנו עדיין שומרים את הערך האמיתי (הנתיב)
    })
    .eq('uuid', user.id)
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // גם כאן - מחזירים לקליינט תשובה עם ה-Mapping החדש
  const responseData = {
    ...data,
    image: !!data.image ? true : null
  };

  return c.json(responseData)
})

export default app
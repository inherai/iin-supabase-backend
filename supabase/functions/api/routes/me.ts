// supabase/functions/api/routes/me.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const app = new Hono()

async function updateUserVector(userId: string) {
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: user, error } = await supabaseAdmin
      .from("users")
      .select("headline, about, skills, interests, languages, work_preferences, experience, education, certifications, location, role")
      .eq("uuid", userId)
      .single();

    if (error || !user) return;

    const experienceText = (user.experience ?? [])
      .map((e: any) => [e.title, typeof e.company === 'object' ? e.company?.name : e.company].filter(Boolean).join(" at "))
      .join(", ");

    const educationText = (user.education ?? [])
      .map((e: any) => [e.degree, e.institution].filter(Boolean).join(" from "))
      .join(", ");

    const certificationsText = (user.certifications ?? [])
      .map((c: any) => c.name || c.title || c).filter(Boolean)
      .join(", ");

    const languagesText = (user.languages ?? [])
      .map((l: any) => typeof l === 'object' ? (l.language || l.name) : l).filter(Boolean)
      .join(", ");

    const parts = [
      user.role && `Role: ${user.role}`,
      user.location && `Location: ${user.location}`,
      user.headline && `Headline: ${user.headline}`,
      user.about && `About: ${user.about}`,
      user.skills?.length && `Skills: ${user.skills.join(", ")}`,
      user.interests?.length && `Interests: ${user.interests.join(", ")}`,
      languagesText && `Languages: ${languagesText}`,
      user.work_preferences?.length && `Work Preferences: ${user.work_preferences.join(", ")}`,
      experienceText && `Experience: ${experienceText}`,
      educationText && `Education: ${educationText}`,
      certificationsText && `Certifications: ${certificationsText}`,
    ].filter(Boolean).join("\n");

    if (!parts.trim()) return;

    const embRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: parts.slice(0, 8000),
    });

    await supabaseAdmin.from("users_vectors").upsert({
      user_id: userId,
      vector: embRes.data[0].embedding,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    console.log(`Vector updated for user: ${userId}`);
  } catch (err) {
    console.error("Error updating user vector:", err);
  }
}

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
// עדכון פרופיל (ללא תמונת פרופיל)
// --------------------------------------------------------------------
app.put('/', async (c) => {
  const user = c.get('user')

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const supabase = c.get('supabase')
  const payload = await c.req.json()
  const profileData = payload.profile || payload

  const EMBEDDING_FIELDS = ['headline', 'about', 'skills', 'interests', 'languages', 'work_preferences', 'experience', 'education', 'certifications', 'location', 'role'];

  // שלוף מצב נוכחי לפני העדכון - להשוואה
  const { data: currentUser } = await supabase
    .from('users')
    .select(EMBEDDING_FIELDS.join(', '))
    .eq('uuid', user.id)
    .single()

  // אובייקט העדכון - ללא השדה image!
  const updateData = {
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
    cover_image_url: profileData.cover_image_url ?? null
  };

  const { data, error } = await supabase
    .from('users')
    .update(updateData)
    .eq('uuid', user.id)
    .select()
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // עדכון ה-vector רק אם שדה משמעותי באמת השתנה
  const hasEmbeddingChange = currentUser && EMBEDDING_FIELDS.some(
    field => JSON.stringify(profileData[field]) !== JSON.stringify(currentUser[field])
  );
  if (hasEmbeddingChange) {
     updateUserVector(user.id); 
  }

  // מחזירים לקליינט תשובה עם ה-Mapping החדש
  // ה-select() למעלה שלף גם את התמונה הקיימת ב-DB, אז נוכל להחזיר אותה נכון לקליינט
  const responseData = {
    ...data,
    image: !!data.image ? true : null
  };

  return c.json(responseData)
})

// --------------------------------------------------------------------
// PUT /api/me/image
// עדכון תמונת פרופיל בלבד (עם ואלידציה של הקישור)
// --------------------------------------------------------------------
app.put('/image', async (c) => {
  const user = c.get('user')

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const supabase = c.get('supabase')
  const payload = await c.req.json()
  const newImageUrl = payload.image

  // בדיקת תקינות הקישור
  const SUPABASE_URL_PREFIX = 'https://csfyofqntrfxsystdzca.supabase.co/storage/v1/object/public/profile-images/profile-images-folder/';  
  if (typeof newImageUrl !== 'string' || !newImageUrl.startsWith(SUPABASE_URL_PREFIX)) {
    return c.json({ error: 'Invalid image URL format or missing image' }, 400)
  }

  // ביצוע העדכון - רק לשדה image
  const { data, error } = await supabase
    .from('users')
    .update({ image: newImageUrl })
    .eq('uuid', user.id)
    .select('image') 
    .single()

  if (error) {
    return c.json({ error: error.message }, 400)
  }

  // מחזירים תשובה באותו מבנה מיפוי כמו בראוט הראשי
  const responseData = {
    image: !!data.image ? true : null
  }

  return c.json(responseData)
})

export default app
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
    .select(EMBEDDING_FIELDS.join(', ') + ', values_agreed')
    .eq('uuid', user.id)
    .single()

  const updateData: any = {
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
    cover_image_url: profileData.cover_image_url ?? null,
    values_agreed: profileData.values_agreed
  };

  if (profileData.values_agreed === true && !currentUser?.values_agreed) {
    updateData.values_agreed_at = new Date().toISOString();
  }

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
  if (newImageUrl !== null && (typeof newImageUrl !== 'string' || !newImageUrl.startsWith(SUPABASE_URL_PREFIX))) {
    return c.json({ error: 'Invalid image URL format or missing image' }, 400)
  }

  // ביצוע העדכון - רק לשדה image
  const { data, error } = await supabase
    .from('users')
    .update({ image: newImageUrl ?? null })
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


// --------------------------------------------------------------------
// PUT /api/me/status
// עדכון סטטוס משתמש (מותר רק onboarding -> active)
// Body נתמך: { status: "active" }  
// --------------------------------------------------------------------
app.put('/status', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // קרא body בצורה בטוחה
    const payload = await c.req.json().catch(() => ({} as any))

    // 1) { status: "active" }
    const requestedStatus = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : null

    const wantsActive = requestedStatus === 'active' 
    // אם לא ביקשו Active — לא משנים כלום
    if (!wantsActive) {
      return c.json({
        updated: false,
        reason: 'No change: only "active" is allowed',
      })
    }

    // שלוף מצב נוכחי לפני העדכון - להשוואה
    const { data: currentUser, error: currentErr } = await supabase
      .from('users')
      .select('status')
      .eq('uuid', user.id)
      .single()

    if (currentErr) {
      return c.json({ error: currentErr.message }, 500)
    }

    // רק אם כרגע onboarding מאפשרים מעבר ל-active
    if (currentUser?.status !== 'onboarding') {
      return c.json({
        updated: false,
        reason: `No change: status must be "onboarding" to update (current: ${currentUser?.status ?? 'null'})`,
      }, 400)
    }

    // עדכון בפועל
    const { error: updateErr } = await supabase
      .from('users')
      .update({ status: 'Active' })
      .eq('uuid', user.id)

    if (updateErr) {
      return c.json({ error: updateErr.message }, 500)
    }

    return c.json({ updated: true, status: 'active' })
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'Unknown error' }, 500)
  }
})

// --------------------------------------------------------------------
// GET /api/me/strength
// חישוב חוזק הפרופיל של המשתמש המחובר
// --------------------------------------------------------------------
app.get('/strength', async (c) => {
  const user = c.get('user')

  if (!user) {
    return c.json({ error: 'Unauthorized: You must be logged in' }, 401)
  }

  const supabase = c.get('supabase')

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('headline, about, skills, experience, education, work_preferences, image')
    .eq('uuid', user.id)
    .single()

  if (userError) {
    return c.json({ error: userError.message }, 400)
  }

  const { count: connectionsCount, error: connectionsError } = await supabase
    .from('connections')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'accepted')
    .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)

  if (connectionsError) {
    return c.json({ error: connectionsError.message }, 400)
  }

  const oneMonthAgo = new Date()
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)

  const { count: postsCount, error: postsError } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('sender', user.email)
    .gte('sent_at', oneMonthAgo.toISOString())

  if (postsError) {
    return c.json({ error: postsError.message }, 400)
  }

  const hasPhoto = !!(userData.image && userData.image !== 'null' && userData.image !== 'false')
  const aboutText = userData.about?.trim() ?? ''
  const aboutScore = aboutText.length === 0 ? 0 : aboutText.length < 80 ? 0.5 : 1
  const connections = connectionsCount ?? 0
  const connectionsScore =
    connections >= 30 ? 1 :
    connections >= 15 ? 0.75 :
    connections >= 5  ? 0.5 :
    connections >= 1  ? 0.25 : 0
  const recentPosts = postsCount ?? 0
  const postsScore =
    recentPosts >= 10 ? 1 :
    recentPosts >= 6  ? 0.75 :
    recentPosts >= 3  ? 0.5 :
    recentPosts >= 1  ? 0.25 : 0

  const items = [
    {
      key: 'headline',
      label: 'Professional headline',
      tip: 'Your headline is the first thing recruiters see in search',
      score: userData.headline?.trim() ? 1 : 0,
      weight: 0.18,
    },
    {
      key: 'experience',
      label: 'Work experience',
      tip: 'The first thing recruiters look for when filtering candidates',
      score: (userData.experience?.length ?? 0) >= 1 ? 1 : 0,
      weight: 0.18,
    },
    {
      key: 'photo',
      label: 'Profile photo',
      tip: 'Profiles with a photo get 40% more recruiter outreach',
      score: hasPhoto ? 1 : 0,
      weight: 0.13,
    },
    {
      key: 'skills',
      label: 'At least 3 skills',
      tip: 'Recruiters search by skills — the more you add, the better',
      score: (userData.skills?.length ?? 0) >= 3 ? 1 : 0,
      weight: 0.13,
    },
    {
      key: 'education',
      label: 'Education',
      tip: 'Shows your academic background and qualifications to recruiters',
      score: (userData.education?.length ?? 0) >= 1 ? 1 : 0,
      weight: 0.13,
    },
    {
      key: 'about',
      label: aboutScore === 0.5 ? 'Expand your About section' : 'About section',
      tip: aboutScore === 0.5
        ? 'Your bio is a bit short — aim for 80+ characters to make a real impression'
        : 'A personal story increases the chance of direct outreach',
      score: aboutScore,
      weight: 0.10,
    },
    {
      key: 'connections',
      label: 'Community connections',
      tip: connectionsScore === 0
        ? 'Connect with community members to expand your network'
        : 'Keep connecting — aim for 30+ connections for full credit',
      score: connectionsScore,
      weight: 0.08,
    },
    {
      key: 'posts',
      label: 'Recent posts',
      tip: postsScore === 0
        ? 'Share a post to show your expertise to the community'
        : 'Keep posting — aim for 10+ posts this month for full credit',
      score: postsScore,
      weight: 0.06,
    },
    {
      key: 'preferences',
      label: 'Work preferences',
      tip: 'Enables precise matching between your needs and open roles',
      score: (userData.work_preferences?.length ?? 0) >= 1 ? 1 : 0,
      weight: 0.01,
    },
  ]

  const totalScore = items.reduce((sum, i) => sum + i.score * i.weight, 0)
  const percentage = Math.round(totalScore * 100)
  const nextItem = items.find((i) => i.score < 1) ?? null
  const tier =
    percentage >= 95 ? 'Elite' :
    percentage >= 85 ? 'Expert' :
    percentage >= 70 ? 'Strong' :
    percentage >= 40 ? 'Building' :
    'Starter'

  return c.json({ items, percentage, tier, nextItem })
})

export default app
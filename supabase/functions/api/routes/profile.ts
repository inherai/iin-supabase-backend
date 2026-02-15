// supabase/functions/api/routes/profile.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// ====================================================================
// POST /api/profile
// מקבל רשימת אימיילים (למשל עבור ה-Feed) ומחזיר רשימת משתמשים מסוננת
// ====================================================================
app.post('/', async (c) => {
  try {
    const user = c.get('user') // הצופה (Viewer)
    const supabase = c.get('supabase') // הקליינט

    // 1. הגנה
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // 2. קבלת ה-Body (רשימת המיילים)
    const body = await c.req.json().catch(() => ({}))
    const { emails } = body

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return c.json([]) // מחזירים מערך ריק
    }

    // 3. שליפת התפקיד (Role) של הצופה - ישר מהטוקן!
    const viewerBusinessRole = user.app_metadata.role;

    // 4. שליפת המשתמשים המבוקשים (Target Users)
    const { data: users, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .in('email', emails)

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    // 5. לוגיקת הסינון
    const hasAccess = (privacyArray: any) => {
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    // 6. יצירת הרשימה הסופית
    const enrichedUsers = users.map((u: any) => {
      const isSelf = u.email === user.email;

      // אם זה אני - יש גישה מלאה. אם לא - בודקים הרשאות.
      const showLastName = isSelf || hasAccess(u.privacy_lastname)
      const showPicture = isSelf || hasAccess(u.privacy_picture)

      const isInactive = u.status === 'Inactive';

      const displayName = u.first_name
        ? (showLastName && u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name)
        : (isInactive ? u.email : '');

      return {
        uuid: u.uuid,
        email: u.email,
        name: displayName,
        image: showPicture ? u.image : null,
        role: u.role,
        headline: u.headline
      }
    })

    return c.json(enrichedUsers)

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// GET /api/profile?id=...
// שליפת פרופיל יחיד
// ====================================================================
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view profiles' }, 401)
    }

    const targetUserId = c.req.query('id')
    if (!targetUserId) {
      return c.json({ error: 'Target User ID is required' }, 400)
    }

    // 3. שליפת התפקיד (Role) של הצופה - ישר מהטוקן!
    const viewerBusinessRole = user.app_metadata.role;

    // 4. שליפת נתוני המשתמש שרוצים לראות
    const { data: targetUser, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('uuid', targetUserId)
      .single()

    if (fetchError || !targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    // 5. לוגיקת סינון
    const isSelf = targetUser.uuid === user.id || targetUser.email === user.email;

    const hasAccess = (privacyArray: any) => {
      if (isSelf) return true; // גישה מלאה לעצמי
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    const publicProfile = {
      uuid: targetUser.uuid,
      first_name: targetUser.first_name,
      headline: targetUser.headline,
      company: targetUser.company,
      location: targetUser.location,
      about: targetUser.about,
      interests: targetUser.interests,
      languages: targetUser.languages,
      work_preferences: targetUser.work_preferences,
      experience: targetUser.experience,
      education: targetUser.education,
      certifications: targetUser.certifications,
      skills: targetUser.skills,
      open_to_work: targetUser.open_to_work,

      last_name: hasAccess(targetUser.privacy_lastname) ? targetUser.last_name : null,
      picture: hasAccess(targetUser.privacy_picture) ? targetUser.picture : null,
      contact_details: hasAccess(targetUser.privacy_contact_details) ? {
        email: targetUser.email,
        phone: targetUser.phone
      } : null
    }

    return c.json(publicProfile)

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app
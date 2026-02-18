// supabase/functions/api/routes/profile.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

app.get('/views/count', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view profile views count' }, 401)
    }

    const { count, error } = await supabase
      .from('profile_views')
      .select('id', { count: 'exact', head: true })
      .eq('viewed_id', user.id)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// --- פונקציית עזר: בניית ה-URL לתמונה דרך הפרוקסי ---
const getAvatarUrl = (userId: string) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  // מחזיר לינק: https://.../functions/v1/avatar-proxy?id=...
  return `${supabaseUrl}/functions/v1/avatar-proxy?id=${userId}`;
}

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

    // 2. קבלת ה-Body
    const body = await c.req.json().catch(() => ({}))
    const { emails } = body

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return c.json([]) 
    }

    // 3. שליפת התפקיד
    const viewerBusinessRole = user.app_metadata.role;

    // 4. שליפת המשתמשים
    const { data: users, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .in('email', emails)

    if (fetchError) {
      return c.json({ error: fetchError.message }, 500)
    }

    // 5. פונקציית עזר לבדיקת גישה
    const hasAccess = (privacyArray: any) => {
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    // 6. יצירת הרשימה הסופית
    const enrichedUsers = users.map((u: any) => {
      const isSelf = u.email === user.email;
      const isInactive = u.status === 'Inactive'; // בדיקת סטטוס

      // בדיקות פרטיות
      const showLastName = isSelf || hasAccess(u.privacy_lastname)
      const showPicture = isSelf || hasAccess(u.privacy_picture)

      // לוגיקת "שם חכם"
      const displayName = u.first_name
        ? (showLastName && u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name)
        : (isInactive ? u.email : ''); // אם אין שם והוא לא פעיל -> מציג אימייל

      return {
        uuid: u.uuid,
        email: u.email,
        name: displayName, // השם המחושב
        //החזרת הלינק לפרוקסי
        image: showPicture ? getAvatarUrl(u.uuid) : null, 
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
// GET /api/profile?id=... או GET /api/profile?page=...
// שליפת פרופיל יחיד או רשימת משתמשים
// ====================================================================
app.get('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view profiles' }, 401)
    }

    const targetUserId = c.req.query('id')
    const searchQuery = c.req.query('search') || null
    
    // אם אין id, מחזיר רשימה עם pagination
    if (!targetUserId) {
      const page = parseInt(c.req.query('page') || '1')
      const limit = 10
      const offset = (page - 1) * limit
      const viewerBusinessRole = user.app_metadata.role

      const { data: users, error: fetchError } = await supabase
        .rpc('get_random_unconnected_users', {
          current_user_id: user.id,
          requestor_role: viewerBusinessRole,
          page_limit: limit,
          page_offset: offset,
          search_text: searchQuery
        })

      if (fetchError) {
        return c.json({ error: fetchError.message }, 500)
      }

      const total = users?.[0]?.total_count || 0

      const hasAccess = (privacyArray: any) => {
        if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
        return privacyArray.includes(viewerBusinessRole)
      }

      const enrichedUsers = (users || []).map((u: any) => {
        const isSelf = u.uuid === user.id || u.email === user.email
        const isInactive = u.status === 'Inactive'
        const showLastName = isSelf || hasAccess(u.privacy_lastname)
        const showPicture = isSelf || hasAccess(u.privacy_picture)

        const displayName = u.first_name
          ? (showLastName && u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name)
          : (isInactive ? u.email : '')

        const avatarUrl = showPicture ? getAvatarUrl(u.uuid) : null

        return {
          uuid: u.uuid,
          name: displayName,
          headline: u.headline,
          company: u.company,
          location: u.location,
          about: u.about,
          interests: u.interests,
          languages: u.languages,
          work_preferences: u.work_preferences,
          experience: u.experience,
          education: u.education,
          certifications: u.certifications,
          skills: u.skills,
          last_name: showLastName ? u.last_name : null,
          image: avatarUrl,
          contact_details: hasAccess(u.privacy_contact_details) ? {
            email: u.email,
            phone: u.phone
          } : null
        }
      })

      return c.json({
        users: enrichedUsers,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      })
    }

    const viewerBusinessRole = user.app_metadata.role;

    // 4. שליפת המשתמש
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
    const isInactive = targetUser.status === 'Inactive';

    const hasAccess = (privacyArray: any) => {
      if (isSelf) return true;
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    // חישובים
    const showLastName = isSelf || hasAccess(targetUser.privacy_lastname);
    
    // אותה לוגיקת שם חכם גם כאן
    const displayName = targetUser.first_name
      ? (showLastName && targetUser.last_name ? `${targetUser.first_name} ${targetUser.last_name}` : targetUser.first_name)
      : (isInactive ? targetUser.email : '');

    // 6. שליפת פעילות חודשית דרך RPC
    const { data: monthlyActivity, error: activityError } = await supabase
      .rpc('get_user_monthly_activity', { target_user_id: targetUserId })

    if (activityError) {
      console.error('Failed to fetch monthly activity:', activityError.message)
    }

    const publicProfile = {
      uuid: targetUser.uuid,
      name: displayName, // השם לתצוגה הראשית
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

      // שדות מותנים
      last_name: showLastName ? targetUser.last_name : null,
      
      //  החזרת הלינק לפרוקסי
      image: hasAccess(targetUser.privacy_picture) ? getAvatarUrl(targetUser.uuid) : null,
      
      contact_details: hasAccess(targetUser.privacy_contact_details) ? {
        email: targetUser.email,
        phone: targetUser.phone
      } : null,

      // מערך הפעילויות מהחודש האחרון
      monthly_activity: monthlyActivity || []
    }

    if (!isSelf) {
      const { error: insertViewError } = await supabase
        .from('profile_views')
        .insert({
          viewer_id: user.id,
          viewed_id: targetUser.uuid,
          viewed_at: new Date().toISOString()
        })

      if (insertViewError) {
        console.error('Failed to insert profile view:', insertViewError.message)
      }
    }

    return c.json(publicProfile)

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// PUT /api/profile/privacy
// עדכון הגדרות פרטיות
// ====================================================================
app.put('/privacy', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    const { privacy_lastname, privacy_picture, privacy_contact_details, is_anonymous } = body

    const updates: any = {}
    if (privacy_lastname) updates.privacy_lastname = privacy_lastname
    if (privacy_picture) updates.privacy_picture = privacy_picture
    if (privacy_contact_details) updates.privacy_contact_details = privacy_contact_details
    if (typeof is_anonymous === 'boolean') updates.is_anonymous = is_anonymous

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No privacy settings provided' }, 400)
    }

    const { error: updateError } = await supabase
      .from('users')
      .update(updates)
      .eq('uuid', user.id)

    if (updateError) {
      return c.json({ error: updateError.message }, 500)
    }

    return c.json({ success: true, updated: updates })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app
// supabase/functions/api/routes/profile.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

app.get('/views/count', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view profile views count' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { count, error } = await supabaseAdmin
      .from('profile_views')
      .select('id', { count: 'exact', head: true })
      .eq('viewed_id', targetUserId)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
app.get('/posts/count', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view posts count' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: targetUser } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('uuid', targetUserId)
      .single()

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    const { count, error } = await supabaseAdmin
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('sender', targetUser.email)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/comments/count', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view comments count' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: targetUser } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('uuid', targetUserId)
      .single()

    if (!targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    const { count, error } = await supabaseAdmin
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('sender', targetUser.email)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/connections/count', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view connections count' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { count, error } = await supabaseAdmin
      .from('connections')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'accepted')
      .or(`requester_id.eq.${targetUserId},receiver_id.eq.${targetUserId}`)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// --- פונקציית עזר: העשרת מערך experience עם נתוני חברות ---
const enrichExperience = async (experience: any[], supabase: any) => {
  if (!experience || !Array.isArray(experience)) return experience;
  
  const companyIds = experience.map(exp => exp.company).filter(id => typeof id === 'number');
  
  if (companyIds.length === 0) return experience;
  
  console.log('Fetching companies for IDs:', companyIds);
  
  const { data: companies, error } = await supabase
    .from('companies')
    .select('id, logo, name')
    .in('id', companyIds);
  
  console.log('Companies fetched:', companies, 'Error:', error);
  
  const companyMap = new Map(companies?.map((c: any) => [c.id, c]) || []);
  
  return experience.map(exp => {
    if (typeof exp.company === 'number' && companyMap.has(exp.company)) {
      return { ...exp, company: companyMap.get(exp.company) };
    }
    return exp;
  });
}


// ====================================================================
// POST /api/profile/feed
// מקבל רשימת אימיילים (עבור ה-Feed) ומחזיר רשימת משתמשים מסוננת
// ====================================================================
app.post('/feed', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    // שליפת הרול של המשתמש הנוכחי מהטוקן
    const viewerBusinessRole = user.app_metadata?.role

    const body = await c.req.json().catch(() => ({}))
    const emails = Array.isArray(body?.emails)
      ? body.emails.filter((e: any) => typeof e === 'string' && e.trim())
      : []

    if (emails.length === 0) return c.json([])

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseAdmin = createClient(supabaseUrl, supabaseKey)

    // הוספת שדות ה-Privacy לשליפה
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('uuid, email, first_name, last_name, headline, cover_image_url, image, is_anonymous, privacy_lastname, privacy_picture')
      .in('email', emails)

    if (error) return c.json({ error: error.message }, 500)

    // פונקציית עזר לבדיקת הרשאות (כמו בשאר הקוד שלך)
    const hasAccess = (privacyArray: any) => {
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    const enrichedUsers = (data || []).map((u) => {
      const isOwner = u.uuid === user.id
      const isAnonymous = u.is_anonymous === true
      
      // לוגיקת פרטיות משולבת:
      // 1. אם אנונימי ולא בעלים -> הכל מוסתר
      // 2. אם לא אנונימי -> בודקים רול לפי המערכים (privacy)
      
      const canSeeGeneralInfo = !isAnonymous || isOwner
      const canSeeLastName = isOwner || hasAccess(u.privacy_lastname)
      const canSeePicture = isOwner || hasAccess(u.privacy_picture)

      return {
        uuid: u.uuid,
        is_anonymous: isAnonymous,
        // אימייל ופרטים כלליים מוסתרים רק אם אנונימי
        email: canSeeGeneralInfo ? u.email : null,
        first_name: canSeeGeneralInfo ? u.first_name : (isAnonymous ? 'Anonymous' : null),
        headline: canSeeGeneralInfo ? u.headline : null,
        
        // שם משפחה ותמונה תלויים במערכי ה-Privacy (גם אם לא אנונימי!)
        last_name: (canSeeGeneralInfo && canSeeLastName) ? u.last_name : null,
        image: (canSeeGeneralInfo && canSeePicture) ? (u.image ? true : null) : null,
        
        cover_image_url: canSeeGeneralInfo ? u.cover_image_url : null,
        _internal_email_lookup: u.email?.toLowerCase()
      }
    })

    return c.json(enrichedUsers)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// POST /api/profile
// מקבל רשימת IDs ומחזיר רשימת משתמשים
// ====================================================================
app.post('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id: unknown) => typeof id === 'string' && id.trim())
      : []

    if (ids.length === 0) return c.json([])

    const { data, error } = await supabase
      .from('public_users_view')
      .select('uuid, email, first_name, last_name, headline, role, image, cover_image_url')
      .in('uuid', ids)

    if (error) return c.json({ error: error.message }, 500)

    const profiles = (data || []).map((profile: any) => {
      const resolvedName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')

      // The user's snippet uses 'image_url', which likely corresponds to 'cover_image_url' in the DB
      const image =
        (typeof profile.cover_image_url === 'string' && profile.cover_image_url) ||
        (typeof profile.image === 'string' && profile.image) ||
        undefined

      return {
        id: profile.uuid || undefined,
        email: profile.email || undefined,
        name: resolvedName || undefined,
        headline: profile.headline || '',
        role: profile.role || undefined,
        image,
      }
    })

    return c.json(profiles)
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

    // חסימת משתמשים אנונימיים
    if (user.app_metadata?.role === 'feed_participant') {
      return c.json({ error: 'Access denied for anonymous users' }, 403)
    }

    const targetUserId = c.req.query('id')
    const searchQuery = c.req.query('search') || null
    
    // אם אין id, מחזיר רשימה עם pagination
    if (!targetUserId) {
      const page = parseInt(c.req.query('page') || '1')
      const limit = 10
      const offset = (page - 1) * limit

      // אם יש חיפוש, נחפש לפי שם
      if (searchQuery) {
        const { data: searchResults, error: searchError } = await supabase
          .rpc('search_users', {
            current_user_id: user.id,
            search_text: searchQuery,
            page_limit: limit,
            page_offset: offset
          })

        if (searchError) {
          return c.json({ error: searchError.message }, 500)
        }

        const total = searchResults?.[0]?.total_count || 0
        const cleanResults = (searchResults || []).map((u: any) => {
          const { total_count, ...rest } = u
          return rest
        })

        const enrichedUsers = cleanResults.map((u: any) => ({
          uuid: u.uuid,
          first_name: u.first_name,
          last_name: u.last_name,
          headline: u.headline,
          cover_image_url: u.cover_image_url ?? null,
          location: u.location,
          about: u.about,
          interests: u.interests,
          languages: u.languages,
          work_preferences: u.work_preferences,
          experience: u.experience,
          education: u.education,
          certifications: u.certifications,
          skills: u.skills,
          image: u.image === 'true' ? true : null,
          contact_details: (u.email || u.phone) ? {
            email: u.email,
            phone: u.phone
          } : null
        }))

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

      const { data: aiMatches, error: aiError } = await supabase.rpc('match_users', {
        p_user_id: user.id,
        p_threshold: 0.3,
        p_match_count: limit,
        p_offset: offset
      })

      if (aiError) {
        return c.json({ error: aiError.message }, 500)
      }

      const total = aiMatches?.[0]?.total_count || 0
      const userIds = (aiMatches || []).map((m: any) => m.user_id)

      if (userIds.length === 0) {
        return c.json({
          users: [],
          pagination: { page, limit, total: 0, totalPages: 0 }
        })
      }

      const { data: fetchedUsers } = await supabase
        .from('public_users_view')
        .select('*')
        .in('uuid', userIds)

      const usersData = userIds
        .map((id: string) => fetchedUsers?.find((u: any) => u.uuid === id))
        .filter(Boolean)

      const enrichedUsers = usersData.map((u: any) => {
        return {
          uuid: u.uuid,
          first_name: u.first_name,
          last_name: u.last_name,
          headline: u.headline,
          cover_image_url: u.cover_image_url ?? null,
          location: u.location,
          about: u.about,
          interests: u.interests,
          languages: u.languages,
          work_preferences: u.work_preferences,
          experience: u.experience,
          education: u.education,
          certifications: u.certifications,
          skills: u.skills,
          image: u.image === 'true' ? true : null,
          contact_details: (u.email || u.phone) ? {
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
      .from('public_users_view')
      .select('*')
      .eq('uuid', targetUserId)
      .single()

    if (fetchError || !targetUser) {
      return c.json({ error: 'User not found' }, 404)
    }

    // 5. לוגיקת סינון
    // העשרת experience עם נתוני חברות
    const enrichedExperience = await enrichExperience(targetUser.experience, supabase);

    const publicProfile = {
      uuid: targetUser.uuid,
      first_name: targetUser.first_name,
      last_name: targetUser.last_name,
      headline: targetUser.headline,
      location: targetUser.location,
      about: targetUser.about,
      interests: targetUser.interests,
      languages: targetUser.languages,
      work_preferences: targetUser.work_preferences,
      experience: enrichedExperience,
      education: targetUser.education,
      certifications: targetUser.certifications,
      skills: targetUser.skills,
      image: targetUser.image === 'true' ? true : null,
      cover_image_url: targetUser.cover_image_url ?? null,
      contact_details: (targetUser.email || targetUser.phone) ? {
        email: targetUser.email,
        phone: targetUser.phone
      } : null
    }

    if (targetUser.uuid !== user.id) {
  // ביצוע Upsert - אם קיים שילוב של viewer_id ו-viewed_id, הוא רק יעדכן את הזמן
  const { error: upsertError } = await supabase
    .from('profile_views')
    .upsert(
      { 
        viewer_id: user.id, 
        viewed_id: targetUser.uuid,
        viewed_at: new Date().toISOString() 
      }, 
      { onConflict: 'viewer_id,viewed_id' } // דורש אינדקס ייחודי ב-DB
    );

  if (upsertError) {
    console.error('Failed to upsert profile view:', upsertError.message);
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
    if (!user) return c.json({ error: 'unauthorized' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const { privacy_lastname, privacy_picture, privacy_contact_details, is_anonymous } = body

    const updates: any = {}
    if (privacy_lastname) updates.privacy_lastname = privacy_lastname
    if (privacy_picture) updates.privacy_picture = privacy_picture
    if (privacy_contact_details) updates.privacy_contact_details = privacy_contact_details
    
    // שואלים פעם אחת, ומכינים את כל הנתונים
    if (typeof is_anonymous === 'boolean') {
      updates.is_anonymous = is_anonymous
      updates.role = is_anonymous ? 'feed_participant' : 'community'
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no privacy settings provided' }, 400)
    }

    // עדכון אחד ב-DB (הטריגר יעדכן את app_metadata אוטומטית)
    const { error: updateError } = await supabase
      .from('users')
      .update(updates)
      .eq('uuid', user.id)

    if (updateError) return c.json({ error: updateError.message }, 500)

    return c.json({ success: true, updated: updates })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app


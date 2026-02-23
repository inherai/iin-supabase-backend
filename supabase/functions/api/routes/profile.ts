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
app.get('/posts/count', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view posts count' }, 401)
    }

    const { count, error } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('sender', user.email)

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
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view comments count' }, 401)
    }

    const { count, error } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('sender', user.email)

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
    const supabase = c.get('supabase')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view connections count' }, 401)
    }

    const { count, error } = await supabase
      .from('connections')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'accepted')
      .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)

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
// POST /api/profile
// מקבל רשימת אימיילים (למשל עבור ה-Feed) ומחזיר רשימת משתמשים מסוננת
// ====================================================================
app.post('/', async (c) => {
  try {
    const user = c.get('user')
    const supabase = c.get('supabase')

    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const emails = Array.isArray(body?.emails)
      ? body.emails.filter((e: unknown) => typeof e === 'string' && e.trim())
      : []
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id: unknown) => typeof id === 'string' && id.trim())
      : []

    if (emails.length === 0 && ids.length === 0) return c.json([])

    const viewerBusinessRole = user.app_metadata.role

    const emptyResult = { data: [] as any[], error: null as any }

    const [byEmails, byIds] = await Promise.all([
      emails.length
        ? supabase.from('users').select('*').in('email', emails)
        : Promise.resolve(emptyResult),
      ids.length
        ? supabase.from('users').select('*').in('uuid', ids)
        : Promise.resolve(emptyResult),
    ])

    if (byEmails.error || byIds.error) {
      return c.json({ error: byEmails.error?.message || byIds.error?.message }, 500)
    }

    const usersMap = new Map<string, any>()
    ;[...(byEmails.data || []), ...(byIds.data || [])].forEach((u) => {
      usersMap.set(u.uuid || u.email, u)
    })
    const users = [...usersMap.values()]

    const hasAccess = (privacyArray: any) => {
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    const enrichedUsers = users.map((u: any) => {
      const isSelf = u.email === user.email
      const isInactive = u.status === 'Inactive'
      const showLastName = isSelf || hasAccess(u.privacy_lastname)
      const showPicture = isSelf || hasAccess(u.privacy_picture)

      const displayName = u.first_name
        ? (showLastName && u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name)
        : (isInactive ? u.email : '')

      return {
        uuid: u.uuid,
        email: u.email,
        name: displayName,
        role: u.role,
        headline: u.headline,
        cover_image_url: u.cover_image_url ?? null,
        image: (showPicture && !!u.image) ? true : null,      // backward compatibility
        image_url: (showPicture && !!u.image) ? u.image : null // ל-ProfileHeader בפועל
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

      let usersData: any[] = []
      let total = 0
      let isAiMode = false

      // ניסיון ראשון: המלצות AI דרך match_users (עם offset לפגינציה)
      if (!searchQuery) {
        const { data: aiMatches } = await supabase.rpc('match_users', {
          p_user_id: user.id,
          p_threshold: 0.3,
          p_match_count: limit,
          p_offset: offset
        })

        if (aiMatches && aiMatches.length > 0) {
          const userIds = aiMatches.map((m: any) => m.user_id)
          const { data: fetchedUsers } = await supabase
            .from('users')
            .select('*')
            .in('uuid', userIds)

          if (fetchedUsers && fetchedUsers.length > 0) {
            usersData = userIds
              .map((id: string) => fetchedUsers.find((u: any) => u.uuid === id))
              .filter(Boolean)
            // total_count מה-RPC + באפר של 50 כדי שתמיד יהיה אפשר לגלול לרנדומליים
            const aiTotal = parseInt(aiMatches[0].total_count) || 0
            total = aiTotal + 50
            isAiMode = true
          }
        }
      }

      // fallback: רנדומלי (פרופיל ריק / חיפוש טקסטואלי / נגמרו ה-AI)
      if (!isAiMode) {
        const { data: randomUsers, error: fetchError } = await supabase
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

        usersData = randomUsers || []
        total = usersData[0]?.total_count || 0
      }

      const hasAccess = (privacyArray: any) => {
        if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
        return privacyArray.includes(viewerBusinessRole)
      }

      const enrichedUsers = usersData.map((u: any) => {
        const isSelf = u.uuid === user.id || u.email === user.email
        const isInactive = u.status === 'Inactive'
        const showLastName = isSelf || hasAccess(u.privacy_lastname)
        const showPicture = isSelf || hasAccess(u.privacy_picture)

        const displayName = u.first_name
          ? (showLastName && u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name)
          : (isInactive ? u.email : '')

        return {
          uuid: u.uuid,
          name: displayName,
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
          last_name: showLastName ? u.last_name : null,
          image: (showPicture && !!u.image) ? true : null,
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

    // העשרת experience עם נתוני חברות
    const enrichedExperience = await enrichExperience(targetUser.experience, supabase);

    const publicProfile = {
      uuid: targetUser.uuid,
      name: displayName, // השם לתצוגה הראשית
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

      // שדות מותנים
      last_name: showLastName ? targetUser.last_name : null,
      
      image: (hasAccess(targetUser.privacy_picture) && !!targetUser.image) ? true : null,
      cover_image_url: targetUser.cover_image_url ?? null,
      
      contact_details: hasAccess(targetUser.privacy_contact_details) ? {
        email: targetUser.email,
        phone: targetUser.phone
      } : null
    }

    if (!isSelf) {
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


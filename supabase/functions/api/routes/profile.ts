// supabase/functions/api/routes/profile.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    const emptyResult = { data: [] as any[], error: null as any }

    // כשיש מיילים - צריך service role key כדי לגשת לטבלת users ישירות
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const [byEmails, byIds] = await Promise.all([
      emails.length
        ? supabaseAdmin.from('users').select('uuid, email, first_name, last_name, role, headline, cover_image_url, image, is_anonymous').in('email', emails)
        : Promise.resolve(emptyResult),
      ids.length
        ? supabase.from('public_users_view').select('*').in('uuid', ids)
        : Promise.resolve(emptyResult),
    ])

    if (byEmails.error || byIds.error) {
      return c.json({ error: byEmails.error?.message || byIds.error?.message }, 500)
    }

    const usersMap = new Map<string, any>()
    
    ;[...(byEmails.data || []), ...(byIds.data || [])].forEach((u) => {
      if (u.email) {
        usersMap.set(u.email.toLowerCase(), u)
      } else if (u.uuid) {
        usersMap.set(u.uuid, u)
      }
    })
    const users = [...usersMap.values()]

    const enrichedUsers = users.map((u: any) => {
      const isAnonymous = u.is_anonymous === true
      const isOwner = u.uuid === user.id
      const originalEmail = u.email
      
      return {
        uuid: u.uuid,
        email: (isAnonymous && !isOwner) ? null : u.email,
        first_name: (isAnonymous && !isOwner) ? null : u.first_name,
        last_name: (isAnonymous && !isOwner) ? null : u.last_name,
        role: u.role,
        headline: (isAnonymous && !isOwner) ? null : u.headline,
        cover_image_url: (isAnonymous && !isOwner) ? null : u.cover_image_url,
        image: (isAnonymous && !isOwner) ? null : (u.image ? true : null),
        is_anonymous: isAnonymous,
        _internal_email_lookup: originalEmail?.toLowerCase()
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
      let aiTotal = 0
      let randomTotal = 0

      // ניסיון ראשון: המלצות AI דרך match_users
      if (!searchQuery) {
        const { data: aiMatches, error: aiError } = await supabase.rpc('match_users', {
          p_user_id: user.id,
          p_threshold: 0.3,
          p_match_count: limit,
          p_offset: offset
        })

        console.log('[AI] aiMatches:', aiMatches?.length || 0, 'error:', aiError)

        if (aiMatches && aiMatches.length > 0) {
          aiTotal = parseInt(aiMatches[0].total_count) || 0
          console.log('[AI] aiTotal:', aiTotal)
          const userIds = aiMatches.map((m: any) => m.user_id)
          const { data: fetchedUsers } = await supabase
            .from('public_users_view')
            .select('*')
            .in('uuid', userIds)

          if (fetchedUsers) {
            usersData = userIds
              .map((id: string) => fetchedUsers.find((u: any) => u.uuid === id))
              .filter(Boolean)
            console.log('[AI] usersData:', usersData.length)
          }
        } else if (offset > 0) {
          // אם בעמוד מתקדם וה-AI נגמר, שולפים את ה-total_count מעמוד 1
          const { data: countCheck } = await supabase.rpc('match_users', {
            p_user_id: user.id,
            p_threshold: 0.3,
            p_match_count: 1,
            p_offset: 0
          })
          if (countCheck && countCheck.length > 0) {
            aiTotal = parseInt(countCheck[0].total_count) || 0
            console.log('[AI] aiTotal from page 1:', aiTotal)
          }
        }
      }

      // השלמה: אם חסרים משתמשים להשלמת העמוד
      const needMore = limit - usersData.length
      console.log('[Random] needMore:', needMore, 'aiTotal:', aiTotal, 'offset:', offset)
      if (needMore > 0) {
        const randomOffset = Math.max(0, offset - aiTotal)
        console.log('[Random] randomOffset:', randomOffset)
        const { data: randomUsers, error: fetchError } = await supabase
          .rpc('get_random_unconnected_users', {
            current_user_id: user.id,
            requestor_role: viewerBusinessRole,
            page_limit: needMore,
            page_offset: randomOffset,
            search_text: searchQuery
          })

        console.log('[Random] randomUsers:', randomUsers?.length || 0, 'error:', fetchError)

        if (fetchError) {
          return c.json({ error: fetchError.message }, 500)
        }

        if (randomUsers && randomUsers.length > 0) {
          randomTotal = parseInt(randomUsers[0].total_count) || 0
          console.log('[Random] randomTotal:', randomTotal)
          usersData = [...usersData, ...randomUsers]
        }
      }

      const total = aiTotal + randomTotal
      console.log('[Final] total:', total, 'usersData:', usersData.length)

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


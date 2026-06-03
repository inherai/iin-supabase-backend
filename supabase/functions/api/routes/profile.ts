// supabase/functions/api/routes/profile.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ⚠️  ADMIN CLIENT usage in this file — bypasses ALL Supabase RLS policies.
// It is used in two categories:
//   1. System operations (profile views, post/comment counts, account deletion)
//      that must run as the service role because the target rows are not owned
//      by the requesting user.
//   2. Grant-based privacy override: when a recruiter holds an active approved
//      grant, fields that RLS hides (email, phone, last_name, image) are fetched
//      via admin and returned ONLY after verifying the grant in application code.
// Before adding any new createClient(SERVICE_ROLE_KEY) call here, confirm with
// a second developer that there is no RLS-safe alternative.

const app = new Hono()

app.get('/views/count', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized: You must be logged in to view profile views count' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id
    const end   = c.req.query('end')   ?? new Date().toISOString()
    const start = c.req.query('start') ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { count, error } = await supabaseAdmin
      .from('profile_views')
      .select('id', { count: 'exact', head: true })
      .eq('viewed_id', targetUserId)
      .gte('viewed_at', start)
      .lte('viewed_at', end)

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/views/chart', async (c) => {
  try {
    const user = c.get('user')

    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const targetUserId = c.req.query('id') || user.id
    const period  = c.req.query('period')  ?? '30d'
    const groupBy = c.req.query('groupBy') ?? 'day'

    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data, error } = await supabaseAdmin
      .from('profile_views')
      .select('viewed_at')
      .eq('viewed_id', targetUserId)
      .gte('viewed_at', since)
      .order('viewed_at', { ascending: true })

    if (error) {
      return c.json({ error: error.message }, 500)
    }

    const buckets: Record<string, number> = {}
    for (const row of data ?? []) {
      const d = new Date(row.viewed_at)
      let key: string
      if (groupBy === 'week') {
        const dow = d.getDay() || 7
        const monday = new Date(d)
        monday.setDate(d.getDate() - (dow - 1))
        key = monday.toISOString().slice(0, 10)
      } else {
        key = d.toISOString().slice(0, 10)
      }
      buckets[key] = (buckets[key] ?? 0) + 1
    }

    const result = Object.entries(buckets).map(([date, count]) => ({ date, count }))
    return c.json({ data: result })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})
app.get('/post-impressions/chart', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const period = c.req.query('period') ?? '30d'
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Resolve viewer email from UUID
    const { data: emailData } = await supabaseAdmin
      .rpc('get_user_email_by_uuid', { p_uuid: user.id })
    if (!emailData) return c.json({ current_period_total: 0, previous_period_total: 0, data: [] })

    const senderEmail = String(emailData)

    const today = new Date()
    const currentEnd = today.toISOString().slice(0, 10)
    const currentStart = new Date(today.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const prevEnd = new Date(currentStart)
    prevEnd.setDate(prevEnd.getDate() - 1)
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)

    const [{ data: currentData }, { data: prevData }] = await Promise.all([
      supabaseAdmin.rpc('get_post_impressions_chart', {
        p_sender_email: senderEmail,
        p_start_date: currentStart,
        p_end_date: currentEnd,
      }),
      supabaseAdmin.rpc('get_post_impressions_chart', {
        p_sender_email: senderEmail,
        p_start_date: prevStart,
        p_end_date: prevEnd,
      }),
    ])

    const chartData = (currentData || []).map((row: any) => ({
      date: row.impression_date,
      count: Number(row.daily_count),
    }))

    const current_period_total = chartData.reduce((s: number, r: any) => s + r.count, 0)
    const previous_period_total = (prevData || []).reduce(
      (s: number, r: any) => s + Number(r.daily_count), 0
    )

    return c.json({ current_period_total, previous_period_total, data: chartData })
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
      .select('uuid, email, first_name, last_name, headline, cover_image_url, image, is_anonymous, role, privacy_lastname, privacy_picture, privacy_contact_details')
      .in('email', emails)

    if (error) return c.json({ error: error.message }, 500)

    // פונקציית עזר לבדיקת הרשאות
    const hasAccess = (privacyArray: any) => {
      if (!privacyArray || !Array.isArray(privacyArray) || !viewerBusinessRole) return false
      return privacyArray.includes(viewerBusinessRole)
    }

    // Fetch active grants if viewer is a recruiter (grant overrides privacy settings)
    const isRecruiterViewer = viewerBusinessRole === 'recruiters'
    const grantMap: Record<string, string[]> = {}
    if (isRecruiterViewer) {
      const uuids = (data || []).map((u: any) => u.uuid).filter(Boolean)
      if (uuids.length > 0) {
        const now = new Date().toISOString()
        const { data: grants } = await supabaseAdmin
          .from('profile_access_requests')
          .select('candidate_id, approved_fields')
          .eq('recruiter_id', user.id)
          .in('candidate_id', uuids)
          .in('status', ['approved', 'partial'])
          .or(`expires_at.is.null,expires_at.gt.${now}`)
        for (const g of grants ?? []) {
          grantMap[(g as any).candidate_id] = (g as any).approved_fields ?? []
        }
      }
    }

    const enrichedUsers = (data || []).map((u) => {
      const isOwner = u.uuid === user.id
      const isAnonymous = u.is_anonymous === true
      const approvedFields: string[] = grantMap[(u as any).uuid] ?? []

      const canSeeGeneralInfo = !isAnonymous || isOwner
      const canSeeLastName = isOwner || approvedFields.includes('last_name') || !u.privacy_lastname || hasAccess(u.privacy_lastname)
      const canSeePicture = isOwner || approvedFields.includes('picture') || !u.privacy_picture || hasAccess(u.privacy_picture)
      const canSeeContact = isOwner || approvedFields.includes('contact_details') || !u.privacy_contact_details || hasAccess(u.privacy_contact_details)

      return {
        uuid: u.uuid,
        is_anonymous: isAnonymous,
        role: u.role || undefined,
        email: (canSeeGeneralInfo && canSeeContact) ? u.email : null,
        first_name: canSeeGeneralInfo ? u.first_name : (isAnonymous ? 'Anonymous' : null),
        headline: canSeeGeneralInfo ? u.headline : null,
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
      .select('uuid, email, first_name, last_name, headline, role, image, cover_image_url, privacy_contact_details')
      .in('uuid', ids)

    if (error) return c.json({ error: error.message }, 500)

    const viewerBusinessRole = user.app_metadata?.role
    const isRecruiterViewerBatch = viewerBusinessRole === 'recruiters'

    // Fetch grants + actual contact info for recruiters (public_users_view masks email via RLS)
    const batchGrantMap: Record<string, string[]> = {}
    const batchContactMap: Record<string, { email: string | null; phone: string | null }> = {}
    if (isRecruiterViewerBatch && ids.length > 0) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )
      const now = new Date().toISOString()
      const { data: grants } = await supabaseAdmin
        .from('profile_access_requests')
        .select('candidate_id, approved_fields')
        .eq('recruiter_id', user.id)
        .in('candidate_id', ids)
        .in('status', ['approved', 'partial'])
        .or(`expires_at.is.null,expires_at.gt.${now}`)
      const contactGrantIds: string[] = []
      for (const g of grants ?? []) {
        batchGrantMap[(g as any).candidate_id] = (g as any).approved_fields ?? []
        if (((g as any).approved_fields ?? []).includes('contact_details')) {
          contactGrantIds.push((g as any).candidate_id)
        }
      }
      if (contactGrantIds.length > 0) {
        const { data: contacts } = await supabaseAdmin
          .from('users')
          .select('uuid, email, phone')
          .in('uuid', contactGrantIds)
        for (const c of contacts ?? []) {
          batchContactMap[(c as any).uuid] = { email: (c as any).email ?? null, phone: (c as any).phone ?? null }
        }
      }
    }

    const profiles = (data || []).map((profile: any) => {
      const resolvedName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')

      const image =
        (typeof profile.cover_image_url === 'string' && profile.cover_image_url) ||
        (typeof profile.image === 'string' && profile.image) ||
        undefined

      const isOwner = profile.uuid === user.id
      const approvedFields: string[] = batchGrantMap[profile.uuid] ?? []
      const canSeeContact = isOwner ||
        approvedFields.includes('contact_details') ||
        !profile.privacy_contact_details ||
        (Array.isArray(profile.privacy_contact_details) && profile.privacy_contact_details.includes(viewerBusinessRole))

      const effectiveEmail = batchContactMap[profile.uuid]?.email ?? profile.email ?? null

      return {
        id: profile.uuid || undefined,
        email: canSeeContact ? (effectiveEmail || undefined) : undefined,
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

        const viewerBusinessRole = user.app_metadata?.role
        const isRecruiterSearch = viewerBusinessRole === 'recruiters'

        // Fetch grants + raw private fields for recruiter viewers (view masks them via RLS)
        const searchGrantMap: Record<string, string[]> = {}
        const searchRawMap: Record<string, { email: string | null; phone: string | null; last_name: string | null; image: string | null }> = {}
        if (isRecruiterSearch) {
          const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
          )
          const searchUuids = cleanResults.map((u: any) => u.uuid)
          if (searchUuids.length > 0) {
            const now = new Date().toISOString()
            const { data: grants } = await supabaseAdmin
              .from('profile_access_requests')
              .select('candidate_id, approved_fields')
              .eq('recruiter_id', user.id)
              .in('candidate_id', searchUuids)
              .in('status', ['approved', 'partial'])
              .or(`expires_at.is.null,expires_at.gt.${now}`)
            const rawFetchIds: string[] = []
            for (const g of grants ?? []) {
              searchGrantMap[(g as any).candidate_id] = (g as any).approved_fields ?? []
              const fields: string[] = (g as any).approved_fields ?? []
              if (fields.includes('contact_details') || fields.includes('last_name') || fields.includes('picture')) {
                rawFetchIds.push((g as any).candidate_id)
              }
            }
            if (rawFetchIds.length > 0) {
              const { data: rawRows } = await supabaseAdmin
                .from('users')
                .select('uuid, email, phone, last_name, image')
                .in('uuid', rawFetchIds)
              for (const r of rawRows ?? []) {
                searchRawMap[(r as any).uuid] = {
                  email: (r as any).email ?? null,
                  phone: (r as any).phone ?? null,
                  last_name: (r as any).last_name ?? null,
                  image: (r as any).image ?? null,
                }
              }
            }
          }
        }

        const enrichedUsers = cleanResults.map((u: any) => {
          const isOwner = u.uuid === user.id
          const approvedFields: string[] = searchGrantMap[u.uuid] ?? []
          const raw = searchRawMap[u.uuid]
          const privacyAllows = (arr: any) => !arr || !Array.isArray(arr) || arr.includes(viewerBusinessRole)
          const canSeeLastName = isOwner || approvedFields.includes('last_name') || privacyAllows(u.privacy_lastname)
          const canSeePicture = isOwner || approvedFields.includes('picture') || privacyAllows(u.privacy_picture)
          const canSeeContact = isOwner ||
            approvedFields.includes('contact_details') ||
            !u.privacy_contact_details ||
            (Array.isArray(u.privacy_contact_details) && u.privacy_contact_details.includes(viewerBusinessRole))
          const effectiveLastName = raw?.last_name ?? u.last_name ?? null
          const effectiveEmail = raw?.email ?? u.email ?? null
          const effectivePhone = raw?.phone ?? u.phone ?? null
          const effectiveHasImage = !!(raw?.image) || u.image === 'true'
          return {
            uuid: u.uuid,
            first_name: u.first_name,
            last_name: canSeeLastName ? effectiveLastName : null,
            headline: u.headline,
            role: u.role || undefined,
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
            image: canSeePicture ? (effectiveHasImage ? true : null) : null,
            contact_details: canSeeContact && (effectiveEmail || effectivePhone) ? {
              email: effectiveEmail,
              phone: effectivePhone
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

      const { data: aiMatches, error: aiError } = await supabase.rpc('match_users', {
        p_user_id: user.id,
        p_threshold: 0,
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

      const viewerBusinessRole = user.app_metadata?.role
      const isRecruiterAI = viewerBusinessRole === 'recruiters'

      // Fetch grants + raw private fields for recruiters (public_users_view masks them via RLS)
      const aiGrantMap: Record<string, string[]> = {}
      const aiRawMap: Record<string, { email: string | null; phone: string | null; last_name: string | null; image: string | null }> = {}
      if (isRecruiterAI && userIds.length > 0) {
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )
        const now = new Date().toISOString()
        const { data: grants } = await supabaseAdmin
          .from('profile_access_requests')
          .select('candidate_id, approved_fields')
          .eq('recruiter_id', user.id)
          .in('candidate_id', userIds)
          .in('status', ['approved', 'partial'])
          .or(`expires_at.is.null,expires_at.gt.${now}`)
        const rawFetchIds: string[] = []
        for (const g of grants ?? []) {
          aiGrantMap[(g as any).candidate_id] = (g as any).approved_fields ?? []
          const fields: string[] = (g as any).approved_fields ?? []
          if (fields.includes('contact_details') || fields.includes('last_name') || fields.includes('picture')) {
            rawFetchIds.push((g as any).candidate_id)
          }
        }
        if (rawFetchIds.length > 0) {
          const { data: rawRows } = await supabaseAdmin
            .from('users')
            .select('uuid, email, phone, last_name, image')
            .in('uuid', rawFetchIds)
          for (const r of rawRows ?? []) {
            aiRawMap[(r as any).uuid] = {
              email: (r as any).email ?? null,
              phone: (r as any).phone ?? null,
              last_name: (r as any).last_name ?? null,
              image: (r as any).image ?? null,
            }
          }
        }
      }

      const enrichedUsers = usersData.map((u: any) => {
        const isOwner = u.uuid === user.id
        const approvedFields: string[] = aiGrantMap[u.uuid] ?? []
        const raw = aiRawMap[u.uuid]
        const privacyAllows = (arr: any) => !arr || !Array.isArray(arr) || arr.includes(viewerBusinessRole)
        const canSeeLastName = isOwner || approvedFields.includes('last_name') || privacyAllows(u.privacy_lastname)
        const canSeePicture = isOwner || approvedFields.includes('picture') || privacyAllows(u.privacy_picture)
        const canSeeContact = isOwner ||
          approvedFields.includes('contact_details') ||
          !u.privacy_contact_details ||
          (Array.isArray(u.privacy_contact_details) && u.privacy_contact_details.includes(viewerBusinessRole))
        const effectiveLastName = raw?.last_name ?? u.last_name ?? null
        const effectiveEmail = raw?.email ?? u.email ?? null
        const effectivePhone = raw?.phone ?? u.phone ?? null
        const effectiveHasImage = !!(raw?.image) || u.image === 'true'
        return {
          uuid: u.uuid,
          first_name: u.first_name,
          last_name: canSeeLastName ? effectiveLastName : null,
          headline: u.headline,
          role: u.role || undefined,
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
          image: canSeePicture ? (effectiveHasImage ? true : null) : null,
          contact_details: canSeeContact && (effectiveEmail || effectivePhone) ? {
            email: effectiveEmail,
            phone: effectivePhone
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
    const isRecruiterViewer = viewerBusinessRole === 'recruiters'

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
    const enrichedExperience = await enrichExperience(targetUser.experience, supabase);

    const isOwner = targetUser.uuid === user.id

    // public_users_view masks last_name, image, email, phone from non-owners via RLS.
    // When a recruiter has an active grant covering these fields, fetch raw values via
    // admin client (bypasses RLS) so the grant actually reveals what it should.
    let approvedFields: string[] = []
    let grantedEmail: string | null = null
    let grantedPhone: string | null = null
    let grantedLastName: string | null = null
    let grantedHasImage: boolean = false
    if (isRecruiterViewer && !isOwner) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )
      const now = new Date().toISOString()
      const { data: grant } = await supabaseAdmin
        .from('profile_access_requests')
        .select('approved_fields')
        .eq('recruiter_id', user.id)
        .eq('candidate_id', targetUserId)
        .in('status', ['approved', 'partial'])
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .maybeSingle()
      approvedFields = grant?.approved_fields ?? []

      const needsRawFetch = approvedFields.includes('contact_details') ||
        approvedFields.includes('last_name') ||
        approvedFields.includes('picture')

      if (needsRawFetch) {
        const { data: rawData } = await supabaseAdmin
          .from('users')
          .select('email, phone, last_name, image')
          .eq('uuid', targetUserId)
          .maybeSingle()
        if (approvedFields.includes('contact_details')) {
          grantedEmail = rawData?.email ?? null
          grantedPhone = rawData?.phone ?? null
        }
        if (approvedFields.includes('last_name')) {
          grantedLastName = rawData?.last_name ?? null
        }
        if (approvedFields.includes('picture')) {
          grantedHasImage = !!(rawData?.image)
        }
      }
    }

    // Grant overrides privacy — if recruiter has an approved field, show it regardless of privacy setting
    const privacyAllows = (arr: any) =>
      !arr || !Array.isArray(arr) || arr.includes(viewerBusinessRole)

    const canSeeLastName = isOwner || approvedFields.includes('last_name') || privacyAllows(targetUser.privacy_lastname)
    const canSeePicture = isOwner || approvedFields.includes('picture') || privacyAllows(targetUser.privacy_picture)
    const canSeeContact = isOwner || approvedFields.includes('contact_details') || privacyAllows(targetUser.privacy_contact_details)

    // Use admin-fetched raw values when grant covers them (view masks these from non-owners)
    const effectiveLastName = isOwner ? targetUser.last_name : (grantedLastName ?? targetUser.last_name ?? null)
    const effectiveEmail = isOwner ? (targetUser.email ?? null) : (grantedEmail ?? targetUser.email ?? null)
    const effectivePhone = isOwner ? (targetUser.phone ?? null) : (grantedPhone ?? targetUser.phone ?? null)
    const effectiveHasImage = isOwner
      ? (targetUser.image === 'true')
      : (grantedHasImage || targetUser.image === 'true')

    const publicProfile = {
      uuid: targetUser.uuid,
      first_name: targetUser.first_name,
      last_name: canSeeLastName ? effectiveLastName : null,
      headline: targetUser.headline,
      role: targetUser.role || undefined,
      location: targetUser.location,
      about: targetUser.about,
      interests: targetUser.interests,
      languages: targetUser.languages,
      work_preferences: targetUser.work_preferences,
      experience: enrichedExperience,
      education: targetUser.education,
      certifications: targetUser.certifications,
      skills: targetUser.skills,
      image: canSeePicture ? (effectiveHasImage ? true : null) : null,
      cover_image_url: targetUser.cover_image_url ?? null,
      contact_details: canSeeContact && (effectiveEmail || effectivePhone) ? {
        email: effectiveEmail,
        phone: effectivePhone
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
    
    if (typeof is_anonymous === 'boolean') {
      updates.is_anonymous = is_anonymous

      // Read role from DB — JWT may be stale right after invite registration
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      )
      const { data: currentUser } = await supabaseAdmin
        .from('users')
        .select('role')
        .eq('uuid', user.id)
        .maybeSingle()

      if (currentUser?.role !== 'recruiters') {
        updates.role = is_anonymous ? 'feed_participant' : 'community'
      }

      // When going anonymous — delete all conversations, messages and storage files
      if (is_anonymous) {
        const { data: conversations } = await supabaseAdmin
          .from('conversations')
          .select('id')
          .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)

        const conversationIds = (conversations ?? []).map((c: any) => c.id)

        if (conversationIds.length > 0) {
          // Collect attachment paths to delete from storage
          const { data: msgsWithAttachments } = await supabaseAdmin
            .from('messages')
            .select('attachments')
            .in('conversation_id', conversationIds)
            .not('attachments', 'is', null)

          const paths: string[] = []
          for (const msg of msgsWithAttachments ?? []) {
            for (const att of (msg.attachments ?? []) as any[]) {
              const path = att.localPath || att.url || ''
              if (path && !path.startsWith('http')) paths.push(path)
            }
          }
          if (paths.length > 0) {
            await supabaseAdmin.storage.from('chat-attachments').remove(paths)
          }

          // Delete messages then conversations
          await supabaseAdmin.from('messages').delete().in('conversation_id', conversationIds)
          await supabaseAdmin.from('conversations').delete().in('id', conversationIds)
        }

        // Delete all connections (both as requester and receiver)
        await supabaseAdmin
          .from('connections')
          .delete()
          .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`)
      }
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


// supabase/functions/api/routes/articles.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { supabaseAdmin } from '../middleware.ts'

const app = new Hono()

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function buildExcerpt(plain: string, maxChars = 160): string {
  return plain.length <= maxChars ? plain : plain.slice(0, maxChars).trimEnd() + '…'
}

/** Allowlist-based HTML sanitizer — only TipTap schema elements pass through */
function sanitizeHtml(html: string): string {
  const ALLOWED_TAGS = new Set([
    'p','h2','h3','strong','em','u','s','a','ul','ol','li',
    'blockquote','pre','code','img','figure','figcaption',
    'hr','table','thead','tbody','tr','th','td',
    'div','span','br',
  ])
  const ALLOWED_ATTRS: Record<string, Set<string>> = {
    a:    new Set(['href','target','rel']),
    img:  new Set(['src','alt','width','height']),
    div:  new Set(['data-youtube-video','data-pull-quote','class']),
    span: new Set(['data-mention','data-id','class']),
    th:   new Set(['colspan','rowspan']),
    td:   new Set(['colspan','rowspan']),
    '*':  new Set(['class']),
  }

  // Strip script/style/on* attributes — simple regex approach for Deno edge
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ on\w+='[^']*'/gi, '')
    // Remove disallowed tags (keep content for inline elements)
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tag) => {
      if (ALLOWED_TAGS.has(tag.toLowerCase())) return match
      return ''
    })
}

/** Single-article enrich — used only when fetching one article */
async function enrichArticle(article: any, supabase: any) {
  if (article.author_type === 'guest') return article

  if (article.company_id) {
    const { data: co } = await supabase
      .from('companies')
      .select('id, name, logo, tagline')
      .eq('id', article.company_id)
      .maybeSingle()
    const company = co ? { id: co.id, name: co.name, logo_url: co.logo ?? null, tagline: co.tagline ?? null } : null
    return { ...article, company }
  }

  if (article.author_uuid) {
    const { data: user } = await supabase
      .from('public_users_view')
      .select('uuid, first_name, last_name, image, headline')
      .eq('uuid', article.author_uuid)
      .maybeSingle()
    const author = user
      ? { id: user.uuid, first_name: user.first_name, last_name: user.last_name, profile_image_url: user.image, headline: user.headline }
      : null
    return { ...article, author }
  }

  return article
}

/**
 * Batch enrich a list of articles — 2 DB queries regardless of list size.
 * Replaces Promise.all(articles.map(enrichArticle)) which was N queries.
 */
async function batchEnrichArticles(articles: any[], supabase: any): Promise<any[]> {
  if (!articles.length) return articles

  const userUuids = [...new Set(
    articles.filter(a => a.author_type !== 'guest' && a.author_uuid && !a.company_id)
            .map(a => a.author_uuid)
  )]
  const companyIds = [...new Set(
    articles.filter(a => a.company_id).map(a => a.company_id)
  )]

  const [usersRes, companiesRes] = await Promise.all([
    userUuids.length
      ? supabase.from('public_users_view').select('uuid, first_name, last_name, image, headline').in('uuid', userUuids)
      : { data: [] },
    companyIds.length
      ? supabase.from('companies').select('id, name, logo, tagline').in('id', companyIds)
      : { data: [] },
  ])

  const userMap = new Map<string, any>()
  for (const u of usersRes.data || []) userMap.set(u.uuid, u)

  const companyMap = new Map<number, any>()
  for (const co of companiesRes.data || []) companyMap.set(co.id, co)

  return articles.map(a => {
    if (a.author_type === 'guest') return a
    if (a.company_id) {
      const co = companyMap.get(a.company_id)
      return { ...a, company: co ? { id: co.id, name: co.name, logo_url: co.logo ?? null, tagline: co.tagline ?? null } : null }
    }
    if (a.author_uuid) {
      const u = userMap.get(a.author_uuid)
      return { ...a, author: u ? { id: u.uuid, first_name: u.first_name, last_name: u.last_name, profile_image_url: u.image, headline: u.headline } : null }
    }
    return a
  })
}

// ─── GET /articles/filter-tags — smart tag list for the filter bar ────────────

app.get('/filter-tags', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const q = c.req.query('q')?.trim()

  try {
    if (q) {
      // Search the FULL skills + interests tables by name (not limited to tags on articles)
      const [{ data: skillMatches }, { data: interestMatches }] = await Promise.all([
        supabase.from('skills').select('id, name').ilike('name', `%${q}%`).order('name').limit(limit),
        supabase.from('interests').select('id, name').ilike('name', `%${q}%`).order('name').limit(limit),
      ])

      // Count how many published articles use each matched tag
      const sIds = (skillMatches || []).map((s: any) => s.id)
      const iIds = (interestMatches || []).map((i: any) => i.id)

      const [skillCountRes, interestCountRes] = await Promise.all([
        sIds.length ? supabase.from('article_skills').select('skill_id').in('skill_id', sIds) : { data: [] },
        iIds.length ? supabase.from('article_interests').select('interest_id').in('interest_id', iIds) : { data: [] },
      ])

      const sCount: Record<number, number> = {}
      for (const r of skillCountRes.data || []) sCount[r.skill_id] = (sCount[r.skill_id] || 0) + 1
      const iCount: Record<number, number> = {}
      for (const r of interestCountRes.data || []) iCount[r.interest_id] = (iCount[r.interest_id] || 0) + 1

      const tags = [
        ...(skillMatches || []).map((s: any) => ({
          id: s.id, name: s.name, type: 'skill', article_count: sCount[s.id] || 0, is_user_tag: false,
        })),
        ...(interestMatches || []).map((i: any) => ({
          id: i.id, name: i.name, type: 'interest', article_count: iCount[i.id] || 0, is_user_tag: false,
        })),
      ].sort((a, b) => b.article_count - a.article_count)

      return c.json({ tags })
    }

    const { data, error } = await supabase.rpc('get_article_filter_tags', { p_limit: limit })
    if (error) throw error
    return c.json({ tags: data || [] })
  } catch (err) {
    console.error('GET /articles/filter-tags error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── Helper: filter article IDs to only those matching given skill/interest IDs ─

async function filterIdsByTags(
  articleIds: string[],
  skillIds: number[],
  interestIds: number[],
  supabase: any,
): Promise<string[]> {
  if (!skillIds.length && !interestIds.length) return articleIds
  if (!articleIds.length) return []

  const matchingIds = new Set<string>()

  if (skillIds.length) {
    const { data } = await supabase
      .from('article_skills')
      .select('article_id')
      .in('article_id', articleIds)
      .in('skill_id', skillIds)
    for (const row of data || []) matchingIds.add(String(row.article_id))
  }
  if (interestIds.length) {
    const { data } = await supabase
      .from('article_interests')
      .select('article_id')
      .in('article_id', articleIds)
      .in('interest_id', interestIds)
    for (const row of data || []) matchingIds.add(String(row.article_id))
  }

  return articleIds.filter(id => matchingIds.has(id))
}

// ─── Helper: batch-fetch tags (skills + interests) for a list of article IDs ──

async function batchFetchTags(articleIds: string[], supabase: any) {
  if (!articleIds.length) return {}

  const [{ data: skillRows }, { data: interestRows }] = await Promise.all([
    supabase
      .from('article_skills')
      .select('article_id, skills(id, name)')
      .in('article_id', articleIds),
    supabase
      .from('article_interests')
      .select('article_id, interests(id, name)')
      .in('article_id', articleIds),
  ])

  const map: Record<string, any[]> = {}
  for (const row of skillRows || []) {
    if (!row.skills) continue
    if (!map[row.article_id]) map[row.article_id] = []
    map[row.article_id].push({ id: (row.skills as any).id, name: (row.skills as any).name, type: 'skill' })
  }
  for (const row of interestRows || []) {
    if (!row.interests) continue
    if (!map[row.article_id]) map[row.article_id] = []
    map[row.article_id].push({ id: (row.interests as any).id, name: (row.interests as any).name, type: 'interest' })
  }
  return map
}

// ─── GET /articles — published feed (single-RPC, keyset pagination) ───────────

app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const skillIdsParam    = c.req.query('skill_ids')    || c.req.query('skill_id')
  const interestIdsParam = c.req.query('interest_ids') || c.req.query('interest_id')
  const cursor           = c.req.query('cursor')
  const limit            = Math.min(parseInt(c.req.query('limit') || '20'), 50)

  const skillIds    = skillIdsParam    ? skillIdsParam.split(',').map(Number).filter(n => n > 0)    : []
  const interestIds = interestIdsParam ? interestIdsParam.split(',').map(Number).filter(n => n > 0) : []

  // Cursor format: "{match_count}__{published_at}__{uuid}"
  let cursorMatch: number | null = null
  let cursorDate:  string | null = null
  let cursorId:    string | null = null
  if (cursor) {
    const parts = cursor.split('__')
    if (parts.length === 3) {
      cursorMatch = parseInt(parts[0])
      cursorDate  = parts[1]
      cursorId    = parts[2]
    }
  }

  try {
    const { data, error } = await supabase.rpc('get_articles_feed', {
      p_skill_ids:    skillIds,
      p_interest_ids: interestIds,
      p_cursor_match: cursorMatch,
      p_cursor_date:  cursorDate,
      p_cursor_id:    cursorId,
      p_limit:        limit,
    })

    if (error) throw error

    const hasMore = (data || []).length > limit
    const raw     = hasMore ? data.slice(0, limit) : (data || [])
    const last    = raw[raw.length - 1]
    const nextCursor = hasMore && last
      ? `${last.match_count}__${last.published_at}__${last.id}`
      : null

    const articleIds  = raw.map((a: any) => String(a.id))
    const authorUuids = [...new Set(raw.filter((a: any) => a.author_uuid).map((a: any) => String(a.author_uuid)))]

    const [enrichedArticles, tagsMap, impressionsRes, followersRes] = await Promise.all([
      batchEnrichArticles(raw, supabase),
      batchFetchTags(articleIds, supabase),
      articleIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
        : { data: [] as any[] },
      authorUuids.length
        ? supabase.from('article_author_follows').select('author_uuid').in('author_uuid', authorUuids)
        : { data: [] as any[] },
    ])

    const viewCountMap: Record<string, number> = {}
    for (const row of impressionsRes.data || []) {
      viewCountMap[row.article_id] = row.view_count ?? 0
    }
    const followerCountMap: Record<string, number> = {}
    for (const row of followersRes.data || []) {
      followerCountMap[row.author_uuid] = (followerCountMap[row.author_uuid] || 0) + 1
    }

    const articles = enrichedArticles.map((a: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { content, content_plain, ...rest } = a
      return {
        ...rest,
        tags: tagsMap[a.id] || [],
        view_count: viewCountMap[a.id] || 0,
        ...(a.author ? { author: { ...a.author, follower_count: followerCountMap[a.author_uuid] || 0 } } : {}),
      }
    })

    return c.json({ articles, nextCursor })
  } catch (err) {
    console.error('GET /articles error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/latest — newest articles, pure date sort ──────────────────

app.get('/latest', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const since = c.req.query('since')

  try {
    let query = supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(limit)

    if (since) query = query.gte('published_at', since)

    const { data, error } = await query

    if (error) throw error

    const articles = await batchEnrichArticles(data || [], supabase)
    const articleIds = (data || []).map((a: any) => String(a.id))
    const [tagsMap, viewsRes] = await Promise.all([
      batchFetchTags(articleIds, supabase),
      articleIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
        : { data: [] as any[] },
    ])
    const viewCountMap: Record<string, number> = {}
    for (const row of viewsRes.data || []) viewCountMap[row.article_id] = row.view_count ?? 0

    const enriched = articles.map((a: any) => ({
      ...a,
      tags: tagsMap[a.id] || [],
      view_count: viewCountMap[a.id] || 0,
    }))

    return c.json({ articles: enriched })
  } catch (err) {
    console.error('GET /articles/latest error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/search ─────────────────────────────────────────────────────

app.get('/search', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ articles: [] })

  // Escape LIKE special characters so user input is treated as literal text
  const esc = q.replace(/[%_\\]/g, '\\$&')

  // Split into words for multi-word name matching ("duallin management" → ["duallin","management"])
  const words = esc.split(/\s+/).filter(Boolean)

  try {
    // Run all searches in parallel; author search runs one query per word (all parallel)
    const [articleRes, authorWordResults, companyRes] = await Promise.all([
      supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name')
        .eq('status', 'published')
        .is('deleted_at', null)
        .or(`title.ilike.%${esc}%,excerpt.ilike.%${esc}%`)
        .order('published_at', { ascending: false })
        .limit(20),

      // Each word must match first_name OR last_name; intersect results → handles "first last" queries
      Promise.all(words.map(word =>
        supabase
          .from('public_users_view')
          .select('uuid')
          .or(`first_name.ilike.%${word}%,last_name.ilike.%${word}%`)
          .limit(50)
      )),

      // Search by company name
      supabase
        .from('companies')
        .select('id')
        .ilike('name', `%${esc}%`)
        .limit(10),
    ])

    // Intersect word results: user must match every word in at least one name field
    let authorIds: string[]
    if (words.length >= 2) {
      const sets = authorWordResults.map((r: any) => new Set((r.data || []).map((u: any) => u.uuid as string)))
      authorIds = [...(sets[0] as Set<string>)].filter(id => sets.slice(1).every((s: Set<string>) => s.has(id)))
    } else {
      authorIds = (authorWordResults[0]?.data || []).map((u: any) => u.uuid)
    }
    const companyIds = (companyRes.data || []).map((co: any) => co.id)

    let byAuthor: any[] = []
    if (authorIds.length || companyIds.length) {
      const orClauses: string[] = []
      if (authorIds.length)  orClauses.push(`author_uuid.in.(${authorIds.join(',')})`)
      if (companyIds.length) orClauses.push(`company_id.in.(${companyIds.join(',')})`)

      const { data } = await supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name')
        .eq('status', 'published')
        .is('deleted_at', null)
        .or(orClauses.join(','))
        .order('published_at', { ascending: false })
        .limit(20)
      byAuthor = data || []
    }

    // Merge and deduplicate — title matches first, author matches appended
    const seen = new Set<string>()
    const merged: any[] = []
    for (const a of [...(articleRes.data || []), ...byAuthor]) {
      if (!seen.has(String(a.id))) { seen.add(String(a.id)); merged.push(a) }
    }

    const articles = await batchEnrichArticles(merged.slice(0, 20), supabase)
    return c.json({ articles })
  } catch (err) {
    console.error('GET /articles/search error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/trending — top articles by views (7-day window, falls back to all-time) ──

app.get('/trending', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 20)
  const skillIdsParam    = c.req.query('skill_ids')
  const interestIdsParam = c.req.query('interest_ids')
  const skillIds    = skillIdsParam    ? skillIdsParam.split(',').map(Number).filter(n => n > 0)    : []
  const interestIds = interestIdsParam ? interestIdsParam.split(',').map(Number).filter(n => n > 0) : []

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    // Count impressions per article in the last 7 days
    const { data: impressionData } = await supabaseAdmin
      .from('article_impressions')
      .select('article_id')
      .gte('impression_date', sevenDaysAgo)

    // Aggregate counts
    const weekCountMap: Record<string, number> = {}
    for (const row of impressionData || []) {
      const id = String(row.article_id)
      weekCountMap[id] = (weekCountMap[id] || 0) + 1
    }

    let articleIds: string[] = Object.entries(weekCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 3) // fetch more before filtering by tags
      .map(([id]) => id)

    // Fallback: if fewer than 4 results from the last 7 days, use all-time view counts
    if (articleIds.length < 4) {
      const { data: allTimeData } = await supabaseAdmin
        .from('article_view_counts')
        .select('article_id, view_count')
        .order('view_count', { ascending: false })
        .limit(limit * 3)
      const allTimeIds = (allTimeData || []).map((r: any) => String(r.article_id))
      const merged = [...articleIds]
      for (const id of allTimeIds) {
        if (!merged.includes(id)) merged.push(id)
        if (merged.length >= limit * 3) break
      }
      articleIds = merged
    }

    // Apply skill/interest filter before truncating to limit
    articleIds = await filterIdsByTags(articleIds, skillIds, interestIds, supabase)
    articleIds = articleIds.slice(0, limit)

    if (!articleIds.length) return c.json({ articles: [] })

    // Fetch the actual articles
    const { data: raw, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .is('deleted_at', null)
      .in('id', articleIds)

    if (error) throw error

    // Re-sort to match our rank order
    const idOrder = articleIds.map(String)
    const sorted = (raw || []).sort((a: any, b: any) => idOrder.indexOf(String(a.id)) - idOrder.indexOf(String(b.id)))

    const enriched = await batchEnrichArticles(sorted, supabase)
    const enrichedIds = enriched.map((a: any) => String(a.id))
    const [tagsMap, viewCountRes] = await Promise.all([
      batchFetchTags(enrichedIds, supabase),
      enrichedIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', enrichedIds)
        : { data: [] as any[] },
    ])
    const viewCountMap: Record<string, number> = {}
    for (const row of viewCountRes.data || []) viewCountMap[row.article_id] = row.view_count ?? 0

    const articles = enriched.map((a: any) => ({
      ...a,
      tags: tagsMap[a.id] || [],
      view_count: viewCountMap[a.id] || 0,
    }))

    return c.json({ articles })
  } catch (err) {
    console.error('GET /articles/trending error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/following — articles from followed authors + companies ─────

app.get('/following', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 20)
  const skillIdsParam    = c.req.query('skill_ids')
  const interestIdsParam = c.req.query('interest_ids')
  const skillIds    = skillIdsParam    ? skillIdsParam.split(',').map(Number).filter(n => n > 0)    : []
  const interestIds = interestIdsParam ? interestIdsParam.split(',').map(Number).filter(n => n > 0) : []

  try {
    // Fetch who the user follows (authors + companies) in parallel
    const [authorFollowsRes, companyFollowsRes] = await Promise.all([
      supabase.from('article_author_follows').select('author_uuid').eq('follower_uuid', user.id),
      supabase.from('article_company_follows').select('company_id').eq('follower_uuid', user.id),
    ])

    const authorIds  = (authorFollowsRes.data  || []).map((r: any) => r.author_uuid)
    const companyIds = (companyFollowsRes.data || []).map((r: any) => r.company_id)

    if (!authorIds.length && !companyIds.length) {
      return c.json({ articles: [] })
    }

    // Fetch recent articles from followed authors and companies
    const orFilters: string[] = []
    if (authorIds.length)  orFilters.push(`author_uuid.in.(${authorIds.join(',')})`)
    if (companyIds.length) orFilters.push(`company_id.in.(${companyIds.join(',')})`)

    const { data, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .is('deleted_at', null)
      .or(orFilters.join(','))
      .order('published_at', { ascending: false })
      .limit(skillIds.length || interestIds.length ? limit * 3 : limit)

    if (error) throw error

    let rawIds = (data || []).map((a: any) => String(a.id))
    if (skillIds.length || interestIds.length) {
      rawIds = await filterIdsByTags(rawIds, skillIds, interestIds, supabase)
      rawIds = rawIds.slice(0, limit)
    }
    const filtered = (data || []).filter((a: any) => rawIds.includes(String(a.id)))

    const enriched = await batchEnrichArticles(filtered, supabase)
    const articleIds = enriched.map((a: any) => String(a.id))
    const [tagsMap, viewCountRes] = await Promise.all([
      batchFetchTags(articleIds, supabase),
      articleIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
        : { data: [] as any[] },
    ])
    const viewCountMap: Record<string, number> = {}
    for (const row of viewCountRes.data || []) viewCountMap[row.article_id] = row.view_count ?? 0

    const articles = enriched.map((a: any) => ({
      ...a,
      tags: tagsMap[a.id] || [],
      view_count: viewCountMap[a.id] || 0,
    }))

    return c.json({ articles })
  } catch (err) {
    console.error('GET /articles/following error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/news — latest news-type articles ──────────────────────────

app.get('/news', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 20)
  const skillIdsParam    = c.req.query('skill_ids')
  const interestIdsParam = c.req.query('interest_ids')
  const skillIds    = skillIdsParam    ? skillIdsParam.split(',').map(Number).filter(n => n > 0)    : []
  const interestIds = interestIdsParam ? interestIdsParam.split(',').map(Number).filter(n => n > 0) : []

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .eq('article_type', 'news')
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .limit(skillIds.length || interestIds.length ? limit * 3 : limit)

    if (error) throw error

    let filtered = data || []
    if (skillIds.length || interestIds.length) {
      const rawIds = filtered.map((a: any) => String(a.id))
      const kept = new Set(await filterIdsByTags(rawIds, skillIds, interestIds, supabase))
      filtered = filtered.filter((a: any) => kept.has(String(a.id))).slice(0, limit)
    }

    const articles = await batchEnrichArticles(filtered, supabase)
    return c.json({ articles })
  } catch (err) {
    console.error('GET /articles/news error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/editors-picks ─────────────────────────────────────────────

app.get('/editors-picks', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .eq('is_editors_pick', true)
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .limit(6)

    if (error) throw error
    const articles = await batchEnrichArticles(data || [], supabase)
    return c.json({ articles })
  } catch (err) {
    console.error('GET /articles/editors-picks error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/my-articles — author's own published + drafts ──────────────

app.get('/my-articles', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, status, cover_image_url, read_time, published_at, updated_at, is_pinned, series_name, series_order, company_id')
      .eq('author_uuid', user.id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })

    if (error) throw error

    // Attach view counts and reaction/comment counts for analytics
    const articleIds = (data || []).map((a: any) => a.id)
    const companyIds = [...new Set((data || []).filter((a: any) => a.company_id).map((a: any) => a.company_id))]
    let viewCounts: Record<string, number> = {}
    let commentCounts: Record<string, number> = {}
    let companyMap: Record<number, { id: number; name: string; logo_url: string | null }> = {}

    const fetchPromises: Promise<any>[] = []

    if (articleIds.length) {
      fetchPromises.push(
        supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
          .then(({ data: rows }: any) => {
            for (const row of rows || []) viewCounts[row.article_id] = row.view_count ?? 0
          }),
        supabase.from('article_comments').select('article_id').in('article_id', articleIds)
          .then(({ data: rows }: any) => {
            for (const row of rows || []) commentCounts[row.article_id] = (commentCounts[row.article_id] || 0) + 1
          })
      )
    }

    if (companyIds.length) {
      fetchPromises.push(
        supabase.from('companies').select('id, name, logo').in('id', companyIds)
          .then(({ data: rows }: any) => {
            for (const c of rows || []) companyMap[c.id] = { ...c, logo_url: c.logo }
          })
      )
    }

    await Promise.all(fetchPromises)

    const enriched = (data || []).map((a: any) => ({
      ...a,
      company: a.company_id ? (companyMap[a.company_id] || null) : null,
      view_count: viewCounts[a.id] || 0,
      comment_count: commentCounts[a.id] || 0,
    }))

    return c.json({ articles: enriched })
  } catch (err) {
    console.error('GET /articles/my-articles error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/user/:userId — published articles by a specific author ─────

app.get('/user/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const userId = c.req.param('userId')

  try {
    // Fetch article IDs first so all parallel queries can use them cleanly
    // Only personal articles (company_id IS NULL) — company articles belong to the company page
    const { data: idRows } = await supabase
      .from('articles')
      .select('id')
      .eq('author_uuid', userId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .is('company_id', null)
    const articleIds = (idRows || []).map((a: any) => a.id)

    // Non-owner visiting a page with no articles → 404 (don't expose empty profiles)
    if (!articleIds.length && user.id !== userId) {
      return c.json({ error: 'Author not found' }, 404)
    }

    const [articlesRes, profileRes, viewCountsRes, tagsMap, authorRes, coverRes, followRes, followerCountRes] = await Promise.all([
      supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, is_pinned, series_name, is_editors_pick')
        .eq('author_uuid', userId)
        .eq('status', 'published')
        .is('deleted_at', null)
        .is('company_id', null)
        .order('is_pinned', { ascending: false })
        .order('published_at', { ascending: false }),
      supabase
        .from('article_author_profiles')
        .select('writing_bio')
        .eq('author_uuid', userId)
        .maybeSingle(),
      articleIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
        : Promise.resolve({ data: [] as any[] }),
      batchFetchTags(articleIds, supabase),
      supabase
        .from('public_users_view')
        .select('uuid, first_name, last_name, image, headline')
        .eq('uuid', userId)
        .maybeSingle(),
      supabase
        .from('users')
        .select('cover_image_url')
        .eq('uuid', userId)
        .maybeSingle(),
      supabase
        .from('article_author_follows')
        .select('follower_uuid')
        .eq('author_uuid', userId)
        .eq('follower_uuid', user.id)
        .maybeSingle()
        .then((r: any) => r)
        .catch(() => ({ data: null })),
      supabase
        .from('article_author_follows')
        .select('follower_uuid', { count: 'exact', head: true })
        .eq('author_uuid', userId),
    ])

    const viewCountMap: Record<string, number> = {}
    for (const row of viewCountsRes.data || []) {
      viewCountMap[row.article_id] = row.view_count ?? 0
    }

    const articles = (articlesRes.data || []).map((a: any) => ({
      ...a,
      view_count: viewCountMap[a.id] || 0,
      tags: tagsMap[a.id] || [],
    }))

    // Top skills with article count per skill
    let topSkills: any[] = []
    if (articleIds.length) {
      const { data: skillRows } = await supabase
        .from('article_skills')
        .select('skill_id, skills(id, name)')
        .in('article_id', articleIds)
      const counts: Record<string, { skill: any; count: number }> = {}
      for (const row of skillRows || []) {
        const sid = row.skill_id
        if (!counts[sid]) counts[sid] = { skill: row.skills, count: 0 }
        counts[sid].count++
      }
      topSkills = Object.values(counts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 6)
        .map(({ skill, count }) => ({ ...skill, count }))
    }

    const u = authorRes.data
    return c.json({
      articles,
      writing_bio: profileRes.data?.writing_bio || null,
      top_skills: topSkills,
      author: u ? {
        id: u.uuid,
        first_name: u.first_name,
        last_name: u.last_name,
        has_image: !!u.image,
        headline: u.headline ?? null,
        cover_image_url: (coverRes.data as any)?.cover_image_url ?? null,
      } : null,
      is_following: !!(followRes as any)?.data,
      stats: {
        article_count: articles.length,
        total_views: Object.values(viewCountMap).reduce((s, v) => s + v, 0),
        follower_count: (followerCountRes as any).count || 0,
      },
    })
  } catch (err) {
    console.error('GET /articles/user/:userId error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/follow/:userId — follow an author ────────────────────────

app.post('/follow/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const authorId = c.req.param('userId')
  if (authorId === user.id) return c.json({ error: 'Cannot follow yourself' }, 400)
  try {
    const { data: existing } = await supabase
      .from('article_author_follows')
      .select('follower_uuid')
      .eq('follower_uuid', user.id)
      .eq('author_uuid', authorId)
      .maybeSingle()

    const isNewFollow = !existing

    await supabase.from('article_author_follows')
      .upsert({ follower_uuid: user.id, author_uuid: authorId }, { onConflict: 'follower_uuid,author_uuid' })

    if (isNewFollow) {
      try {
        await supabase.from('notifications').insert({
          user_id: authorId,
          actor_id: user.id,
          target_id: null,
          type: 'FOLLOW',
          count: 1,
          is_read: false,
        })
      } catch (e) {
        console.error('[FOLLOW] notification insert failed:', e)
      }
    }

    return c.json({ is_following: true })
  } catch (err) {
    console.error('POST /articles/follow/:userId error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── DELETE /articles/follow/:userId — unfollow an author ────────────────────

app.delete('/follow/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const authorId = c.req.param('userId')
  try {
    await supabase.from('article_author_follows')
      .delete()
      .eq('follower_uuid', user.id)
      .eq('author_uuid', authorId)
    return c.json({ is_following: false })
  } catch (err) {
    console.error('DELETE /articles/follow/:userId error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/follow-company/:companyId — follow a company ─────────────

app.post('/follow-company/:companyId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const companyId = parseInt(c.req.param('companyId'))
  if (isNaN(companyId)) return c.json({ error: 'Invalid company ID' }, 400)
  try {
    await supabase
      .from('article_company_follows')
      .upsert({ follower_uuid: user.id, company_id: companyId }, { onConflict: 'follower_uuid,company_id' })
    return c.json({ is_following: true })
  } catch (err) {
    console.error('POST /articles/follow-company error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── DELETE /articles/follow-company/:companyId — unfollow a company ──────────

app.delete('/follow-company/:companyId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const companyId = parseInt(c.req.param('companyId'))
  if (isNaN(companyId)) return c.json({ error: 'Invalid company ID' }, 400)
  try {
    await supabase
      .from('article_company_follows')
      .delete()
      .eq('follower_uuid', user.id)
      .eq('company_id', companyId)
    return c.json({ is_following: false })
  } catch (err) {
    console.error('DELETE /articles/follow-company error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/company/:companyId — published articles by a company ────────

app.get('/company/:companyId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const companyId = parseInt(c.req.param('companyId'))
  if (isNaN(companyId)) return c.json({ error: 'Invalid company ID' }, 400)

  try {
    const [companyRes, articlesRes, followerCountRes, isFollowingRes] = await Promise.all([
      supabase.from('companies').select('id, name, logo, tagline, owner_uuid').eq('id', companyId).single(),
      supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, is_pinned, series_name, is_editors_pick')
        .eq('company_id', companyId)
        .eq('status', 'published')
        .is('deleted_at', null)
        .order('is_pinned', { ascending: false })
        .order('published_at', { ascending: false }),
      supabase
        .from('article_company_follows')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', companyId),
      supabase
        .from('article_company_follows')
        .select('company_id')
        .eq('company_id', companyId)
        .eq('follower_uuid', user.id)
        .maybeSingle(),
    ])

    if (!companyRes.data) return c.json({ error: 'Company not found' }, 404)

    const articles = articlesRes.data || []
    const isOwner = companyRes.data.owner_uuid === user.id

    // Non-owner visiting a company page with no articles → 404
    if (!articles.length && !isOwner) {
      return c.json({ error: 'Company not found' }, 404)
    }
    const articleIds = articles.map((a: any) => a.id)

    const [skillRows, viewCountsRes, tagsMap] = await Promise.all([
      articleIds.length
        ? supabase.from('article_skills').select('skill_id, skills(id, name)').in('article_id', articleIds)
        : Promise.resolve({ data: [] }),
      articleIds.length
        ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', articleIds)
        : Promise.resolve({ data: [] as any[] }),
      batchFetchTags(articleIds, supabase),
    ])

    const viewCountMap: Record<string, number> = {}
    for (const row of (viewCountsRes.data || [])) {
      viewCountMap[row.article_id] = row.view_count ?? 0
    }

    const enrichedArticles = articles.map((a: any) => ({
      ...a,
      view_count: viewCountMap[a.id] || 0,
      tags: tagsMap[a.id] || [],
    }))

    const counts: Record<string, { skill: any; count: number }> = {}
    for (const row of (skillRows.data || [])) {
      const sid = row.skill_id
      if (!counts[sid]) counts[sid] = { skill: row.skills, count: 0 }
      counts[sid].count++
    }
    const topSkills = Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(({ skill }) => skill)

    const firstPublished = articles.length > 0
      ? articles.reduce((min: string | null, a: any) => {
          if (!a.published_at) return min
          if (!min) return a.published_at
          return new Date(a.published_at) < new Date(min) ? a.published_at : min
        }, null)
      : null

    const co = companyRes.data
    return c.json({
      articles: enrichedArticles,
      company: { id: co.id, name: co.name, logo_url: co.logo ?? null, tagline: co.tagline ?? null },
      top_skills: topSkills,
      is_following: !!(isFollowingRes.data),
      first_published: firstPublished,
      stats: {
        article_count: articles.length,
        total_views: Object.values(viewCountMap).reduce((s, v) => s + v, 0),
        follower_count: followerCountRes.count ?? 0,
      },
    })
  } catch (err) {
    console.error('GET /articles/company/:companyId error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/series/:authorId/:seriesName ───────────────────────────────

app.get('/series/:authorId/:seriesName', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const { authorId, seriesName } = c.req.param()

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, series_order')
      .eq('author_uuid', authorId)
      .eq('series_name', decodeURIComponent(seriesName))
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('series_order', { ascending: true })

    if (error) throw error
    return c.json({ articles: data || [] })
  } catch (err) {
    console.error('GET /articles/series error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/author-profile/:userId ────────────────────────────────────

app.get('/author-profile/:userId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  try {
    const { data } = await supabase
      .from('article_author_profiles')
      .select('writing_bio, updated_at')
      .eq('author_uuid', c.req.param('userId'))
      .maybeSingle()

    return c.json({ profile: data || null })
  } catch (err) {
    console.error('GET /articles/author-profile error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /articles/author-profile ────────────────────────────────────────────

app.put('/author-profile', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const { writing_bio } = await c.req.json()

  try {
    const { error } = await supabase
      .from('article_author_profiles')
      .upsert({ author_uuid: user.id, writing_bio, updated_at: new Date().toISOString() })

    if (error) throw error
    return c.json({ success: true })
  } catch (err) {
    console.error('PUT /articles/author-profile error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/authors — list authors with stats ─────────────────────────
// sort=popular (by total views, then article count) | sort=new (by first published date)

app.get('/authors', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const sort  = c.req.query('sort')  ?? 'popular'
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 50)

  try {
    // All aggregation (article counts, total views, follower counts, sort) runs
    // in Postgres via the get_top_authors RPC. Returns exactly `limit` rows.
    // See migration add_authors_rpc.sql for the query + index rationale.
    const { data: statsRows, error } = await supabase.rpc('get_top_authors', {
      p_sort: sort,
      p_limit: limit,
    })
    if (error) throw error

    const topUuids = (statsRows as any[] ?? []).map((r: any) => String(r.author_uuid))

    // Fetch user profiles (skip if no user authors)
    let userAuthors: any[] = []
    if (topUuids.length) {
      const [{ data: profiles }, { data: userCovers }, { data: bioProfiles }, { data: soloArticleRows }] = await Promise.all([
        supabase
          .from('public_users_view')
          .select('uuid, first_name, last_name, image, headline')
          .in('uuid', topUuids),
        supabase
          .from('users')
          .select('uuid, cover_image_url')
          .in('uuid', topUuids),
        supabase
          .from('article_author_profiles')
          .select('author_uuid, writing_bio')
          .in('author_uuid', topUuids),
        // Only users who wrote at least one article as themselves (not as company) should appear.
        // If all their articles have company_id set, they appear as the company — not as a person.
        supabase
          .from('articles')
          .select('author_uuid')
          .eq('status', 'published')
          .is('deleted_at', null)
          .is('company_id', null)
          .in('author_uuid', topUuids),
      ])

      // Build set of UUIDs that have at least one personal article
      const soloAuthorSet = new Set((soloArticleRows || []).map((r: any) => String(r.author_uuid)))

      const profileMap: Record<string, any> = {}
      for (const p of profiles || []) profileMap[p.uuid] = p

      const coverMap: Record<string, string | null> = {}
      for (const u of userCovers || []) coverMap[u.uuid] = u.cover_image_url ?? null

      const bioMap: Record<string, string | null> = {}
      for (const b of bioProfiles || []) bioMap[b.author_uuid] = b.writing_bio ?? null

      const statsMap: Record<string, any> = {}
      for (const s of statsRows as any[]) statsMap[String(s.author_uuid)] = s

      userAuthors = topUuids
        .filter((uuid: string) => soloAuthorSet.has(uuid)) // exclude authors who only wrote as a company
        .map((uuid: string) => {
          const p = profileMap[uuid]
          const s = statsMap[uuid]
          if (!p || !s) return null
          return {
            id: uuid,
            type: 'user' as const,
            first_name: p.first_name,
            last_name: p.last_name,
            profile_image_url: p.image ?? null,
            cover_image_url: coverMap[uuid] ?? null,
            headline: p.headline ?? null,
            writing_bio: bioMap[uuid] ?? null,
            first_published: s.first_published,
            stats: {
              article_count: Number(s.article_count),
              total_views:   Number(s.total_views),
              follower_count: Number(s.follower_count),
            },
          }
        })
        .filter(Boolean)
    }

    // Also fetch companies that published articles (exclude soft-deleted)
    const { data: companyArticleRows } = await supabase
      .from('articles')
      .select('id, company_id, published_at')
      .eq('status', 'published')
      .is('deleted_at', null)
      .filter('company_id', 'not.is', null)

    const companyStatsMap: Record<number, { article_count: number; first_published: string }> = {}
    for (const a of companyArticleRows || []) {
      const cid = Number(a.company_id)
      if (!companyStatsMap[cid]) companyStatsMap[cid] = { article_count: 0, first_published: a.published_at }
      companyStatsMap[cid].article_count++
      if (a.published_at < companyStatsMap[cid].first_published) companyStatsMap[cid].first_published = a.published_at
    }

    const sortedCompanyIds = Object.entries(companyStatsMap)
      .sort(([, a], [, b]) => sort === 'new'
        ? new Date(b.first_published).getTime() - new Date(a.first_published).getTime()
        : b.article_count - a.article_count
      )
      .map(([id]) => Number(id))

    // Compute real view totals and follower counts for companies
    const companyViewTotals: Record<number, number> = {}
    const companyFollowerCounts: Record<number, number> = {}

    const companyAuthors: any[] = []
    if (sortedCompanyIds.length) {
      const companyArtIds = (companyArticleRows || []).map((a: any) => String(a.id))
      const artToCompany: Record<string, number> = {}
      for (const a of companyArticleRows || []) artToCompany[String(a.id)] = Number(a.company_id)

      const [{ data: companiesData }, viewCountsRes, followsRes] = await Promise.all([
        supabase.from('companies').select('id, name, logo, tagline').in('id', sortedCompanyIds),
        companyArtIds.length
          ? supabaseAdmin.from('article_view_counts').select('article_id, view_count').in('article_id', companyArtIds)
          : Promise.resolve({ data: [] as any[] }),
        supabase.from('article_company_follows').select('company_id').in('company_id', sortedCompanyIds),
      ])

      for (const row of (viewCountsRes.data || [])) {
        const cid = artToCompany[String(row.article_id)]
        if (cid) companyViewTotals[cid] = (companyViewTotals[cid] || 0) + (row.view_count || 0)
      }
      for (const row of (followsRes.data || [])) {
        const cid = Number(row.company_id)
        companyFollowerCounts[cid] = (companyFollowerCounts[cid] || 0) + 1
      }

      const companyMap: Record<number, any> = {}
      for (const c of companiesData || []) companyMap[c.id] = c

      for (const cid of sortedCompanyIds) {
        const c = companyMap[cid]
        if (!c) continue
        companyAuthors.push({
          id: String(cid),
          type: 'company' as const,
          name: c.name,
          logo_url: c.logo ?? null,
          tagline: c.tagline ?? null,
          first_published: companyStatsMap[cid].first_published,
          stats: {
            article_count: companyStatsMap[cid].article_count,
            total_views: companyViewTotals[cid] || 0,
            follower_count: companyFollowerCounts[cid] || 0,
          },
        })
      }
    }

    // Drop any author whose article_count reached 0 (safety net for edge cases)
    const filteredUserAuthors    = userAuthors.filter((a: any)    => a.stats.article_count > 0)
    const filteredCompanyAuthors = companyAuthors.filter((a: any) => a.stats.article_count > 0)

    // Interleave: every 3 users, insert 1 company (if available)
    const authors: any[] = []
    let ci = 0
    for (let i = 0; i < filteredUserAuthors.length; i++) {
      authors.push(filteredUserAuthors[i])
      if ((i + 1) % 3 === 0 && ci < filteredCompanyAuthors.length) {
        authors.push(filteredCompanyAuthors[ci++])
      }
    }
    while (ci < filteredCompanyAuthors.length) authors.push(filteredCompanyAuthors[ci++])

    return c.json({ authors })
  } catch (err) {
    console.error('GET /articles/authors error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/:id — single article ──────────────────────────────────────

app.get('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article, error } = await supabase
      .from('articles')
      .select('*')
      .eq('id', articleId)
      .maybeSingle()

    if (error) throw error

    // Tombstone for soft-deleted articles
    if (!article || article.deleted_at) {
      return c.json({ article: null, deleted: true }, 404)
    }

    // Author can see their own drafts; others cannot
    const isOwner = article.author_uuid === user.id
    if (article.status === 'draft' && !isOwner) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Tags — skills + interests
    const [{ data: skillRows }, { data: interestRows }] = await Promise.all([
      supabase.from('article_skills').select('skill_id, skills(id, name)').eq('article_id', articleId),
      supabase.from('article_interests').select('interest_id, interests(id, name)').eq('article_id', articleId),
    ])
    const skills = (skillRows || []).map((r: any) => ({ ...(r.skills as any), type: 'skill' })).filter(Boolean)
    const interests = (interestRows || []).map((r: any) => ({ ...(r.interests as any), type: 'interest' })).filter(Boolean)
    const tags = [...skills, ...interests]

    // Series navigation
    let seriesArticles: any[] = []
    if (article.series_name && article.author_uuid) {
      const { data } = await supabase
        .from('articles')
        .select('id, title, series_order')
        .eq('author_uuid', article.author_uuid)
        .eq('series_name', article.series_name)
        .eq('status', 'published')
        .is('deleted_at', null)
        .order('series_order', { ascending: true })
      seriesArticles = data || []
    }

    // Related articles (skill + interest overlap)
    let related: any[] = []
    if (skills.length) {
      const skillIds = skills.map((s: any) => s.id)
      const { data: relatedRows } = await supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, article_type, author_uuid, author_type, company_id, guest_author_name')
        .eq('status', 'published')
        .is('deleted_at', null)
        .neq('id', articleId)
        .in('id',
          (await supabase
            .from('article_skills')
            .select('article_id')
            .in('skill_id', skillIds)
          ).data?.map((r: any) => r.article_id) || []
        )
        .order('published_at', { ascending: false })
        .limit(5)
      related = relatedRows || []
    }

    // More from author
    let moreFromAuthor: any[] = []
    if (article.author_uuid) {
      const { data } = await supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at')
        .eq('author_uuid', article.author_uuid)
        .eq('status', 'published')
        .is('deleted_at', null)
        .neq('id', articleId)
        .order('published_at', { ascending: false })
        .limit(3)
      moreFromAuthor = data || []
    }

    // View count
    const { count: viewCount } = await supabaseAdmin
      .from('article_impressions')
      .select('*', { count: 'exact', head: true })
      .eq('article_id', articleId)

    const enriched = await enrichArticle(article, supabase)

    return c.json({
      article: { ...enriched, skills, interests, tags, view_count: viewCount || 0 },
      series: seriesArticles,
      related,
      more_from_author: moreFromAuthor,
    })
  } catch (err) {
    console.error('GET /articles/:id error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles — create draft ───────────────────────────────────────────

app.post('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const { title = '', content = '', cover_image_url, company_id, skill_ids = [], interest_ids = [], series_name, series_order, article_type } = await c.req.json()

  const sanitized = sanitizeHtml(content)
  const plain = stripHtml(sanitized)
  const isAdmin = (user as any).app_metadata?.is_admin === true
  const resolvedType = isAdmin && article_type === 'news' ? 'news' : 'article'

  try {
    const { data: article, error } = await supabase
      .from('articles')
      .insert({
        author_uuid: user.id,
        company_id: company_id || null,
        author_type: 'user',
        title,
        content: sanitized,
        content_plain: plain,
        cover_image_url: cover_image_url || null,
        series_name: series_name || null,
        series_order: series_order || null,
        article_type: resolvedType,
        status: 'draft',
      })
      .select('id')
      .single()

    if (error) throw error

    const inserts: Promise<any>[] = []
    if (skill_ids.length && article) {
      inserts.push(supabase.from('article_skills').insert(
        skill_ids.map((sid: number) => ({ article_id: article.id, skill_id: sid }))
      ))
    }
    if (interest_ids.length && article) {
      inserts.push(supabase.from('article_interests').insert(
        interest_ids.map((iid: number) => ({ article_id: article.id, interest_id: iid }))
      ))
    }
    await Promise.all(inserts)

    return c.json({ article })
  } catch (err) {
    console.error('POST /articles error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── PUT /articles/:id — update ──────────────────────────────────────────────

app.put('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  const { title, content, cover_image_url, company_id, skill_ids, interest_ids, series_name, series_order, article_type } = await c.req.json()

  try {
    // Verify ownership
    const { data: existing } = await supabase
      .from('articles')
      .select('id, author_uuid, company_id')
      .eq('id', articleId)
      .is('deleted_at', null)
      .maybeSingle()

    if (!existing) return c.json({ error: 'Not found' }, 404)

    const isOwner = existing.author_uuid === user.id ||
      (existing.company_id && (await supabase
        .from('companies')
        .select('id')
        .eq('id', existing.company_id)
        .eq('owner_uuid', user.id)
        .maybeSingle()
      ).data)

    if (!isOwner) return c.json({ error: 'Forbidden' }, 403)

    const isAdminUpdate = (user as any).app_metadata?.is_admin === true

    const updates: Record<string, any> = { updated_at: new Date().toISOString() }
    if (title !== undefined) updates.title = title
    if (content !== undefined) {
      updates.content = sanitizeHtml(content)
      updates.content_plain = stripHtml(updates.content)
      updates.read_time = Math.max(1, Math.ceil(wordCount(updates.content_plain) / 200))
    }
    if (cover_image_url !== undefined) updates.cover_image_url = cover_image_url
    if (company_id !== undefined) updates.company_id = company_id || null
    if (series_name !== undefined) updates.series_name = series_name || null
    if (series_order !== undefined) updates.series_order = series_order || null
    if (article_type !== undefined && isAdminUpdate) {
      updates.article_type = article_type === 'news' ? 'news' : 'article'
    }

    const { error } = await supabase.from('articles').update(updates).eq('id', articleId)
    if (error) throw error

    // Replace tags if provided
    const tagUpdates: Promise<any>[] = []
    if (skill_ids !== undefined) {
      tagUpdates.push(
        supabase.from('article_skills').delete().eq('article_id', articleId).then(() =>
          skill_ids.length
            ? supabase.from('article_skills').insert(skill_ids.map((sid: number) => ({ article_id: articleId, skill_id: sid })))
            : Promise.resolve()
        )
      )
    }
    if (interest_ids !== undefined) {
      tagUpdates.push(
        supabase.from('article_interests').delete().eq('article_id', articleId).then(() =>
          interest_ids.length
            ? supabase.from('article_interests').insert(interest_ids.map((iid: number) => ({ article_id: articleId, interest_id: iid })))
            : Promise.resolve()
        )
      )
    }
    await Promise.all(tagUpdates)

    return c.json({ success: true })
  } catch (err) {
    console.error('PUT /articles/:id error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/publish ───────────────────────────────────────────────

app.post('/:id/publish', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article } = await supabase
      .from('articles')
      .select('id, author_uuid, company_id, title, content_plain, cover_image_url, status')
      .eq('id', articleId)
      .is('deleted_at', null)
      .maybeSingle()

    if (!article) return c.json({ error: 'Not found' }, 404)

    const isOwner = article.author_uuid === user.id
    if (!isOwner) return c.json({ error: 'Forbidden' }, 403)

    if (article.status === 'published') return c.json({ success: true })

    // Validate minimum quality
    if (!article.title?.trim()) return c.json({ error: 'Title is required' }, 400)
    if (!article.cover_image_url) return c.json({ error: 'Cover image is required' }, 400)
    const words = wordCount(article.content_plain || '')
    if (words < 100) return c.json({ error: `Article too short (${words} words, minimum 100)` }, 400)

    const excerpt = buildExcerpt(article.content_plain || '')
    const rt = Math.max(1, Math.ceil(words / 200))

    const { error } = await supabase
      .from('articles')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        excerpt,
        read_time: rt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', articleId)

    if (error) throw error

    // Notify author's personal followers
    const { data: authorFollowers } = await supabase
      .from('article_author_follows')
      .select('follower_uuid')
      .eq('author_uuid', article.author_uuid)

    const authorFollowerIds = new Set((authorFollowers ?? []).map((f: any) => f.follower_uuid))

    const authorNotifications = (authorFollowers ?? [])
      .filter((f: any) => f.follower_uuid !== user.id)
      .map((f: any) => ({
        user_id: f.follower_uuid,
        actor_id: user.id,
        target_id: articleId,
        type: 'NEW_ARTICLE',
        count: 1,
        is_read: false,
      }))

    try {
      if (authorNotifications.length > 0) {
        await supabase.from('notifications').insert(authorNotifications)
      }
    } catch (e) {
      console.error('[NEW_ARTICLE] notification insert failed:', e)
    }

    // Notify company followers (excluding those already notified as author followers)
    if (article.company_id) {
      const { data: companyFollowers } = await supabase
        .from('article_company_follows')
        .select('follower_uuid')
        .eq('company_id', article.company_id)

      const companyNotifications = (companyFollowers ?? [])
        .filter((f: any) => f.follower_uuid !== user.id && !authorFollowerIds.has(f.follower_uuid))
        .map((f: any) => ({
          user_id: f.follower_uuid,
          actor_id: user.id,
          target_id: articleId,
          type: 'NEW_COMPANY_ARTICLE',
          count: 1,
          is_read: false,
        }))

      try {
        if (companyNotifications.length > 0) {
          await supabase.from('notifications').insert(companyNotifications)
        }
      } catch (e) {
        console.error('[NEW_COMPANY_ARTICLE] notification insert failed:', e)
      }
    }

    return c.json({ success: true })
  } catch (err) {
    console.error('POST /articles/:id/publish error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/unpublish ────────────────────────────────────────────

app.post('/:id/unpublish', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article, error: fetchErr } = await supabase
      .from('articles')
      .select('author_uuid, company_id')
      .eq('id', articleId)
      .single()

    if (fetchErr || !article) return c.json({ error: 'Not found' }, 404)

    const isOwner = article.author_uuid === user.id
    if (!isOwner) return c.json({ error: 'Forbidden' }, 403)

    const { error } = await supabase
      .from('articles')
      .update({ status: 'draft', published_at: null, updated_at: new Date().toISOString() })
      .eq('id', articleId)

    if (error) throw error
    return c.json({ success: true })
  } catch (err) {
    console.error('POST /articles/:id/unpublish error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/pin ───────────────────────────────────────────────────

app.post('/:id/pin', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article } = await supabase
      .from('articles')
      .select('id, author_uuid, is_pinned')
      .eq('id', articleId)
      .maybeSingle()

    if (!article || article.author_uuid !== user.id) return c.json({ error: 'Forbidden' }, 403)

    // Unpin all other articles from this author first
    if (!article.is_pinned) {
      await supabase
        .from('articles')
        .update({ is_pinned: false })
        .eq('author_uuid', user.id)
        .eq('is_pinned', true)
    }

    const { error } = await supabase
      .from('articles')
      .update({ is_pinned: !article.is_pinned })
      .eq('id', articleId)

    if (error) throw error
    return c.json({ is_pinned: !article.is_pinned })
  } catch (err) {
    console.error('POST /articles/:id/pin error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/editors-pick — admin only ────────────────────────────

app.post('/:id/editors-pick', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  // Admin check via app_metadata
  const isAdmin = (user as any).app_metadata?.is_admin === true
  if (!isAdmin) return c.json({ error: 'Forbidden' }, 403)

  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article } = await supabase
      .from('articles')
      .select('id, is_editors_pick')
      .eq('id', articleId)
      .maybeSingle()

    if (!article) return c.json({ error: 'Not found' }, 404)

    const { error } = await supabase
      .from('articles')
      .update({ is_editors_pick: !article.is_editors_pick })
      .eq('id', articleId)

    if (error) throw error
    return c.json({ is_editors_pick: !article.is_editors_pick })
  } catch (err) {
    console.error('POST /articles/:id/editors-pick error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── DELETE /articles/:id — soft delete ──────────────────────────────────────

app.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data: article } = await supabase
      .from('articles')
      .select('id, author_uuid')
      .eq('id', articleId)
      .maybeSingle()

    if (!article || article.author_uuid !== user.id) return c.json({ error: 'Forbidden' }, 403)

    const { error } = await supabase
      .from('articles')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', articleId)

    if (error) throw error
    return c.json({ success: true })
  } catch (err) {
    console.error('DELETE /articles/:id error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/impression — dedup daily view ────────────────────────

app.post('/:id/impression', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    // Verify article exists and is published
    const { data: article } = await supabase
      .from('articles')
      .select('id, author_uuid')
      .eq('id', articleId)
      .eq('status', 'published')
      .is('deleted_at', null)
      .maybeSingle()

    if (!article) return c.json({ success: false })

    // Don't count self-views
    if (article.author_uuid === user.id) return c.json({ success: false })

    const today = new Date().toISOString().slice(0, 10)
    await supabase
      .from('article_impressions')
      .upsert(
        { article_id: articleId, user_id: user.id, impression_date: today },
        { onConflict: 'article_id,user_id,impression_date', ignoreDuplicates: true }
      )

    return c.json({ success: true })
  } catch (err) {
    console.error('POST /articles/:id/impression error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── GET /articles/:id/comments ───────────────────────────────────────────────

app.get('/:id/comments', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  try {
    const { data, error } = await supabase
      .from('article_comments')
      .select('id, content, created_at, author_uuid')
      .eq('article_id', articleId)
      .order('created_at', { ascending: true })

    if (error) throw error

    const authorUuids = [...new Set((data || []).map((c: any) => c.author_uuid))]
    let userMap: Record<string, any> = {}
    if (authorUuids.length) {
      const { data: users } = await supabase
        .from('public_users_view')
        .select('uuid, first_name, last_name, image')
        .in('uuid', authorUuids)
      for (const u of users || []) {
        userMap[u.uuid] = { id: u.uuid, first_name: u.first_name, last_name: u.last_name, profile_image_url: u.image || null }
      }
    }

    const comments = (data || []).map((c: any) => ({
      ...c,
      users: userMap[c.author_uuid] || null,
    }))

    return c.json({ comments })
  } catch (err) {
    console.error('GET /articles/:id/comments error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── POST /articles/:id/comments ─────────────────────────────────────────────

app.post('/:id/comments', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const articleId = c.req.param('id')

  const { content } = await c.req.json()
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)

  try {
    const { data: comment, error } = await supabase
      .from('article_comments')
      .insert({ article_id: articleId, author_uuid: user.id, content: content.trim() })
      .select('id, content, created_at, author_uuid')
      .single()

    if (error) throw error

    // Enrich with user data
    const { data: authorData } = await supabase
      .from('public_users_view')
      .select('uuid, first_name, last_name, image')
      .eq('uuid', user.id)
      .maybeSingle()
    const enrichedComment = {
      ...comment,
      users: authorData ? { id: authorData.uuid, first_name: authorData.first_name, last_name: authorData.last_name, profile_image_url: authorData.image || null } : null,
    }

    return c.json({ comment: enrichedComment })
  } catch (err) {
    console.error('POST /articles/:id/comments error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── DELETE /articles/:id/comments/:commentId ────────────────────────────────

app.delete('/:id/comments/:commentId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  try {
    const { error } = await supabase
      .from('article_comments')
      .delete()
      .eq('id', c.req.param('commentId'))
      .eq('author_uuid', user.id)

    if (error) throw error
    return c.json({ success: true })
  } catch (err) {
    console.error('DELETE /articles/:id/comments/:commentId error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export default app

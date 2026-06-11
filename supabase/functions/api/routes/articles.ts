// supabase/functions/api/routes/articles.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'

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

/** Inline author join for articles list */
async function enrichArticle(article: any, supabase: any) {
  if (article.author_type === 'guest') return article

  // Fetch author info — user or company
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

// ─── GET /articles/filter-tags — smart tag list for the filter bar ────────────

app.get('/filter-tags', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 40)

  try {
    const { data, error } = await supabase.rpc('get_article_filter_tags', {
      p_limit: limit,
    })
    if (error) throw error
    return c.json({ tags: data || [] })
  } catch (err) {
    console.error('GET /articles/filter-tags error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

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

// ─── GET /articles — published feed (cursor-based pagination) ─────────────────

app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)
  const supabase = c.get('supabase')

  const skillId    = c.req.query('skill_id')
  const interestId = c.req.query('interest_id')
  const cursor     = c.req.query('cursor')          // format: "published_at__id"
  const limit      = Math.min(parseInt(c.req.query('limit') || '20'), 50)

  try {
    let query = supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url, is_editors_pick')
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (skillId) {
      const { data: tagIds } = await supabase
        .from('article_skills')
        .select('article_id')
        .eq('skill_id', skillId)
      const ids = (tagIds || []).map((r: any) => r.article_id)
      if (!ids.length) return c.json({ articles: [], nextCursor: null })
      query = query.in('id', ids)
    }

    if (interestId) {
      const { data: tagIds } = await supabase
        .from('article_interests')
        .select('article_id')
        .eq('interest_id', interestId)
      const ids = (tagIds || []).map((r: any) => r.article_id)
      if (!ids.length) return c.json({ articles: [], nextCursor: null })
      query = query.in('id', ids)
    }

    if (cursor) {
      const [cursorDate, cursorId] = cursor.split('__')
      query = query.or(`published_at.lt.${cursorDate},and(published_at.eq.${cursorDate},id.lt.${cursorId})`)
    }

    const { data, error } = await query
    if (error) throw error

    const hasMore = data.length > limit
    const raw = hasMore ? data.slice(0, limit) : data
    const last = raw[raw.length - 1]
    const nextCursor = hasMore && last
      ? `${last.published_at}__${last.id}`
      : null

    const articleIds = raw.map((a: any) => String(a.id))
    const [enrichedArticles, tagsMap] = await Promise.all([
      Promise.all(raw.map((a: any) => enrichArticle(a, supabase))),
      batchFetchTags(articleIds, supabase),
    ])
    const articles = enrichedArticles.map((a: any) => ({ ...a, tags: tagsMap[a.id] || [] }))

    return c.json({ articles, nextCursor })
  } catch (err) {
    console.error('GET /articles error:', err)
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

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, excerpt, cover_image_url, read_time, published_at, author_uuid, author_type, company_id, guest_author_name')
      .eq('status', 'published')
      .is('deleted_at', null)
      .textSearch('title', q, { type: 'websearch', config: 'simple' })
      .order('published_at', { ascending: false })
      .limit(20)

    if (error) throw error
    return c.json({ articles: data || [] })
  } catch (err) {
    console.error('GET /articles/search error:', err)
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
      .select('id, title, excerpt, cover_image_url, read_time, published_at, author_uuid, author_type, company_id, guest_author_name, guest_author_avatar_url')
      .eq('status', 'published')
      .eq('is_editors_pick', true)
      .is('deleted_at', null)
      .order('published_at', { ascending: false })
      .limit(6)

    if (error) throw error
    const articles = await Promise.all((data || []).map((a: any) => enrichArticle(a, supabase)))
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
      .select('id, title, status, cover_image_url, read_time, published_at, updated_at, is_pinned, series_name, series_order')
      .eq('author_uuid', user.id)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })

    if (error) throw error

    // Attach view counts and reaction/comment counts for analytics
    const articleIds = (data || []).map((a: any) => a.id)
    let viewCounts: Record<string, number> = {}
    let commentCounts: Record<string, number> = {}

    if (articleIds.length) {
      const { data: impressions } = await supabase
        .from('article_impressions')
        .select('article_id')
        .in('article_id', articleIds)
      for (const row of impressions || []) {
        viewCounts[row.article_id] = (viewCounts[row.article_id] || 0) + 1
      }

      const { data: comments } = await supabase
        .from('article_comments')
        .select('article_id')
        .in('article_id', articleIds)
      for (const row of comments || []) {
        commentCounts[row.article_id] = (commentCounts[row.article_id] || 0) + 1
      }
    }

    const enriched = (data || []).map((a: any) => ({
      ...a,
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
    const [articlesRes, profileRes, impressionsRes, authorRes] = await Promise.all([
      supabase
        .from('articles')
        .select('id, title, excerpt, cover_image_url, read_time, published_at, is_pinned, series_name')
        .eq('author_uuid', userId)
        .eq('status', 'published')
        .is('deleted_at', null)
        .order('is_pinned', { ascending: false })
        .order('published_at', { ascending: false }),
      supabase
        .from('article_author_profiles')
        .select('writing_bio')
        .eq('author_uuid', userId)
        .maybeSingle(),
      supabase
        .from('article_impressions')
        .select('article_id')
        .in('article_id',
          (await supabase
            .from('articles')
            .select('id')
            .eq('author_uuid', userId)
            .eq('status', 'published')
            .is('deleted_at', null)
          ).data?.map((a: any) => a.id) || []
        ),
      supabase
        .from('public_users_view')
        .select('uuid, first_name, last_name, image, headline')
        .eq('uuid', userId)
        .maybeSingle(),
    ])

    // Top skills from this author's articles
    const articleIds = (articlesRes.data || []).map((a: any) => a.id)
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
        .slice(0, 5)
        .map(({ skill }) => skill)
    }

    const u = authorRes.data
    return c.json({
      articles: articlesRes.data || [],
      writing_bio: profileRes.data?.writing_bio || null,
      top_skills: topSkills,
      author: u ? {
        id: u.uuid,
        first_name: u.first_name,
        last_name: u.last_name,
        has_image: !!u.image,
        headline: u.headline,
      } : null,
      stats: {
        article_count: (articlesRes.data || []).length,
        total_views: (impressionsRes.data || []).length,
      },
    })
  } catch (err) {
    console.error('GET /articles/user/:userId error:', err)
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
        .select('id, title, excerpt, cover_image_url, read_time, published_at, author_uuid, author_type, company_id, guest_author_name')
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
    const { count: viewCount } = await supabase
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

  const { title = '', content = '', cover_image_url, company_id, skill_ids = [], interest_ids = [], series_name, series_order } = await c.req.json()

  const sanitized = sanitizeHtml(content)
  const plain = stripHtml(sanitized)

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

  const { title, content, cover_image_url, company_id, skill_ids, interest_ids, series_name, series_order } = await c.req.json()

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

    const updates: Record<string, any> = { updated_at: new Date().toISOString() }
    if (title !== undefined) updates.title = title
    if (content !== undefined) {
      updates.content = sanitizeHtml(content)
      updates.content_plain = stripHtml(updates.content)
    }
    if (cover_image_url !== undefined) updates.cover_image_url = cover_image_url
    if (company_id !== undefined) updates.company_id = company_id || null
    if (series_name !== undefined) updates.series_name = series_name || null
    if (series_order !== undefined) updates.series_order = series_order || null

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
    return c.json({ success: true })
  } catch (err) {
    console.error('POST /articles/:id/publish error:', err)
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
      .select('id, content, created_at, author_uuid, users(id, first_name, last_name, profile_image_url)')
      .eq('article_id', articleId)
      .order('created_at', { ascending: true })

    if (error) throw error
    return c.json({ comments: data || [] })
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

    // Notify article author (skip self-comment)
    const { data: article } = await supabase
      .from('articles')
      .select('author_uuid')
      .eq('id', articleId)
      .maybeSingle()

    if (article?.author_uuid && article.author_uuid !== user.id) {
      await supabase.from('notifications').insert({
        user_id: article.author_uuid,
        actor_id: user.id,
        target_id: String(articleId),
        type: 'ARTICLE_COMMENT',
        is_read: false,
      })
    }

    return c.json({ comment })
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

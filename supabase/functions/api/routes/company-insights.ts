import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const app = new Hono()

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )
}

function paginate(page: number, limit: number) {
  const from = (page - 1) * limit
  return { from, to: from + limit - 1 }
}

async function enrichAuthors(supabase: any, rows: any[], isAnonymousKey = 'is_anonymous') {
  const ids = [...new Set(
    rows.filter((r: any) => !r[isAnonymousKey]).map((r: any) => r.user_id)
  )]
  if (ids.length === 0) return new Map()
  const { data } = await supabase
    .from('public_users_view')
    .select('uuid, first_name, last_name')
    .in('uuid', ids)
  return new Map((data ?? []).map((u: any) => [u.uuid, u]))
}

function withAuthor(row: any, usersById: Map<string, any>, currentUserId?: string | null) {
  const { user_id, ...rest } = row
  return {
    ...rest,
    author: rest.is_anonymous ? null : (usersById.get(user_id) ?? null),
    is_mine: currentUserId ? user_id === currentUserId : false,
  }
}

async function singleAuthor(admin: any, userId: string, isAnonymous: boolean) {
  if (isAnonymous) return null
  const { data: u } = await admin
    .from('public_users_view')
    .select('uuid, first_name, last_name')
    .eq('uuid', userId)
    .single()
  return u ?? null
}

// ─── My Contributions ────────────────────────────────────────────────────────

app.get('/mine', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ company_ids: [] })

  const supabase = c.get('supabase')
  const [reviews, fit, salaries, interviews] = await Promise.all([
    supabase.from('company_reviews').select('company_id').eq('user_id', user.id),
    supabase.from('company_fit').select('company_id').eq('user_id', user.id),
    supabase.from('company_salaries').select('company_id').eq('user_id', user.id),
    supabase.from('company_interviews').select('company_id').eq('user_id', user.id),
  ])

  const all = [
    ...(reviews.data ?? []),
    ...(fit.data ?? []),
    ...(salaries.data ?? []),
    ...(interviews.data ?? []),
  ]
  const company_ids = [...new Set(all.map((r: any) => r.company_id))]
  return c.json({ company_ids })
})

// ─── Reviews ────────────────────────────────────────────────────────────────

app.get('/:companyId/reviews', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const currentUserId = user?.id ?? null
  const companyId = parseInt(c.req.param('companyId'))
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const { from, to } = paginate(page, limit)

  const [{ data, error, count }, { data: allRows }] = await Promise.all([
    supabase
      .from('company_reviews')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(from, to),
    supabase
      .from('company_reviews')
      .select('overall_rating, work_life_balance_rating, culture_rating, management_rating, recommend')
      .eq('company_id', companyId),
  ])

  if (error) return c.json({ error: error.message }, 400)

  const rows = data ?? []
  const all = allRows ?? []
  const usersById = await enrichAuthors(supabase, rows)

  const total = count ?? 0
  const avg = (key: string) => {
    const vals = all.map((r: any) => r[key]).filter((v: any) => v !== null)
    return vals.length ? Math.round((vals.reduce((s: number, v: number) => s + v, 0) / vals.length) * 10) / 10 : null
  }

  const summary = {
    count: total,
    avg_overall: avg('overall_rating') ?? 0,
    avg_work_life_balance: avg('work_life_balance_rating'),
    avg_culture: avg('culture_rating'),
    avg_management: avg('management_rating'),
    recommend_pct: all.length
      ? Math.round((all.filter((r: any) => r.recommend).length / all.length) * 100)
      : 0,
  }

  return c.json({
    data: rows.map((r: any) => withAuthor(r, usersById, currentUserId)),
    summary,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

app.post('/:companyId/reviews', async (c) => {
  const user = c.get('user')
  const companyId = parseInt(c.req.param('companyId'))
  const body = await c.req.json()

  const { title, job_title, pros, cons, overall_rating,
    work_life_balance_rating, culture_rating, management_rating,
    recommend, is_anonymous } = body

  if (!title?.trim() || !pros?.trim() || !cons?.trim() || !overall_rating) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const admin = adminClient()
  const { data, error } = await admin
    .from('company_reviews')
    .insert({
      company_id: companyId,
      user_id: user.id,
      title: title.trim(),
      job_title: job_title?.trim() || null,
      pros: pros.trim(),
      cons: cons.trim(),
      overall_rating,
      work_life_balance_rating: work_life_balance_rating ?? null,
      culture_rating: culture_rating ?? null,
      management_rating: management_rating ?? null,
      recommend: recommend ?? false,
      is_anonymous: is_anonymous ?? false,
    })
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ id: data.id, item: { ...item, author, is_mine: true } }, 201)
})

app.put('/:companyId/reviews/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json()
  const { title, job_title, pros, cons, overall_rating,
    work_life_balance_rating, culture_rating, management_rating,
    recommend, is_anonymous } = body

  if (!title?.trim() || !pros?.trim() || !cons?.trim() || !overall_rating)
    return c.json({ error: 'Missing required fields' }, 400)

  const admin = adminClient()
  const { data: existing } = await admin.from('company_reviews').select('user_id').eq('id', id).single()
  if (!existing || existing.user_id !== user.id) return c.json({ error: 'Not found' }, 404)

  const { data, error } = await admin.from('company_reviews')
    .update({
      title: title.trim(), job_title: job_title?.trim() || null,
      pros: pros.trim(), cons: cons.trim(), overall_rating,
      work_life_balance_rating: work_life_balance_rating ?? null,
      culture_rating: culture_rating ?? null,
      management_rating: management_rating ?? null,
      recommend: recommend ?? false, is_anonymous: is_anonymous ?? false,
    })
    .eq('id', id).select('*').single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ item: { ...item, author, is_mine: true } })
})

app.delete('/:companyId/reviews/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const admin = adminClient()
  const { data: row } = await admin.from('company_reviews').select('user_id').eq('id', id).single()
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('company_reviews').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

// ─── Fit Ratings ─────────────────────────────────────────────────────────────

app.get('/:companyId/fit', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const currentUserId = user?.id ?? null
  const companyId = parseInt(c.req.param('companyId'))
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const { from, to } = paginate(page, limit)

  const [{ data, error, count }, { data: allRows }] = await Promise.all([
    supabase
      .from('company_fit_ratings')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(from, to),
    supabase
      .from('company_fit_ratings')
      .select('overall_fit_rating, modesty_rating, friday_hours_rating, holiday_flexibility_rating, separate_workspace_rating, kosher_kitchen_rating')
      .eq('company_id', companyId),
  ])

  if (error) return c.json({ error: error.message }, 400)

  const rows = data ?? []
  const all = allRows ?? []
  const usersById = await enrichAuthors(supabase, rows)

  const total = count ?? 0
  const avg = (key: string) => {
    const vals = all.map((r: any) => r[key]).filter((v: any) => v !== null)
    return vals.length ? Math.round((vals.reduce((s: number, v: number) => s + v, 0) / vals.length) * 10) / 10 : null
  }

  const summary = {
    count: total,
    avg_overall: avg('overall_fit_rating') ?? 0,
    avg_modesty: avg('modesty_rating'),
    avg_friday_hours: avg('friday_hours_rating'),
    avg_holiday_flexibility: avg('holiday_flexibility_rating'),
    avg_separate_workspace: avg('separate_workspace_rating'),
    avg_kosher_kitchen: avg('kosher_kitchen_rating'),
  }

  return c.json({
    data: rows.map((r: any) => withAuthor(r, usersById, currentUserId)),
    summary,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

app.post('/:companyId/fit', async (c) => {
  const user = c.get('user')
  const companyId = parseInt(c.req.param('companyId'))
  const body = await c.req.json()

  const { overall_fit_rating, modesty_rating, friday_hours_rating,
    holiday_flexibility_rating, separate_workspace_rating,
    kosher_kitchen_rating, notes, is_anonymous } = body

  if (!overall_fit_rating) {
    return c.json({ error: 'overall_fit_rating is required' }, 400)
  }

  const admin = adminClient()
  const { data, error } = await admin
    .from('company_fit_ratings')
    .insert({
      company_id: companyId,
      user_id: user.id,
      overall_fit_rating,
      modesty_rating: modesty_rating ?? null,
      friday_hours_rating: friday_hours_rating ?? null,
      holiday_flexibility_rating: holiday_flexibility_rating ?? null,
      separate_workspace_rating: separate_workspace_rating ?? null,
      kosher_kitchen_rating: kosher_kitchen_rating ?? null,
      notes: notes?.trim() || null,
      is_anonymous: is_anonymous ?? false,
    })
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ id: data.id, item: { ...item, author, is_mine: true } }, 201)
})

app.put('/:companyId/fit/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json()
  const { overall_fit_rating, modesty_rating, friday_hours_rating,
    holiday_flexibility_rating, separate_workspace_rating,
    kosher_kitchen_rating, notes, is_anonymous } = body

  if (!overall_fit_rating) return c.json({ error: 'overall_fit_rating is required' }, 400)

  const admin = adminClient()
  const { data: existing } = await admin.from('company_fit_ratings').select('user_id').eq('id', id).single()
  if (!existing || existing.user_id !== user.id) return c.json({ error: 'Not found' }, 404)

  const { data, error } = await admin.from('company_fit_ratings')
    .update({
      overall_fit_rating,
      modesty_rating: modesty_rating ?? null,
      friday_hours_rating: friday_hours_rating ?? null,
      holiday_flexibility_rating: holiday_flexibility_rating ?? null,
      separate_workspace_rating: separate_workspace_rating ?? null,
      kosher_kitchen_rating: kosher_kitchen_rating ?? null,
      notes: notes?.trim() || null,
      is_anonymous: is_anonymous ?? false,
    })
    .eq('id', id).select('*').single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ item: { ...item, author, is_mine: true } })
})

app.delete('/:companyId/fit/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const admin = adminClient()
  const { data: row } = await admin.from('company_fit_ratings').select('user_id').eq('id', id).single()
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('company_fit_ratings').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

// ─── Salaries ────────────────────────────────────────────────────────────────

app.get('/:companyId/salaries', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const currentUserId = user?.id ?? null
  const companyId = parseInt(c.req.param('companyId'))
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const { from, to } = paginate(page, limit)

  const { data, error, count } = await supabase
    .from('company_salaries')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (error) return c.json({ error: error.message }, 400)

  const rows = data ?? []
  const usersById = await enrichAuthors(supabase, rows)
  const total = count ?? 0

  return c.json({
    data: rows.map((r: any) => withAuthor(r, usersById, currentUserId)),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

app.post('/:companyId/salaries', async (c) => {
  const user = c.get('user')
  const companyId = parseInt(c.req.param('companyId'))
  const body = await c.req.json()

  const { job_title, salary_min, salary_max, currency,
    employment_type, experience_years, is_anonymous } = body

  if (!job_title?.trim() || !salary_min || !salary_max) {
    return c.json({ error: 'Missing required fields' }, 400)
  }
  if (salary_min > salary_max) {
    return c.json({ error: 'salary_min must be <= salary_max' }, 400)
  }

  const admin = adminClient()
  const { data, error } = await admin
    .from('company_salaries')
    .insert({
      company_id: companyId,
      user_id: user.id,
      job_title: job_title.trim(),
      salary_min,
      salary_max,
      currency: currency ?? 'ILS',
      employment_type: employment_type ?? null,
      experience_years: experience_years ?? null,
      is_anonymous: is_anonymous ?? false,
    })
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ id: data.id, item: { ...item, author, is_mine: true } }, 201)
})

app.put('/:companyId/salaries/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json()
  const { job_title, salary_min, salary_max, currency, employment_type, experience_years, is_anonymous } = body

  if (!job_title?.trim() || !salary_min || !salary_max) return c.json({ error: 'Missing required fields' }, 400)
  if (salary_min > salary_max) return c.json({ error: 'salary_min must be <= salary_max' }, 400)

  const admin = adminClient()
  const { data: existing } = await admin.from('company_salaries').select('user_id').eq('id', id).single()
  if (!existing || existing.user_id !== user.id) return c.json({ error: 'Not found' }, 404)

  const { data, error } = await admin.from('company_salaries')
    .update({
      job_title: job_title.trim(), salary_min, salary_max,
      currency: currency ?? 'ILS', employment_type: employment_type ?? null,
      experience_years: experience_years ?? null, is_anonymous: is_anonymous ?? false,
    })
    .eq('id', id).select('*').single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ item: { ...item, author, is_mine: true } })
})

app.delete('/:companyId/salaries/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const admin = adminClient()
  const { data: row } = await admin.from('company_salaries').select('user_id').eq('id', id).single()
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('company_salaries').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

// ─── Interviews ───────────────────────────────────────────────────────────────

app.get('/:companyId/interviews', async (c) => {
  const supabase = c.get('supabase')
  const user = c.get('user')
  const currentUserId = user?.id ?? null
  const companyId = parseInt(c.req.param('companyId'))
  const page = parseInt(c.req.query('page') || '1')
  const limit = parseInt(c.req.query('limit') || '10')
  const { from, to } = paginate(page, limit)

  const [{ data, error, count }, { data: allRows }] = await Promise.all([
    supabase
      .from('company_interviews')
      .select('*', { count: 'exact' })
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(from, to),
    supabase
      .from('company_interviews')
      .select('difficulty, outcome')
      .eq('company_id', companyId),
  ])

  if (error) return c.json({ error: error.message }, 400)

  const rows = data ?? []
  const all = allRows ?? []
  const usersById = await enrichAuthors(supabase, rows)

  const total = count ?? 0
  const diffVals = all.map((r: any) => r.difficulty).filter((v: any) => v !== null)
  const avg_difficulty = diffVals.length
    ? Math.round((diffVals.reduce((s: number, v: number) => s + v, 0) / diffVals.length) * 10) / 10
    : 0

  const summary = {
    count: total,
    avg_difficulty,
    outcome_counts: {
      offer: all.filter((r: any) => r.outcome === 'offer').length,
      rejected: all.filter((r: any) => r.outcome === 'rejected').length,
      pending: all.filter((r: any) => r.outcome === 'pending').length,
    },
  }

  return c.json({
    data: rows.map((r: any) => withAuthor(r, usersById, currentUserId)),
    summary,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  })
})

app.post('/:companyId/interviews', async (c) => {
  const user = c.get('user')
  const companyId = parseInt(c.req.param('companyId'))
  const body = await c.req.json()

  const { job_title, difficulty, outcome, pros, cons,
    process_description, questions, duration_weeks, is_anonymous } = body

  if (!job_title?.trim() || !difficulty || !outcome) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const admin = adminClient()
  const { data, error } = await admin
    .from('company_interviews')
    .insert({
      company_id: companyId,
      user_id: user.id,
      job_title: job_title.trim(),
      difficulty,
      outcome,
      pros: pros?.trim() || null,
      cons: cons?.trim() || null,
      process_description: process_description?.trim() || null,
      questions: Array.isArray(questions) && questions.length > 0 ? questions : null,
      duration_weeks: duration_weeks ?? null,
      is_anonymous: is_anonymous ?? false,
    })
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ id: data.id, item: { ...item, author, is_mine: true } }, 201)
})

app.put('/:companyId/interviews/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json()
  const { job_title, difficulty, outcome, pros, cons, process_description, questions, duration_weeks, is_anonymous } = body

  if (!job_title?.trim() || !difficulty || !outcome) return c.json({ error: 'Missing required fields' }, 400)

  const admin = adminClient()
  const { data: existing } = await admin.from('company_interviews').select('user_id').eq('id', id).single()
  if (!existing || existing.user_id !== user.id) return c.json({ error: 'Not found' }, 404)

  const { data, error } = await admin.from('company_interviews')
    .update({
      job_title: job_title.trim(), difficulty, outcome,
      pros: pros?.trim() || null, cons: cons?.trim() || null,
      process_description: process_description?.trim() || null,
      questions: Array.isArray(questions) && questions.length > 0 ? questions : null,
      duration_weeks: duration_weeks ?? null,
      is_anonymous: is_anonymous ?? false,
    })
    .eq('id', id).select('*').single()

  if (error) return c.json({ error: error.message }, 400)

  const author = await singleAuthor(admin, user.id, is_anonymous)
  const { user_id: _uid, ...item } = data
  return c.json({ item: { ...item, author, is_mine: true } })
})

app.delete('/:companyId/interviews/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const admin = adminClient()
  const { data: row } = await admin.from('company_interviews').select('user_id').eq('id', id).single()
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404)
  const { error } = await admin.from('company_interviews').delete().eq('id', id)
  if (error) return c.json({ error: error.message }, 400)
  return c.json({ success: true })
})

export default app

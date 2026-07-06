// supabase/functions/api/routes/public-profile.ts
//
// Unauthenticated routes — served to logged-out visitors outside the platform via a
// member's shared /in/<slug> link. NOT mounted behind authMiddleware's normal auth
// check (see the allowlist in middleware.ts).
//
// Security model: the `users` table has no RLS and grants nothing to `anon` — there is
// no way to read it at all without an authenticated JWT, by design. Rather than bypass
// that with the service-role admin client and re-implement field-masking in JS (which
// would make this Edge Function's application code the ONLY thing standing between the
// internet and a member's email/phone/last name), the masking is pushed into the
// database itself: `public_shared_profiles` (see add_public_profile_link.sql) is a view
// that already filters to public_profile_enabled rows and nulls out every field/section
// the owner hasn't opted into, based on their own public_profile_settings — then GRANTs
// SELECT to `anon`. This route reads that view with the anon key, not the service role,
// so even a bug here can't return more than the view already restricts.
//
// The service-role admin client is still used for two narrow, non-PII reads where no
// anon-readable path exists: (1) resolving a company id to its public name/logo for the
// experience list, and (2) the actual private-storage byte download for the avatar,
// itself re-gated by the same view's `has_image` flag before any download is attempted.
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { supabaseAdmin } from '../middleware.ts'

const app = new Hono()

const supabasePublic = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_ANON_KEY') ?? ''
)

const enrichExperience = async (experience: any[]) => {
  if (!Array.isArray(experience)) return []
  const companyIds = experience.map((exp) => exp.company).filter((id) => typeof id === 'number')
  if (companyIds.length === 0) return experience

  // Company name/logo isn't PII — fine via admin client; `companies` has no anon grant.
  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, logo, name')
    .in('id', companyIds)

  const companyMap = new Map((companies ?? []).map((co: any) => [co.id, co]))
  return experience.map((exp) =>
    typeof exp.company === 'number' && companyMap.has(exp.company)
      ? { ...exp, company: companyMap.get(exp.company) }
      : exp
  )
}

async function findSharedProfile(slug: string) {
  const { data } = await supabasePublic
    .from('public_shared_profiles')
    .select('*')
    .eq('slug', slug)
    .maybeSingle()
  return data ?? null
}

app.get('/:slug', async (c) => {
  try {
    const slug = c.req.param('slug')
    c.header('Cache-Control', 'no-store')
    if (!slug) return c.json({ error: 'Not found' }, 404)

    const row = await findSharedProfile(slug)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const publicProfile = {
      first_name: row.first_name,
      last_name: row.last_name,
      headline: row.headline ?? null,
      role: row.role || undefined,
      location: row.location,
      image: Boolean(row.has_image),
      cover_image_url: row.cover_image_url ?? null,
      contact_details: (row.email || row.phone) ? { email: row.email ?? null, phone: row.phone ?? null } : null,
      about: row.about,
      experience: await enrichExperience(row.experience ?? []),
      education: row.education ?? [],
      certifications: row.certifications ?? [],
      projects: await enrichExperience(row.projects ?? []),
      skills: row.skills ?? [],
      languages: row.languages ?? [],
      interests: row.interests ?? [],
      github_url: row.github_url ?? null,
      website_url: row.website_url ?? null,
    }

    return c.json(publicProfile)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Profile picture bytes — the `profile-images` storage bucket is private (proxied
// everywhere else via the role/grant-checked /api/avatar route). Eligibility is
// confirmed via the anon-readable masked view first; the service-role client is used
// only for the actual storage download, which a private bucket requires regardless.
app.get('/:slug/avatar', async (c) => {
  try {
    const slug = c.req.param('slug')
    if (!slug) return c.json({ error: 'Not found' }, 404)

    const row = await findSharedProfile(slug)
    if (!row || !row.has_image) return c.json({ error: 'No image set for user' }, 404)

    const { data: imageRow } = await supabaseAdmin
      .from('users')
      .select('image')
      .eq('public_profile_slug', slug)
      .eq('public_profile_enabled', true)
      .maybeSingle()

    if (!imageRow?.image) return c.json({ error: 'No image set for user' }, 404)

    const bucketName = 'profile-images'
    const splitPath = String(imageRow.image).split(`/${bucketName}/`)
    if (splitPath.length < 2) return c.json({ error: 'Invalid image URL' }, 500)

    const relativePath = decodeURIComponent(splitPath[1])
    const { data: fileData, error: downloadError } = await supabaseAdmin
      .storage
      .from(bucketName)
      .download(relativePath)

    if (downloadError) return c.json({ error: 'Image not found in storage' }, 404)

    const arrayBuffer = await fileData.arrayBuffer()
    return c.body(arrayBuffer, 200, {
      'Content-Type': fileData.type || 'image/jpeg',
      'Content-Length': arrayBuffer.byteLength.toString(),
      'Cache-Control': 'no-store',
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default app

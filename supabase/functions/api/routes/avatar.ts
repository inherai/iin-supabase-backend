// supabase/functions/api/routes/avatar.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { supabaseAdmin } from '../middleware.ts'

const app = new Hono()

// In-memory permission cache: "${viewerId}:${targetId}" → timestamp of last successful check
// Only caches GRANTED permissions — denials are never cached so that newly granted access
// takes effect on the next request without waiting for TTL expiry.
const permissionCache = new Map<string, number>();
const PERMISSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function checkPermission(
  viewerId: string,
  targetId: string,
  viewerRole: string,
  isAdmin: boolean
): Promise<boolean> {
  // Same-user always allowed
  if (viewerId === targetId) return true;

  const cacheKey = `${viewerId}:${targetId}`;
  const cachedAt = permissionCache.get(cacheKey);
  if (cachedAt && Date.now() - cachedAt < PERMISSION_TTL_MS) {
    return true; // cache only stores granted permissions
  }

  let allowed = false;

  const { data: rpcResult, error: rpcError } = await supabaseAdmin
    .rpc('can_view_profile_picture', {
      target_user_id: targetId,
      viewer_role: viewerRole
    });

  if (!rpcError && rpcResult === true) allowed = true;

  if (!allowed && viewerRole === 'recruiters') {
    const { data: profile } = await supabaseAdmin
      .from('public_users_view')
      .select('privacy_picture')
      .eq('uuid', targetId)
      .single();
    if (profile?.privacy_picture && Array.isArray(profile.privacy_picture) &&
        profile.privacy_picture.includes('recruiters')) {
      allowed = true;
    }
  }

  if (!allowed && (viewerRole === 'recruiters' || isAdmin)) {
    const { data: grant } = await supabaseAdmin
      .from('profile_access_requests')
      .select('approved_fields')
      .eq('recruiter_id', viewerId)
      .eq('candidate_id', targetId)
      .in('status', ['approved', 'partial'])
      .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
      .single();
    if (grant?.approved_fields?.includes('picture')) allowed = true;
  }

  // Cache only granted permissions — never denied ones.
  // Denial of a previously allowed request takes effect within TTL (acceptable).
  // Granting of a previously denied request takes effect immediately (required).
  if (allowed) permissionCache.set(cacheKey, Date.now());
  return allowed;
}

async function getImagePath(targetId: string): Promise<{ path: string; etag: string } | null> {
  const { data: userRecord, error } = await supabaseAdmin
    .from('users')
    .select('image')
    .eq('uuid', targetId)
    .single();

  if (error || !userRecord?.image) return null;

  const etag = `"${btoa(userRecord.image)}"`;
  return { path: userRecord.image, etag };
}

app.get('/', async (c) => {
  try {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const targetUserId = c.req.query('id');
    if (!targetUserId) return c.json({ error: 'Missing id parameter' }, 400);

    const viewerRole = user.app_metadata.role || 'guest';
    const isAdmin = user.app_metadata?.is_admin === true;

    const allowed = await checkPermission(user.id, targetUserId, viewerRole, isAdmin);
    if (!allowed) return c.json({ error: 'Access Denied' }, 403);

    const imageResult = await getImagePath(targetUserId);
    if (!imageResult) return c.json({ error: 'No image set for user' }, 404);

    const { path: imagePath, etag } = imageResult;

    const clientETag = c.req.header('If-None-Match');
    if (clientETag === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'private, max-age=300'
        }
      });
    }

    const bucketName = 'profile-images';
    const splitPath = imagePath.split(`/${bucketName}/`);
    if (splitPath.length < 2) return c.json({ error: 'Invalid image URL' }, 500);

    const relativePath = decodeURIComponent(splitPath[1]);
    const { data: fileData, error: downloadError } = await supabaseAdmin
      .storage
      .from(bucketName)
      .download(relativePath);

    if (downloadError) return c.json({ error: 'Image not found in storage' }, 404);

    const arrayBuffer = await fileData.arrayBuffer();
    return c.body(arrayBuffer, 200, {
      'Content-Type': fileData.type || 'image/jpeg',
      'Content-Length': arrayBuffer.byteLength.toString(),
      'Cache-Control': 'private, max-age=300',
      'ETag': etag
    });

  } catch (error) {
    console.error('Avatar Route Error:', error);
    return c.json({ error: error.message }, 500);
  }
})

export default app

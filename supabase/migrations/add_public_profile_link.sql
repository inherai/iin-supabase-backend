-- Public, shareable profile link (e.g. duallin.com/in/<slug>) — opt-in, off by default.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_profile_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_profile_slug TEXT,
  ADD COLUMN IF NOT EXISTS public_profile_settings JSONB NOT NULL DEFAULT '{
    "show_last_name": true,
    "show_picture": true,
    "show_location": true,
    "show_contact_details": false,
    "sections": {
      "about": true,
      "experience": true,
      "education": true,
      "skills": true,
      "certifications": true,
      "languages": true,
      "interests": true
    }
  }'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS users_public_profile_slug_key
  ON users (public_profile_slug)
  WHERE public_profile_slug IS NOT NULL;

-- Every slug ever assigned to an account, kept permanently. A slug is never freed for
-- reuse once claimed — even after the owner renames or disables their public link —
-- so a stale shared link can never later resolve to a different person's profile.
CREATE TABLE IF NOT EXISTS public_profile_slug_history (
  slug TEXT PRIMARY KEY,
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS public_profile_slug_history_user_uuid_idx
  ON public_profile_slug_history (user_uuid);

-- Masked, anon-readable view backing the unauthenticated /api/public-profile/:slug
-- endpoint. The `users` table itself has no RLS and grants nothing to `anon` — this
-- view IS the security boundary: each field is masked here, in SQL, based on the
-- row's own public_profile_settings, so a bug in the Edge Function's application code
-- can never expose more than this view already restricts. `ELSE NULL` (untyped) is used
-- throughout so the view doesn't need to assume each column's exact underlying type.
CREATE OR REPLACE VIEW public_shared_profiles AS
SELECT
  public_profile_slug AS slug,
  first_name,
  CASE WHEN COALESCE((public_profile_settings ->> 'show_last_name')::boolean, true)
    THEN last_name ELSE NULL END AS last_name,
  headline,
  role,
  CASE WHEN COALESCE((public_profile_settings ->> 'show_location')::boolean, true)
    THEN location ELSE NULL END AS location,
  (image IS NOT NULL AND COALESCE((public_profile_settings ->> 'show_picture')::boolean, true)) AS has_image,
  cover_image_url,
  CASE WHEN COALESCE((public_profile_settings ->> 'show_contact_details')::boolean, false)
    THEN email ELSE NULL END AS email,
  CASE WHEN COALESCE((public_profile_settings ->> 'show_contact_details')::boolean, false)
    THEN phone ELSE NULL END AS phone,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'about')::boolean, true)
    THEN about ELSE NULL END AS about,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'experience')::boolean, true)
    THEN experience ELSE NULL END AS experience,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'education')::boolean, true)
    THEN education ELSE NULL END AS education,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'certifications')::boolean, true)
    THEN certifications ELSE NULL END AS certifications,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'skills')::boolean, true)
    THEN skills ELSE NULL END AS skills,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'languages')::boolean, true)
    THEN languages ELSE NULL END AS languages,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'interests')::boolean, true)
    THEN interests ELSE NULL END AS interests
FROM users
WHERE public_profile_enabled = true
  AND public_profile_slug IS NOT NULL
  AND email NOT LIKE 'deleted_%@deleted.local';

GRANT SELECT ON public_shared_profiles TO anon;

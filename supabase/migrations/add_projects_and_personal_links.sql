-- Projects profile section (LinkedIn-style) + personal links (GitHub / website).
-- Projects items: { id, name, description?, startDate, endDate?, current, url?,
--                   technologies: string[], company?: number (enriched on read) }

-- 1. New columns (fast default backfills existing rows with '[]')
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS projects    JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS github_url  TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT;

-- 2. New users get the projects section toggle by default
ALTER TABLE users ALTER COLUMN public_profile_settings SET DEFAULT '{
  "show_last_name": true,
  "show_picture": true,
  "show_location": true,
  "show_contact_details": false,
  "sections": {
    "about": true,
    "experience": true,
    "projects": true,
    "education": true,
    "skills": true,
    "certifications": true,
    "languages": true,
    "interests": true
  }
}'::jsonb;

-- 3. Backfill existing rows (defensive — the view below also COALESCEs to true)
UPDATE users
SET public_profile_settings =
  jsonb_set(public_profile_settings, '{sections,projects}', 'true'::jsonb, true)
WHERE NOT (public_profile_settings -> 'sections' ? 'projects');

-- 4. Recreate the anon-facing masked view with the new fields appended at the END
--    (CREATE OR REPLACE VIEW only allows appending columns; existing order unchanged).
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
    THEN interests ELSE NULL END AS interests,
  CASE WHEN COALESCE((public_profile_settings -> 'sections' ->> 'projects')::boolean, true)
    THEN projects ELSE NULL END AS projects,
  github_url,
  website_url
FROM users
WHERE public_profile_enabled = true
  AND public_profile_slug IS NOT NULL
  AND email NOT LIKE 'deleted_%@deleted.local';

GRANT SELECT ON public_shared_profiles TO anon;

-- 5. Recreate public_users_view (feeds member-to-member profile views and AI search).
--    Body reproduced verbatim from the live definition (pg_get_viewdef, 2026-07-06),
--    with the three new columns appended at the END — masked for anonymous members
--    like every other identifying field (a GitHub/website link, or a project with a
--    company association, would immediately de-anonymize an anonymous profile).
CREATE OR REPLACE VIEW public_users_view AS
SELECT uuid,
    role,
    created_at,
    status,
    is_anonymous,
    privacy_lastname,
    privacy_picture,
    privacy_contact_details,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE name
        END AS name,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE first_name
        END AS first_name,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE about
        END AS about,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text[]
            ELSE interests
        END AS interests,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::jsonb
            ELSE languages
        END AS languages,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text[]
            ELSE work_preferences
        END AS work_preferences,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::jsonb
            ELSE experience
        END AS experience,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::jsonb
            ELSE education
        END AS education,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::jsonb
            ELSE certifications
        END AS certifications,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text[]
            ELSE skills
        END AS skills,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE location
        END AS location,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE cover_image_url
        END AS cover_image_url,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE headline
        END AS headline,
        CASE
            WHEN has_privacy_access(uuid, privacy_contact_details, is_anonymous) THEN email
            ELSE NULL::text
        END AS email,
        CASE
            WHEN has_privacy_access(uuid, privacy_contact_details, is_anonymous) THEN phone
            ELSE NULL::text
        END AS phone,
        CASE
            WHEN has_privacy_access(uuid, privacy_lastname, is_anonymous) THEN last_name
            WHEN privacy_lastname IS NULL AND NOT is_anonymous THEN last_name
            ELSE NULL::text
        END AS last_name,
        CASE
            WHEN has_privacy_access(uuid, privacy_picture, is_anonymous) AND image IS NOT NULL THEN 'true'::text
            WHEN privacy_picture IS NULL AND NOT is_anonymous AND image IS NOT NULL THEN 'true'::text
            ELSE NULL::text
        END AS image,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::jsonb
            ELSE projects
        END AS projects,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE github_url
        END AS github_url,
        CASE
            WHEN is_anonymous AND uuid <> auth.uid() THEN NULL::text
            ELSE website_url
        END AS website_url
   FROM users;

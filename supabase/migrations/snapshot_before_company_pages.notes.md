# Snapshot before company pages — findings

Snapshot: `snapshot_before_company_pages.json`, taken 2026-11-11 from project `csfyofqntrfxsystdzca`
with `snapshot_query_company_pages_schema.sql` (grants read separately via `aclexplode(relacl)`).

## Facts that settle open questions in the plan

- `companies.id` is `int4`. Every new foreign key to it is `INTEGER`.
- `companies` has columns the repo never declared: `source`, `source_raw_json`, `last_scraped_at`,
  `employees_count`. `UNIQUE (name)` exists — a new page cannot reuse an existing name.
- `companies.employees` is maintained by trigger `trg_sync_user_to_company` on `users`.
- `likes`: `UNIQUE (user_id, target_id)`, and insert policy `auth.uid() = user_id`.
  Reacting as a page needs a new uniqueness rule and policy.
- `messages` insert is gated in the database by policy `enforce_active_connection_on_insert`.
  Applicant chat needs that policy extended, not only `routes/chat.ts`.
- `posts` update/delete policies allow only `sender = jwt email`. Letting another page admin edit a
  company post needs a policy change (or a service-role path).
- `comments` policies are keyed on `sender = jwt email` the same way.
- `notifications` has no insert policy; rows come from SECURITY DEFINER triggers
  (`handle_new_like`, `handle_new_comment`, `notify_post_mentions`, `notify_comment_reaction`,
  `notify_comment_reply_and_mentions`). Their bodies are in the snapshot under `functions`.
- `job_applications.status` is checked to `clicked | applied`; FK is to `open_position.id`.
- `open_position` has no status / owner columns; `source` is NOT NULL; trigger `process_job_ai_v3`
  fires on INSERT.
- Storage buckets: `article-covers`, `attachments`, `chat-attachments`, `profile-headers`,
  `profile-images`. No company bucket. `article-covers` (public, 10 MB, image types) is the model.
- `article_company_follows(follower_uuid, company_id int4)`, PK on the pair, own-row policies.

## Existing exposures found (not caused by this work, not changed)

Verified with the public anon key, logged out, reading row counts only:

1. `companies` is readable by anyone: policy `SELECT USING (true)` for role `public`, and `anon`
   holds table privileges. Readable columns include `owner_uuid`, `employees` (member uuids per
   company) and `source_raw_json`.
   **Fixed 2026-11-11** (after this snapshot): `secure_companies_step1_safe.sql` removed signed-out
   access and made `companies_ranked` a `security_invoker` view; `secure_companies_step2_safe.sql`
   gave members column-level SELECT on everything except `source_raw_json`.
   Still member-readable by design until the admins step: `owner_uuid`, `employees`.
   **Any column added to `companies` now needs `GRANT SELECT (col) ... TO authenticated`.**
2. `feed_cache` has RLS disabled in production and `anon` holds SELECT. Its columns include
   `sender` (the poster's email) and `community_members_only`. The repo's `secure_feed_cache.sql`
   describes RLS as enabled; production does not match.
   **Fixed 2026-11-11** by running `secure_feed_cache_safe.sql` (after this snapshot was taken):
   RLS on, `anon` has no access, `authenticated` read-only, the four `feed_cache_on_*` trigger
   functions are SECURITY DEFINER. Rollback: `rollback_secure_feed_cache.sql`.

`anon` holds ALL on almost every table in scope; protection rests on RLS policies alone.

## Consequence for the company-pages schema

Nothing sensitive goes on `companies` itself (it is world-readable today): `verified_domain`,
claims, admins and audit data live in their own tables with no `anon` / `authenticated` grants.

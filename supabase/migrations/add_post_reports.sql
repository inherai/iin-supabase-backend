create table if not exists post_reports (
  id          bigserial primary key,
  post_id     text not null references posts(id) on delete cascade,
  reporter_id uuid not null references users(uuid) on delete cascade,
  reason      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists post_reports_post_id_idx      on post_reports (post_id);
create index if not exists post_reports_reporter_id_idx  on post_reports (reporter_id);
create index if not exists post_reports_created_at_idx   on post_reports (created_at desc);

-- Prevent the same user from submitting duplicate reports on the same post
create unique index if not exists post_reports_unique_per_user
  on post_reports (post_id, reporter_id);

-- Only the service role / admin can read reports; regular users can only insert their own
alter table post_reports enable row level security;

create policy "Users can report posts"
  on post_reports for insert
  with check (auth.uid() = reporter_id);

create policy "Admins can read all reports"
  on post_reports for select
  using (
    (auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean = true
  );

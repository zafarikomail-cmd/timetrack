-- ============================================================================
-- TimeTrack — initial schema, RLS policies, triggers, and helper view
-- ----------------------------------------------------------------------------
-- Run with: supabase db push
-- (or paste into Supabase Studio → SQL Editor and run once)
-- ============================================================================

create extension if not exists pgcrypto; -- gen_random_uuid()

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles — 1:1 with auth.users. id is intentionally the same as
-- auth.users.id (not a separate surrogate key) so every join is a plain id
-- match, and deleting the auth user cascades the profile automatically.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'employee'
             check (role in ('employee', 'admin', 'super_admin')),
  created_at timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  -- NOTE: no allowed-value CHECK constraint here — the attached files never
  -- define the set of valid project statuses. Tighten this once you tell me
  -- the real list (e.g. 'active' | 'on_hold' | 'completed' | 'archived').
  status      text not null default 'active',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
create table public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

-- ---------------------------------------------------------------------------
-- work_sessions
-- ----------------------------------------------------------------------------
-- FIXED (this pass): the frontend (dashboard.js, profile.js, overview.js,
-- reports.js, projects.js, report-utils.js) reads `duration_seconds` and
-- `last_seen_at` on every session row — neither column existed before, so
-- every hour total in the app silently rendered as 0 and the "who's working"
-- heartbeat had nothing to write to. Both are added below.
--
-- Also FIXED: `project_id` was nullable with `on delete set null`, and
-- `task_description` was nullable with no server-side requirement — but
-- part 3 of the spec requires the timer's "project + non-empty task
-- required" rule to be enforced server-side too, and projects.js's delete
-- handler already expects a foreign-key violation (23503) when a project
-- with logged sessions is deleted, not a silent null-out. Both columns are
-- now required, and the FK is `on delete restrict`.
-- ---------------------------------------------------------------------------
create table public.work_sessions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  project_id            uuid not null references public.projects (id) on delete restrict,
  task_description      text not null check (length(trim(task_description)) > 0),
  status                text not null default 'running'
                        check (status in ('running', 'paused', 'completed')),
  started_at            timestamptz not null default now(),
  paused_at             timestamptz,
  ended_at              timestamptz,
  total_paused_seconds  integer not null default 0,
  -- Heartbeat: stamped by enforce_work_session_timestamps() below on every
  -- insert/update (including the no-op "touch" update presence.js's
  -- startHeartbeat() sends every 60s). A running/paused row whose
  -- last_seen_at has gone stale (see presence.js's STALE_AFTER_MS) is
  -- treated as an abandoned tab, not "still working".
  last_seen_at          timestamptz not null default now(),
  -- Generated so every reader (dashboard/profile/overview/reports/projects)
  -- gets the same number without recomputing it in JS. NULL until the
  -- session is completed (ended_at is set); every UI already treats
  -- non-completed sessions' duration as "—" rather than reading this.
  duration_seconds      integer generated always as (
                          case
                            when ended_at is not null then
                              greatest(0, extract(epoch from (ended_at - started_at))::integer - total_paused_seconds)
                            else null
                          end
                        ) stored,
  created_at            timestamptz not null default now()
);

create index work_sessions_user_id_idx on public.work_sessions (user_id);
create index work_sessions_project_id_idx on public.work_sessions (project_id);
create index work_sessions_status_idx on public.work_sessions (status);

-- ============================================================================
-- 2. HELPER FUNCTIONS
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER + a fixed search_path so these run as the function owner
-- (postgres), which bypasses RLS on `profiles`. Without this, a policy on
-- `profiles` that queries `profiles` to find the caller's own role would
-- recurse into itself.
-- ============================================================================

create or replace function public.current_profile_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.role_level(r text)
returns int
language sql
immutable
as $$
  select case r
    when 'super_admin' then 3
    when 'admin' then 2
    when 'employee' then 1
    else 0
  end;
$$;

create or replace function public.is_admin_or_super()
returns boolean
language sql
stable
as $$
  select public.current_profile_role() in ('admin', 'super_admin');
$$;

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Role changes on `profiles` may ONLY come from a service-role connection
-- (i.e. an Edge Function using the service key), never a normal client
-- update — even one that otherwise passes RLS. This is what keeps
-- profiles.role and the auth.users JWT (app_metadata.role) from desyncing,
-- and is a second line of defense behind the RLS policy below.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_profiles_role_lock()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and auth.role() <> 'service_role' then
    raise exception 'Role changes must go through the admin-update-user-role Edge Function.';
  end if;
  return new;
end;
$$;

create trigger profiles_role_lock
before update on public.profiles
for each row execute function public.enforce_profiles_role_lock();

-- ---------------------------------------------------------------------------
-- BUG FIXED: js/data.js's updateProfile() comment claims "email is
-- intentionally excluded — changing it requires the Supabase Admin API and
-- isn't exposed here", but nothing previously enforced that server-side.
-- The profiles_update RLS policy lets a user update their own row with no
-- column-level restriction, so a tampered client could still call
-- `.from("profiles").update({ email: ... })` directly and desync the
-- displayed email (shown across Users/Overview/Reports) from the real
-- auth.users login email. Mirrors the role-lock trigger above.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_profiles_email_lock()
returns trigger
language plpgsql
as $$
begin
  if new.email is distinct from old.email and auth.role() <> 'service_role' then
    raise exception 'Email changes must go through the Supabase Admin API.';
  end if;
  return new;
end;
$$;

create trigger profiles_email_lock
before update on public.profiles
for each row execute function public.enforce_profiles_email_lock();

-- ---------------------------------------------------------------------------
-- work_sessions timestamps: started_at / paused_at / ended_at are always
-- derived from the database's own clock, regardless of any value a client
-- tries to send (the current frontend does send its own
-- new Date().toISOString() for paused_at/ended_at — this trigger silently
-- overrides that rather than trusting it; see the accompanying notes).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_work_session_timestamps()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
    new.paused_at := null;
    new.ended_at := null;
    new.last_seen_at := now();
    return new;
  end if;

  -- started_at is immutable once set, no matter what the client sends.
  new.started_at := old.started_at;

  if new.status = 'paused' and old.status <> 'paused' then
    new.paused_at := now();
  elsif new.status = 'running' and old.status = 'paused' then
    new.paused_at := null;
  else
    new.paused_at := old.paused_at;
  end if;

  if new.status = 'completed' then
    new.ended_at := now();
    new.paused_at := null;
  else
    new.ended_at := old.ended_at;
  end if;

  -- Every update (including presence.js's no-op "touch" heartbeat, which
  -- just re-writes the same status every 60s) refreshes last_seen_at from
  -- the DB clock — never trusting a client-sent value, same rule as every
  -- other timestamp on this table.
  new.last_seen_at := now();

  return new;
end;
$$;

create trigger work_sessions_timestamps
before insert or update on public.work_sessions
for each row execute function public.enforce_work_session_timestamps();

-- ---------------------------------------------------------------------------
-- Defense in depth alongside the .eq("status", currentStatus) guard added to
-- presence.js's heartbeat: a row can never be "completed" without ended_at
-- set, nor "running"/"paused" WITH ended_at set. Without this, a stray
-- write that resurrects a completed session's status (e.g. a stale
-- heartbeat tick racing a second device) would silently leave a corrupted
-- row instead of failing loudly.
-- ---------------------------------------------------------------------------
alter table public.work_sessions
  add constraint work_sessions_ended_at_matches_status
  check ((status = 'completed') = (ended_at is not null));

-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.work_sessions enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
--
-- Visibility rules:
--  - Everyone can see their own row.
--  - Super Admin sees every profile, including other super_admins.
--  - Admin sees every profile EXCEPT rows with role = 'super_admin' — this
--    is what keeps a Super Admin's own row invisible to Admins (and, by the
--    same clause, to Employees, who fail every branch except "self" and
--    would never have role = 'super_admin' as their own row anyway).
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles
for select
using (
  id = auth.uid()
  or public.current_profile_role() = 'super_admin'
  or (public.current_profile_role() = 'admin' and role <> 'super_admin')
);

-- Update: a user may update their own row; Admin/Super Admin may update
-- others' rows within the same visibility rule above. The role column
-- itself is protected separately by the profiles_role_lock trigger, so this
-- policy only needs to gate *which rows* are touchable, not which columns.
create policy profiles_update on public.profiles
for update
using (
  id = auth.uid()
  or public.current_profile_role() = 'super_admin'
  or (public.current_profile_role() = 'admin' and role <> 'super_admin')
)
with check (
  id = auth.uid()
  or public.current_profile_role() = 'super_admin'
  or (public.current_profile_role() = 'admin' and role <> 'super_admin')
);

-- No INSERT or DELETE policy for `profiles`: both must go through
-- admin-create-user / admin-delete-user, which use the service-role key and
-- bypass RLS entirely. A normal client can never insert or delete a row.

-- BUG FIXED: unlike every other table/view in this file, `profiles` had no
-- GRANT statement at all — RLS policies only decide which ROWS a role can
-- see once that role already has the underlying table-level privilege, and
-- without this grant Postgres denies the query before RLS is even
-- evaluated, which is exactly the literal "permission denied for table
-- profiles" error (a privilege error, distinct from an RLS-policy error)
-- reported from Profile → Edit Profile → Save Changes and from any
-- getProfileById()/getAllProfiles() read. authenticated is granted select
-- and update to match the two policies above; insert/delete are
-- intentionally withheld to match the "no INSERT/DELETE policy" note.
-- The service_role path used by the seed script and the admin-create-user
-- edge function also needs explicit table privileges to insert the initial
-- profile row and later manage roles.
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;

grant select, insert, update, delete on public.projects to service_role;
grant select, insert, update, delete on public.project_members to service_role;
grant select, insert, update, delete on public.work_sessions to service_role;

-- ---------------------------------------------------------------------------
-- projects
--
-- The base table is Admin/Super Admin only. Employees never query this
-- table directly — see `projects_public` below and the note in the
-- accompanying write-up about why.
-- ---------------------------------------------------------------------------
create policy projects_select_admin on public.projects
for select
using (public.is_admin_or_super());

create policy projects_write_admin on public.projects
for all
using (public.is_admin_or_super())
with check (public.is_admin_or_super());

-- ---------------------------------------------------------------------------
-- project_members
-- ---------------------------------------------------------------------------
create policy project_members_select on public.project_members
for select
using (public.is_admin_or_super() or user_id = auth.uid());

create policy project_members_write_admin on public.project_members
for all
using (public.is_admin_or_super())
with check (public.is_admin_or_super());

-- ---------------------------------------------------------------------------
-- work_sessions
--
-- Employees may see/insert/update only their own rows. Admin/Super Admin
-- can see and manage every row. Only Admin/Super Admin can delete.
-- ---------------------------------------------------------------------------
create policy work_sessions_select on public.work_sessions
for select
using (user_id = auth.uid() or public.is_admin_or_super());

create policy work_sessions_insert on public.work_sessions
for insert
with check (user_id = auth.uid() or public.is_admin_or_super());

create policy work_sessions_update on public.work_sessions
for update
using (user_id = auth.uid() or public.is_admin_or_super())
with check (user_id = auth.uid() or public.is_admin_or_super());

create policy work_sessions_delete_admin on public.work_sessions
for delete
using (public.is_admin_or_super());

-- ============================================================================
-- 5. projects_public — the description-free view for Employees
-- ----------------------------------------------------------------------------
-- Owned by the migration-running role (postgres), so it runs with that
-- owner's privileges and is NOT subject to the `projects_select_admin`
-- policy above — it does its own filtering here instead. It simply never
-- selects `description`, so an Employee querying it cannot get that column
-- back under any circumstance.
--
-- RESOLVED: js/data.js's getProjects(role) branches on the caller's role —
-- admin/super_admin query the base `projects` table (gets `description`),
-- everyone else queries this view instead (no `description` column at all).
-- ============================================================================
create view public.projects_public as
select id, name, status, created_at
from public.projects;

grant select on public.projects_public to authenticated;

-- ============================================================================
-- 6. REALTIME — required for js/presence.js's live "who's working" feature
-- ----------------------------------------------------------------------------
-- Without these two statements, subscribeToActiveSessions() in presence.js
-- (a Postgres Changes subscription on work_sessions) either never fires or
-- only delivers the primary key on UPDATE — not the full row (status,
-- project_id, last_seen_at) the Users page needs to render live status.
-- Wrapped so this migration is safe to re-run: adding a table to a
-- publication twice raises "duplicate_object", which is caught and ignored.
-- ============================================================================
alter table public.work_sessions replica identity full;

do $$
begin
  execute 'alter publication supabase_realtime add table public.work_sessions';
exception when duplicate_object then
  null;
end $$;
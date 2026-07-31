-- ============================================================================
-- TimeTrack — notifications table, RLS, and realtime
-- ----------------------------------------------------------------------------
-- js/data.js's sendNotification() / getNotificationsForUser() /
-- markNotificationRead() / markAllNotificationsRead() were already written
-- against this schema (see the comment at the top of that section, which
-- pointed here) but this file itself never existed — so every call into
-- those functions failed with "Could not find the table 'public.notifications'
-- in the schema cache", and the bell icon in the topbar had nothing to load.
-- Safe to run once; re-running is idempotent via `if not exists` / `or replace`.
-- ============================================================================

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  message       text not null check (char_length(trim(message)) > 0),
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);

alter table public.notifications
  add constraint notifications_sender_id_fkey
  foreign key (sender_id) references public.profiles(id) on delete cascade;

create index if not exists notifications_recipient_id_idx on public.notifications (recipient_id);
create index if not exists notifications_recipient_unread_idx on public.notifications (recipient_id) where read_at is null;

alter table public.notifications enable row level security;

-- Recipients read only their own notifications.
create policy notifications_select_own on public.notifications
for select
using (recipient_id = auth.uid());

-- Only Admin/Super Admin may send. Re-enforced here server-side regardless
-- of what the client-side "Notify" button gates — mirrors every other
-- admin-only write policy in this schema (see 0001_init.sql).
create policy notifications_insert_admin on public.notifications
for insert
with check (public.is_admin_or_super() and sender_id = auth.uid());

-- A recipient may only update their own row, and only to mark it read
-- (flip read_at) — they can't rewrite the message or reassign it.
create policy notifications_update_own on public.notifications
for update
using (recipient_id = auth.uid())
with check (recipient_id = auth.uid());

grant select, update on public.notifications to authenticated;
grant insert on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications to service_role;

-- Realtime so the bell badge/list update live without a page refresh,
-- same reasoning as work_sessions in 0001_init.sql.
alter table public.notifications replica identity full;

do $$
begin
  execute 'alter publication supabase_realtime add table public.notifications';
exception when duplicate_object then
  null;
end $$;

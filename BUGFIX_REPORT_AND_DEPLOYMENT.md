# TimeTrack — Bug Diagnosis, Fixes Applied, and Deployment Checklist

I audited the actual code and SQL in `TimeTrack_fixed_v3.zip` (not guessing from
the console log alone). Here's what's actually going on, item by item, plus
what I changed and what you still need to do.

## The one thing that explains most of your bugs

Your `supabase/migrations/0001_init.sql` is genuinely well-built — correct RLS
policies, a `projects_public` view for employees, grants, and a server-side
trigger that stamps timestamps from the database clock (not the browser) to
stop clock manipulation. **But your live Supabase project doesn't have this
migration fully applied.** That's exactly what the console errors say:

- `permission denied for table profiles` / `work_sessions` → the tables exist,
  but the `grant select, update on ... to authenticated` statements were
  never run against your real project.
- `404 Could not find the table 'public.projects_public'` → that view was
  never created there either.

This single gap explains bugs **#1, #4, #5, #6, #8, #9**, and almost
certainly **#3** (a leftover running session that couldn't be stopped because
the same 403s blocked the update).

## Bugs that were real code problems (fixed in the attached zip)

**#1 / #9 — Users page broken / admin can't see live status**
`js/users.js` imported `subscribeToOnlineUsers` from `js/presence.js` — a
function that never existed there. A missing named export throws at import
time, so the *entire* Users module failed to load before any of its code
(the user list, live status, hours, filters — all of which were already
correctly built) ever ran. I implemented `subscribeToOnlineUsers` and a
companion `trackOwnPresence` in `presence.js` using Supabase's Presence API,
and wired `trackOwnPresence` into `app.js` so every signed-in user (not just
admins) registers as online.

**#2 — Notification bell does nothing**
Two separate gaps, not one: `supabase/migrations/0002_notifications.sql` was
referenced in a comment in `data.js` but the file itself never existed, so
the `notifications` table was never created. Separately, the bell button
(`#notificationsBtn`) had *zero* JavaScript wired to it anywhere — no click
handler, no dropdown, nothing — even though `sendNotification()` /
`getNotificationsForUser()` / `markNotificationRead()` were already written
in `data.js`. I added the missing migration, a dropdown panel with unread
badge + mark-as-read, and a "Notify" button on each row of the Users page so
admins can actually send one.

**#7 — Timer trusts the browser clock**
Already solved correctly server-side: `enforce_work_session_timestamps()` in
the migration overrides any client-sent `paused_at`/`ended_at` with `now()`
from the database. This just needs the migration deployed (see below) —
no code change needed.

## Likely explanation for #10 (admin and demo user look identical)

`getUserRole()` reads role from the Supabase Auth JWT (`app_metadata.role`),
which is correctly set server-side by the `admin-create-user` Edge Function.
The most common cause of "two accounts, same permissions" is testing both
logins in the **same browser without an incognito/private window** — Supabase
Auth persists the session in `localStorage`, which is shared across every tab
of the same origin. Logging into the second account can silently overwrite
the first tab's session too, so you're actually looking at one account twice.
Test with two separate browser profiles (or one normal + one incognito
window) and confirm the accounts were created via the in-app "Add Member"
flow (which calls `admin-create-user`), not added manually in Supabase
Studio — a manually-added auth user has no `app_metadata.role` at all.

---

## Deployment checklist (do this in order)

1. **Push the full migration set** — `0001_init.sql` then the new
   `0002_notifications.sql` — via `supabase db push` or by pasting each into
   the Supabase SQL Editor, in order. If you'd already run an older/partial
   version of `0001_init.sql` against this project and have no real data yet,
   the cleanest path is `supabase db reset` before pushing, so you're not
   layering on top of an inconsistent partial state.
2. **Deploy the three Edge Functions**:
   ```
   supabase functions deploy admin-create-user
   supabase functions deploy admin-delete-user
   supabase functions deploy admin-update-user-role
   ```
3. **Seed the first Super Admin** (README.md in the zip has the exact
   command) — run once, locally, never in browser code.
4. **Create every other account (admin + employees) through the app's "Add
   Member" screen**, not through Supabase Studio's Auth UI directly — only
   the Edge Function sets `app_metadata.role` correctly.
5. **Hard-refresh the app** (or clear the old session) and test admin vs.
   employee in two separate browser profiles.
6. Ignore the `manifest.json` 404 — that's PWA-related and you said to
   ignore it.

## What's in the attached zip

`TimeTrack_fixed_v4.zip` — your project with the four fixes above applied:
`js/presence.js`, `js/app.js`, `js/users.js` changed; `js/notifications.js`
added; `app.html` and `css/app.css` updated for the notification panel and
"Notify" button; `supabase/migrations/0002_notifications.sql` added. Nothing
else was touched — everything else in your `data.js`/RLS/Edge Functions was
already correct and just needed deploying.

Once you've pushed the migrations and redeployed, re-test the numbered list —
items 1–2 and 4–9 should be resolved, #3 should stop appearing once no
orphaned session row remains, and #10 should resolve once accounts are
created the right way and tested in separate browser sessions.

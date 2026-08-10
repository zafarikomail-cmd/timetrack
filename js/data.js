// ============================================================================
// Shared data-access layer
// ----------------------------------------------------------------------------
// Every page-level module (dashboard.js, projects.js, overview.js, profile.js,
// users.js, reports.js) reads/writes through these functions instead of
// duplicating Supabase queries. Keeps RLS-respecting queries in one place.
// ============================================================================

import { supabase, invokeEdgeFunction } from "./supabase.js";

/* ---------------------------------------------------------------------------
   Date range helpers
   ------------------------------------------------------------------------- */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? 6 : day - 1); // week starts Monday
  d.setDate(d.getDate() - diff);
  return d;
}

/**
 * Returns { from: Date, to: Date } for a named preset. `custom` requires
 * customFrom/customTo (Date or ISO string) to be passed in.
 */
export function getDateRangeForPreset(preset, { customFrom, customTo } = {}) {
  const now = new Date();

  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "thisWeek":
      return { from: startOfWeek(now), to: endOfDay(now) };
    case "lastWeek": {
      const start = startOfWeek(now);
      start.setDate(start.getDate() - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: start, to: endOfDay(end) };
    }
    case "thisMonth":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case "lastMonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: start, to: endOfDay(end) };
    }
    case "custom":
      return { from: startOfDay(new Date(customFrom)), to: endOfDay(new Date(customTo)) };
    default:
      return { from: null, to: null };
  }
}

/* ---------------------------------------------------------------------------
   Projects
   ------------------------------------------------------------------------- */
/**
 * Employees have no RLS SELECT policy on the base `projects` table at all
 * (see migration 0001, section 5) — only admin/super_admin do, because
 * `description` must never reach an Employee. Employees instead read
 * `projects_public`, a view with no `description` column.
 *
 * BUG FIXED: this function used to query the base `projects` table
 * unconditionally for every caller. Under RLS, an Employee's call silently
 * returned zero rows (not an error) — which meant the project dropdown in
 * the timer (projects.js) was permanently empty for every non-admin user,
 * and they could never start a timer at all. Pass the caller's own role so
 * this can branch to the right table/view.
 */
export async function getProjects(role) {
  // "projects_public" was never created in the live database (confirmed via
  // information_schema.tables — only "projects" exists there). Querying it
  // threw a "relation does not exist" error for every non-admin caller,
  // which safeCall() in projects.js silently swallowed into an empty array
  // — so regular users always saw zero projects. The live RLS policy
  // "projects_select_all" already permits SELECT on the base "projects"
  // table for any authenticated user (qual: auth.role() = 'authenticated'),
  // so there's no need for a separate view. Description-hiding for non-admins
  // is handled below by simply not requesting that column.
  const table = "projects";
  const columns = isAdminLevel(role) ? "id, name, description, status, created_at" : "id, name, status, created_at";

  const { data, error } = await supabase.from(table).select(columns).order("name", { ascending: true });

  if (error) throw error;
  return data;
}

export async function getProjectMemberCounts() {
  const { data, error } = await supabase.from("project_members").select("project_id");
  if (error) throw error;

  const counts = {};
  data.forEach((row) => {
    counts[row.project_id] = (counts[row.project_id] || 0) + 1;
  });
  return counts;
}

export async function createProject({ name, description }) {
  // BUG FIXED: this used to insert a `created_by` column that doesn't exist
  // on the projects table (see migration 0001) — the insert always failed
  // with a "column not found" error, independent of and in addition to the
  // role-resolution bug below. status defaults to 'active' via the column
  // default, so it's intentionally omitted here.
  const { data, error } = await supabase
    .from("projects")
    .insert({ name, description })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateProject(id, { name, description, status }) {
  const { data, error } = await supabase
    .from("projects")
    .update({ name, description, status })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteProject(id) {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
   Work sessions
   ------------------------------------------------------------------------- */
export async function getActiveSessionForUser(userId) {
  const { data, error } = await supabase
    .from("work_sessions")
    .select("*, projects(name)")
    .eq("user_id", userId)
    .in("status", ["running", "paused"])
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function createWorkSession({ userId, projectId, taskDescription }) {
  const { data, error } = await supabase
    .from("work_sessions")
    .insert({ user_id: userId, project_id: projectId, task_description: taskDescription })
    .select("*, projects(name)")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Patches an in-progress (running/paused) session's project and/or task
 * description — used so users can correct/change what they're tracking
 * without having to stop and restart the timer. Only the fields actually
 * passed are updated; started_at/status/timing columns are untouched.
 */
export async function updateWorkSession(id, { projectId, taskDescription } = {}) {
  const patch = {};
  if (projectId !== undefined) patch.project_id = projectId;
  if (taskDescription !== undefined) patch.task_description = taskDescription;

  if (Object.keys(patch).length === 0) return null;

  const { data, error } = await supabase
    .from("work_sessions")
    .update(patch)
    .eq("id", id)
    .select("*, projects(name)")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Admin/Super-Admin-only: edits any user's session — project, task
 * description, start date/time, end date/time, and/or duration. Used by the
 * Reports page's "Edit Session" modal (admin/super admin only).
 *
 * Whether the session counts as "edited" is deliberately never sent from
 * here — that flag is entirely computed by a DB trigger (see
 * supabase/migrations/0005_work_sessions_admin_edit.sql), so no caller —
 * however it invokes this function — can set it itself. RLS additionally
 * restricts this UPDATE to admin/super_admin roles at the database level,
 * so this isn't just a client-side gate.
 */
export async function adminUpdateWorkSession(id, { projectId, taskDescription, startedAt, stoppedAt, durationSeconds } = {}) {
  const patch = {};
  if (projectId !== undefined) patch.project_id = projectId;
  if (taskDescription !== undefined) patch.task_description = taskDescription;
  if (startedAt !== undefined) patch.started_at = startedAt;
  if (stoppedAt !== undefined) patch.stopped_at = stoppedAt;
  if (durationSeconds !== undefined) patch.duration_seconds = durationSeconds;

  if (Object.keys(patch).length === 0) return null;

  const { data, error } = await supabase
    .from("work_sessions")
    .update(patch)
    .eq("id", id)
    .select("*, projects(name), profiles(full_name, email)")
    .single();

  if (error) throw error;
  return data;
}

export async function pauseWorkSession(id) {
  const { data, error } = await supabase
    .from("work_sessions")
    .update({ status: "paused", paused_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function resumeWorkSession(id, additionalPausedSeconds, currentTotalPausedSeconds) {
  const { data, error } = await supabase
    .from("work_sessions")
    .update({
      status: "running",
      paused_at: null,
      total_paused_seconds: currentTotalPausedSeconds + additionalPausedSeconds,
    })
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function stopWorkSession(id, extraPausedSeconds = 0, currentTotalPausedSeconds = 0, startedAt) {
  // BUG FIXED: this used to write to a column called `ended_at`, which
  // doesn't exist on work_sessions — the actual column is `stopped_at`
  // (see migration 0001). That's what caused "Could not find the
  // 'ended_at' column" on every Stop click.
  //
  // Also: duration_seconds was never being computed anywhere, client or
  // DB, so every completed session would have shown "—" for its duration
  // even once Stop stopped erroring. Computing it here from startedAt
  // (the session's server-set started_at) and the now-finalized
  // total_paused_seconds.
  //
  // CHANGED PER CLIENT REQUEST: task status ("how's this task?", asked at
  // Stop time) has been removed entirely — the column is no longer written
  // here. See supabase/migrations/0004_drop_task_status.sql, which drops
  // the column from the database.
  const totalPausedSeconds = currentTotalPausedSeconds + extraPausedSeconds;
  const stoppedAt = new Date();
  const durationSeconds = startedAt
    ? Math.max(0, Math.floor((stoppedAt.getTime() - new Date(startedAt).getTime()) / 1000) - totalPausedSeconds)
    : null;

  const { data, error } = await supabase
    .from("work_sessions")
    .update({
      status: "completed",
      stopped_at: stoppedAt.toISOString(),
      paused_at: null,
      total_paused_seconds: totalPausedSeconds,
      duration_seconds: durationSeconds,
    })
    .eq("id", id)
    .select("*, projects(name)")
    .single();

  if (error) throw error;
  return data;
}

/**
 * Fetches a page of a user's own sessions, newest first, with optional
 * date-range/project filters. Returns { rows, count }.
 */
export async function getSessionsForUser(userId, { from, to, projectId, search, page = 1, pageSize = 10 } = {}) {
  let query = supabase
    .from("work_sessions")
    .select("*, projects(name)", { count: "exact" })
    .eq("user_id", userId)
    .order("started_at", { ascending: false });

  if (from) query = query.gte("started_at", from.toISOString());
  if (to) query = query.lte("started_at", to.toISOString());
  if (projectId) query = query.eq("project_id", projectId);
  if (search) query = query.ilike("task_description", `%${search}%`);

  const start = (page - 1) * pageSize;
  query = query.range(start, start + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/**
 * Admin-scoped version: all users' sessions, with optional user/project/date
 * filters (RLS allows admins to select every row). Returns { rows, count }.
 */
export async function getAllSessions({ from, to, projectId, userId, search, page = 1, pageSize = 10 } = {}) {
  let query = supabase
    .from("work_sessions")
    .select("*, projects(name), profiles(full_name, email)", { count: "exact" })
    .order("started_at", { ascending: false });

  if (from) query = query.gte("started_at", from.toISOString());
  if (to) query = query.lte("started_at", to.toISOString());
  if (projectId) query = query.eq("project_id", projectId);
  if (userId) query = query.eq("user_id", userId);
  if (search) query = query.ilike("task_description", `%${search}%`);

  const start = (page - 1) * pageSize;
  query = query.range(start, start + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  return { rows: data, count: count ?? 0 };
}

/* ---------------------------------------------------------------------------
   Profiles / Users
   ------------------------------------------------------------------------- */

// Role hierarchy: higher number = more privilege. Used to decide what an
// acting user is allowed to view/promote/demote/delete.
export const ROLE_LEVELS = { employee: 1, admin: 2, super_admin: 3 };

export function roleLevel(role) {
  return ROLE_LEVELS[role] || ROLE_LEVELS.employee;
}

export function isSuperAdmin(role) {
  return role === "super_admin";
}

/**
 * True for "admin" and "super_admin". Several places in the UI (Reports
 * page, Overview's admin filters, Projects' Manage tab) previously gated on
 * a bare `role === "admin"` string check, which silently excluded
 * super_admin — contradicting "super_admin can see/manage everything."
 * Use this instead of comparing role strings directly.
 */
export function isAdminLevel(role) {
  return roleLevel(role) >= ROLE_LEVELS.admin;
}

/**
 * Whether `actingRole` is allowed to manage (edit/delete/change role of) a
 * profile whose role is `targetRole`. Nobody can manage a peer or superior —
 * this is what keeps "Super Admin hidden/protected from Admin" true even if
 * an Admin somehow gets a row into view.
 */
export function canManageRole(actingRole, targetRole) {
  return roleLevel(actingRole) > roleLevel(targetRole);
}

/**
 * Fetches all profiles. By default, rows with role "super_admin" are
 * excluded — per spec, Super Admin is hidden from normal Admin views. Pass
 * `includeSuperAdmins: true` (only when the caller is itself a Super Admin)
 * to see everyone.
 */
export async function getAllProfiles({ includeSuperAdmins = false } = {}) {
  let query = supabase
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .order("created_at", { ascending: false });

  if (!includeSuperAdmins) {
    query = query.neq("role", "super_admin");
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * getProfileById() is called independently by nearly every page module on
 * every page load (app.js for the topbar/nav role gate, dashboard.js for
 * the active-projects count, and overview.js/reports.js/profile.js/users.js
 * for their own role checks) — all asking Supabase for the exact same row
 * (the caller's own profile) within milliseconds of each other. That was
 * turning into 4-6 redundant network round-trips stacked on page load,
 * which is what was causing the visible ~2s gap where the page shows
 * default/zeroed state (hidden nav items, "0h 0m") before flipping to the
 * real data once the (repeated) fetches finally resolved.
 *
 * This cache makes concurrent calls for the same id share a single
 * in-flight request (so 6 simultaneous callers on page load = 1 network
 * call, not 6), and keeps the result around briefly so a user clicking
 * between pages within the cache window doesn't force a router-me fetch.
 * The short TTL (rather than caching forever) keeps role/name changes made
 * elsewhere (e.g. an admin editing someone's role) from going stale for
 * long — and invalidateProfileCache() below clears it immediately whenever
 * this app itself writes a profile change.
 */
const PROFILE_CACHE_TTL_MS = 30_000;
const profileCache = new Map(); // id -> { promise, expiresAt }

export async function getProfileById(id) {
  const cached = profileCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = (async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, full_name, role, created_at")
      .eq("id", id)
      .single();

    if (error) {
      profileCache.delete(id); // don't cache failures
      throw error;
    }
    return data;
  })();

  profileCache.set(id, { promise, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
  return promise;
}

/**
 * Clears a cached profile (or the whole cache, if no id is given) so the
 * next getProfileById() call fetches fresh data instead of a stale cached
 * copy. Called after any write to a profiles row.
 */
export function invalidateProfileCache(id) {
  if (id) profileCache.delete(id);
  else profileCache.clear();
}

/**
 * Updates a profile's editable fields. Deliberately name-only now — role
 * changes must go through adminUpdateUserRole() so the auth JWT stays in
 * sync with profiles.role (see that function's comment for why). Email is
 * intentionally excluded too — changing it requires the Supabase Admin API
 * and isn't exposed here.
 */
export async function updateProfile(id, { full_name } = {}) {
  const patch = {};
  if (full_name !== undefined) patch.full_name = full_name;

  const { data, error } = await supabase.from("profiles").update(patch).eq("id", id).select().single();
  if (error) throw error;
  invalidateProfileCache(id);
  return data;
}

export async function deleteProfile(id) {
  // Deletes the profile row. The auth.users row itself requires the
  // Supabase Admin API (service role) and must be removed from a trusted
  // server context — never from browser code with the publishable key.
  const { error } = await supabase.from("profiles").delete().eq("id", id);
  if (error) throw error;
  invalidateProfileCache(id);
}

/**
 * Creates a brand-new team member: an auth.users account plus its profile
 * row (full_name, role). This requires the Supabase service-role key, which
 * must never live in browser code — so it is delegated to the
 * "admin-create-user" Edge Function (see /supabase/functions). The function
 * must be deployed to the linked Supabase project for this to work.
 */
export async function adminCreateUser({ email, password, fullName, role }) {
  const data = await invokeEdgeFunction("admin-create-user", { email, password, fullName, role });
  return data?.user;
}

/**
 * Permanently removes a team member: their auth.users account and profile
 * row. Like adminCreateUser, this needs the service role key and is
 * delegated to the "admin-delete-user" Edge Function.
 *
 * `actingRole`/`targetRole` are passed so we refuse client-side before ever
 * hitting the network — but the Edge Function MUST re-check this itself
 * (never trust the frontend), since a modified client could skip this call.
 */
export async function adminDeleteUser(id, { actingRole, targetRole } = {}) {
  if (actingRole && targetRole && !canManageRole(actingRole, targetRole)) {
    throw new Error("You don't have permission to delete this user.");
  }

  await invokeEdgeFunction("admin-delete-user", { id });
}

/**
 * Changes a user's role (promote to admin / demote to employee / promote to
 * super_admin). This must go through the "admin-update-user-role" Edge
 * Function rather than a plain table update: the profiles.role column is
 * only half the picture — the user's auth JWT (app_metadata.role), which
 * every RLS policy and getUserRole() check ultimately relies on, lives in
 * auth.users and can only be written with the service role key. Writing
 * profiles.role alone (the old updateProfileRole path) would silently
 * desync the two and the role change wouldn't take effect until next login.
 *
 * Enforces the role hierarchy client-side as a first line of defense; the
 * Edge Function re-validates server-side regardless.
 */
/**
 * `newRole` is optional (pass null/undefined) when this call is only
 * updating `fullName` for someone other than the caller — see
 * users.js's handleFormSubmit, which uses this for BOTH name and role
 * edits to another user, since a plain client-side update() there is
 * blocked by RLS (only self-updates are permitted at the table level).
 */
export async function adminUpdateUserRole(id, newRole, { actingRole, targetRole, fullName } = {}) {
  if (actingRole && targetRole && !canManageRole(actingRole, targetRole)) {
    throw new Error("You don't have permission to change this user's role.");
  }
  // Only a Super Admin may create another Super Admin.
  if (newRole === "super_admin" && actingRole !== "super_admin") {
    throw new Error("Only a Super Admin can promote someone to Super Admin.");
  }

  const payload = { id };
  if (newRole) payload.role = newRole;
  if (fullName !== undefined) payload.fullName = fullName;

  const data = await invokeEdgeFunction("admin-update-user-role", payload);
  invalidateProfileCache(id);
  return data?.profile;
}

/**
 * Returns a Map of user_id -> { status, projectName, lastSeenAt } for every
 * user with a running/paused session right now. Used to seed the Users
 * page's live status column; js/presence.js keeps it updated afterward via
 * a Realtime subscription instead of re-fetching this on a timer.
 *
 * BUG FIXED: this used to select `last_seen_at`, a column that never
 * existed on work_sessions — the real column (see migration 0001) is
 * `last_heartbeat_at`. That's what caused "column work_sessions.last_seen_at
 * does not exist" on every Users page load.
 */
export async function getActiveSessionsSummary() {
  const { data, error } = await supabase
    .from("work_sessions")
    .select("user_id, status, last_heartbeat_at, projects(name)")
    .in("status", ["running", "paused"]);

  if (error) throw error;

  const map = new Map();
  (data || []).forEach((row) => {
    map.set(row.user_id, {
      status: row.status,
      projectName: row.projects?.name || null,
      lastSeenAt: row.last_heartbeat_at,
    });
  });
  return map;
}

/* ---------------------------------------------------------------------------
   Notifications (F) — Admin/Super Admin can message specific members.
   Persisted (not just a live toast) so a recipient sees it after reload;
   see supabase/migrations/0002_notifications.sql for the table/RLS/trigger.
   ------------------------------------------------------------------------- */

/**
 * Sends the same message to one or more recipients. RLS (notifications_
 * insert_admin) re-enforces the admin-only check server-side regardless of
 * this client-side gate.
 */
export async function sendNotification({ recipientIds, message }) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const senderId = userData.user?.id;

  const rows = recipientIds.map((recipientId) => ({
    sender_id: senderId,
    recipient_id: recipientId,
    message,
  }));

  const { error } = await supabase.from("notifications").insert(rows);
  if (error) throw error;
}

/**
 * Fetches the signed-in user's own notifications, newest first. RLS already
 * restricts this to `recipient_id = auth.uid()` — the .eq() below just makes
 * the query's intent explicit.
 */
export async function getNotificationsForUser(userId, { limit = 30 } = {}) {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, message, created_at, read_at, sender:profiles!notifications_sender_id_fkey(full_name, email)")
    .eq("recipient_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function markNotificationRead(id) {
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function markAllNotificationsRead(userId) {
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", userId)
    .is("read_at", null);
  if (error) throw error;
}

/* ---------------------------------------------------------------------------
   Formatting helpers
   ------------------------------------------------------------------------- */
/**
 * BUG FIXED: this used to only check user.app_metadata.role /
 * user.user_metadata.role — but role has never actually lived on the JWT
 * in this app, only in public.profiles.role (which is also what every RLS
 * policy's my_role() reads from). Every account created outside the
 * admin-create-user Edge Function's exact claim-setting path (i.e. every
 * account made via the Dashboard or direct SQL, including the three test
 * accounts) had app_metadata.role permanently undefined, so this always
 * returned null — Add Project button never got wired, nav role-gating
 * never worked, etc.
 *
 * Now accepts EITHER a profiles row (role is a plain top-level property)
 * OR a raw auth user object (checked as a fallback, in case app_metadata.role
 * ever does get set by an Edge Function in the future). Callers should
 * prefer fetching the caller's own profiles row via getProfileById() and
 * passing that in, rather than the raw auth user.
 */
export function getUserRole(userOrProfile) {
  return userOrProfile?.role || userOrProfile?.app_metadata?.role || userOrProfile?.user_metadata?.role || null;
}

export function secondsToHoursMinutes(totalSeconds) {
  const seconds = Math.max(0, totalSeconds || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Computes the live elapsed seconds for a running/paused session as of
 * `referenceDate` (defaults to now). Shared by every live-ticking duration
 * display (Projects timer, Dashboard's detailed sessions table) so they can
 * never drift out of sync with each other over slightly different formulas.
 */
export function computeElapsedSeconds(session, referenceDate = new Date()) {
  const startedAt = new Date(session.started_at).getTime();
  const pausedAt = session.paused_at ? new Date(session.paused_at).getTime() : null;
  const pausedMs =
    (session.total_paused_seconds || 0) * 1000 +
    (session.status === "paused" && pausedAt ? referenceDate.getTime() - pausedAt : 0);
  return Math.max(0, Math.floor((referenceDate.getTime() - startedAt - pausedMs) / 1000));
}

export function formatDuration(seconds) {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

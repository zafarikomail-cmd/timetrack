// ============================================================================
// Presence module — real-time "who's working now"
// ----------------------------------------------------------------------------
// Replaces the old one-time snapshot query (getActiveUserIds(), fetched once
// on page load) with a live Supabase Realtime subscription plus a heartbeat,
// so an admin watching the Users page sees a colleague's status change the
// moment they start/pause/stop their timer — no refresh needed.
//
// Why Postgres Changes instead of Presence: Supabase Presence tracks which
// *clients* have a socket connected to a channel, not the state of any row.
// What we actually care about is "is there a running/paused work_sessions
// row for this user" — that's database state, not connection state, and it
// needs to stay correct even if the admin viewing it and the employee doing
// the work never share a channel. Postgres Changes streams the real row
// state directly, filtered by RLS exactly the same way a normal select
// would be (an Employee's subscription only ever receives their own rows;
// Admin/Super Admin receive everyone's — which is what makes the live Users
// page status work for them).
// ============================================================================

import { supabase, isSupabaseConfigured } from "./supabase.js";

// A running/paused session with no heartbeat in this long is treated as
// abandoned (tab closed without clicking Stop) even though the DB row
// hasn't been explicitly stopped yet.
export const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Subscribes to every change on work_sessions and invokes `onChange(payload)`
 * for each one. Returns an unsubscribe function — callers MUST call it when
 * navigating away/logging out to avoid duplicate subscriptions/leaks.
 */
export function subscribeToActiveSessions(onChange) {
  if (!isSupabaseConfigured) return () => {};

  const channel = supabase
    .channel("work_sessions_presence")
    .on("postgres_changes", { event: "*", schema: "public", table: "work_sessions" }, onChange)
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * A running/paused session counts as genuinely active only if its
 * last_heartbeat_at heartbeat is recent — otherwise treat it as idle/offline
 * even though the row itself is still technically "running" in the DB.
 *
 * BUG FIXED: this used to check session.last_seen_at, a column/property
 * name that never matched the real work_sessions column (last_heartbeat_at)
 * — see data.js's getActiveSessionsSummary(). Every caller now passes
 * { last_heartbeat_at, started_at }, so check that key instead.
 */
export function isSessionFresh(session) {
  if (!session?.last_heartbeat_at && !session?.started_at) return false;
  const lastSeen = new Date(session.last_heartbeat_at || session.started_at).getTime();
  return Date.now() - lastSeen < STALE_AFTER_MS;
}

/**
 * Pings a work_sessions row every minute while it's running/paused so other
 * viewers can tell "still working" apart from "abandoned tab" (see
 * isSessionFresh). The heartbeat is just a normal client update — the DB
 * trigger stamps last_heartbeat_at from its own clock, never trusting a
 * client-sent timestamp. Returns a function that stops the heartbeat (call
 * on pause/stop/page unload).
 *
 * BUG FIXED: this used to blindly `.update({ status: currentStatus })` on a
 * 60s timer with no guard. If the same user opened a second tab/device and
 * that session got completed elsewhere in the meantime (e.g. the stale-
 * session auto-finalize in projects.js's handleStart), the next heartbeat
 * tick from the FIRST tab would silently flip status back to
 * running/paused — resurrecting a session that should have stayed
 * completed, while the DB trigger preserves the old (already-set)
 * ended_at, leaving a corrupted row. Adding `.eq("status", currentStatus)`
 * makes the write a no-op (0 rows matched, no error) once the row's real
 * status has moved on, instead of clobbering it back.
 */
/**
 * Shared Supabase Presence channel used for "is this person's tab open at
 * all" — independent of whether their timer is running. Every signed-in
 * user (Employee, Admin, Super Admin) calls trackOwnPresence() once on app
 * load so they show up in this channel's member list; the Users page (via
 * subscribeToOnlineUsers) reads that member list to render Online/Idle/
 * Offline.
 *
 * BUG FIXED: trackOwnPresence() and subscribeToOnlineUsers() used to each
 * open their OWN separate channel object for this same topic name. On an
 * admin's own tab that meant two independent joins to "online_users" at
 * once (one from app.js on load, a second from users.js every time the
 * Users page was opened) — Realtime doesn't cleanly support two channel
 * objects joined to the same topic from one client, and worse, every time
 * the Users page was (re)opened it had to join a brand-new channel and do
 * a full presence "sync" round-trip from zero before it knew who was
 * online. That round-trip is exactly the lag you'd see — Online/Working
 * wouldn't flip until that fresh sync finally landed.
 *
 * Fixed by making this a single shared channel per browser tab: created
 * once (by whichever of trackOwnPresence/subscribeToOnlineUsers runs
 * first), reused by both, and only torn down once nothing needs it
 * anymore (reference-counted below). A late subscriber (e.g. opening the
 * Users page well after app load) gets the ALREADY-synced state
 * immediately instead of waiting on a new sync — that's what makes status
 * changes feel instant instead of hesitating.
 */
const PRESENCE_CHANNEL_NAME = "online_users";

/**
 * FEATURE: device type ("mobile"/"desktop"), shown as a small icon next to
 * a user's status on the Users page (see users.js's Device column).
 *
 * Classified from navigator.userAgent, the same string every mainstream
 * mobile browser (iOS Safari, Android Chrome, etc.) self-identifies through.
 * This is client-reported, not a server-verified fact — a determined user
 * could spoof their UA string — so treat it as a helpful "what are they
 * probably on" indicator for admins, not a security or access-control
 * signal. That's the standard trade-off for this kind of detection and is
 * fine for an internal team-visibility feature like this one.
 */
function detectDeviceType() {
  if (typeof navigator === "undefined" || !navigator.userAgent) return "desktop";
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

let presenceChannel = null; // the one shared channel object for this tab
let presenceSubscribed = false; // true once its "SUBSCRIBED" callback has fired
let presenceChannelKey = null; // the key this channel is currently tracking under
let onlineListeners = new Set(); // subscribeToOnlineUsers callbacks
let presenceRefCount = 0; // how many callers (trackOwnPresence + subscribeToOnlineUsers) still need this channel alive

/**
 * FEATURE: used to emit a bare Set<userId> of who's online. Now emits a
 * Map<userId, deviceType> instead, so callers get "who's online" AND "what
 * they're on" in one signal, at no extra cost (device_type rides along in
 * each presence entry's own tracked payload — see trackOwnPresence). A Map
 * still supports .has(userId) exactly like the old Set did, so this is a
 * non-breaking change for any caller that only ever checked membership.
 */
function emitOnlineUsers() {
  if (!presenceChannel) return;
  const state = presenceChannel.presenceState();
  const online = new Map();
  Object.entries(state).forEach(([userId, metas]) => {
    online.set(userId, metas?.[0]?.device_type || "desktop");
  });
  onlineListeners.forEach((fn) => fn(online));
}

/**
 * Creates the shared channel on first use. If trackOwnPresence() hasn't
 * run yet (so the real user id isn't known), a random placeholder key is
 * used just so the channel can exist and start syncing — trackOwnPresence
 * re-keys it (tears down + rejoins under the real user id) if it turns out
 * to have been created that way, which shouldn't normally happen since
 * app.js calls trackOwnPresence() on load, before any page could call
 * subscribeToOnlineUsers().
 */
function ensurePresenceChannel(userId) {
  const keyToUse = userId || presenceChannelKey || `viewer-${Math.random().toString(36).slice(2)}`;

  if (presenceChannel && presenceChannelKey !== keyToUse && userId) {
    // A real user id showed up after the channel was already opened under a
    // placeholder key — rejoin under the real key so this tab's own
    // presence is tracked correctly.
    supabase.removeChannel(presenceChannel);
    presenceChannel = null;
    presenceSubscribed = false;
  }

  if (presenceChannel) return presenceChannel;

  presenceChannelKey = keyToUse;
  presenceChannel = supabase.channel(PRESENCE_CHANNEL_NAME, {
    config: { presence: { key: keyToUse } },
  });

  presenceChannel
    .on("presence", { event: "sync" }, emitOnlineUsers)
    .on("presence", { event: "join" }, emitOnlineUsers)
    .on("presence", { event: "leave" }, emitOnlineUsers)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        presenceSubscribed = true;
        if (userId) {
          presenceChannel.track({ online_at: new Date().toISOString(), device_type: detectDeviceType() });
        }
        emitOnlineUsers();
      }
    });

  return presenceChannel;
}

function releasePresenceChannel() {
  presenceRefCount = Math.max(0, presenceRefCount - 1);
  if (presenceRefCount > 0) return;

  if (presenceChannel) supabase.removeChannel(presenceChannel);
  presenceChannel = null;
  presenceSubscribed = false;
  presenceChannelKey = null;
  onlineListeners.clear();
}

/**
 * Registers the current tab's presence so admins watching the Users page
 * can tell "tab open" (Idle) apart from "tab closed" (Offline), distinct
 * from isSessionFresh()'s "timer actively running" (Working). Call once
 * per page load, right after the authenticated user is known. Returns an
 * untrack/cleanup function.
 */
export function trackOwnPresence(userId) {
  if (!isSupabaseConfigured || !userId) return () => {};

  presenceRefCount++;
  const channel = ensurePresenceChannel(userId);
  if (presenceSubscribed && presenceChannelKey === userId) {
    channel.track({ online_at: new Date().toISOString(), device_type: detectDeviceType() });
  }

  return () => releasePresenceChannel();
}

/**
 * Subscribes to the shared presence channel and invokes `onChange(online)`
 * with a Map<userId, deviceType> ("mobile" | "desktop") of everyone
 * currently online, every time membership changes (join/leave/sync) — AND
 * immediately, with whatever the current state already is, so a late
 * subscriber (opening the Users page after the app has been running a
 * while) doesn't have to wait for the next join/leave to see accurate
 * statuses. Returns an unsubscribe function.
 *
 * The Map still supports .has(userId) exactly like the Set this used to
 * return, so any caller that only checks membership needs no changes.
 */
export function subscribeToOnlineUsers(onChange) {
  if (!isSupabaseConfigured) return () => {};

  presenceRefCount++;
  onlineListeners.add(onChange);
  ensurePresenceChannel();
  if (presenceSubscribed) emitOnlineUsers();

  return () => {
    onlineListeners.delete(onChange);
    releasePresenceChannel();
  };
}

export function startHeartbeat(sessionId, currentStatus) {
  if (!isSupabaseConfigured || !sessionId) return () => {};

  // BUG FIXED: this used to only `.update({ status: currentStatus })` and
  // rely on a DB trigger to stamp last_heartbeat_at from the server clock.
  // Writing `status` back to the value it already is looks like a no-op to
  // Postgres — if the trigger was written with any "only touch the
  // timestamp when the row actually changed" guard (e.g. comparing NEW vs
  // OLD), it never fires, so last_heartbeat_at is set once at session
  // creation and never refreshed again. Every 60s heartbeat after that
  // "succeeds" (no error) without actually doing anything, so the session
  // looks fresh for STALE_AFTER_MS (5 minutes) from creation and then
  // silently flips to Not Working even though the user is still working.
  //
  // Fix: set last_heartbeat_at directly from the client on every beat, so
  // freshness no longer depends on trigger behavior at all. A few seconds
  // of client/server clock skew is irrelevant against a 5-minute staleness
  // window, so this is safe. The `.eq("status", currentStatus)` guard is
  // kept so a heartbeat from a stale tab can never resurrect a session
  // that has since been completed/stopped elsewhere (see comment above).
  const beat = () => {
    supabase
      .from("work_sessions")
      .update({ status: currentStatus, last_heartbeat_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("status", currentStatus)
      .then(({ error }) => {
        if (error) console.error("Heartbeat failed:", error.message);
      });
  };

  // Fire one heartbeat immediately, instead of waiting the first full
  // HEARTBEAT_INTERVAL_MS, so a freshly (re)started heartbeat doesn't
  // depend on the session-creation timestamp being recent — e.g. right
  // after resuming a recovered session on page load.
  beat();
  const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(interval);
}

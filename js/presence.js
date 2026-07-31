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
 * Offline. All clients join the SAME channel name so presence state is
 * visible to every member, per Supabase's documented Presence pattern.
 */
const PRESENCE_CHANNEL_NAME = "online_users";
let ownPresenceChannel = null;

/**
 * FIX: users.js already imported subscribeToOnlineUsers from this file —
 * it just never existed here, which broke users.js's module load entirely
 * (a missing named export throws at import time, before any of the file's
 * code runs). Registers the current tab's presence so admins watching the
 * Users page can tell "tab open" (Idle) apart from "tab closed" (Offline),
 * distinct from isSessionFresh()'s "timer actively running" (Working).
 * Call once per page load, right after the authenticated user is known.
 * Returns an untrack/cleanup function.
 */
export function trackOwnPresence(userId) {
  if (!isSupabaseConfigured || !userId) return () => {};

  if (ownPresenceChannel) {
    supabase.removeChannel(ownPresenceChannel);
    ownPresenceChannel = null;
  }

  const channel = supabase.channel(PRESENCE_CHANNEL_NAME, {
    config: { presence: { key: userId } },
  });

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      channel.track({ online_at: new Date().toISOString() });
    }
  });

  ownPresenceChannel = channel;

  return () => {
    supabase.removeChannel(channel);
    if (ownPresenceChannel === channel) ownPresenceChannel = null;
  };
}

/**
 * Subscribes to the shared presence channel and invokes `onChange(idsSet)`
 * with a Set of currently-online user ids every time membership changes
 * (join/leave/sync). Returns an unsubscribe function.
 */
export function subscribeToOnlineUsers(onChange) {
  if (!isSupabaseConfigured) return () => {};

  const channel = supabase.channel(PRESENCE_CHANNEL_NAME, {
    config: { presence: { key: "__viewer__" } },
  });

  const emit = () => {
    const state = channel.presenceState();
    onChange(new Set(Object.keys(state)));
  };

  channel
    .on("presence", { event: "sync" }, emit)
    .on("presence", { event: "join" }, emit)
    .on("presence", { event: "leave" }, emit)
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export function startHeartbeat(sessionId, currentStatus) {
  if (!isSupabaseConfigured || !sessionId) return () => {};

  const beat = () => {
    supabase
      .from("work_sessions")
      .update({ status: currentStatus })
      .eq("id", sessionId)
      .eq("status", currentStatus)
      .then(({ error }) => {
        if (error) console.error("Heartbeat failed:", error.message);
      });
  };

  const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(interval);
}
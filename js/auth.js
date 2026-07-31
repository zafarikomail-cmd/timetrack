// ============================================================================
// Authentication helpers
// ----------------------------------------------------------------------------
// This module wraps the Supabase Auth client that is already configured in
// js/supabase.js (shared with login.html). It does not implement any new
// authentication logic, mock users, or bypass logic — it only exposes the
// real session/user retrieval and sign-out flow for the app shell to use.
// ============================================================================

import { supabase, isSupabaseConfigured } from "./supabase.js";

const LOGIN_PAGE = "login.html";

/**
 * Returns the currently authenticated Supabase user, or null if there is
 * no active session — or if Supabase credentials haven't been added yet.
 * Callers decide what to do when no user is present.
 */
export async function getCurrentUser() {
  if (!isSupabaseConfigured) return null;

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    console.error("Failed to retrieve session:", error.message);
    return null;
  }

  return data.session?.user ?? null;
}

/**
 * Subscribes to Supabase auth state changes (sign-in, sign-out, token
 * refresh). Returns an unsubscribe function. Intended for future modules
 * that need to react to session changes without re-checking on every action.
 * No-ops safely until Supabase credentials are configured.
 */
export function onAuthStateChange(callback) {
  if (!isSupabaseConfigured) return () => {};

  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });

  return () => subscription.unsubscribe();
}

/**
 * Signs the current user out of Supabase and redirects to the login page.
 */
export async function logout() {
  if (isSupabaseConfigured) {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error("Sign-out failed:", error.message);
    }
  }

  window.location.replace(LOGIN_PAGE);
}

/**
 * Updates the signed-in user's auth display name (user_metadata.full_name).
 * Callers are also responsible for updating the `profiles` table row via
 * data.js's updateProfile() so both stay in sync.
 */
export async function updateDisplayName(fullName) {
  const { data, error } = await supabase.auth.updateUser({ data: { full_name: fullName } });
  if (error) throw error;
  return data.user;
}

/**
 * Changes the signed-in user's password. Re-authenticates with the current
 * password first (signInWithPassword) so a stolen/left-open session can't
 * silently change the password without knowing it.
 */
export async function changePassword(email, currentPassword, newPassword) {
  const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
  if (verifyError) throw new Error("Current password is incorrect.");

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/**
 * Redirects to the login page if there is no authenticated session.
 * Intended to be called once during app initialization, after real
 * Supabase credentials and roles are wired up. Left as a ready-to-use
 * integration point — not called by the app shell yet.
 */
export async function requireAuthenticatedUser() {
  if (!isSupabaseConfigured) return null;

  const user = await getCurrentUser();

  if (!user) {
    window.location.replace(LOGIN_PAGE);
    return null;
  }

  return user;
}
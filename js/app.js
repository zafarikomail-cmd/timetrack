// ============================================================================
// Application entry point
// ----------------------------------------------------------------------------
// Bootstraps the app shell: verifies the session, populates the topbar with
// the current user, applies role-based navigation visibility, and wires up
// section navigation and the mobile sidebar.
// ============================================================================

import { requireAuthenticatedUser, logout } from "./auth.js";
import { initNavigation, initSidebarToggle } from "./navigation.js";
import { isSupabaseConfigured } from "./supabase.js";
import { trackOwnPresence } from "./presence.js";
import { paintAvatar, formatRoleLabel } from "./avatar.js";
import { showToast } from "./toast.js";
import { getProfileById, getUserRole } from "./data.js";

// Roles permitted to see each role-restricted navigation item. This is the
// single place future modules should update as real roles are introduced.
const RESTRICTED_NAV_ACCESS = {
  users: ["admin", "super_admin"],
  reports: ["employee", "admin", "super_admin"],
};

// Set once the authenticated user's role is known (see initUserIdentity).
// navigation.js reads this through getCurrentRole() so switchSection() can
// enforce it even if isSupabaseConfigured is momentarily false at wire-up
// time (before the identity check has resolved).
let currentRole = null;

document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
  // Navigation, sidebar, and logout are the core of the app shell and must
  // work regardless of whether Supabase has been configured yet.
  wireNavigation();
  wireSidebar();
  wireLogout();

  await initUserIdentity();
}

/**
 * Populates the topbar and applies role-based nav visibility for the
 * authenticated user. Redirects to login.html if there is no valid session
 * (requireAuthenticatedUser no-ops safely if Supabase isn't configured yet).
 */
async function initUserIdentity() {
  const user = await requireAuthenticatedUser();
  if (!user) return;

  // BUG FIXED: role used to be read from user.app_metadata/user_metadata,
  // which never actually holds role in this app — role only ever lives in
  // public.profiles.role. That meant currentRole was always null, which
  // hid every role-restricted nav item and, in projects.js, meant the
  // whole admin Manage Projects panel (including Add Project) never
  // rendered for anyone, admin or not. Fetch the real profile row instead.
  let profile = null;
  try {
    profile = await getProfileById(user.id);
  } catch (error) {
    console.error("Failed to load profile:", error.message);
  }

  renderUserIdentity(user, profile);
  currentRole = getUserRole(profile) || getUserRole(user);
  applyRoleBasedNavVisibility(currentRole);

  // Every signed-in user (Employee, Admin, Super Admin) registers "tab is
  // open" presence, not just admins — the Users page reads this member
  // list to show Online/Idle/Offline for everyone, so everyone must join.
  trackOwnPresence(user.id);
}

/**
 * Derives a display name, role, and avatar from the authenticated user and
 * renders them into the topbar. Falls back gracefully when optional profile
 * fields are not yet populated in Supabase.
 */
function renderUserIdentity(user, profile) {
  const displayName = profile?.full_name || getUserDisplayName(user);
  const role = getUserRole(profile) || getUserRole(user);

  const userNameEl = document.getElementById("userName");
  const userRoleBadgeEl = document.getElementById("userRoleBadge");
  const userAvatarEl = document.getElementById("userAvatar");

  userNameEl.textContent = displayName;

  if (role) {
    userRoleBadgeEl.textContent = formatRoleLabel(role);
    userRoleBadgeEl.hidden = false;
  }

  paintAvatar(userAvatarEl, displayName);
}

function getUserDisplayName(user) {
  return (
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email ||
    "User"
  );
}

/**
 * Reveals role-restricted navigation items (Users, Reports). Once Supabase
 * is configured and a user is authenticated, visibility is driven by their
 * real role. Until then (no backend wired up yet) the items stay visible so
 * the navigation system itself remains fully testable.
 */
function applyRoleBasedNavVisibility(role) {
  document.querySelectorAll(".nav-item-wrapper[data-requires-role]").forEach((wrapper) => {
    const sectionKey = wrapper.querySelector("[data-section]")?.dataset.section;
    const allowedRoles = RESTRICTED_NAV_ACCESS[sectionKey] || [];

    if (!isSupabaseConfigured) {
      wrapper.hidden = false;
      return;
    }

    wrapper.hidden = !role || !allowedRoles.includes(role);
  });
}

function wireNavigation() {
  initNavigation({
    navItems: document.querySelectorAll(".nav-item[data-section]"),
    sections: document.querySelectorAll(".page-section"),
    pageTitleEl: document.getElementById("pageTitle"),
    restrictedSections: isSupabaseConfigured ? RESTRICTED_NAV_ACCESS : {},
    getRole: () => currentRole,
    onAccessDenied: () => {
      showToast("You don't have permission to view that page.", "error");
    },
    // BUG FIXED: this is a single-page app — switchSection() only toggles
    // `hidden` on <section> elements, it never re-fetches anything. Every
    // page module (dashboard.js, projects.js, etc.) only loaded its data
    // once, on the initial DOMContentLoaded. That meant navigating away
    // from Dashboard and back (e.g. after stopping a timer on the Projects
    // page) kept showing stale data — a session that had already been
    // stopped could still appear "running" on the Dashboard. Broadcasting
    // this event lets any page module opt in to refreshing itself every
    // time it becomes visible again, not just on first load.
    onChange: (sectionKey) => {
      document.dispatchEvent(new CustomEvent("app:section-shown", { detail: { sectionKey } }));
    },
  });
}

function wireSidebar() {
  initSidebarToggle({
    sidebar: document.getElementById("sidebar"),
    overlay: document.getElementById("sidebarOverlay"),
    menuToggle: document.getElementById("menuToggle"),
    closeButton: document.getElementById("sidebarClose"),
  });
}

function wireLogout() {
  document.getElementById("logoutBtn").addEventListener("click", () => {
    logout();
  });
}

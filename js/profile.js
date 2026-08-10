// ============================================================================
// Profile module
// ----------------------------------------------------------------------------
// Shows the signed-in user's own identity and live online/offline status,
// and lets them edit their display name and change their password. All data
// is the user's own row — RLS already restricts non-admins to their own
// profile anyway.
//
// CHANGED PER CLIENT REQUEST: the personal stats tiles (Today/This Week/
// This Month/All Time), the three personal charts, and the "Export My Data"
// card have all been removed from this page.
// ============================================================================

import { getCurrentUser, updateDisplayName, changePassword } from "./auth.js";
import {
  getProfileById,
  updateProfile,
  getActiveSessionForUser,
  computeElapsedSeconds,
  formatDuration,
} from "./data.js";
import { paintAvatar, formatRoleLabel } from "./avatar.js";
import { openModal, closeModal, initModalDismissal } from "./modal.js";
import { showToast } from "./toast.js";

let currentUser = null;
let dom = {};
let sessionTimerInterval = null;

document.addEventListener("DOMContentLoaded", initProfile);

async function initProfile() {
  currentUser = await getCurrentUser();
  if (!currentUser) return;

  cacheDom();
  initModalDismissal("editProfileModal");
  initModalDismissal("changePasswordModal");
  wireEvents();

  await loadProfile();
}

function cacheDom() {
  dom = {
    avatar: document.getElementById("profileAvatar"),
    name: document.getElementById("profileName"),
    roleBadge: document.getElementById("profileRoleBadge"),
    email: document.getElementById("profileEmail"),
    joinedDate: document.getElementById("profileJoinedDate"),
    statusBadge: document.getElementById("profileStatusBadge"),

    sessionActive: document.getElementById("profileSessionActive"),
    sessionEmpty: document.getElementById("profileSessionEmpty"),
    sessionStatusBadge: document.getElementById("profileSessionStatusBadge"),
    sessionProject: document.getElementById("profileSessionProject"),
    sessionTask: document.getElementById("profileSessionTask"),
    sessionTimer: document.getElementById("profileSessionTimer"),
    sessionManageBtn: document.getElementById("profileSessionManageBtn"),
    sessionStartBtn: document.getElementById("profileSessionStartBtn"),

    editProfileBtn: document.getElementById("editProfileBtn"),
    changePasswordBtn: document.getElementById("changePasswordBtn"),

    editProfileForm: document.getElementById("editProfileForm"),
    editProfileName: document.getElementById("editProfileName"),
    editProfileNameError: document.getElementById("editProfileNameError"),
    editProfileSubmitBtn: document.getElementById("editProfileSubmitBtn"),

    changePasswordForm: document.getElementById("changePasswordForm"),
    currentPassword: document.getElementById("currentPassword"),
    currentPasswordError: document.getElementById("currentPasswordError"),
    toggleCurrentPassword: document.getElementById("toggleCurrentPassword"),
    newPassword: document.getElementById("newPassword"),
    newPasswordError: document.getElementById("newPasswordError"),
    toggleNewPassword: document.getElementById("toggleNewPassword"),
    confirmNewPassword: document.getElementById("confirmNewPassword"),
    confirmNewPasswordError: document.getElementById("confirmNewPasswordError"),
    toggleConfirmNewPassword: document.getElementById("toggleConfirmNewPassword"),
    changePasswordSubmitBtn: document.getElementById("changePasswordSubmitBtn"),
  };
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    console.error("Profile data load failed:", error.message);
    return fallback;
  }
}

async function loadProfile() {
  const [profile, activeSession] = await Promise.all([
    safeCall(() => getProfileById(currentUser.id)),
    safeCall(() => getActiveSessionForUser(currentUser.id)),
  ]);

  renderIdentity(profile, activeSession);
}

function renderIdentity(profile, activeSession) {
  const displayName = profile?.full_name || currentUser.user_metadata?.full_name || currentUser.email;
  const role = profile?.role || "employee";

  dom.name.textContent = displayName;
  dom.roleBadge.textContent = formatRoleLabel(role);
  dom.email.textContent = profile?.email || currentUser.email;
  dom.joinedDate.textContent = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "—";

  paintAvatar(dom.avatar, displayName);

  // BUG FIXED (H): status used to be `Boolean(activeSession)` — "Offline"
  // whenever no timer was running, even though you're looking at this page
  // right now and are obviously online. Viewing your own Profile page means
  // you're online by definition; only whether a timer is running should
  // change the label.
  const isWorking = Boolean(activeSession);
  dom.statusBadge.className = `badge ${isWorking ? "badge-online" : "badge-idle"}`;
  dom.statusBadge.innerHTML = `<span class="badge-dot"></span>${isWorking ? "Working" : "Online now"}`;

  renderSessionCard(activeSession);
}

/**
 * "Right now" card — live reflection of the user's own active work
 * session (running or paused). Intentionally operational, not a stats/
 * analytics widget, so it's separate from the tiles/charts that were
 * removed from this page.
 */
function renderSessionCard(activeSession) {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }

  if (!activeSession) {
    dom.sessionActive.hidden = true;
    dom.sessionEmpty.hidden = false;
    return;
  }

  dom.sessionEmpty.hidden = true;
  dom.sessionActive.hidden = false;

  const isPaused = activeSession.status === "paused";
  dom.sessionStatusBadge.className = `badge ${isPaused ? "badge-idle" : "badge-online"}`;
  dom.sessionStatusBadge.innerHTML = `<span class="badge-dot"></span>${isPaused ? "Paused" : "Running"}`;

  dom.sessionProject.textContent = activeSession.projects?.name || "No project";
  dom.sessionTask.textContent = activeSession.task_description || "No description";

  const tick = () => {
    dom.sessionTimer.textContent = formatDuration(computeElapsedSeconds(activeSession));
  };
  tick();
  sessionTimerInterval = setInterval(tick, 1000);
}

/* ============================================================================
   Edit profile
   ========================================================================== */
function wireEvents() {
  dom.editProfileBtn.addEventListener("click", () => {
    dom.editProfileForm.reset();
    dom.editProfileNameError.textContent = "";
    dom.editProfileName.value = dom.name.textContent.trim();
    openModal("editProfileModal");
  });

  dom.editProfileForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fullName = dom.editProfileName.value.trim();

    if (!fullName) {
      dom.editProfileNameError.textContent = "Full name is required.";
      return;
    }
    dom.editProfileNameError.textContent = "";
    dom.editProfileSubmitBtn.disabled = true;

    try {
      await updateDisplayName(fullName);
      await updateProfile(currentUser.id, { full_name: fullName });
      showToast("Profile updated", "success");
      closeModal("editProfileModal");
      await loadProfile();
    } catch (error) {
      showToast(error.message || "Could not update your profile.", "error");
    } finally {
      dom.editProfileSubmitBtn.disabled = false;
    }
  });

  dom.changePasswordBtn.addEventListener("click", () => {
    dom.changePasswordForm.reset();
    clearPasswordErrors();
    [dom.currentPassword, dom.newPassword, dom.confirmNewPassword].forEach((input) => {
      input.type = "password";
    });
    [dom.toggleCurrentPassword, dom.toggleNewPassword, dom.toggleConfirmNewPassword].forEach((btn) =>
      setToggleIcon(btn, false)
    );
    openModal("changePasswordModal");
  });

  const goToProjects = () => {
    document.querySelector('.nav-item[data-section="projects"]')?.click();
  };
  dom.sessionManageBtn.addEventListener("click", goToProjects);
  dom.sessionStartBtn.addEventListener("click", goToProjects);

  wirePasswordToggle(dom.toggleCurrentPassword, dom.currentPassword);
  wirePasswordToggle(dom.toggleNewPassword, dom.newPassword);
  wirePasswordToggle(dom.toggleConfirmNewPassword, dom.confirmNewPassword);

  dom.changePasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearPasswordErrors();

    const current = dom.currentPassword.value;
    const next = dom.newPassword.value;
    const confirm = dom.confirmNewPassword.value;
    let valid = true;

    if (!current) {
      dom.currentPasswordError.textContent = "Current password is required.";
      valid = false;
    }
    if (!next || next.length < 8) {
      dom.newPasswordError.textContent = "New password must be at least 8 characters.";
      valid = false;
    }
    if (confirm !== next) {
      dom.confirmNewPasswordError.textContent = "Passwords do not match.";
      valid = false;
    }
    if (!valid) return;

    dom.changePasswordSubmitBtn.disabled = true;
    try {
      await changePassword(currentUser.email, current, next);
      showToast("Password updated", "success");
      closeModal("changePasswordModal");
    } catch (error) {
      dom.currentPasswordError.textContent = error.message || "Could not change your password.";
    } finally {
      dom.changePasswordSubmitBtn.disabled = false;
    }
  });
}

/**
 * Bug J: no show/hide toggle existed on the Change Password fields at all.
 * Wired the same way as login.js's (working) version — one independent
 * click handler per button/input pair, reading the input's *current* type
 * each click rather than any cached boolean, so it flips correctly every
 * time instead of only once.
 */
function wirePasswordToggle(button, input) {
  button.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    setToggleIcon(button, isHidden);
  });
}

function setToggleIcon(button, isVisible) {
  button.setAttribute("aria-pressed", String(isVisible));
  button.setAttribute("aria-label", isVisible ? "Hide password" : "Show password");
  button.querySelector(".icon-eye").hidden = isVisible;
  button.querySelector(".icon-eye-off").hidden = !isVisible;
}

function clearPasswordErrors() {
  dom.currentPasswordError.textContent = "";
  dom.newPasswordError.textContent = "";
  dom.confirmNewPasswordError.textContent = "";
}

// ============================================================================
// Users module (Admin only)
// ----------------------------------------------------------------------------
// Lists real profiles from Supabase, with search/role/status filters, and
// lets an admin add (via the admin-create-user Edge Function), edit, or
// delete (via admin-delete-user) team members. Online status is derived from
// real running/paused work_sessions rows, not a fabricated field.
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getAllProfiles,
  getActiveSessionsSummary,
  getProjects,
  getProfileById,
  adminCreateUser,
  adminDeleteUser,
  adminUpdateUserRole,
  updateProfile,
  getUserRole,
  canManageRole,
  isSuperAdmin,
  sendNotification,
} from "./data.js";
import { showToast } from "./toast.js";
import { openModal, closeModal, initModalDismissal, confirmDialog } from "./modal.js";
import { renderPagination } from "./pagination.js";
import { escapeHtml } from "./report-utils.js";
import { getInitials, getAvatarColor } from "./avatar.js";
import { subscribeToActiveSessions, isSessionFresh, subscribeToOnlineUsers } from "./presence.js";

let currentUser = null;
let currentRole = null;
let profilesList = [];
let activeSessions = new Map(); // user_id -> { status, projectName, lastSeenAt }
let onlineUserIds = new Set(); // H: user ids with a live presence-channel connection right now
let projectNamesById = new Map();
let unsubscribeRealtime = null;
let unsubscribePresence = null;
let dom = {};

const state = { page: 1, pageSize: 8, search: "", roleFilter: "", statusFilter: "", timerFilter: "" };

document.addEventListener("DOMContentLoaded", initUsers);

async function initUsers() {
  currentUser = await getCurrentUser();
  if (!currentUser) return;

  // BUG FIXED: currentRole used to be derived from getUserRole(currentUser)
  // — the raw auth user, which never actually carries role (role only ever
  // lives in public.profiles.role; see data.js's getUserRole() comment).
  // currentRole was therefore always null, so the admin-only guard right
  // below returned early for every real admin/super admin — cacheDom(),
  // wireEvents(), and loadUsers() never ran. That's why the table stayed
  // permanently empty and "Add User" appeared to do nothing (its click
  // handler was never attached). Fetch the caller's own profiles row
  // instead, same fix already applied in overview.js/app.js.
  const profile = await safeCall(() => getProfileById(currentUser.id), null);
  currentRole = getUserRole(profile) || getUserRole(currentUser);

  // This page is admin/super_admin-only; app.js already hides the nav item
  // for everyone else, but guard here too in case the section is reached
  // directly (e.g. a stale bookmark or direct hash navigation).
  if (currentRole !== "admin" && currentRole !== "super_admin") return;

  cacheDom();
  initModalDismissal("userModal");
  initModalDismissal("notifyUserModal");
  wireEvents();

  await loadUsers();

  // Live "who's working now": Postgres Changes pushes every work_sessions
  // insert/update/delete to us as it happens, so status updates without a
  // refresh. Must be unsubscribed on unload or we'd leak a channel/leave a
  // duplicate subscription behind (only relevant risk here since this is a
  // single-page app — logging out/closing the tab tears the page down
  // entirely, which also kills the socket, but we unsubscribe explicitly
  // too rather than relying on that).
  unsubscribeRealtime = subscribeToActiveSessions(handleRealtimeSessionChange);

  // H: separate live signal for "tab is open" vs "timer is running" — see
  // js/presence.js. Re-renders the table whenever someone connects/
  // disconnects so Idle/Offline updates without a refresh, same as Working.
  unsubscribePresence = subscribeToOnlineUsers((ids) => {
    onlineUserIds = ids;
    renderTable();
  });

  window.addEventListener("pagehide", () => {
    unsubscribeRealtime?.();
    unsubscribePresence?.();
  });
}

function handleRealtimeSessionChange(payload) {
  const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old;
  if (!row?.user_id) return;

  const isNowActive = payload.eventType !== "DELETE" && (row.status === "running" || row.status === "paused");

  if (isNowActive) {
    activeSessions.set(row.user_id, {
      status: row.status,
      projectName: projectNamesById.get(row.project_id) || null,
      // BUG FIXED: was row.last_seen_at, a column that never existed on
      // work_sessions — the real column is last_heartbeat_at.
      lastSeenAt: row.last_heartbeat_at,
    });
  } else {
    activeSessions.delete(row.user_id);
  }

  renderTable();
}

function cacheDom() {
  dom = {
    search: document.getElementById("usersSearch"),
    roleFilter: document.getElementById("usersRoleFilter"),
    statusFilter: document.getElementById("usersStatusFilter"),
    timerFilter: document.getElementById("usersTimerFilter"),
    addUserBtn: document.getElementById("addUserBtn"),

    tableWrapper: document.getElementById("usersTableWrapper"),
    tableBody: document.getElementById("usersTableBody"),
    emptyState: document.getElementById("usersEmptyState"),
    pagination: document.getElementById("usersPagination"),

    userForm: document.getElementById("userForm"),
    userFormId: document.getElementById("userFormId"),
    userFormName: document.getElementById("userFormName"),
    userFormNameError: document.getElementById("userFormNameError"),
    userFormEmail: document.getElementById("userFormEmail"),
    userFormEmailError: document.getElementById("userFormEmailError"),
    userFormPasswordGroup: document.getElementById("userFormPasswordGroup"),
    userFormPassword: document.getElementById("userFormPassword"),
    userFormPasswordError: document.getElementById("userFormPasswordError"),
    userFormRole: document.getElementById("userFormRole"),
    userModalTitle: document.getElementById("userModalTitle"),
    userModalSubtitle: document.getElementById("userModalSubtitle"),
    userFormSubmitBtn: document.getElementById("userFormSubmitBtn"),

    notifyUserForm: document.getElementById("notifyUserForm"),
    notifyUserFormRecipientId: document.getElementById("notifyUserFormRecipientId"),
    notifyUserFormMessage: document.getElementById("notifyUserFormMessage"),
    notifyUserFormMessageError: document.getElementById("notifyUserFormMessageError"),
    notifyUserFormSubmitBtn: document.getElementById("notifyUserFormSubmitBtn"),
    notifyUserModalSubtitle: document.getElementById("notifyUserModalSubtitle"),
  };
}

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.error("Users data load failed:", error.message);
    return fallback;
  }
}

async function loadUsers() {
  const [profiles, sessions, projects] = await Promise.all([
    safeCall(() => getAllProfiles({ includeSuperAdmins: isSuperAdmin(currentRole) }), []),
    safeCall(getActiveSessionsSummary, new Map()),
    safeCall(() => getProjects(currentRole), []),
  ]);
  profilesList = profiles || [];
  activeSessions = sessions || new Map();
  projectNamesById = new Map((projects || []).map((p) => [p.id, p.name]));
  ensureRoleOptionsForActingRole();
  ensureSuperAdminOptions();
  renderTable();
}

/**
 * The role <select> in the Add/Edit User modal hard-codes "Employee" and
 * "Admin" in the HTML, with "Super Admin" appended dynamically for a Super
 * Admin actor (see below). But per the hierarchy rule ("no one can grant a
 * role equal to or higher than their own, except Super Admin"), a plain
 * Admin can only ever grant "Employee" — granting "Admin" would be
 * promoting a peer, which both Edge Functions already correctly reject.
 *
 * BUG FIXED: the dropdown offered "Admin" to a plain Admin regardless, so
 * selecting it and saving always failed with a permission error from the
 * server — a confusing dead end instead of the option simply not being
 * there. Now the option is removed for anyone who isn't a Super Admin.
 */
function ensureRoleOptionsForActingRole() {
  const adminOption = dom.userFormRole.querySelector('option[value="admin"]');
  if (!isSuperAdmin(currentRole)) {
    adminOption?.remove();
  } else if (!adminOption) {
    dom.userFormRole.insertAdjacentHTML("afterbegin", `<option value="admin">Admin</option>`);
  }
}

/**
 * Only a Super Admin should ever be offered "Super Admin" as a filter value
 * or a role choice in the Add/Edit form — Admins shouldn't even know the
 * option exists, per "Super Admin hidden from normal admin views".
 */
function ensureSuperAdminOptions() {
  if (!isSuperAdmin(currentRole)) return;

  if (!dom.roleFilter.querySelector('option[value="super_admin"]')) {
    dom.roleFilter.insertAdjacentHTML("beforeend", `<option value="super_admin">Super Admin</option>`);
  }
  if (!dom.userFormRole.querySelector('option[value="super_admin"]')) {
    dom.userFormRole.insertAdjacentHTML("beforeend", `<option value="super_admin">Super Admin</option>`);
  }
}

function wireEvents() {
  dom.search.addEventListener("input", debounce(() => {
    state.search = dom.search.value;
    state.page = 1;
    renderTable();
  }, 250));

  dom.roleFilter.addEventListener("change", () => {
    state.roleFilter = dom.roleFilter.value;
    state.page = 1;
    renderTable();
  });

  dom.statusFilter.addEventListener("change", () => {
    state.statusFilter = dom.statusFilter.value;
    state.page = 1;
    renderTable();
  });

  dom.timerFilter.addEventListener("change", () => {
    state.timerFilter = dom.timerFilter.value;
    state.page = 1;
    renderTable();
  });

  dom.addUserBtn.addEventListener("click", () => {
    dom.userForm.reset();
    clearFormErrors();
    dom.userFormId.value = "";
    dom.userFormRole.value = "employee";
    dom.userModalTitle.textContent = "Add User";
    dom.userModalSubtitle.textContent = "Creates a real account the person can sign in with.";
    dom.userFormEmail.disabled = false;
    dom.userFormPasswordGroup.hidden = false;
    dom.userFormPassword.required = true;
    dom.userFormSubmitBtn.textContent = "Save User";
    openModal("userModal");
  });

  dom.tableBody.addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-user]");
    const deleteBtn = event.target.closest("[data-delete-user]");
    const promoteBtn = event.target.closest("[data-promote-user]");
    const demoteBtn = event.target.closest("[data-demote-user]");
    const notifyBtn = event.target.closest("[data-notify-user]");

    if (editBtn && !editBtn.disabled) openEditModal(editBtn.dataset.editUser);
    if (deleteBtn && !deleteBtn.disabled) handleDelete(deleteBtn.dataset.deleteUser);
    if (promoteBtn) handleRoleChange(promoteBtn.dataset.promoteUser, "admin");
    if (demoteBtn) handleRoleChange(demoteBtn.dataset.demoteUser, "employee");
    if (notifyBtn && !notifyBtn.disabled) {
      openNotifyModal(notifyBtn.dataset.notifyUser, notifyBtn.dataset.notifyUserName);
    }
  });

  dom.userForm.addEventListener("submit", handleFormSubmit);
  dom.notifyUserForm.addEventListener("submit", handleNotifyFormSubmit);
}

function openNotifyModal(recipientId, recipientName) {
  dom.notifyUserForm.reset();
  dom.notifyUserFormMessageError.textContent = "";
  dom.notifyUserFormRecipientId.value = recipientId;
  dom.notifyUserModalSubtitle.textContent = `This message will appear in ${recipientName}'s notification bell.`;
  openModal("notifyUserModal");
}

async function handleNotifyFormSubmit(event) {
  event.preventDefault();
  const recipientId = dom.notifyUserFormRecipientId.value;
  const message = dom.notifyUserFormMessage.value.trim();

  if (!message) {
    dom.notifyUserFormMessageError.textContent = "Message can't be blank.";
    return;
  }
  dom.notifyUserFormMessageError.textContent = "";
  dom.notifyUserFormSubmitBtn.disabled = true;

  try {
    await sendNotification({ recipientIds: [recipientId], message });
    closeModal("notifyUserModal");
    showToast("Notification sent", "success");
  } catch (error) {
    showToast(error.message || "Could not send notification", "error");
  } finally {
    dom.notifyUserFormSubmitBtn.disabled = false;
  }
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function getFiltered() {
  const query = state.search.trim().toLowerCase();

  return profilesList.filter((p) => {
    const matchesSearch =
      !query ||
      (p.full_name || "").toLowerCase().includes(query) ||
      (p.email || "").toLowerCase().includes(query);

    const matchesRole = !state.roleFilter || p.role === state.roleFilter;

    const isOnline = isUserOnline(p.id);
    const matchesStatus =
      !state.statusFilter || (state.statusFilter === "online" ? isOnline : !isOnline);

    const matchesTimer = matchesTimerFilter(p.id);

    return matchesSearch && matchesRole && matchesStatus && matchesTimer;
  });
}

/**
 * Timer-status filter — separate from the presence-based Status
 * filter above. "working"/"paused" both require a fresh (non-stale)
 * work_sessions row (see isUserWorking); "not_working" is everyone else,
 * including users who are online/idle but have no timer running.
 */
function matchesTimerFilter(userId) {
  if (!state.timerFilter) return true;
  const entry = activeSessions.get(userId);
  const working = isUserWorking(userId);

  if (state.timerFilter === "working") return working && entry.status !== "paused";
  if (state.timerFilter === "paused") return working && entry.status === "paused";
  if (state.timerFilter === "not_working") return !working;
  return true;
}

/**
 * True only if the user has a running/paused session AND its heartbeat is
 * still fresh — otherwise (tab closed without clicking Stop) it doesn't
 * count as "working" even though the DB row is technically still open.
 */
function isUserWorking(userId) {
  const entry = activeSessions.get(userId);
  if (!entry) return false;
  return isSessionFresh({ last_heartbeat_at: entry.lastSeenAt });
}

/**
 * "Present" = has a live presence-channel connection OR a fresh timer
 * session. In practice a running timer always implies a fresh presence
 * connection too (the heartbeat only ticks while the tab is open), so this
 * mainly guards against a brief gap between the two signals updating —
 * it keeps the "Online now" status filter from flickering someone to
 * "offline" for a moment while their timer is clearly still active.
 */
function isUserPresent(userId) {
  return isUserWorking(userId) || onlineUserIds.has(userId);
}

// Kept for the existing "online"/"offline" status-filter dropdown, which
// only has those two options — "online" means "present" per isUserPresent
// above. Working/Paused/Not working live in their own Timer filter now
// (see matchesTimerFilter), so this only governs the Status column.
const isUserOnline = isUserPresent;

/**
 * Status column: pure "is their tab open right now" presence, independent
 * of whether a timer happens to be running (see the Timer column below for
 * that). Anyone actively timing must have a tab open, so this and the
 * Timer column never contradict each other — they just answer two
 * different questions ("are they here" vs "are they clocked in").
 */
function statusLabel(userId) {
  return onlineUserIds.has(userId) ? "Online" : "Offline";
}

function statusBadgeClass(userId) {
  return onlineUserIds.has(userId) ? "badge-online" : "badge-offline";
}

/**
 * Timer column: is this user's work timer actually running right now.
 * "Working" / "Paused" both require a fresh (non-stale) work_sessions row;
 * everyone else — including users who are Online but haven't started a
 * timer — shows "Not working".
 */
function timerLabel(userId) {
  if (!isUserWorking(userId)) return "Not working";
  const entry = activeSessions.get(userId);
  if (entry.status === "paused") return "Paused";
  return entry.projectName ? `Working on ${entry.projectName}` : "Working";
}

function timerBadgeClass(userId) {
  if (!isUserWorking(userId)) return "badge-offline";
  const entry = activeSessions.get(userId);
  return entry.status === "paused" ? "badge-idle" : "badge-online";
}

function renderTable() {
  const filtered = getFiltered();
  const start = (state.page - 1) * state.pageSize;
  const pageRows = filtered.slice(start, start + state.pageSize);

  dom.emptyState.hidden = filtered.length > 0;
  dom.tableWrapper.hidden = filtered.length === 0;

  dom.tableBody.innerHTML = pageRows
    .map((p) => {
      const isSelf = p.id === currentUser.id;
      const targetRole = p.role || "employee";
      const canManage = !isSelf && canManageRole(currentRole, targetRole);

      const disabledAttr = (reason) => (canManage ? "" : `disabled title="${reason}"`);
      const deleteDisabledReason = isSelf ? "You can't delete your own account" : "You don't have permission to manage this user";

      let promoteBtn = "";
      if (isSuperAdmin(currentRole) && !isSelf) {
        if (targetRole === "admin") {
          promoteBtn = `<button type="button" class="btn btn-outline btn-sm" data-demote-user="${p.id}">Demote</button>`;
        } else if (targetRole === "employee") {
          promoteBtn = `<button type="button" class="btn btn-outline btn-sm" data-promote-user="${p.id}">Promote</button>`;
        }
      }

      const name = p.full_name || p.email || "—";

      return `
      <tr class="${isSelf ? "is-current-user" : ""}">
        <td>
          <div class="table-user-cell">
            <div class="user-avatar" style="background-color:${getAvatarColor(name)}" aria-hidden="true">${escapeHtml(getInitials(name))}</div>
            <span>${escapeHtml(p.full_name || "—")}</span>
          </div>
        </td>
        <td>${escapeHtml(p.email)}</td>
        <td><span class="user-role-badge">${escapeHtml(formatRoleLabel(targetRole))}</span></td>
        <td><span class="badge ${statusBadgeClass(p.id)}"><span class="badge-dot"></span>${escapeHtml(statusLabel(p.id))}</span></td>
        <td><span class="badge ${timerBadgeClass(p.id)}"><span class="badge-dot"></span>${escapeHtml(timerLabel(p.id))}</span></td>
        <td>${new Date(p.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}</td>
        <td>
          <div class="table-row-actions">
            ${promoteBtn}
            <button type="button" class="btn btn-outline btn-sm" data-notify-user="${p.id}" data-notify-user-name="${escapeHtml(name)}" ${isSelf ? `disabled title="You can't notify yourself"` : ""}>Notify</button>
            <button type="button" class="btn btn-outline btn-sm" data-edit-user="${p.id}" ${disabledAttr("You don't have permission to edit this user")}>Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-delete-user="${p.id}" ${isSelf || !canManage ? `disabled title="${deleteDisabledReason}"` : ""}>Delete</button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  renderPagination(dom.pagination, { page: state.page, pageSize: state.pageSize, total: filtered.length }, (page) => {
    state.page = page;
    renderTable();
  });
}

function openEditModal(id) {
  const profile = profilesList.find((p) => p.id === id);
  if (!profile) return;

  dom.userForm.reset();
  clearFormErrors();
  dom.userFormId.value = profile.id;
  dom.userFormName.value = profile.full_name || "";
  dom.userFormEmail.value = profile.email || "";
  dom.userFormEmail.disabled = true; // email changes require the Admin API elsewhere
  // Guard rail: this row should already be excluded from the list for
  // anyone who can't manage it, but never trust that alone — re-check here.
  if (profile.id !== currentUser.id && !canManageRole(currentRole, profile.role || "employee")) {
    showToast("You don't have permission to edit this user.", "error");
    return;
  }

  dom.userFormRole.value = profile.role || "employee";
  dom.userFormPasswordGroup.hidden = true;
  dom.userFormPassword.required = false;
  dom.userModalTitle.textContent = "Edit User";
  dom.userModalSubtitle.textContent = "Update this team member's name and role.";
  dom.userFormSubmitBtn.textContent = "Save Changes";
  openModal("userModal");
}

async function handleDelete(id) {
  const profile = profilesList.find((p) => p.id === id);
  if (!profile || profile.id === currentUser.id) return;
  if (!canManageRole(currentRole, profile.role || "employee")) {
    showToast("You don't have permission to delete this user.", "error");
    return;
  }

  const confirmed = await confirmDialog({
    title: "Delete this user?",
    message: `"${profile.full_name || profile.email}" will lose access permanently. This can't be undone.`,
  });
  if (!confirmed) return;

  try {
    await adminDeleteUser(id, { actingRole: currentRole, targetRole: profile.role || "employee" });
    showToast("User deleted", "success");
    await loadUsers();
  } catch (error) {
    showToast(error.message || "Could not delete this user.", "error");
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();
  clearFormErrors();

  const isEditing = Boolean(dom.userFormId.value);
  const fullName = dom.userFormName.value.trim();
  const email = dom.userFormEmail.value.trim();
  const role = dom.userFormRole.value;
  let valid = true;

  if (!fullName) {
    dom.userFormNameError.textContent = "Full name is required.";
    valid = false;
  }
  if (!isEditing) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      dom.userFormEmailError.textContent = "Enter a valid email address.";
      valid = false;
    }
    if (!dom.userFormPassword.value || dom.userFormPassword.value.length < 8) {
      dom.userFormPasswordError.textContent = "Temporary password must be at least 8 characters.";
      valid = false;
    }
    if (role === "super_admin" && !isSuperAdmin(currentRole)) {
      showToast("Only a Super Admin can create another Super Admin.", "error");
      valid = false;
    }
  }
  if (!valid) return;

  dom.userFormSubmitBtn.disabled = true;
  try {
    if (isEditing) {
      const id = dom.userFormId.value;
      const original = profilesList.find((p) => p.id === id);
      const originalRole = original?.role || "employee";
      const roleChanged = role !== originalRole;
      const isSelf = id === currentUser.id;

      if (isSelf) {
        // Editing your OWN row: RLS permits this directly (auth.uid() = id).
        // Role changes to your own account are blocked server-side anyway,
        // so there's nothing else to do here even if `role` differs.
        await updateProfile(id, { full_name: fullName });
      } else {
        // BUG FIXED: editing someone else's name used to go through the
        // plain client-side updateProfile() (anon key). RLS only allows a
        // user to update their OWN profiles row, so that update always
        // matched zero rows for another user and .select().single() then
        // threw "Cannot coerce the result to a single JSON object" — this
        // is what caused every "Edit User" save (on anyone but yourself)
        // to fail. Route name + role together through the service-role
        // Edge Function instead, which isn't subject to that RLS rule.
        await adminUpdateUserRole(id, roleChanged ? role : null, {
          actingRole: currentRole,
          targetRole: originalRole,
          fullName,
        });
      }
      showToast("User updated", "success");
    } else {
      await adminCreateUser({ email, password: dom.userFormPassword.value, fullName, role });
      showToast("User created", "success");
    }
    closeModal("userModal");
    await loadUsers();
  } catch (error) {
    showToast(error.message || "Could not save this user.", "error");
  } finally {
    dom.userFormSubmitBtn.disabled = false;
  }
}

/** Quick one-click Promote/Demote from the table row (skips opening the modal). */
async function handleRoleChange(id, newRole) {
  const profile = profilesList.find((p) => p.id === id);
  if (!profile) return;

  const targetLabel = formatRoleLabel(profile.role || "employee");
  const nextLabel = formatRoleLabel(newRole);
  const confirmed = await confirmDialog({
    title: newRole === "admin" ? "Promote this user?" : "Demote this user?",
    message: `"${profile.full_name || profile.email}" will change from ${targetLabel} to ${nextLabel}.`,
    confirmLabel: newRole === "admin" ? "Promote" : "Demote",
  });
  if (!confirmed) return;

  try {
    await adminUpdateUserRole(id, newRole, { actingRole: currentRole, targetRole: profile.role || "employee" });
    showToast(`User ${newRole === "admin" ? "promoted" : "demoted"}`, "success");
    await loadUsers();
  } catch (error) {
    showToast(error.message || "Could not change this user's role.", "error");
  }
}

function formatRoleLabel(role) {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Admin";
  return "Employee";
}

function clearFormErrors() {
  dom.userFormNameError.textContent = "";
  dom.userFormEmailError.textContent = "";
  dom.userFormPasswordError.textContent = "";
}
// ============================================================================
// Notifications module — powers the topbar bell button
// ----------------------------------------------------------------------------
// Previously the bell button (#notificationsBtn) had no click handler at
// all anywhere in the app, and js/data.js's sendNotification() /
// getNotificationsForUser() / markNotificationRead() were written but never
// called from any UI. This module is the missing wiring: it loads the
// signed-in user's notifications, renders them in a dropdown, keeps an
// unread-count badge on the bell, and marks messages read on click/"mark
// all read" — plus a live Realtime subscription so a new notification
// shows up without a page refresh, matching presence.js's pattern for
// work_sessions.
//
// CHANGED PER CLIENT REQUEST: added a "Notifications | Trash" tab switcher
// inside the same panel. Deleting a notification is a SOFT delete (see
// data.js's softDeleteNotification — it stamps deleted_at rather than
// removing the row), so it moves into the Trash tab instead of vanishing.
// From Trash, a notification can be Restored back to the main list,
// deleted permanently (a real, unrecoverable DELETE), or the whole Trash
// can be cleared at once via "Delete all". The Realtime subscription below
// was widened from INSERT-only to "*" so a delete/restore/permanent-delete
// done from another tab or device stays in sync here too, without a
// manual refresh.
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getNotificationsForUser,
  getTrashedNotificationsForUser,
  markNotificationRead,
  markAllNotificationsRead,
  softDeleteNotification,
  restoreNotification,
  permanentlyDeleteNotification,
  emptyNotificationsTrash,
} from "./data.js";
import { supabase, isSupabaseConfigured } from "./supabase.js";
import { escapeHtml } from "./report-utils.js";

const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 7h14M10 11v6M14 11v6M6.5 7l1-3h9l1 3M8 7v12a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 19V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RESTORE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 8.5A8 8 0 1 1 4.5 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 4v4.5h4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

let dom = null;
let currentUserId = null;
let notifications = []; // inbox: deleted_at IS NULL
let trashed = []; // trash: deleted_at IS NOT NULL
let isOpen = false;
let activeTab = "inbox"; // "inbox" | "trash"
let trashLoaded = false;

document.addEventListener("DOMContentLoaded", initNotifications);

async function initNotifications() {
  dom = {
    btn: document.getElementById("notificationsBtn"),
    panel: document.getElementById("notificationsPanel"),
    label: document.getElementById("notificationsPanelLabel"),
    inboxTabBtn: document.getElementById("notificationsTabBtn"),
    trashTabBtn: document.getElementById("trashTabBtn"),
    list: document.getElementById("notificationsList"),
    empty: document.getElementById("notificationsEmpty"),
    trashList: document.getElementById("trashList"),
    trashEmpty: document.getElementById("trashEmpty"),
    markAllBtn: document.getElementById("markAllNotificationsReadBtn"),
    emptyTrashBtn: document.getElementById("emptyTrashBtn"),
  };
  if (!dom.btn) return; // topbar not present on this page

  const user = await getCurrentUser();
  if (!user) return;
  currentUserId = user.id;

  await loadNotifications();

  dom.btn.addEventListener("click", (event) => {
    event.stopPropagation();
    isOpen ? closePanel() : openPanel();
  });

  document.addEventListener("click", (event) => {
    if (isOpen && !dom.panel.contains(event.target) && event.target !== dom.btn) closePanel();
  });

  dom.inboxTabBtn.addEventListener("click", () => switchTab("inbox"));
  dom.trashTabBtn.addEventListener("click", () => switchTab("trash"));

  dom.markAllBtn.addEventListener("click", async () => {
    try {
      await markAllNotificationsRead(currentUserId);
      notifications = notifications.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
      renderActiveTab();
    } catch (error) {
      console.error("Mark all read failed:", error.message);
    }
  });

  dom.emptyTrashBtn.addEventListener("click", async () => {
    if (trashed.length === 0) return;
    const confirmed = window.confirm(
      `Permanently delete ${trashed.length} notification${trashed.length === 1 ? "" : "s"} from Trash? This cannot be undone.`
    );
    if (!confirmed) return;
    try {
      await emptyNotificationsTrash(currentUserId);
      trashed = [];
      renderActiveTab();
    } catch (error) {
      console.error("Empty trash failed:", error.message);
      // CHANGED: same silent-failure issue as handlePermanentDelete above.
      window.alert("Couldn't empty Trash: " + error.message);
    }
  });

  // Inbox: click an unread item's body to mark it read; click its delete
  // button to soft-delete it into Trash. stopPropagation on the action
  // button (see renderInbox) keeps those two from firing together.
  dom.list.addEventListener("click", async (event) => {
    const deleteBtn = event.target.closest("[data-delete-id]");
    if (deleteBtn) {
      await handleSoftDelete(deleteBtn.dataset.deleteId);
      return;
    }

    const item = event.target.closest("[data-notification-id]");
    if (!item || item.dataset.read === "true") return;
    const id = item.dataset.notificationId;
    try {
      await markNotificationRead(id);
      const target = notifications.find((n) => n.id === id);
      if (target) target.read_at = new Date().toISOString();
      renderActiveTab();
    } catch (error) {
      console.error("Mark read failed:", error.message);
    }
  });

  // Trash: restore or permanently delete a single item.
  dom.trashList.addEventListener("click", async (event) => {
    const restoreBtn = event.target.closest("[data-restore-id]");
    if (restoreBtn) {
      await handleRestore(restoreBtn.dataset.restoreId);
      return;
    }

    const permDeleteBtn = event.target.closest("[data-perm-delete-id]");
    if (permDeleteBtn) {
      await handlePermanentDelete(permDeleteBtn.dataset.permDeleteId);
    }
  });

  if (isSupabaseConfigured) {
    // CHANGED PER CLIENT REQUEST: widened from INSERT-only to "*" so a
    // delete/restore/permanent-delete made elsewhere (another tab, another
    // signed-in device) is reflected here immediately too — see
    // handleRealtimeChange.
    supabase
      .channel("notifications_for_" + currentUserId)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications", filter: `recipient_id=eq.${currentUserId}` },
        handleRealtimeChange
      )
      .subscribe();
  }
}

async function loadNotifications() {
  try {
    notifications = await getNotificationsForUser(currentUserId);
  } catch (error) {
    console.error("Notifications load failed:", error.message);
    notifications = [];
  }
  renderActiveTab();
}

async function loadTrash() {
  try {
    trashed = await getTrashedNotificationsForUser(currentUserId);
    trashLoaded = true;
  } catch (error) {
    console.error("Trash load failed:", error.message);
    trashed = [];
  }
  renderActiveTab();
}

async function handleSoftDelete(id) {
  // Optimistic: remove from inbox and (if Trash has already been loaded
  // this session) drop it straight into the local trashed array too, so
  // switching tabs feels instant instead of waiting on a re-fetch.
  const target = notifications.find((n) => n.id === id);
  notifications = notifications.filter((n) => n.id !== id);
  renderActiveTab();

  try {
    await softDeleteNotification(id);
    if (target) {
      const withDeletedAt = { ...target, deleted_at: new Date().toISOString() };
      trashed = [withDeletedAt, ...trashed.filter((n) => n.id !== id)];
      renderActiveTab();
    }
  } catch (error) {
    console.error("Delete notification failed:", error.message);
    // Roll back the optimistic removal so the UI still matches the DB.
    if (target) notifications = [target, ...notifications];
    renderActiveTab();
  }
}

async function handleRestore(id) {
  const target = trashed.find((n) => n.id === id);
  trashed = trashed.filter((n) => n.id !== id);
  renderActiveTab();

  try {
    await restoreNotification(id);
    if (target) {
      const restored = { ...target, deleted_at: null };
      notifications = [restored, ...notifications.filter((n) => n.id !== id)].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      renderActiveTab();
    }
  } catch (error) {
    console.error("Restore notification failed:", error.message);
    if (target) trashed = [target, ...trashed];
    renderActiveTab();
  }
}

async function handlePermanentDelete(id) {
  const target = trashed.find((n) => n.id === id);
  const confirmed = window.confirm("Permanently delete this notification? This cannot be undone.");
  if (!confirmed) return;

  trashed = trashed.filter((n) => n.id !== id);
  renderActiveTab();

  try {
    await permanentlyDeleteNotification(id);
  } catch (error) {
    console.error("Permanent delete failed:", error.message);
    // CHANGED: this used to fail silently (console.error only) — the item
    // would just quietly reappear in Trash with no explanation. Now the
    // user actually sees why it didn't work.
    window.alert("Couldn't delete this notification: " + error.message);
    if (target) trashed = [target, ...trashed];
    renderActiveTab();
  }
}

/**
 * Keeps this tab's state correct when a notification is inserted,
 * soft-deleted, restored, or permanently deleted from anywhere else
 * (another open tab, another signed-in device) — not just changes made
 * right here.
 */
function handleRealtimeChange(payload) {
  if (payload.eventType === "INSERT") {
    const row = payload.new;
    if (!row.deleted_at) notifications = [row, ...notifications.filter((n) => n.id !== row.id)];
    renderActiveTab();
    return;
  }

  if (payload.eventType === "UPDATE") {
    const row = payload.new;

    if (row.deleted_at) {
      // Now trashed: remove from inbox, upsert into trash.
      notifications = notifications.filter((n) => n.id !== row.id);
      trashed = [row, ...trashed.filter((n) => n.id !== row.id)];
    } else {
      // Now active (or was already): remove from trash, upsert into inbox.
      trashed = trashed.filter((n) => n.id !== row.id);
      notifications = [row, ...notifications.filter((n) => n.id !== row.id)].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
    }

    renderActiveTab();
    return;
  }

  if (payload.eventType === "DELETE") {
    const id = payload.old?.id;
    if (!id) return;
    notifications = notifications.filter((n) => n.id !== id);
    trashed = trashed.filter((n) => n.id !== id);
    renderActiveTab();
  }
}

function openPanel() {
  isOpen = true;
  dom.panel.hidden = false;
  dom.btn.setAttribute("aria-expanded", "true");
}

function closePanel() {
  isOpen = false;
  dom.panel.hidden = true;
  dom.btn.setAttribute("aria-expanded", "false");
}

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;

  const isTrash = activeTab === "trash";
  dom.inboxTabBtn.classList.toggle("is-active", !isTrash);
  dom.inboxTabBtn.setAttribute("aria-selected", String(!isTrash));
  dom.trashTabBtn.classList.toggle("is-active", isTrash);
  dom.trashTabBtn.setAttribute("aria-selected", String(isTrash));

  dom.list.hidden = isTrash;
  dom.trashList.hidden = !isTrash;
  dom.markAllBtn.hidden = isTrash;
  dom.emptyTrashBtn.hidden = !isTrash;
  if (dom.label) dom.label.textContent = isTrash ? "Trash" : "Notifications";

  if (isTrash && !trashLoaded) {
    loadTrash();
  } else {
    renderActiveTab();
  }
}

function renderActiveTab() {
  renderBadge();
  renderInbox();
  renderTrash();
}

function renderBadge() {
  // Unread count is based on the inbox only — a trashed notification
  // shouldn't keep contributing to the bell's badge.
  const unreadCount = notifications.filter((n) => !n.read_at).length;

  if (unreadCount > 0) {
    dom.btn.dataset.count = unreadCount > 9 ? "9+" : String(unreadCount);
  } else {
    delete dom.btn.dataset.count;
  }
}

function renderInbox() {
  dom.empty.hidden = notifications.length > 0;

  dom.list.innerHTML = notifications
    .map((n) => {
      const senderName = n.sender?.full_name || n.sender?.email || "Someone";
      const when = new Date(n.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const isRead = Boolean(n.read_at);
      return `
        <div class="notification-item ${isRead ? "is-read" : "is-unread"}" data-notification-id="${n.id}" data-read="${isRead}">
          <div class="notification-item-body">
            <p class="notification-sender">${escapeHtml(senderName)}</p>
            <p class="notification-message">${escapeHtml(n.message)}</p>
            <p class="notification-time">${when}</p>
          </div>
          <div class="notification-item-actions">
            <button type="button" class="notification-action-btn is-danger" data-delete-id="${n.id}" title="Delete" aria-label="Delete notification">${TRASH_ICON}</button>
          </div>
        </div>`;
    })
    .join("");
}

function renderTrash() {
  if (dom.trashList.hidden) return; // avoid pointless DOM writes while not visible

  dom.trashEmpty.hidden = trashed.length > 0;

  dom.trashList.innerHTML = trashed
    .map((n) => {
      const senderName = n.sender?.full_name || n.sender?.email || "Someone";
      const when = new Date(n.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      return `
        <div class="notification-item is-read" data-notification-id="${n.id}">
          <div class="notification-item-body">
            <p class="notification-sender">${escapeHtml(senderName)}</p>
            <p class="notification-message">${escapeHtml(n.message)}</p>
            <p class="notification-time">${when}</p>
          </div>
          <div class="notification-item-actions">
            <button type="button" class="notification-action-btn is-success" data-restore-id="${n.id}" title="Restore" aria-label="Restore notification">${RESTORE_ICON}</button>
            <button type="button" class="notification-action-btn is-danger" data-perm-delete-id="${n.id}" title="Delete permanently" aria-label="Delete notification permanently">${CLOSE_ICON}</button>
          </div>
        </div>`;
    })
    .join("");
}

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
// ============================================================================

import { getCurrentUser } from "./auth.js";
import { getNotificationsForUser, markNotificationRead, markAllNotificationsRead } from "./data.js";
import { supabase, isSupabaseConfigured } from "./supabase.js";
import { escapeHtml } from "./report-utils.js";

let dom = null;
let currentUserId = null;
let notifications = [];
let isOpen = false;

document.addEventListener("DOMContentLoaded", initNotifications);

async function initNotifications() {
  dom = {
    btn: document.getElementById("notificationsBtn"),
    panel: document.getElementById("notificationsPanel"),
    list: document.getElementById("notificationsList"),
    empty: document.getElementById("notificationsEmpty"),
    markAllBtn: document.getElementById("markAllNotificationsReadBtn"),
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

  dom.markAllBtn.addEventListener("click", async () => {
    try {
      await markAllNotificationsRead(currentUserId);
      notifications = notifications.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
      renderList();
    } catch (error) {
      console.error("Mark all read failed:", error.message);
    }
  });

  dom.list.addEventListener("click", async (event) => {
    const item = event.target.closest("[data-notification-id]");
    if (!item || item.dataset.read === "true") return;
    const id = item.dataset.notificationId;
    try {
      await markNotificationRead(id);
      const target = notifications.find((n) => n.id === id);
      if (target) target.read_at = new Date().toISOString();
      renderList();
    } catch (error) {
      console.error("Mark read failed:", error.message);
    }
  });

  if (isSupabaseConfigured) {
    supabase
      .channel("notifications_for_" + currentUserId)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `recipient_id=eq.${currentUserId}` },
        (payload) => {
          notifications = [payload.new, ...notifications];
          renderList();
        }
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
  renderList();
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

function renderList() {
  const unreadCount = notifications.filter((n) => !n.read_at).length;

  if (unreadCount > 0) {
    dom.btn.dataset.count = unreadCount > 9 ? "9+" : String(unreadCount);
  } else {
    delete dom.btn.dataset.count;
  }

  dom.empty.hidden = notifications.length > 0;

  dom.list.innerHTML = notifications
    .map((n) => {
      const senderName = n.sender?.full_name || n.sender?.email || "Someone";
      const when = new Date(n.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const isRead = Boolean(n.read_at);
      return `
        <div class="notification-item ${isRead ? "is-read" : "is-unread"}" data-notification-id="${n.id}" data-read="${isRead}">
          <p class="notification-sender">${escapeHtml(senderName)}</p>
          <p class="notification-message">${escapeHtml(n.message)}</p>
          <p class="notification-time">${when}</p>
        </div>`;
    })
    .join("");
}

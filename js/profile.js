// ============================================================================
// Profile module
// ----------------------------------------------------------------------------
// Shows the signed-in user's own identity, live online/offline status, own
// time stats/charts, and lets them edit their display name, change their
// password, and export their own sessions. All data is the user's own row(s)
// — RLS already restricts non-admins to their own profile/sessions anyway.
// ============================================================================

import { getCurrentUser, updateDisplayName, changePassword } from "./auth.js";
import {
  getProfileById,
  updateProfile,
  getActiveSessionForUser,
  getSessionsForUser,
  formatDuration,
  getDateRangeForPreset,
} from "./data.js";
import { renderChart, renderLegend, setChartEmptyState, CHART_COLORS } from "./charts.js";
import { paintAvatar, formatRoleLabel } from "./avatar.js";
import { openModal, closeModal, initModalDismissal } from "./modal.js";
import { showToast } from "./toast.js";
import { exportRowsToExcel, exportRowsToCsv } from "./export.js";
import {
  lastNDays,
  groupHoursByProject,
  dailyHoursSeries,
  dayLabelsShort,
  dayLabelsMonthDay,
  formatDateOnly,
  formatTimeOnly,
  secondsToDecimalHours,
  resolveTaskStatus,
  taskStatusLabel,
  escapeHtml,
} from "./report-utils.js";

let currentUser = null;
let dom = {};

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

    editProfileBtn: document.getElementById("editProfileBtn"),
    changePasswordBtn: document.getElementById("changePasswordBtn"),

    statToday: document.getElementById("profileStatToday"),
    statWeek: document.getElementById("profileStatWeek"),
    statMonth: document.getElementById("profileStatMonth"),
    statTotal: document.getElementById("profileStatTotal"),

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

    exportDateFilter: document.getElementById("profileExportDateFilter"),
    exportDateFrom: document.getElementById("profileExportDateFrom"),
    exportDateTo: document.getElementById("profileExportDateTo"),
    exportExcelBtn: document.getElementById("profileExportExcelBtn"),
    exportCsvBtn: document.getElementById("profileExportCsvBtn"),
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
  const [profile, activeSession, sessionsResult] = await Promise.all([
    safeCall(() => getProfileById(currentUser.id)),
    safeCall(() => getActiveSessionForUser(currentUser.id)),
    safeCall(() => getSessionsForUser(currentUser.id, { page: 1, pageSize: 5000 }), { rows: [] }),
  ]);

  renderIdentity(profile, activeSession);

  const completedSessions = (sessionsResult?.rows || []).filter((s) => s.status === "completed");
  renderStats(completedSessions, activeSession);
  renderCharts(completedSessions);

  wireExport(sessionsResult?.rows || []);
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
}

function renderStats(completedSessions, activeSession) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfToday.getDay() + 6) % 7));
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let today = 0, week = 0, month = 0, total = 0;

  completedSessions.forEach((s) => {
    const startedAt = new Date(s.started_at);
    const duration = s.duration_seconds || 0;
    total += duration;
    if (startedAt >= startOfMonth) month += duration;
    if (startedAt >= startOfWeek) week += duration;
    if (startedAt >= startOfToday) today += duration;
  });

  if (activeSession && new Date(activeSession.started_at) >= startOfToday) {
    const startedAt = new Date(activeSession.started_at).getTime();
    const pausedMs = activeSession.total_paused_seconds * 1000;
    const liveSeconds = Math.max(0, Math.floor((Date.now() - startedAt - pausedMs) / 1000));
    today += liveSeconds;
    week += liveSeconds;
    month += liveSeconds;
    total += liveSeconds;
  }

  dom.statToday.textContent = formatDuration(today);
  dom.statWeek.textContent = formatDuration(week);
  dom.statMonth.textContent = formatDuration(month);
  dom.statTotal.textContent = formatDuration(total);
}

function renderCharts(completedSessions) {
  renderProjectPie(completedSessions);
  renderWeeklyBar(completedSessions);
  renderMonthlyLine(completedSessions);
}

function renderProjectPie(sessions) {
  const canvas = document.getElementById("profilePieChart");
  const legendEl = document.getElementById("profilePieLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const { labels, values } = groupHoursByProject(sessions);
  const isEmpty = labels.length === 0 || values.every((v) => v === 0);

  setChartEmptyState(wrapper, isEmpty, "No completed sessions yet");
  renderChart(canvas, "pie", {
    labels: isEmpty ? ["No data"] : labels,
    datasets: [{ data: isEmpty ? [1] : values, backgroundColor: isEmpty ? ["#e2e8f0"] : CHART_COLORS }],
  });
  renderLegend(legendEl, isEmpty ? ["No data yet"] : labels, isEmpty ? ["#e2e8f0"] : CHART_COLORS);
}

function renderWeeklyBar(sessions) {
  const canvas = document.getElementById("profileBarChart");
  const legendEl = document.getElementById("profileBarLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const days = lastNDays(7);
  const hours = dailyHoursSeries(sessions, days);
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 7 days");
  renderChart(canvas, "bar", {
    labels: dayLabelsShort(days),
    datasets: [{ label: "Hours", data: hours, backgroundColor: CHART_COLORS[0], borderRadius: 6, maxBarThickness: 36 }],
  });
  renderLegend(legendEl, ["Hours worked"], [CHART_COLORS[0]]);
}

function renderMonthlyLine(sessions) {
  const canvas = document.getElementById("profileLineChart");
  const legendEl = document.getElementById("profileLineLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const days = lastNDays(30);
  const hours = dailyHoursSeries(sessions, days);
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 30 days");
  renderChart(canvas, "line", {
    labels: dayLabelsMonthDay(days),
    datasets: [{
      label: "Hours", data: hours, borderColor: CHART_COLORS[1],
      backgroundColor: "rgba(124, 58, 237, 0.1)", fill: true, tension: 0.35, pointRadius: 0,
    }],
  }, { plugins: { legend: { display: false } } });
  renderLegend(legendEl, ["Hours worked"], [CHART_COLORS[1]]);
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

/* ============================================================================
   Export
   ========================================================================== */
function wireExport(sessions) {
  dom.exportDateFilter.onchange = () => {
    const isCustom = dom.exportDateFilter.value === "custom";
    dom.exportDateFrom.hidden = !isCustom;
    dom.exportDateTo.hidden = !isCustom;
  };

  const sessionsInRange = () => {
    const preset = dom.exportDateFilter.value;
    if (preset === "all") return sessions;

    if (preset === "custom") {
      if (!dom.exportDateFrom.value || !dom.exportDateTo.value) return null; // wait for both dates
      const { from, to } = getDateRangeForPreset("custom", {
        customFrom: dom.exportDateFrom.value,
        customTo: dom.exportDateTo.value,
      });
      return sessions.filter((s) => {
        const startedAt = new Date(s.started_at);
        return startedAt >= from && startedAt <= to;
      });
    }

    const { from, to } = getDateRangeForPreset(preset);
    return sessions.filter((s) => {
      const startedAt = new Date(s.started_at);
      return startedAt >= from && startedAt <= to;
    });
  };

  const toRows = (rows) =>
    rows.map((s) => ({
      Project: s.projects?.name || "Untitled project",
      Description: s.task_description,
      "Started Date": formatDateOnly(s.started_at),
      "Started Time": formatTimeOnly(s.started_at),
      "Ended Date": s.stopped_at ? formatDateOnly(s.stopped_at) : "—",
      "Ended Time": s.stopped_at ? formatTimeOnly(s.stopped_at) : "—",
      "Duration (hh:mm:ss)": s.status === "completed" ? formatDuration(s.duration_seconds) : "—",
      "Duration (hours)": s.status === "completed" ? secondsToDecimalHours(s.duration_seconds) : "—",
      "Task Status": taskStatusLabel(resolveTaskStatus(s)),
    }));

  dom.exportExcelBtn.onclick = () => {
    const inRange = sessionsInRange();
    if (inRange === null) return showToast("Choose both a from and to date.", "info");
    const rows = toRows(inRange);
    if (!rows.length) return showToast("Nothing to export in that range.", "info");
    exportRowsToExcel(rows, "my-sessions", "My Sessions")
      .then(() => showToast("Export ready", "success"))
      .catch(() => showToast("Could not export the data.", "error"));
  };

  dom.exportCsvBtn.onclick = () => {
    const inRange = sessionsInRange();
    if (inRange === null) return showToast("Choose both a from and to date.", "info");
    const rows = toRows(inRange);
    if (!rows.length) return showToast("Nothing to export in that range.", "info");
    exportRowsToCsv(rows, "my-sessions");
    showToast("Export ready", "success");
  };
}

// ============================================================================
// Dashboard module
// ----------------------------------------------------------------------------
// Populates the welcome card, stat tiles, active project card, recent
// activity list, and four charts — all from real work_sessions data for the
// current user. No fake/demo rows: every element has a genuine empty state.
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getActiveSessionForUser,
  getSessionsForUser,
  getProjects,
  getProfileById,
  getUserRole,
  formatDuration,
} from "./data.js";
import { renderChart, renderLegend, setChartEmptyState, CHART_COLORS } from "./charts.js";
import { paintAvatar } from "./avatar.js";

let tickInterval = null;

document.addEventListener("DOMContentLoaded", initDashboard);

// BUG FIXED: this SPA never reloads the page when switching sections — it
// just toggles `hidden` on <section> elements — so initDashboard() used to
// only ever run once, on first page load. Navigating to Projects, stopping
// a timer there, then coming back to Dashboard kept showing the old
// (already-stopped) session as still running, since nothing told this
// module to re-fetch. Re-running initDashboard() every time Dashboard is
// shown again keeps it in sync with whatever changed elsewhere.
document.addEventListener("app:section-shown", (event) => {
  if (event.detail?.sectionKey === "dashboard") {
    initDashboard();
  }
});

async function initDashboard() {
  const user = await getCurrentUser();
  if (!user) return; // app.js already handles the auth redirect

  renderGreeting(user);

  const [activeSession, sessionsResult, activeProjectsCount] = await Promise.all([
    safeCall(() => getActiveSessionForUser(user.id)),
    safeCall(() => getSessionsForUser(user.id, { page: 1, pageSize: 1000 })),
    safeCall(() => getActiveProjectsCount(user)),
  ]);

  const completedSessions = (sessionsResult?.rows || []).filter((s) => s.status === "completed");

  renderActiveSession(activeSession, activeProjectsCount || 0);
  renderStats(completedSessions, activeSession);
  renderActiveProjectCard(activeProjectsCount || 0);
  renderRecentActivity(completedSessions);
  renderCharts(completedSessions);
}

/**
 * Total count of projects with status "active" across the whole workspace
 * (not just the current user's own in-progress session). Resolves the
 * caller's role first since getProjects(role) branches on it, the same way
 * projects.js does for the Manage Projects panel.
 */
async function getActiveProjectsCount(user) {
  const profile = await getProfileById(user.id).catch(() => null);
  const role = getUserRole(profile) || getUserRole(user);
  const projects = await getProjects(role);
  return (projects || []).filter((p) => p.status === "active").length;
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (error) {
    console.error("Dashboard data load failed:", error.message);
    return null;
  }
}

function renderGreeting(user) {
  const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email;
  document.getElementById("dashboardGreeting").textContent = `Welcome Back, ${name}`;

  paintAvatar(document.getElementById("dashboardAvatar"), name);
}

/**
 * Sets the dashboard status badge to one of two states, per the client's
 * spec: green "Working" while the timer is actively running, red
 * "Not working" any other time (no session at all, or paused). Uses the
 * real .badge-online / .badge-not-working classes in Component.css — the
 * dot inherits its color from `currentColor` automatically, no inline
 * overrides needed.
 */
function setStatusBadge(badge, isWorking) {
  badge.className = `badge ${isWorking ? "badge-online" : "badge-not-working"}`;
  badge.innerHTML = `<span class="badge-dot"></span>${isWorking ? "Working" : "Not working"}`;
}

function renderActiveSession(session, activeProjectsCount) {
  const badge = document.getElementById("dashboardStatusBadge");
  const timerEl = document.getElementById("dashboardActiveTimer");
  const projectEl = document.getElementById("dashboardActiveProject");

  clearInterval(tickInterval);

  const isWorking = !!session && session.status === "running";
  setStatusBadge(badge, isWorking);

  if (!session) {
    timerEl.textContent = "00:00:00";
    // CHANGED PER CLIENT REQUEST: this used to always read the static
    // string "No active project" whenever the current user had no
    // running/paused session of their own. Now it shows the workspace-wide
    // count of projects with status "active" (e.g. "7 - active project"),
    // falling back to "No active project" only when that count is zero.
    projectEl.textContent = activeProjectsCount ? `${activeProjectsCount} - active project` : "No active project";
    return;
  }

  projectEl.textContent = `${session.projects?.name || "Untitled project"} — ${session.task_description}`;

  const startedAt = new Date(session.started_at).getTime();
  const pausedAt = session.paused_at ? new Date(session.paused_at).getTime() : null;

  const tick = () => {
    const now = Date.now();
    const pausedMs = session.total_paused_seconds * 1000 + (session.status === "paused" && pausedAt ? now - pausedAt : 0);
    const elapsedSeconds = Math.max(0, Math.floor((now - startedAt - pausedMs) / 1000));
    timerEl.textContent = formatDuration(elapsedSeconds);
  };

  tick();
  if (session.status === "running") {
    tickInterval = setInterval(tick, 1000);
  }
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

  // Reflect the live running/paused session in "today" if it started today.
  if (activeSession && new Date(activeSession.started_at) >= startOfToday) {
    const startedAt = new Date(activeSession.started_at).getTime();
    const pausedMs = activeSession.total_paused_seconds * 1000;
    const liveSeconds = Math.max(0, Math.floor((Date.now() - startedAt - pausedMs) / 1000));
    today += liveSeconds;
    week += liveSeconds;
    month += liveSeconds;
    total += liveSeconds;
  }

  // BUG FIXED: these used secondsToHoursMinutes() ("0h 11m"), inconsistent
  // with the Current Session timer right above, which uses formatDuration()
  // ("00:11:00"). Switched to formatDuration() so every duration on this
  // page reads the same way.
  document.getElementById("statToday").textContent = formatDuration(today);
  document.getElementById("statWeek").textContent = formatDuration(week);
  document.getElementById("statMonth").textContent = formatDuration(month);
  document.getElementById("statTotal").textContent = formatDuration(total);
}

/**
 * BUG FIXED / CHANGED PER CLIENT REQUEST: this card used to show the
 * current user's own in-progress session (project name + task + status),
 * falling back to "No active project" only when that user personally had
 * no running/paused session. The client wants it to instead show the
 * workspace-wide count of projects with status "active" — e.g.
 * "7 - active project" — and only fall back to "No active project" when
 * that count is genuinely zero.
 */
function renderActiveProjectCard(activeProjectsCount) {
  const emptyEl = document.getElementById("activeProjectEmpty");
  const detailsEl = document.getElementById("activeProjectDetails");

  if (!activeProjectsCount) {
    emptyEl.hidden = false;
    emptyEl.textContent = "No active project";
    detailsEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  detailsEl.hidden = false;
  detailsEl.innerHTML = `<span class="active-project-count">${activeProjectsCount} - active project</span>`;
}

function renderRecentActivity(completedSessions) {
  const emptyEl = document.getElementById("recentActivityEmpty");
  const listEl = document.getElementById("recentActivityList");

  const recent = completedSessions.slice(0, 6);

  if (recent.length === 0) {
    emptyEl.hidden = false;
    listEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  listEl.hidden = false;
  listEl.innerHTML = recent
    .map(
      (s) => `
      <li class="activity-item">
        <span class="activity-dot" aria-hidden="true"></span>
        <div class="activity-content">
          <p class="activity-title">${escapeHtml(s.projects?.name || "Untitled project")} — ${escapeHtml(s.task_description)}</p>
          <p class="activity-meta">${formatRelativeDate(s.started_at)} · ${formatDuration(s.duration_seconds)}</p>
        </div>
      </li>`
    )
    .join("");
}

function renderCharts(completedSessions) {
  renderProjectDistributionChart(completedSessions);
  renderWorkVsIdleChart(completedSessions);
  renderWeeklyBarChart(completedSessions);
  renderMonthlyLineChart(completedSessions);
}

function renderProjectDistributionChart(sessions) {
  const canvas = document.getElementById("dashboardPieChart");
  const legendEl = document.getElementById("dashboardPieLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const byProject = {};
  sessions.forEach((s) => {
    const name = s.projects?.name || "Untitled project";
    byProject[name] = (byProject[name] || 0) + (s.duration_seconds || 0);
  });

  const labels = Object.keys(byProject);
  const values = Object.values(byProject);
  const isEmpty = values.every((v) => v === 0) || labels.length === 0;

  setChartEmptyState(wrapper, isEmpty, "No completed sessions yet");
  renderChart(canvas, "pie", {
    labels,
    datasets: [{ data: isEmpty ? [1] : values, backgroundColor: isEmpty ? ["#e2e8f0"] : CHART_COLORS }],
  });
  renderLegend(legendEl, isEmpty ? ["No data yet"] : labels, isEmpty ? ["#e2e8f0"] : CHART_COLORS);
}

function renderWorkVsIdleChart(sessions) {
  const canvas = document.getElementById("dashboardDonutChart");
  const legendEl = document.getElementById("dashboardDonutLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const workedSeconds = sessions
    .filter((s) => new Date(s.started_at) >= startOfWeek)
    .reduce((sum, s) => sum + (s.duration_seconds || 0), 0);

  const weeklyTargetSeconds = 40 * 3600;
  const idleSeconds = Math.max(0, weeklyTargetSeconds - workedSeconds);
  const isEmpty = workedSeconds === 0;

  setChartEmptyState(wrapper, isEmpty, "No hours logged this week");
  renderChart(canvas, "doughnut", {
    labels: ["Worked", "Remaining (of 40h target)"],
    datasets: [{ data: [workedSeconds, idleSeconds], backgroundColor: [CHART_COLORS[0], "#e2e8f0"] }],
  });
  renderLegend(legendEl, ["Worked", "Remaining (of 40h target)"], [CHART_COLORS[0], "#e2e8f0"]);
}

function renderWeeklyBarChart(sessions) {
  const canvas = document.getElementById("dashboardBarChart");
  const legendEl = document.getElementById("dashboardBarLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const days = lastNDays(7);
  const totalsBySeconds = days.map((day) =>
    sessions
      .filter((s) => isSameDay(new Date(s.started_at), day))
      .reduce((sum, s) => sum + (s.duration_seconds || 0), 0)
  );
  const hours = totalsBySeconds.map((s) => +(s / 3600).toFixed(2));
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 7 days");
  renderChart(canvas, "bar", {
    labels: days.map((d) => d.toLocaleDateString(undefined, { weekday: "short" })),
    datasets: [{ label: "Hours", data: hours, backgroundColor: CHART_COLORS[0], borderRadius: 6, maxBarThickness: 36 }],
  });
  renderLegend(legendEl, ["Hours worked"], [CHART_COLORS[0]]);
}

function renderMonthlyLineChart(sessions) {
  const canvas = document.getElementById("dashboardLineChart");
  const legendEl = document.getElementById("dashboardLineLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const days = lastNDays(30);
  const hours = days.map((day) => {
    const seconds = sessions
      .filter((s) => isSameDay(new Date(s.started_at), day))
      .reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
    return +(seconds / 3600).toFixed(2);
  });
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 30 days");
  renderChart(canvas, "line", {
    labels: days.map((d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" })),
    datasets: [{
      label: "Hours",
      data: hours,
      borderColor: CHART_COLORS[1],
      backgroundColor: "rgba(124, 58, 237, 0.1)",
      fill: true,
      tension: 0.35,
      pointRadius: 0,
    }],
  }, { plugins: { legend: { display: false } } });
  renderLegend(legendEl, ["Hours worked"], [CHART_COLORS[1]]);
}

function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  return days;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatRelativeDate(isoString) {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
// ============================================================================
// Dashboard module
// ----------------------------------------------------------------------------
// CHANGED PER CLIENT REQUEST: this module now covers everything the old
// Overview page used to (filters, filtered KPIs, cumulative-hours chart,
// a paginated Detailed Sessions table) in addition to what it always had
// (welcome card, personal stat tiles, recent activity, and four personal
// charts). CHANGED PER CLIENT REQUEST: the Active Project card has since
// been removed (see renderRecentActivity below). The two pages had several literally-duplicate
// charts (project distribution, weekly/daily hours, monthly trend) — those
// now exist exactly once, in the "My Hours" section below. Overview's truly
// distinct pieces (filters, filtered KPI grid, cumulative-hours chart, the
// full detailed/paginated session table) were folded in as a second
// "Filtered Summary" section. overview.js has been deleted.
//
// Detailed Sessions durations now update live, once a second, for
// running/paused sessions — including other users' sessions when an admin
// is viewing the unfiltered/team-wide table (client request #2).
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getActiveSessionForUser,
  getSessionsForUser,
  getAllSessions,
  getAllProfiles,
  getProjects,
  getProfileById,
  getUserRole,
  isAdminLevel,
  getDateRangeForPreset,
  formatDuration,
  computeElapsedSeconds,
} from "./data.js";
import { renderChart, renderLegend, setChartEmptyState, CHART_COLORS } from "./charts.js";
import { paintAvatar } from "./avatar.js";
import { renderResultsSummary } from "./pagination.js";
import {
  lastNDays,
  sumDuration,
  groupHoursByProject,
  dailyHoursSeries,
  cumulativeSeries,
  dayLabelsShort,
  dayLabelsMonthDay,
  filterBySearch,
  escapeHtml,
  truncate,
  formatDateOnly,
  formatTimeOnly,
  secondsToDecimalHours,
} from "./report-utils.js";

let currentUser = null;
let currentUserRole = null;
let isAdmin = false;
let wired = false;

let tickInterval = null; // welcome-card live timer
let tableTickInterval = null; // Detailed Sessions live-duration ticker

let allSessionsFiltered = []; // Filtered Summary section's dataset, pre-search
let dom = {};

const filterState = { dateFilter: "all", projectFilter: "", userFilter: "", search: "" };
const tableState = { page: 1, pageSize: 10 };

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
  currentUser = user;

  renderGreeting(user);

  // BUG FIXED (carried over from the old overview.js): role must come from
  // the caller's own profiles row, not the raw auth user — role only ever
  // lives in public.profiles.role, never on the JWT's app_metadata/
  // user_metadata in this app.
  const profile = await safeCall(() => getProfileById(user.id), null);
  currentUserRole = getUserRole(profile) || getUserRole(user);
  isAdmin = isAdminLevel(currentUserRole);

  if (!wired) {
    cacheDom();
    wireFilterEvents();
    wired = true;
  }
  toggleAdminOnlyUi();

  const [activeSession, sessionsResult, activeProjectsCount] = await Promise.all([
    safeCall(() => getActiveSessionForUser(user.id)),
    safeCall(() => getSessionsForUser(user.id, { page: 1, pageSize: 1000 })),
    safeCall(getActiveProjectsCount),
  ]);

  const completedSessions = (sessionsResult?.rows || []).filter((s) => s.status === "completed");

  renderActiveSession(activeSession, activeProjectsCount || 0);
  renderStats(completedSessions, activeSession);
  renderRecentActivity(completedSessions);
  renderPersonalCharts(completedSessions);

  await Promise.all([loadProjectFilterOptions(), isAdmin ? loadUserFilterOptions() : Promise.resolve()]);
  await loadFilteredSection();
}

/**
 * Total count of projects with status "active" across the whole workspace
 * (not just the current user's own in-progress session).
 */
async function getActiveProjectsCount() {
  const projects = await getProjects(currentUserRole);
  return (projects || []).filter((p) => p.status === "active").length;
}

async function safeCall(fn, fallback = []) {
  try {
    return await fn();
  } catch (error) {
    console.error("Dashboard data load failed:", error.message);
    return fallback;
  }
}

function cacheDom() {
  dom = {
    search: document.getElementById("dashboardSearch"),
    dateFilter: document.getElementById("dashboardDateFilter"),
    dateFrom: document.getElementById("dashboardDateFrom"),
    dateTo: document.getElementById("dashboardDateTo"),
    projectFilter: document.getElementById("dashboardProjectFilter"),
    userFilter: document.getElementById("dashboardUserFilter"),

    filteredStatHours: document.getElementById("dashboardFilteredStatHours"),
    filteredStatSessions: document.getElementById("dashboardFilteredStatSessions"),
    filteredStatProjects: document.getElementById("dashboardFilteredStatProjects"),
    filteredStatAvg: document.getElementById("dashboardFilteredStatAvg"),

    tableWrapper: document.getElementById("dashboardTableWrapper"),
    tableBody: document.getElementById("dashboardTableBody"),
    tableEmptyState: document.getElementById("dashboardEmptyState"),
    tablePagination: document.getElementById("dashboardPagination"),
    userColumnHeader: document.querySelector('#dashboardTableWrapper thead th[data-requires-role]'),
  };
}

function toggleAdminOnlyUi() {
  dom.userFilter.hidden = !isAdmin;
  if (dom.userColumnHeader) dom.userColumnHeader.hidden = !isAdmin;
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function wireFilterEvents() {
  dom.search.addEventListener("input", debounce(() => {
    filterState.search = dom.search.value;
    tableState.page = 1;
    renderFilteredFromCache();
  }, 250));

  dom.dateFilter.addEventListener("change", () => {
    filterState.dateFilter = dom.dateFilter.value;
    const isCustom = filterState.dateFilter === "custom";
    dom.dateFrom.hidden = !isCustom;
    dom.dateTo.hidden = !isCustom;
    if (!isCustom) {
      tableState.page = 1;
      loadFilteredSection();
    }
  });

  const onCustomRangeChange = () => {
    if (dom.dateFrom.value && dom.dateTo.value) {
      tableState.page = 1;
      loadFilteredSection();
    }
  };
  dom.dateFrom.addEventListener("change", onCustomRangeChange);
  dom.dateTo.addEventListener("change", onCustomRangeChange);

  dom.projectFilter.addEventListener("change", () => {
    filterState.projectFilter = dom.projectFilter.value;
    tableState.page = 1;
    loadFilteredSection();
  });
  dom.userFilter.addEventListener("change", () => {
    filterState.userFilter = dom.userFilter.value;
    tableState.page = 1;
    loadFilteredSection();
  });
}

async function loadProjectFilterOptions() {
  const projects = await safeCall(() => getProjects(currentUserRole));
  dom.projectFilter.innerHTML =
    `<option value="">All projects</option>` +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

async function loadUserFilterOptions() {
  const profiles = await safeCall(getAllProfiles);
  dom.userFilter.innerHTML =
    `<option value="">All users</option>` +
    profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join("");
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
    projectEl.textContent = activeProjectsCount ? `${activeProjectsCount} - active project` : "No active project";
    return;
  }

  projectEl.textContent = `${session.projects?.name || "Untitled project"} — ${session.task_description}`;

  const tick = () => {
    timerEl.textContent = formatDuration(computeElapsedSeconds(session));
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
    const liveSeconds = computeElapsedSeconds(activeSession);
    today += liveSeconds;
    week += liveSeconds;
    month += liveSeconds;
    total += liveSeconds;
  }

  document.getElementById("statToday").textContent = formatDuration(today);
  document.getElementById("statWeek").textContent = formatDuration(week);
  document.getElementById("statMonth").textContent = formatDuration(month);
  document.getElementById("statTotal").textContent = formatDuration(total);
}

// CHANGED PER CLIENT REQUEST: the "Active Project" card (and the function
// that rendered it) has been removed from the Dashboard. Recent Activity
// below is now the sole card in that row and shows the last 5 activities
// only (was 6).
const RECENT_ACTIVITY_LIMIT = 5;

function renderRecentActivity(completedSessions) {
  const emptyEl = document.getElementById("recentActivityEmpty");
  const listEl = document.getElementById("recentActivityList");

  const recent = completedSessions.slice(0, RECENT_ACTIVITY_LIMIT);

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

/* ============================================================================
   "My Hours" — personal charts (unfiltered, current user only). These are
   the single canonical copies of chart types that used to also appear,
   duplicated, on the old Overview page.
   ========================================================================== */
function renderPersonalCharts(completedSessions) {
  renderProjectDistributionChart(completedSessions);
  renderWorkVsIdleChart(completedSessions);
  renderWeeklyBarChart(completedSessions);
  renderMonthlyLineChart(completedSessions);
}

function renderProjectDistributionChart(sessions) {
  const canvas = document.getElementById("dashboardPieChart");
  const legendEl = document.getElementById("dashboardPieLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const { labels, values } = groupHoursByProject(sessions);
  const isEmpty = values.length === 0 || values.every((v) => v === 0);

  setChartEmptyState(wrapper, isEmpty, "No completed sessions yet");
  renderChart(canvas, "pie", {
    labels: isEmpty ? ["No data"] : labels,
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

  const last7 = lastNDays(7);
  const hours = dailyHoursSeries(sessions, last7);
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 7 days");
  renderChart(canvas, "bar", {
    labels: dayLabelsShort(last7),
    datasets: [{ label: "Hours", data: hours, backgroundColor: CHART_COLORS[0], borderRadius: 6, maxBarThickness: 36 }],
  });
  renderLegend(legendEl, ["Hours worked"], [CHART_COLORS[0]]);
}

function renderMonthlyLineChart(sessions) {
  const canvas = document.getElementById("dashboardLineChart");
  const legendEl = document.getElementById("dashboardLineLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const last30 = lastNDays(30);
  const hours = dailyHoursSeries(sessions, last30);
  const isEmpty = hours.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 30 days");
  renderChart(canvas, "line", {
    labels: dayLabelsMonthDay(last30),
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

/* ============================================================================
   "Filtered Summary" — folded in from the old Overview page: search/date/
   project/user filters, filtered KPI grid, the one chart Overview had that
   Dashboard didn't (Cumulative Hours), and the full paginated Detailed
   Sessions table with live-ticking durations.
   ========================================================================== */
async function loadFilteredSection() {
  let from = null;
  let to = null;

  if (filterState.dateFilter === "custom") {
    if (!dom.dateFrom.value || !dom.dateTo.value) return; // wait for both dates
    ({ from, to } = getDateRangeForPreset("custom", { customFrom: dom.dateFrom.value, customTo: dom.dateTo.value }));
  } else if (filterState.dateFilter !== "all") {
    ({ from, to } = getDateRangeForPreset(filterState.dateFilter));
  }

  const queryOptions = {
    from,
    to,
    projectId: filterState.projectFilter || undefined,
    page: 1,
    pageSize: 5000,
  };

  const result = isAdmin
    ? await safeCall(() => getAllSessions({ ...queryOptions, userId: filterState.userFilter || undefined }), null)
    : await safeCall(() => getSessionsForUser(currentUser.id, queryOptions), null);

  allSessionsFiltered = result?.rows || [];
  renderFilteredFromCache();
}

function renderFilteredFromCache() {
  const searched = filterBySearch(allSessionsFiltered, filterState.search);
  const completed = searched.filter((s) => s.status === "completed");

  renderFilteredKpis(completed);
  renderCumulativeChart(completed);
  renderDetailedTable(searched);
}

function renderFilteredKpis(completed) {
  const totalSeconds = sumDuration(completed);
  const distinctProjects = new Set(completed.map((s) => s.project_id)).size;

  dom.filteredStatHours.textContent = formatDuration(totalSeconds);
  dom.filteredStatSessions.textContent = String(completed.length);
  dom.filteredStatProjects.textContent = String(distinctProjects);
  dom.filteredStatAvg.textContent = formatDuration(completed.length ? totalSeconds / completed.length : 0);
}

function renderCumulativeChart(completed) {
  const canvas = document.getElementById("dashboardAreaChart");
  const legendEl = document.getElementById("dashboardAreaLegend");
  const wrapper = canvas.closest(".chart-canvas-wrapper");

  const last30 = lastNDays(30);
  const hours = dailyHoursSeries(completed, last30);
  const cumulative = cumulativeSeries(hours);
  const isEmpty = cumulative.every((h) => h === 0);

  setChartEmptyState(wrapper, isEmpty, "No sessions in the last 30 days");
  renderChart(canvas, "line", {
    labels: dayLabelsMonthDay(last30),
    datasets: [{
      label: "Cumulative hours", data: cumulative, borderColor: CHART_COLORS[4],
      backgroundColor: "rgba(22, 163, 74, 0.12)", fill: true, tension: 0.3, pointRadius: 0,
    }],
  }, { plugins: { legend: { display: false } } });
  renderLegend(legendEl, ["Cumulative hours"], [CHART_COLORS[4]]);
}

/**
 * CHANGED PER CLIENT REQUEST: durations now compute and display instantly
 * for running/paused sessions, not just completed ones — including other
 * users' sessions when an admin is looking at the team-wide table. Each
 * live row's duration cells carry data-* attributes describing the session
 * (started_at, accumulated paused seconds, status, paused_at); a single
 * shared ticker (startTableTicker, below) re-reads those attributes and
 * updates the visible text every second, without re-fetching or re-
 * rendering the whole table.
 */
/**
 * CHANGED PER CLIENT REQUEST: collapses a newest-first list of sessions down
 * to one row per user — the most recent one. Only used for the Dashboard's
 * Detailed Sessions table when viewed by an admin/super admin; the Reports
 * page keeps showing every session and never calls this.
 */
function latestPerUser(sessionsDesc) {
  const seenUserIds = new Set();
  const result = [];

  for (const session of sessionsDesc) {
    const userId = session.user_id;
    if (seenUserIds.has(userId)) continue;
    seenUserIds.add(userId);
    result.push(session);
  }

  return result;
}

function renderDetailedTable(searched) {
  const sortedDesc = [...searched].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  // CHANGED PER CLIENT REQUEST: for admin/super admin, the Dashboard's
  // Detailed Sessions table should show only each user's single most
  // recent session, not their full history — the Reports page's Detailed
  // Report table (reports.js:renderTable) is untouched and still shows
  // every session. Since sortedDesc is already newest-first, keeping the
  // first row seen per user_id keeps that user's latest session.
  const tableSource = isAdmin ? latestPerUser(sortedDesc) : sortedDesc;
  const count = tableSource.length;

  dom.tableEmptyState.hidden = count > 0;
  dom.tableWrapper.hidden = count === 0;

  // Scrollable list instead of pages: every matching row renders at once
  // and #dashboardTableWrapper (see Component.css) scrolls internally,
  // with the header pinned so column labels stay visible.
  dom.tableBody.innerHTML = tableSource
    .map((s) => {
      const isLive = s.status !== "completed";
      const elapsedNow = isLive ? computeElapsedSeconds(s) : s.duration_seconds;
      const liveAttrs = isLive
        ? ` data-live-session="true" data-started-at="${s.started_at}" data-paused-seconds="${s.total_paused_seconds || 0}" data-status="${s.status}"${s.paused_at ? ` data-paused-at="${s.paused_at}"` : ""}`
        : "";

      return `
      <tr>
        ${isAdmin ? `<td class="cell-truncate" title="${escapeHtml(s.profiles?.full_name || s.profiles?.email || "Unknown")}">${escapeHtml(s.profiles?.full_name || s.profiles?.email || "Unknown")}</td>` : ""}
        <td class="cell-truncate" title="${escapeHtml(s.projects?.name || "Untitled project")}">${escapeHtml(s.projects?.name || "Untitled project")}</td>
        <td class="cell-wrap">${escapeHtml(truncate(s.task_description, 60))}</td>
        <td>${formatDateOnly(s.started_at)}</td>
        <td>${formatTimeOnly(s.started_at)}</td>
        <td>${s.stopped_at ? formatDateOnly(s.stopped_at) : "—"}</td>
        <td>${s.stopped_at ? formatTimeOnly(s.stopped_at) : "—"}</td>
        <td class="live-duration-hms"${liveAttrs}>${formatDuration(elapsedNow)}</td>
        <td class="live-duration-hours">${secondsToDecimalHours(elapsedNow)}</td>
      </tr>`;
    })
    .join("");

  renderResultsSummary(dom.tablePagination, { total: count, itemLabel: count === 1 ? "session" : "sessions" });

  startTableTicker();
}

/**
 * Ticks every second, updating the visible duration text for every
 * currently-rendered live (running/paused) session row in place — cheap
 * DOM text updates, no re-fetch and no full table re-render. Cleared and
 * restarted each time the table re-renders (new page, new filters) so
 * stale intervals never stack up across repeated Dashboard visits.
 */
function startTableTicker() {
  clearInterval(tableTickInterval);

  const liveCells = dom.tableBody.querySelectorAll('.live-duration-hms[data-live-session="true"]');
  if (liveCells.length === 0) return;

  tableTickInterval = setInterval(() => {
    const now = new Date();
    dom.tableBody.querySelectorAll('.live-duration-hms[data-live-session="true"]').forEach((cell) => {
      const session = {
        started_at: cell.dataset.startedAt,
        total_paused_seconds: Number(cell.dataset.pausedSeconds || 0),
        status: cell.dataset.status,
        paused_at: cell.dataset.pausedAt || null,
      };
      const elapsed = computeElapsedSeconds(session, now);
      cell.textContent = formatDuration(elapsed);
      const hoursCell = cell.nextElementSibling;
      if (hoursCell) hoursCell.textContent = secondsToDecimalHours(elapsed);
    });
  }, 1000);
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

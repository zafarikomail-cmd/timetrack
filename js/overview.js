// ============================================================================
// Overview module
// ----------------------------------------------------------------------------
// Regular users see their own sessions; admins see everyone's (with a user
// filter). Search, date range, and project filters are combined, then KPIs,
// five charts, and a detailed paginated table are derived from the same
// filtered dataset — so the numbers on screen are always consistent.
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getProjects,
  getAllProfiles,
  getSessionsForUser,
  getAllSessions,
  getDateRangeForPreset,
  getUserRole,
  getProfileById,
  isAdminLevel,
  formatDuration,
} from "./data.js";
import { renderChart, renderLegend, setChartEmptyState, CHART_COLORS } from "./charts.js";
import { renderPagination } from "./pagination.js";
import { exportRowsToExcel } from "./export.js";
import { showToast } from "./toast.js";
import {
  lastNDays,
  sumDuration,
  groupHoursByProject,
  dailyHoursSeries,
  cumulativeSeries,
  dayLabelsShort,
  dayLabelsMonthDay,
  filterBySearch,
  paginateClientSide,
  escapeHtml,
  truncate,
  formatDateTime,
} from "./report-utils.js";

let currentUser = null;
let currentUserRole = null;
let isAdmin = false;
let allSessionsFiltered = []; // full dataset matching current dropdown filters (pre-search)
let dom = {};

const state = { page: 1, pageSize: 8, dateFilter: "all", projectFilter: "", userFilter: "", search: "" };

document.addEventListener("DOMContentLoaded", initOverview);

async function initOverview() {
  currentUser = await getCurrentUser();
  if (!currentUser) return;

  // BUG FIXED: isAdmin used to be derived from getUserRole(currentUser) —
  // the raw auth user, which never actually carries role (role only lives
  // in public.profiles.role). isAdmin was always false for real admins,
  // so this page always queried "my sessions only" instead of "everyone's
  // sessions", which is why an admin who hadn't personally run the timer
  // saw all-zero KPIs/charts and an apparently-broken search box (nothing
  // had been loaded to search through in the first place).
  const profile = await safeCall(() => getProfileById(currentUser.id), null);
  currentUserRole = getUserRole(profile) || getUserRole(currentUser);
  isAdmin = isAdminLevel(currentUserRole);

  cacheDom();
  wireEvents();
  toggleAdminOnlyUi();

  await Promise.all([loadProjectFilterOptions(), isAdmin ? loadUserFilterOptions() : Promise.resolve()]);
  await loadOverview();
}

function cacheDom() {
  dom = {
    search: document.getElementById("overviewSearch"),
    dateFilter: document.getElementById("overviewDateFilter"),
    dateFrom: document.getElementById("overviewDateFrom"),
    dateTo: document.getElementById("overviewDateTo"),
    projectFilter: document.getElementById("overviewProjectFilter"),
    userFilter: document.getElementById("overviewUserFilter"),
    exportBtn: document.getElementById("overviewExportBtn"),

    statHours: document.getElementById("overviewStatHours"),
    statSessions: document.getElementById("overviewStatSessions"),
    statProjects: document.getElementById("overviewStatProjects"),
    statAvg: document.getElementById("overviewStatAvg"),

    tableWrapper: document.getElementById("overviewTableWrapper"),
    tableBody: document.getElementById("overviewTableBody"),
    userColumnHeader: document.querySelector('#overviewTableWrapper thead th[data-requires-role]'),
    emptyState: document.getElementById("overviewEmptyState"),
    pagination: document.getElementById("overviewPagination"),
  };
}

function toggleAdminOnlyUi() {
  dom.userFilter.hidden = !isAdmin;
  if (dom.userColumnHeader) dom.userColumnHeader.hidden = !isAdmin;
}

async function safeCall(fn, fallback = []) {
  try {
    return await fn();
  } catch (error) {
    console.error("Overview data load failed:", error.message);
    return fallback;
  }
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

function wireEvents() {
  dom.search.addEventListener("input", debounce(() => {
    state.search = dom.search.value;
    state.page = 1;
    renderFromCache();
  }, 250));

  dom.dateFilter.addEventListener("change", () => {
    state.dateFilter = dom.dateFilter.value;
    const isCustom = state.dateFilter === "custom";
    dom.dateFrom.hidden = !isCustom;
    dom.dateTo.hidden = !isCustom;
    if (!isCustom) {
      state.page = 1;
      loadOverview();
    }
  });

  const onCustomRangeChange = () => {
    if (dom.dateFrom.value && dom.dateTo.value) {
      state.page = 1;
      loadOverview();
    }
  };
  dom.dateFrom.addEventListener("change", onCustomRangeChange);
  dom.dateTo.addEventListener("change", onCustomRangeChange);

  dom.projectFilter.addEventListener("change", () => {
    state.projectFilter = dom.projectFilter.value;
    state.page = 1;
    loadOverview();
  });
  dom.userFilter.addEventListener("change", () => {
    state.userFilter = dom.userFilter.value;
    state.page = 1;
    loadOverview();
  });

  dom.exportBtn.addEventListener("click", handleExport);
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Fetches the full filtered dataset (unpaginated) so KPIs/charts/table/export
 * all derive from the exact same numbers — then renders everything.
 */
async function loadOverview() {
  let from = null;
  let to = null;

  if (state.dateFilter === "custom") {
    if (!dom.dateFrom.value || !dom.dateTo.value) return; // wait for both dates
    ({ from, to } = getDateRangeForPreset("custom", { customFrom: dom.dateFrom.value, customTo: dom.dateTo.value }));
  } else if (state.dateFilter !== "all") {
    ({ from, to } = getDateRangeForPreset(state.dateFilter));
  }

  const queryOptions = {
    from,
    to,
    projectId: state.projectFilter || undefined,
    page: 1,
    pageSize: 5000,
  };

  const result = isAdmin
    ? await safeCall(() => getAllSessions({ ...queryOptions, userId: state.userFilter || undefined }), null)
    : await safeCall(() => getSessionsForUser(currentUser.id, queryOptions), null);

  allSessionsFiltered = result?.rows || [];
  renderFromCache();
}

function renderFromCache() {
  const searched = filterBySearch(allSessionsFiltered, state.search);
  const completed = searched.filter((s) => s.status === "completed");

  renderKpis(completed);
  renderCharts(searched, completed);
  renderTable(searched);
}

function renderKpis(completed) {
  const totalSeconds = sumDuration(completed);
  const distinctProjects = new Set(completed.map((s) => s.project_id)).size;

  dom.statHours.textContent = formatDuration(totalSeconds);
  dom.statSessions.textContent = String(completed.length);
  dom.statProjects.textContent = String(distinctProjects);
  dom.statAvg.textContent = formatDuration(completed.length ? totalSeconds / completed.length : 0);
}

function renderCharts(searched, completed) {
  // Pie: hours by project
  const pieCanvas = document.getElementById("overviewPieChart");
  const pieLegend = document.getElementById("overviewPieLegend");
  const pieWrapper = pieCanvas.closest(".chart-canvas-wrapper");
  const { labels: pieLabels, values: pieValues } = groupHoursByProject(completed);
  const pieEmpty = pieValues.length === 0 || pieValues.every((v) => v === 0);
  setChartEmptyState(pieWrapper, pieEmpty, "No completed sessions yet");
  renderChart(pieCanvas, "pie", {
    labels: pieEmpty ? ["No data"] : pieLabels,
    datasets: [{ data: pieEmpty ? [1] : pieValues, backgroundColor: pieEmpty ? ["#e2e8f0"] : CHART_COLORS }],
  });
  renderLegend(pieLegend, pieEmpty ? ["No data yet"] : pieLabels, pieEmpty ? ["#e2e8f0"] : CHART_COLORS);

  // Donut: CHANGED PER CLIENT REQUEST — this used to chart session status
  // (Completed vs Active/running/paused), duplicating the STATUS column
  // that was just removed from the table above. Now it charts task_status
  // instead (Completed / In Progress / Blocked / Not specified), which is
  // the status the client actually wants surfaced.
  const donutCanvas = document.getElementById("overviewDonutChart");
  const donutLegend = document.getElementById("overviewDonutLegend");
  const donutWrapper = donutCanvas.closest(".chart-canvas-wrapper");
  const taskStatusCounts = countByTaskStatus(searched);
  const taskStatusLabels = ["Completed", "In Progress", "Blocked / Other", "Not specified"];
  const taskStatusValues = [
    taskStatusCounts.completed,
    taskStatusCounts.in_progress,
    taskStatusCounts.blocked,
    taskStatusCounts.none,
  ];
  const donutEmpty = taskStatusValues.every((v) => v === 0);
  setChartEmptyState(donutWrapper, donutEmpty, "No sessions yet");
  renderChart(donutCanvas, "doughnut", {
    labels: donutEmpty ? ["No data"] : taskStatusLabels,
    datasets: [{
      data: donutEmpty ? [1] : taskStatusValues,
      backgroundColor: donutEmpty ? ["#e2e8f0"] : CHART_COLORS,
    }],
  });
  renderLegend(donutLegend, donutEmpty ? ["No data yet"] : taskStatusLabels, donutEmpty ? ["#e2e8f0"] : CHART_COLORS);

  // Bar: daily hours, last 7 days
  const barCanvas = document.getElementById("overviewBarChart");
  const barLegend = document.getElementById("overviewBarLegend");
  const barWrapper = barCanvas.closest(".chart-canvas-wrapper");
  const last7 = lastNDays(7);
  const barHours = dailyHoursSeries(completed, last7);
  const barEmpty = barHours.every((h) => h === 0);
  setChartEmptyState(barWrapper, barEmpty, "No sessions in the last 7 days");
  renderChart(barCanvas, "bar", {
    labels: dayLabelsShort(last7),
    datasets: [{ label: "Hours", data: barHours, backgroundColor: CHART_COLORS[0], borderRadius: 6, maxBarThickness: 36 }],
  });
  renderLegend(barLegend, ["Hours worked"], [CHART_COLORS[0]]);

  // Line: trend, last 30 days
  const lineCanvas = document.getElementById("overviewLineChart");
  const lineLegend = document.getElementById("overviewLineLegend");
  const lineWrapper = lineCanvas.closest(".chart-canvas-wrapper");
  const last30 = lastNDays(30);
  const lineHours = dailyHoursSeries(completed, last30);
  const lineEmpty = lineHours.every((h) => h === 0);
  setChartEmptyState(lineWrapper, lineEmpty, "No sessions in the last 30 days");
  renderChart(lineCanvas, "line", {
    labels: dayLabelsMonthDay(last30),
    datasets: [{
      label: "Hours", data: lineHours, borderColor: CHART_COLORS[1],
      backgroundColor: "rgba(124, 58, 237, 0.1)", fill: true, tension: 0.35, pointRadius: 0,
    }],
  });
  renderLegend(lineLegend, ["Hours worked"], [CHART_COLORS[1]]);

  // Area: cumulative hours, last 30 days
  const areaCanvas = document.getElementById("overviewAreaChart");
  const areaLegend = document.getElementById("overviewAreaLegend");
  const areaWrapper = areaCanvas.closest(".chart-canvas-wrapper");
  const cumulative = cumulativeSeries(lineHours);
  const areaEmpty = cumulative.every((h) => h === 0);
  setChartEmptyState(areaWrapper, areaEmpty, "No sessions in the last 30 days");
  renderChart(areaCanvas, "line", {
    labels: dayLabelsMonthDay(last30),
    datasets: [{
      label: "Cumulative hours", data: cumulative, borderColor: CHART_COLORS[4],
      backgroundColor: "rgba(22, 163, 74, 0.12)", fill: true, tension: 0.3, pointRadius: 0,
    }],
  });
  renderLegend(areaLegend, ["Cumulative hours"], [CHART_COLORS[4]]);
}

function renderTable(searched) {
  const sortedDesc = [...searched].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  const { rows, count } = paginateClientSide(sortedDesc, state.page, state.pageSize);

  dom.emptyState.hidden = count > 0;
  dom.tableWrapper.hidden = count === 0;

  dom.tableBody.innerHTML = rows
    .map((s) => `
      <tr>
        ${isAdmin ? `<td>${escapeHtml(s.profiles?.full_name || s.profiles?.email || "Unknown")}</td>` : ""}
        <td>${escapeHtml(s.projects?.name || "Untitled project")}</td>
        <td>${escapeHtml(truncate(s.task_description, 60))}</td>
        <td>${formatDateTime(s.started_at)}</td>
        <td>${s.status === "completed" ? formatDuration(s.duration_seconds) : "—"}</td>
        <td>${renderTaskStatusBadge(s.task_status)}</td>
      </tr>`)
    .join("");

  renderPagination(dom.pagination, { page: state.page, pageSize: state.pageSize, total: count }, (page) => {
    state.page = page;
    renderTable(searched);
  });
}

/**
 * Renders the task_status column as a colored badge (green Completed, blue
 * In Progress, red Blocked/Other), or a neutral "Not specified" for rows
 * recorded before this feature existed (task_status is null). Uses the real
 * badge-task-* classes in Component.css rather than inline colors.
 */
/**
 * Counts sessions by task_status (completed / in_progress / blocked), with
 * anything else (including null, for rows recorded before this feature
 * existed) bucketed as "none" — mirrors renderTaskStatusBadge()'s labels.
 */
function countByTaskStatus(sessions) {
  const counts = { completed: 0, in_progress: 0, blocked: 0, none: 0 };
  sessions.forEach((s) => {
    const key = ["completed", "in_progress", "blocked"].includes(s.task_status) ? s.task_status : "none";
    counts[key] += 1;
  });
  return counts;
}

function renderTaskStatusBadge(taskStatus) {
  const labels = { completed: "Completed", in_progress: "In Progress", blocked: "Blocked / Other" };
  const key = labels[taskStatus] ? taskStatus : "none";
  const label = labels[taskStatus] || "Not specified";
  return `<span class="badge badge-task-${key}">${label}</span>`;
}

function handleExport() {
  const searched = filterBySearch(allSessionsFiltered, state.search);
  if (searched.length === 0) {
    showToast("Nothing to export — adjust your filters.", "info");
    return;
  }

  const taskStatusLabels = { completed: "Completed", in_progress: "In Progress", blocked: "Blocked / Other" };

  const rows = searched.map((s) => ({
    ...(isAdmin ? { User: s.profiles?.full_name || s.profiles?.email || "Unknown" } : {}),
    Project: s.projects?.name || "Untitled project",
    Task: s.task_description,
    Started: formatDateTime(s.started_at),
    "Duration (hh:mm:ss)": s.status === "completed" ? formatDuration(s.duration_seconds) : "—",
    Status: s.status,
    "Task Status": taskStatusLabels[s.task_status] || "Not specified",
  }));

  const charts = collectChartImages([
    { id: "overviewPieChart", title: "Hours by Project" },
    { id: "overviewDonutChart", title: "Task Status Breakdown" },
    { id: "overviewBarChart", title: "Daily Hours — Last 7 Days" },
    { id: "overviewLineChart", title: "Hours Trend — Last 30 Days" },
    { id: "overviewAreaChart", title: "Cumulative Hours — Last 30 Days" },
  ]);

  exportRowsToExcel(rows, "overview-export", "Overview", { charts })
    .then(() => showToast("Export ready", "success"))
    .catch(() => showToast("Could not export the data.", "error"));
}

/**
 * Captures each already-rendered Chart.js canvas as a PNG data URL so it can
 * be embedded in the exported workbook's Charts sheet. Canvases that don't
 * exist yet (or fail to capture, e.g. before a chart has drawn) are skipped
 * rather than breaking the whole export.
 */
function collectChartImages(entries) {
  return entries
    .map(({ id, title }) => {
      const canvas = document.getElementById(id);
      if (!canvas) return null;
      try {
        return { title, dataUrl: canvas.toDataURL("image/png") };
      } catch (error) {
        console.error(`Could not capture chart "${id}" for export:`, error.message);
        return null;
      }
    })
    .filter(Boolean);
}
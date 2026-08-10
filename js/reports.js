// ============================================================================
// Reports module
// ----------------------------------------------------------------------------
// Admins/super admins see whole-team reporting with a user filter. Regular
// employees see the same page scoped to just their own sessions (no user
// filter, no User/Email columns) — same admin/employee split Overview
// already uses. Project/date filters (including a custom date range), KPI
// cards, five charts, a detailed paginated table, and Excel/CSV/Print export
// are all derived from the same filtered dataset for consistency.
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getProjects,
  getAllProfiles,
  getAllSessions,
  getSessionsForUser,
  getDateRangeForPreset,
  getProfileById,
  getUserRole,
  isAdminLevel,
  isSuperAdmin,
  formatDuration,
  adminUpdateWorkSession,
} from "./data.js";
import { renderChart, renderLegend, setChartEmptyState, CHART_COLORS } from "./charts.js";
import { renderPagination } from "./pagination.js";
import { exportRowsToExcel, exportRowsToCsv, printRows } from "./export.js";
import { showToast } from "./toast.js";
import { openModal, closeModal, initModalDismissal } from "./modal.js";
import {
  lastNDays,
  sumDuration,
  groupHoursByProject,
  groupHoursByUser,
  dailyHoursSeries,
  cumulativeSeries,
  dayLabelsShort,
  dayLabelsMonthDay,
  paginateClientSide,
  escapeHtml,
  truncate,
  formatDateOnly,
  formatTimeOnly,
  secondsToDecimalHours,
} from "./report-utils.js";

let currentUser = null;
let currentRole = null;
let isAdmin = false;
let allSessionsFiltered = [];
let allProjects = []; // full project list, for the Edit Session modal's dropdown
let sessionsById = new Map(); // last-rendered sessions, keyed by id, for the edit modal
let dom = {};

const state = { page: 1, pageSize: 10, dateFilter: "all", projectFilter: "", userFilter: "" };
const editSessionState = { sessionId: null, syncing: false }; // syncing guards against feedback loops between duration <-> end time inputs

document.addEventListener("DOMContentLoaded", initReports);

async function initReports() {
  currentUser = await getCurrentUser();
  if (!currentUser) return;

  // BUG FIXED: currentRole used to come from getUserRole(currentUser) — the
  // raw auth user, which never carries role (role only ever lives in
  // public.profiles.role). getUserRole(currentUser) was therefore always
  // null/falsy, so isAdminLevel(...) was always false and this function
  // returned right here for every real admin/super admin — before
  // cacheDom(), wireEvents(), or loadReports() ever ran. That's why the
  // whole page stayed blank (no KPIs, no charts, no table) and every button
  // (filters, Export Excel, Export CSV, Print) appeared completely dead —
  // none of them ever got a click/change listener attached. Fetch the
  // caller's own profiles row instead, same fix already applied in
  // users.js/overview.js/app.js.
  const profile = await safeCall(() => getProfileById(currentUser.id), null);
  currentRole = getUserRole(profile) || getUserRole(currentUser);
  isAdmin = isAdminLevel(currentRole);

  cacheDom();
  wireEvents();
  toggleAdminOnlyUi();

  if (isAdmin) {
    initModalDismissal("editSessionModal");
    wireEditSessionModal();
  }

  await Promise.all([
    loadProjectFilterOptions(),
    isAdmin ? loadUserFilterOptions() : Promise.resolve(),
    isAdmin ? loadAllProjectsForEditModal() : Promise.resolve(),
  ]);
  await loadReports();
}

function toggleAdminOnlyUi() {
  dom.userFilter.hidden = !isAdmin;
  dom.adminColumnHeaders.forEach((th) => { th.hidden = !isAdmin; });
}

function cacheDom() {
  dom = {
    userFilter: document.getElementById("reportsUserFilter"),
    projectFilter: document.getElementById("reportsProjectFilter"),
    dateFilter: document.getElementById("reportsDateFilter"),
    dateFrom: document.getElementById("reportsDateFrom"),
    dateTo: document.getElementById("reportsDateTo"),
    exportExcelBtn: document.getElementById("reportsExportExcelBtn"),
    exportCsvBtn: document.getElementById("reportsExportCsvBtn"),
    printBtn: document.getElementById("reportsPrintBtn"),

    statHours: document.getElementById("reportsStatHours"),
    statUsers: document.getElementById("reportsStatUsers"),
    statProjects: document.getElementById("reportsStatProjects"),
    statSessions: document.getElementById("reportsStatSessions"),

    tableWrapper: document.getElementById("reportsTableWrapper"),
    tableBody: document.getElementById("reportsTableBody"),
    // BUG FIXED: this used to be querySelector (singular) against a table
    // that only ever had ONE th[data-requires-role] (User) — and that one
    // th was also missing the attribute in app.html, so this was always
    // null and toggleAdminOnlyUi() silently did nothing, leaving the User
    // column permanently visible (with no matching <td>) for employees.
    // Now that Edited/Actions are also admin-only columns, this needs to
    // toggle all of them together.
    adminColumnHeaders: document.querySelectorAll('#reportsTableWrapper thead th[data-requires-role]'),
    emptyState: document.getElementById("reportsEmptyState"),
    pagination: document.getElementById("reportsPagination"),

    // Edit Session modal (admin/super admin only)
    editSessionForm: document.getElementById("editSessionForm"),
    editSessionModalSubtitle: document.getElementById("editSessionModalSubtitle"),
    editSessionProject: document.getElementById("editSessionProject"),
    editSessionDescription: document.getElementById("editSessionDescription"),
    editSessionStartDate: document.getElementById("editSessionStartDate"),
    editSessionStartTime: document.getElementById("editSessionStartTime"),
    editSessionEndDate: document.getElementById("editSessionEndDate"),
    editSessionEndTime: document.getElementById("editSessionEndTime"),
    editSessionDurationHours: document.getElementById("editSessionDurationHours"),
    editSessionDurationMinutes: document.getElementById("editSessionDurationMinutes"),
    editSessionDurationSeconds: document.getElementById("editSessionDurationSeconds"),
    editSessionEditedValue: document.getElementById("editSessionEditedValue"),
    editSessionError: document.getElementById("editSessionError"),
    editSessionSubmitBtn: document.getElementById("editSessionSubmitBtn"),
  };
}

async function safeCall(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.error("Reports data load failed:", error.message);
    return fallback;
  }
}

async function loadProjectFilterOptions() {
  const projects = await safeCall(() => getProjects(currentRole), []);
  dom.projectFilter.innerHTML =
    `<option value="">All projects</option>` +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

async function loadUserFilterOptions() {
  const profiles = await safeCall(() => getAllProfiles({ includeSuperAdmins: isSuperAdmin(currentRole) }), []);
  dom.userFilter.innerHTML =
    `<option value="">All users</option>` +
    profiles.map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`).join("");
}

function wireEvents() {
  dom.dateFilter.addEventListener("change", () => {
    state.dateFilter = dom.dateFilter.value;
    const isCustom = state.dateFilter === "custom";
    dom.dateFrom.hidden = !isCustom;
    dom.dateTo.hidden = !isCustom;
    if (!isCustom) {
      state.page = 1;
      loadReports();
    }
  });

  const onCustomRangeChange = () => {
    if (dom.dateFrom.value && dom.dateTo.value) {
      state.page = 1;
      loadReports();
    }
  };
  dom.dateFrom.addEventListener("change", onCustomRangeChange);
  dom.dateTo.addEventListener("change", onCustomRangeChange);

  dom.projectFilter.addEventListener("change", () => {
    state.projectFilter = dom.projectFilter.value;
    state.page = 1;
    loadReports();
  });

  dom.userFilter.addEventListener("change", () => {
    state.userFilter = dom.userFilter.value;
    state.page = 1;
    loadReports();
  });

  dom.exportExcelBtn.addEventListener("click", handleExportExcel);
  dom.exportCsvBtn.addEventListener("click", handleExportCsv);
  dom.printBtn.addEventListener("click", handlePrint);

  if (isAdmin) {
    dom.tableBody.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-edit-session]");
      if (!btn) return;
      const session = sessionsById.get(btn.getAttribute("data-edit-session"));
      if (session) openEditSessionModal(session);
    });
  }
}

/** Full (unfiltered) project list, used only to populate the Edit Session modal's dropdown. */
async function loadAllProjectsForEditModal() {
  allProjects = await safeCall(() => getProjects(currentRole), []);
}

/**
 * Fetches the full filtered dataset (unpaginated) so KPIs/charts/table/export
 * all derive from the exact same numbers — then renders everything.
 */
async function loadReports() {
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
  renderAll();
}

function renderAll() {
  const completed = allSessionsFiltered.filter((s) => s.status === "completed");
  renderKpis(completed);
  renderCharts(allSessionsFiltered, completed);
  renderTable(allSessionsFiltered);
}

function renderKpis(completed) {
  const totalSeconds = sumDuration(completed);
  const distinctUsers = new Set(completed.map((s) => s.user_id)).size;
  const distinctProjects = new Set(completed.map((s) => s.project_id)).size;

  dom.statHours.textContent = formatDuration(totalSeconds);
  dom.statUsers.textContent = String(distinctUsers);
  dom.statProjects.textContent = String(distinctProjects);
  dom.statSessions.textContent = String(completed.length);
}

function renderCharts(all, completed) {
  // Pie: hours by project
  const pieCanvas = document.getElementById("reportsPieChart");
  const pieLegend = document.getElementById("reportsPieLegend");
  const pieWrapper = pieCanvas.closest(".chart-canvas-wrapper");
  const { labels: pieLabels, values: pieValues } = groupHoursByProject(completed);
  const pieEmpty = pieValues.length === 0 || pieValues.every((v) => v === 0);
  setChartEmptyState(pieWrapper, pieEmpty, "No completed sessions yet");
  renderChart(pieCanvas, "pie", {
    labels: pieEmpty ? ["No data"] : pieLabels,
    datasets: [{ data: pieEmpty ? [1] : pieValues, backgroundColor: pieEmpty ? ["#e2e8f0"] : CHART_COLORS }],
  });
  renderLegend(pieLegend, pieEmpty ? ["No data yet"] : pieLabels, pieEmpty ? ["#e2e8f0"] : CHART_COLORS);

  // Donut: hours by user (top contributors)
  const donutCanvas = document.getElementById("reportsDonutChart");
  const donutLegend = document.getElementById("reportsDonutLegend");
  const donutWrapper = donutCanvas.closest(".chart-canvas-wrapper");
  const { labels: userLabels, values: userValues } = groupHoursByUser(completed);
  const topUserLabels = userLabels.slice(0, 8);
  const topUserValues = userValues.slice(0, 8);
  const donutEmpty = topUserValues.length === 0 || topUserValues.every((v) => v === 0);
  setChartEmptyState(donutWrapper, donutEmpty, "No completed sessions yet");
  renderChart(donutCanvas, "doughnut", {
    labels: donutEmpty ? ["No data"] : topUserLabels,
    datasets: [{ data: donutEmpty ? [1] : topUserValues, backgroundColor: donutEmpty ? ["#e2e8f0"] : CHART_COLORS }],
  });
  renderLegend(donutLegend, donutEmpty ? ["No data yet"] : topUserLabels, donutEmpty ? ["#e2e8f0"] : CHART_COLORS);

  // Bar: daily hours, last 7 days, whole team
  const barCanvas = document.getElementById("reportsBarChart");
  const barLegend = document.getElementById("reportsBarLegend");
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
  const lineCanvas = document.getElementById("reportsLineChart");
  const lineLegend = document.getElementById("reportsLineLegend");
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
  }, { plugins: { legend: { display: false } } });
  renderLegend(lineLegend, ["Hours worked"], [CHART_COLORS[1]]);

  // Area: cumulative hours, last 30 days
  const areaCanvas = document.getElementById("reportsAreaChart");
  const areaLegend = document.getElementById("reportsAreaLegend");
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
  }, { plugins: { legend: { display: false } } });
  renderLegend(areaLegend, ["Cumulative hours"], [CHART_COLORS[4]]);
}

function renderTable(all) {
  const sortedDesc = [...all].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  const { rows, count } = paginateClientSide(sortedDesc, state.page, state.pageSize);

  dom.emptyState.hidden = count > 0;
  dom.tableWrapper.hidden = count === 0;

  // Only the sessions actually on screen need to be addressable from the
  // Edit button's click handler — refresh the lookup map each render.
  sessionsById = new Map(rows.map((s) => [String(s.id), s]));

  dom.tableBody.innerHTML = rows
    .map(
      (s) => `
      <tr>
        ${isAdmin ? `<td>${escapeHtml(s.profiles?.full_name || s.profiles?.email || "Unknown")}</td>` : ""}
        <td>${escapeHtml(s.projects?.name || "Untitled project")}</td>
        <td>${escapeHtml(truncate(s.task_description, 60))}</td>
        <td>${formatDateOnly(s.started_at)}</td>
        <td>${formatTimeOnly(s.started_at)}</td>
        <td>${s.stopped_at ? formatDateOnly(s.stopped_at) : "—"}</td>
        <td>${s.stopped_at ? formatTimeOnly(s.stopped_at) : "—"}</td>
        <td>${s.status === "completed" ? formatDuration(s.duration_seconds) : "—"}</td>
        <td>${s.status === "completed" ? secondsToDecimalHours(s.duration_seconds) : "—"}</td>
        ${isAdmin ? `<td>${renderEditedBadge(s)}</td>` : ""}
        ${isAdmin ? `<td>${renderEditAction(s)}</td>` : ""}
      </tr>`
    )
    .join("");

  renderPagination(dom.pagination, { page: state.page, pageSize: state.pageSize, total: count }, (page) => {
    state.page = page;
    renderTable(all);
  });
}

/** Yes/No badge for the "Edited" column — this value comes straight off the
 *  session row; it's never computed or editable client-side (see the DB
 *  trigger in supabase/migrations/0005_work_sessions_admin_edit.sql). */
function renderEditedBadge(session) {
  return session.edited
    ? `<span class="badge badge-task-blocked">Yes</span>`
    : `<span class="badge badge-task-completed">No</span>`;
}

function renderEditAction(session) {
  // Only completed sessions have a fixed start/end/duration to edit —
  // running/paused sessions are still live and are managed from the timer
  // itself, not here.
  if (session.status !== "completed") {
    return `<button type="button" class="btn btn-outline btn-sm" disabled title="Only completed sessions can be edited here">Edit</button>`;
  }
  return `<button type="button" class="btn btn-outline btn-sm" data-edit-session="${session.id}">Edit</button>`;
}

function buildExportRows() {
  return allSessionsFiltered.map((s) => ({
    ...(isAdmin
      ? {
          User: s.profiles?.full_name || s.profiles?.email || "Unknown",
          Email: s.profiles?.email || "", // Excel-only — never shown on the Reports page table
        }
      : {}),
    Project: s.projects?.name || "Untitled project",
    Description: s.task_description,
    "Started Date": formatDateOnly(s.started_at),
    "Started Time": formatTimeOnly(s.started_at),
    "Ended Date": s.stopped_at ? formatDateOnly(s.stopped_at) : "—",
    "Ended Time": s.stopped_at ? formatTimeOnly(s.stopped_at) : "—",
    "Duration (hh:mm:ss)": s.status === "completed" ? formatDuration(s.duration_seconds) : "—",
    "Duration (hours)": s.status === "completed" ? secondsToDecimalHours(s.duration_seconds) : "—",
  }));
}

function handleExportExcel() {
  const rows = buildExportRows();
  if (!rows.length) return showToast("Nothing to export — adjust your filters.", "info");

  const charts = collectChartImages([
    { id: "reportsPieChart", title: "Hours by Project" },
    { id: "reportsDonutChart", title: "Top Contributors" },
    { id: "reportsBarChart", title: "Daily Hours — Last 7 Days" },
    { id: "reportsLineChart", title: "Hours Trend — Last 30 Days" },
    { id: "reportsAreaChart", title: "Cumulative Hours — Last 30 Days" },
  ]);

  exportRowsToExcel(rows, "team-report", "Report", { charts })
    .then(() => showToast("Export ready", "success"))
    .catch(() => showToast("Could not export the data.", "error"));
}

/**
 * Captures each already-rendered Chart.js canvas as a PNG data URL so it can
 * be embedded in the exported workbook's Charts sheet. Canvases that don't
 * exist yet (or fail to capture) are skipped rather than breaking the whole
 * export.
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

function handleExportCsv() {
  const rows = buildExportRows();
  if (!rows.length) return showToast("Nothing to export — adjust your filters.", "info");
  exportRowsToCsv(rows, "team-report");
  showToast("Export ready", "success");
}

function handlePrint() {
  const rows = buildExportRows();
  if (!rows.length) return showToast("Nothing to print — adjust your filters.", "info");

  const summary = [
    { label: "Total Hours", value: dom.statHours.textContent },
    { label: "Users", value: dom.statUsers.textContent },
    { label: "Projects", value: dom.statProjects.textContent },
    { label: "Sessions", value: dom.statSessions.textContent },
  ];

  printRows(rows, "Working Hours Report", { summary, meta: buildFilterSummaryText() });
}

/** Human-readable line describing the currently applied filters, shown under the print title. */
function buildFilterSummaryText() {
  const parts = [];

  if (state.dateFilter === "custom" && dom.dateFrom.value && dom.dateTo.value) {
    parts.push(`${dom.dateFrom.value} → ${dom.dateTo.value}`);
  } else if (state.dateFilter !== "all") {
    parts.push(dom.dateFilter.selectedOptions[0]?.textContent || state.dateFilter);
  } else {
    parts.push("All time");
  }

  if (state.projectFilter) parts.push(dom.projectFilter.selectedOptions[0]?.textContent || "");
  if (state.userFilter) parts.push(dom.userFilter.selectedOptions[0]?.textContent || "");

  return parts.filter(Boolean).join(" · ");
}

/* ============================================================================
   Edit Session (Admin / Super Admin only)
   ----------------------------------------------------------------------------
   Lets an admin correct a completed session's project, task description,
   start/end date-time, and duration. Editing the duration recomputes the
   end date/time (start stays fixed); editing either the start or end
   date/time recomputes the duration — both directions stay in sync as the
   admin types, via the `syncing` guard so the two recompute functions don't
   trigger each other in a loop.

   Whether the session counts as "Edited" is never sent from here — that's
   entirely decided by a DB trigger (see
   supabase/migrations/0005_work_sessions_admin_edit.sql), so this modal
   only ever *displays* the current value, never edits it.
   ========================================================================== */
function wireEditSessionModal() {
  dom.editSessionDurationHours.addEventListener("input", recomputeEndFromDuration);
  dom.editSessionDurationMinutes.addEventListener("input", recomputeEndFromDuration);
  dom.editSessionDurationSeconds.addEventListener("input", recomputeEndFromDuration);

  dom.editSessionStartDate.addEventListener("change", recomputeDurationFromRange);
  dom.editSessionStartTime.addEventListener("change", recomputeDurationFromRange);
  dom.editSessionEndDate.addEventListener("change", recomputeDurationFromRange);
  dom.editSessionEndTime.addEventListener("change", recomputeDurationFromRange);

  dom.editSessionForm.addEventListener("submit", handleEditSessionSubmit);
}

function openEditSessionModal(session) {
  editSessionState.sessionId = session.id;
  dom.editSessionError.textContent = "";
  dom.editSessionSubmitBtn.disabled = false;

  dom.editSessionModalSubtitle.textContent =
    `${session.profiles?.full_name || session.profiles?.email || "Unknown"} — session started ${formatDateOnly(session.started_at)}`;

  dom.editSessionProject.innerHTML = allProjects
    .map((p) => `<option value="${p.id}" ${p.id === session.project_id ? "selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");

  dom.editSessionDescription.value = session.task_description || "";

  const startedAt = new Date(session.started_at);
  const stoppedAt = session.stopped_at ? new Date(session.stopped_at) : startedAt;

  setDateTimeInputs(dom.editSessionStartDate, dom.editSessionStartTime, startedAt);
  setDateTimeInputs(dom.editSessionEndDate, dom.editSessionEndTime, stoppedAt);
  setDurationInputs(session.duration_seconds || 0);

  dom.editSessionEditedValue.textContent = session.edited ? "Yes" : "No";

  openModal("editSessionModal");
}

function setDateTimeInputs(dateInput, timeInput, date) {
  dateInput.value = toLocalDateValue(date);
  timeInput.value = toLocalTimeValue(date);
}

function toLocalDateValue(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toLocalTimeValue(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function setDurationInputs(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  dom.editSessionDurationHours.value = Math.floor(seconds / 3600);
  dom.editSessionDurationMinutes.value = Math.floor((seconds % 3600) / 60);
  dom.editSessionDurationSeconds.value = seconds % 60;
}

/** Reads the Start fields as a Date, in the browser's local timezone (same
 *  as every other date/time on this page) — null if either field is empty. */
function readStartDateTime() {
  if (!dom.editSessionStartDate.value || !dom.editSessionStartTime.value) return null;
  return new Date(`${dom.editSessionStartDate.value}T${dom.editSessionStartTime.value}`);
}

function readEndDateTime() {
  if (!dom.editSessionEndDate.value || !dom.editSessionEndTime.value) return null;
  return new Date(`${dom.editSessionEndDate.value}T${dom.editSessionEndTime.value}`);
}

function readDurationSeconds() {
  const h = Number(dom.editSessionDurationHours.value) || 0;
  const m = Number(dom.editSessionDurationMinutes.value) || 0;
  const s = Number(dom.editSessionDurationSeconds.value) || 0;
  return h * 3600 + m * 60 + s;
}

/** Duration changed -> push a new end date/time (start stays fixed). */
function recomputeEndFromDuration() {
  if (editSessionState.syncing) return;
  const start = readStartDateTime();
  if (!start) return;

  editSessionState.syncing = true;
  const end = new Date(start.getTime() + readDurationSeconds() * 1000);
  setDateTimeInputs(dom.editSessionEndDate, dom.editSessionEndTime, end);
  editSessionState.syncing = false;

  validateEditSessionForm();
}

/** Start or end date/time changed -> recompute duration to match. */
function recomputeDurationFromRange() {
  if (editSessionState.syncing) return;
  const start = readStartDateTime();
  const end = readEndDateTime();
  if (!start || !end) return;

  editSessionState.syncing = true;
  const durationSeconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  setDurationInputs(durationSeconds);
  editSessionState.syncing = false;

  validateEditSessionForm();
}

/** Blocks saving (and shows why) if the end ends up before the start. */
function validateEditSessionForm() {
  const start = readStartDateTime();
  const end = readEndDateTime();
  const invalid = Boolean(start && end && end.getTime() < start.getTime());

  dom.editSessionError.textContent = invalid ? "End date/time can't be before the start." : "";
  dom.editSessionSubmitBtn.disabled = invalid;
  return !invalid;
}

async function handleEditSessionSubmit(event) {
  event.preventDefault();
  if (!editSessionState.sessionId) return;

  const start = readStartDateTime();
  const end = readEndDateTime();
  if (!start || !end) {
    dom.editSessionError.textContent = "Start and end date/time are required.";
    return;
  }
  if (!validateEditSessionForm()) return;

  const taskDescription = dom.editSessionDescription.value.trim();
  if (!taskDescription) {
    dom.editSessionError.textContent = "Task description is required.";
    return;
  }

  dom.editSessionSubmitBtn.disabled = true;
  try {
    await adminUpdateWorkSession(editSessionState.sessionId, {
      projectId: dom.editSessionProject.value,
      taskDescription,
      startedAt: start.toISOString(),
      stoppedAt: end.toISOString(),
      durationSeconds: readDurationSeconds(),
    });
    showToast("Session updated", "success");
    closeModal("editSessionModal");
    await loadReports();
  } catch (error) {
    dom.editSessionError.textContent = error.message || "Could not update this session.";
  } finally {
    dom.editSessionSubmitBtn.disabled = false;
  }
}

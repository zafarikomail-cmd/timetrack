// ============================================================================
// Projects module
// ----------------------------------------------------------------------------
// Track-time UI (project search/select, task description, Start/Pause/
// Resume/Stop timer wired to real Supabase work_sessions rows), a sessions
// table with filters/pagination, crash-recovery for unfinished sessions, and
// — for admins only — a Manage Projects panel (search, add/edit/delete).
// ============================================================================

import { getCurrentUser } from "./auth.js";
import {
  getProjects,
  getProjectMemberCounts,
  createProject,
  updateProject,
  deleteProject,
  getActiveSessionForUser,
  createWorkSession,
  pauseWorkSession,
  resumeWorkSession,
  stopWorkSession,
  getSessionsForUser,
  getDateRangeForPreset,
  getUserRole,
  getProfileById,
  isAdminLevel,
  formatDuration,
} from "./data.js";
import { showToast } from "./toast.js";
import { openModal, closeModal, initModalDismissal, confirmDialog } from "./modal.js";
import { renderPagination } from "./pagination.js";
import { startHeartbeat, isSessionFresh } from "./presence.js";

let currentUser = null;
let currentUserRole = null;
let projectsList = [];
let activeSession = null;
let tickInterval = null;
let stopHeartbeat = null;

/**
 * (Re)starts the presence heartbeat to match the current session state, and
 * stops it entirely once there's no active session. This is what lets other
 * viewers (Users page) tell "still working" apart from "closed the tab
 * without clicking Stop" — see js/presence.js for the staleness logic.
 */
function syncHeartbeat(session) {
  stopHeartbeat?.();
  stopHeartbeat = session ? startHeartbeat(session.id, session.status) : null;
}

const sessionsState = { page: 1, pageSize: 8, dateFilter: "all", projectFilter: "" };
const manageProjectsState = { page: 1, pageSize: 8, search: "" };

// DOM references (populated on init)
let dom = {};

document.addEventListener("DOMContentLoaded", initProjects);

async function initProjects() {
  currentUser = await getCurrentUser();
  if (!currentUser) return;

  // BUG FIXED: getUserRole(currentUser) always returned null, since role
  // lives in public.profiles.role, not on the auth user's app_metadata/
  // user_metadata. That silently kept isAdminLevel() false for every admin,
  // so the whole Manage Projects panel — including Add Project — never
  // rendered. Resolve the real role once here and cache it.
  const profile = await safeCall(() => getProfileById(currentUser.id));
  currentUserRole = getUserRole(profile) || getUserRole(currentUser);

  cacheDom();
  wireTrackViewEvents();
  initModalDismissal("projectModal");

  await loadProjects();

  const recovered = await safeCall(() => getActiveSessionForUser(currentUser.id));
  if (recovered) {
    // A session with a recent heartbeat is still genuinely in progress (the
    // user just switched tabs, refreshed, or navigated away and back) — for
    // that case, resume the track view straight into it with no interruption.
    // Only a STALE session (no heartbeat in 5+ minutes — see presence.js's
    // STALE_AFTER_MS) means the tab was likely closed without clicking Stop,
    // which is the one case actually worth interrupting the user to confirm.
    if (isSessionFresh(recovered)) {
      resumeActiveSessionInTrackView(recovered);
    } else {
      showRecoveryCard(recovered);
      disableAllTimerButtons();
    }
    syncHeartbeat(recovered);
  } else {
    activeSession = null;
    updateButtonStates();
  }

  await loadSessionsTable();

  if (isAdminLevel(currentUserRole)) {
    dom.tabGroup.hidden = false;
    dom.tabGroup.style.display = "";
    wireAdminManageProjects();
    await loadManageProjectsTable();
  } else {
    // BUG FIXED: setting `hidden = true` alone wasn't enough — some CSS
    // rule elsewhere (e.g. `.tab-group { display: flex; }`) has equal or
    // higher specificity than the browser's default [hidden] styling, so
    // the element kept rendering even though `hidden` was correctly `true`
    // in the DOM. Forcing `display: none` directly via inline style can't
    // be overridden by an external stylesheet, so this now actually hides
    // it regardless of whatever CSS exists for `.tab-group`.
    dom.tabGroup.hidden = true;
    dom.tabGroup.style.display = "none";
    dom.manageView.hidden = true;
    dom.trackView.hidden = false;
  }
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch (error) {
    console.error("Projects data load failed:", error.message);
    return null;
  }
}

function cacheDom() {
  dom = {
    tabGroup: document.getElementById("projectsTabGroup"),
    trackView: document.getElementById("projectsTrackView"),
    manageView: document.getElementById("projectsManageView"),

    projectSearch: document.getElementById("projectSearch"),
    projectSearchResults: document.getElementById("projectSearchResults"),
    projectSelect: document.getElementById("projectSelect"),
    projectSelectError: document.getElementById("projectSelectError"),
    projectDescriptionPreview: document.getElementById("projectDescriptionPreview"),
    taskDescription: document.getElementById("taskDescription"),
    taskDescriptionError: document.getElementById("taskDescriptionError"),

    timerDisplay: document.getElementById("timerDisplay"),
    timerStatus: document.getElementById("timerStatus"),
    timerMessage: document.getElementById("timerMessage"),
    startBtn: document.getElementById("startBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resumeBtn: document.getElementById("resumeBtn"),
    stopBtn: document.getElementById("stopBtn"),

    recoveryCard: document.getElementById("recoveryCard"),
    recoveryDetails: document.getElementById("recoveryDetails"),
    recoveryStopBtn: document.getElementById("recoveryStopBtn"),
    recoveryContinueBtn: document.getElementById("recoveryContinueBtn"),

    sessionsDateFilter: document.getElementById("sessionsDateFilter"),
    sessionsProjectFilter: document.getElementById("sessionsProjectFilter"),
    sessionsTableBody: document.getElementById("sessionsTableBody"),
    sessionsTableWrapper: document.getElementById("sessionsTableWrapper"),
    sessionsEmptyState: document.getElementById("sessionsEmptyState"),
    sessionsPagination: document.getElementById("sessionsPagination"),

    manageProjectsSearch: document.getElementById("manageProjectsSearch"),
    addProjectBtn: document.getElementById("addProjectBtn"),
    manageProjectsTableBody: document.getElementById("manageProjectsTableBody"),
    manageProjectsEmptyState: document.getElementById("manageProjectsEmptyState"),
    manageProjectsPagination: document.getElementById("manageProjectsPagination"),

    projectForm: document.getElementById("projectForm"),
    projectFormId: document.getElementById("projectFormId"),
    projectFormName: document.getElementById("projectFormName"),
    projectFormNameError: document.getElementById("projectFormNameError"),
    projectFormDescription: document.getElementById("projectFormDescription"),
    projectFormStatusGroup: document.getElementById("projectFormStatusGroup"),
    projectFormStatus: document.getElementById("projectFormStatus"),
    projectModalTitle: document.getElementById("projectModalTitle"),
    projectFormSubmitBtn: document.getElementById("projectFormSubmitBtn"),
  };
}

/* ============================================================================
   Project loading + searchable select
   ========================================================================== */
async function loadProjects() {
  projectsList = (await safeCall(() => getProjects(currentUserRole))) || [];
  renderProjectOptions();
  renderSessionsProjectFilterOptions();
}

function renderProjectOptions(searchQuery = "") {
  const activeProjects = projectsList.filter((p) => p.status === "active");
  const filtered = activeProjects.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const previousValue = dom.projectSelect.value;

  // BUG FIXED: a recovered/in-progress session (activeSession) can point at
  // a project that is no longer "active" (on_hold/completed/archived). This
  // filter used to drop that project's <option> entirely, so
  // activateRecoveredSession()'s `dom.projectSelect.value = ...` silently
  // matched no option and the dropdown rendered blank — a real project was
  // selected in the DB, but the UI showed nothing selected. Always keep the
  // in-progress session's own project in the list, regardless of status.
  const mustInclude =
    activeSession && !activeProjects.some((p) => p.id === activeSession.project_id)
      ? projectsList.find((p) => p.id === activeSession.project_id)
      : null;
  const options = mustInclude ? [...filtered, mustInclude] : filtered;

  dom.projectSelect.innerHTML =
    `<option value="">${activeProjects.length ? "Select a project…" : "No active projects available"}</option>` +
    options
      .map(
        (p) =>
          `<option value="${p.id}">${escapeHtml(p.name)}${p.status !== "active" ? " (inactive)" : ""}</option>`
      )
      .join("");

  if (options.some((p) => p.id === previousValue)) {
    dom.projectSelect.value = previousValue;
  }
  updateProjectDescriptionPreview();
}

function renderSessionsProjectFilterOptions() {
  dom.sessionsProjectFilter.innerHTML =
    `<option value="">All projects</option>` +
    projectsList.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

function updateProjectDescriptionPreview() {
  if (!isAdminLevel(currentUserRole)) {
    dom.projectDescriptionPreview.hidden = true;
    dom.projectDescriptionPreview.textContent = "";
    return;
  }
  dom.projectDescriptionPreview.hidden = false;
  const project = projectsList.find((p) => p.id === dom.projectSelect.value);
  dom.projectDescriptionPreview.textContent = project ? project.description || "No description provided." : "";
}

/* ============================================================================
   Validation
   ========================================================================== */
function validateBeforeStart() {
  let valid = true;

  if (!dom.projectSelect.value) {
    dom.projectSelectError.textContent = "Please select a project.";
    valid = false;
  } else {
    dom.projectSelectError.textContent = "";
  }

  if (!dom.taskDescription.value.trim()) {
    dom.taskDescriptionError.textContent = "Task description is required.";
    valid = false;
  } else {
    dom.taskDescriptionError.textContent = "";
  }

  return valid;
}

/* ============================================================================
   Timer rendering
   ========================================================================== */
function computeElapsedSeconds(session, referenceDate) {
  const startedAt = new Date(session.started_at).getTime();
  const pausedMs = session.total_paused_seconds * 1000;
  return Math.max(0, Math.floor((referenceDate.getTime() - startedAt - pausedMs) / 1000));
}

function renderTimer(session) {
  clearInterval(tickInterval);

  if (!session) {
    dom.timerDisplay.textContent = "00:00:00";
    dom.timerStatus.textContent = "Not started";
    return;
  }

  if (session.status === "running") {
    const update = () => {
      dom.timerDisplay.textContent = formatDuration(computeElapsedSeconds(session, new Date()));
    };
    update();
    tickInterval = setInterval(update, 1000);
    dom.timerStatus.textContent = "Running";
  } else {
    dom.timerDisplay.textContent = formatDuration(computeElapsedSeconds(session, new Date(session.paused_at)));
    dom.timerStatus.textContent = "Paused";
  }
}

function showTimerMessage(message, type) {
  dom.timerMessage.textContent = message;
  dom.timerMessage.dataset.type = type;
}

function disableAllTimerButtons() {
  [dom.startBtn, dom.pauseBtn, dom.resumeBtn, dom.stopBtn].forEach((btn) => (btn.disabled = true));
}

function updateButtonStates() {
  const hasValidInputs = Boolean(dom.projectSelect.value) && dom.taskDescription.value.trim().length > 0;

  if (!activeSession) {
    dom.startBtn.disabled = !hasValidInputs;
    dom.pauseBtn.hidden = false;
    dom.pauseBtn.disabled = true;
    dom.resumeBtn.hidden = true;
    dom.resumeBtn.disabled = true;
    dom.stopBtn.disabled = true;
    setInputsLocked(false);
  } else if (activeSession.status === "running") {
    dom.startBtn.disabled = true;
    dom.pauseBtn.hidden = false;
    dom.pauseBtn.disabled = false;
    dom.resumeBtn.hidden = true;
    dom.resumeBtn.disabled = true;
    dom.stopBtn.disabled = false;
    setInputsLocked(true);
  } else {
    dom.startBtn.disabled = true;
    dom.pauseBtn.hidden = true;
    dom.pauseBtn.disabled = true;
    dom.resumeBtn.hidden = false;
    dom.resumeBtn.disabled = false;
    dom.stopBtn.disabled = false;
    setInputsLocked(true);
  }
}

function setInputsLocked(locked) {
  dom.projectSelect.disabled = locked;
  dom.projectSearch.disabled = locked;
  dom.taskDescription.disabled = locked;
}

function resetTrackForm() {
  dom.projectSearch.value = "";
  dom.projectSearchResults.hidden = true;
  dom.projectSearchResults.innerHTML = "";
  renderProjectOptions();
  dom.projectSelect.value = "";
  dom.taskDescription.value = "";
  dom.projectDescriptionPreview.textContent = "";
  dom.projectSelectError.textContent = "";
  dom.taskDescriptionError.textContent = "";
}

async function finalizeStop(session, taskStatus = null) {
  const extraPausedSeconds =
    session.status === "paused"
      ? Math.max(0, Math.floor((Date.now() - new Date(session.paused_at).getTime()) / 1000))
      : 0;
  return stopWorkSession(session.id, extraPausedSeconds, session.total_paused_seconds, session.started_at, taskStatus);
}

/**
 * Shows the "How's this task?" modal and resolves with "completed" |
 * "in_progress" | "blocked" | null (null if dismissed via Escape without
 * picking — modal.js's openModal() always wires Escape to close, so this
 * has to resolve in that case too or the caller's `await` would hang).
 */
function askTaskStatus() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("taskStatusDialog");
    const buttons = overlay.querySelectorAll("[data-task-status]");
    let settled = false;

    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      buttons.forEach((btn) => btn.removeEventListener("click", onPick));
      document.removeEventListener("keydown", onKeydown);
      closeModal("taskStatusDialog");
      resolve(result);
    };
    const onPick = (event) => cleanup(event.currentTarget.dataset.taskStatus);
    const onKeydown = (event) => {
      if (event.key === "Escape") cleanup(null);
    };

    buttons.forEach((btn) => btn.addEventListener("click", onPick));
    document.addEventListener("keydown", onKeydown);
    openModal("taskStatusDialog");
  });
}

/* ============================================================================
   Crash recovery
   ========================================================================== */
function showRecoveryCard(session) {
  dom.recoveryCard.hidden = false;
  const projectName = session.projects?.name || "Untitled project";
  const startedLabel = new Date(session.started_at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  dom.recoveryDetails.textContent = `${projectName} — "${session.task_description}" (started ${startedLabel})`;
  activeSession = session;
}

function activateRecoveredSession() {
  dom.recoveryCard.hidden = true;
  resumeActiveSessionInTrackView(activeSession);
  showToast("Continuing your previous session", "info");
}

/**
 * Puts an existing (running/paused) session's data into the track-view UI —
 * selected project, task description, live timer, correct button states —
 * without showing the recovery popup. Used both when silently resuming a
 * still-fresh session on page load, and after the user clicks "Continue" on
 * a stale-session recovery card.
 */
function resumeActiveSessionInTrackView(session) {
  activeSession = session;
  // mustInclude logic in renderProjectOptions needs activeSession set first
  // (see its comment) or an inactive project's <option> won't exist yet.
  renderProjectOptions(dom.projectSearch.value);
  dom.projectSelect.value = session.project_id;
  dom.taskDescription.value = session.task_description;
  updateProjectDescriptionPreview();
  renderTimer(session);
  updateButtonStates();
}

async function stopRecoveredSession() {
  dom.recoveryStopBtn.disabled = true;
  dom.recoveryContinueBtn.disabled = true;
  try {
    const completed = await finalizeStop(activeSession);
    activeSession = null;
    syncHeartbeat(null);
    dom.recoveryCard.hidden = true;
    resetTrackForm();
    renderTimer(null);
    updateButtonStates();
    showToast(`Previous session saved — ${formatDuration(completed.duration_seconds)} logged`, "success");
    sessionsState.page = 1;
    await loadSessionsTable();
  } catch (error) {
    showToast(error.message || "Could not stop the previous session", "error");
  } finally {
    dom.recoveryStopBtn.disabled = false;
    dom.recoveryContinueBtn.disabled = false;
  }
}

function renderSearchResultsList(searchQuery) {
  const list = dom.projectSearchResults;
  if (!list) return;

  if (!searchQuery.trim()) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }

  const activeProjects = projectsList.filter((p) => p.status === "active");
  const matches = activeProjects.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()));

  if (matches.length === 0) {
    list.innerHTML = `<li style="padding:8px 10px; color:#64748b; font-size:14px;">No projects match "${escapeHtml(searchQuery)}"</li>`;
    list.hidden = false;
    return;
  }

  list.innerHTML = matches
    .map(
      (p) => `
      <li role="option" data-project-id="${p.id}" tabindex="0"
        style="padding:8px 10px; border-radius:6px; cursor:pointer; font-size:14px;">
        ${escapeHtml(p.name)}
      </li>`
    )
    .join("");
  list.hidden = false;

  list.querySelectorAll("[data-project-id]").forEach((item) => {
    item.addEventListener("mouseenter", () => (item.style.backgroundColor = "#f1f5f9"));
    item.addEventListener("mouseleave", () => (item.style.backgroundColor = ""));
    const pick = () => selectProjectFromSearch(item.dataset.projectId);
    item.addEventListener("click", pick);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  });
}

function selectProjectFromSearch(projectId) {
  const project = projectsList.find((p) => p.id === projectId);
  if (!project) return;

  renderProjectOptions(dom.projectSearch.value);
  dom.projectSelect.value = project.id;
  dom.projectSearch.value = project.name;
  dom.projectSearchResults.hidden = true;
  dom.projectSearchResults.innerHTML = "";
  updateProjectDescriptionPreview();
  dom.projectSelectError.textContent = "";
  if (!activeSession) updateButtonStates();
}

/* ============================================================================
   Track-view event wiring
   ========================================================================== */
function wireTrackViewEvents() {
  dom.projectSearch.addEventListener("input", () => {
    renderProjectOptions(dom.projectSearch.value);
    renderSearchResultsList(dom.projectSearch.value);
  });
  dom.projectSearch.addEventListener("focus", () => {
    if (dom.projectSearch.value.trim()) renderSearchResultsList(dom.projectSearch.value);
  });
  dom.projectSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      dom.projectSearchResults.hidden = true;
    }
  });
  document.addEventListener("click", (e) => {
    if (!dom.projectSearch.contains(e.target) && !dom.projectSearchResults.contains(e.target)) {
      dom.projectSearchResults.hidden = true;
    }
  });

  dom.projectSelect.addEventListener("change", () => {
    updateProjectDescriptionPreview();
    dom.projectSelectError.textContent = "";
    if (!activeSession) updateButtonStates();
  });
  dom.taskDescription.addEventListener("input", () => {
    dom.taskDescriptionError.textContent = "";
    if (!activeSession) updateButtonStates();
  });

  dom.startBtn.addEventListener("click", handleStart);
  dom.pauseBtn.addEventListener("click", handlePause);
  dom.resumeBtn.addEventListener("click", handleResume);
  dom.stopBtn.addEventListener("click", handleStop);

  dom.recoveryContinueBtn.addEventListener("click", activateRecoveredSession);
  dom.recoveryStopBtn.addEventListener("click", stopRecoveredSession);

  dom.sessionsDateFilter.addEventListener("change", () => {
    sessionsState.dateFilter = dom.sessionsDateFilter.value;
    sessionsState.page = 1;
    loadSessionsTable();
  });
  dom.sessionsProjectFilter.addEventListener("change", () => {
    sessionsState.projectFilter = dom.sessionsProjectFilter.value;
    sessionsState.page = 1;
    loadSessionsTable();
  });

  dom.tabGroup.addEventListener("click", (event) => {
    const btn = event.target.closest(".tab-btn");
    if (!btn) return;
    dom.tabGroup.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    const showManage = btn.dataset.tab === "manage";
    dom.trackView.hidden = showManage;
    dom.manageView.hidden = !showManage;
  });
}

async function handleStart() {
  if (!validateBeforeStart()) {
    const missingProject = !dom.projectSelect.value;
    const missingDescription = !dom.taskDescription.value.trim();

    if (missingProject && missingDescription) {
      showToast("Selecting a project and a task description are both mandatory.", "error");
    } else if (missingProject) {
      showToast("Selecting a project is mandatory.", "error");
    } else {
      showToast("Task description is mandatory.", "error");
    }
    return;
  }
  disableAllTimerButtons();

  try {
    const existing = await getActiveSessionForUser(currentUser.id);
    if (existing) await finalizeStop(existing);

    activeSession = await createWorkSession({
      userId: currentUser.id,
      projectId: dom.projectSelect.value,
      taskDescription: dom.taskDescription.value.trim(),
    });
    renderTimer(activeSession);
    syncHeartbeat(activeSession);
    showTimerMessage("Timer started.", "success");
    showToast("Timer started", "success");
  } catch (error) {
    showTimerMessage(error.message || "Could not start the timer.", "error");
    showToast("Could not start the timer", "error");
  } finally {
    updateButtonStates();
  }
}

async function handlePause() {
  if (!activeSession) return;
  disableAllTimerButtons();

  try {
    activeSession = await pauseWorkSession(activeSession.id);
    renderTimer(activeSession);
    syncHeartbeat(activeSession);
    showTimerMessage("Timer paused.", "success");
    showToast("Timer paused", "info");
  } catch (error) {
    showTimerMessage(error.message || "Could not pause the timer.", "error");
    showToast("Could not pause the timer", "error");
  } finally {
    updateButtonStates();
  }
}

async function handleResume() {
  if (!activeSession) return;
  disableAllTimerButtons();

  try {
    const additionalPaused = Math.max(
      0,
      Math.floor((Date.now() - new Date(activeSession.paused_at).getTime()) / 1000)
    );
    activeSession = await resumeWorkSession(activeSession.id, additionalPaused, activeSession.total_paused_seconds);
    renderTimer(activeSession);
    syncHeartbeat(activeSession);
    showTimerMessage("Timer resumed.", "success");
    showToast("Timer resumed", "info");
  } catch (error) {
    showTimerMessage(error.message || "Could not resume the timer.", "error");
    showToast("Could not resume the timer", "error");
  } finally {
    updateButtonStates();
  }
}

async function handleStop() {
  if (!activeSession) return;

  // Ask before disabling buttons or touching the DB. If the user escapes
  // out without picking a status, cancel the stop entirely — the timer
  // stays running/paused exactly as it was, nothing gets finalized.
  const taskStatus = await askTaskStatus();
  if (!taskStatus) {
    showToast("Stop cancelled — pick a status to finish the session.", "info");
    return;
  }

  disableAllTimerButtons();

  try {
    const completed = await finalizeStop(activeSession, taskStatus);
    activeSession = null;
    syncHeartbeat(null);
    resetTrackForm();
    renderTimer(null);
    showTimerMessage(`Session saved — ${formatDuration(completed.duration_seconds)} logged.`, "success");
    showToast("Session stopped and saved", "success");
    sessionsState.page = 1;
    await loadSessionsTable();
  } catch (error) {
    showTimerMessage(error.message || "Could not stop the timer.", "error");
    showToast("Could not stop the timer", "error");
  } finally {
    updateButtonStates();
  }
}

/* ============================================================================
   Sessions table
   ========================================================================== */
async function loadSessionsTable() {
  const { from, to } =
    sessionsState.dateFilter === "all" ? { from: null, to: null } : getDateRangeForPreset(sessionsState.dateFilter);

  const result = await safeCall(() =>
    getSessionsForUser(currentUser.id, {
      from,
      to,
      projectId: sessionsState.projectFilter || undefined,
      page: sessionsState.page,
      pageSize: sessionsState.pageSize,
    })
  );

  const rows = result?.rows || [];
  const count = result?.count || 0;

  dom.sessionsEmptyState.hidden = rows.length > 0;
  dom.sessionsTableWrapper.hidden = rows.length === 0;

  dom.sessionsTableBody.innerHTML = rows
    .map(
      (s) => `
      <tr>
        <td>${escapeHtml(s.projects?.name || "Untitled project")}</td>
        <td>${escapeHtml(truncate(s.task_description, 60))}</td>
        <td>${new Date(s.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
        <td>${s.status === "completed" ? formatDuration(s.duration_seconds) : "—"}</td>
        <td>${renderTaskStatusBadge(s.task_status)}</td>
      </tr>`
    )
    .join("");

  renderPagination(
    dom.sessionsPagination,
    { page: sessionsState.page, pageSize: sessionsState.pageSize, total: count },
    (page) => {
      sessionsState.page = page;
      loadSessionsTable();
    }
  );
}

/* ============================================================================
   Admin: Manage Projects
   ========================================================================== */
function wireAdminManageProjects() {
  dom.manageProjectsSearch.addEventListener("input", () => {
    manageProjectsState.search = dom.manageProjectsSearch.value;
    manageProjectsState.page = 1;
    loadManageProjectsTable();
  });

  dom.addProjectBtn.addEventListener("click", () => {
    dom.projectForm.reset();
    dom.projectFormId.value = "";
    dom.projectModalTitle.textContent = "Add Project";
    dom.projectFormStatusGroup.hidden = true;
    openModal("projectModal");
  });

  dom.manageProjectsTableBody.addEventListener("click", async (event) => {
    const editBtn = event.target.closest("[data-edit-project]");
    const deleteBtn = event.target.closest("[data-delete-project]");

    if (editBtn) {
      const project = projectsList.find((p) => p.id === editBtn.dataset.editProject);
      if (!project) return;
      dom.projectForm.reset();
      dom.projectFormId.value = project.id;
      dom.projectFormName.value = project.name;
      dom.projectFormDescription.value = project.description || "";
      dom.projectFormStatus.value = project.status;
      dom.projectModalTitle.textContent = "Edit Project";
      dom.projectFormStatusGroup.hidden = false;
      openModal("projectModal");
    }

    if (deleteBtn) {
      const project = projectsList.find((p) => p.id === deleteBtn.dataset.deleteProject);
      if (!project) return;
      const confirmed = await confirmDialog({
        title: "Delete this project?",
        message: `"${project.name}" will be permanently removed. This can't be undone.`,
      });
      if (!confirmed) return;

      try {
        await deleteProject(project.id);
        showToast("Project deleted", "success");
        await loadProjects();
        await loadManageProjectsTable();
        sessionsState.page = 1;
        await loadSessionsTable();
      } catch (error) {
        // BUG FIXED: this used to just show "This project can't be deleted
        // because it has time sessions attached to it" and stop — a dead
        // end with no path forward. A project with real logged hours can't
        // be hard-deleted (work_sessions.project_id has a foreign key back
        // to this row) without either failing outright or destroying that
        // history. Offer archiving instead: it removes the project from the
        // active picker (see renderProjectOptions' status === "active"
        // filter) and from new timers, while every session already logged
        // against it stays fully intact in Reports/Overview.
        if (error.code === "23503") {
          await offerArchiveInstead(project);
        } else {
          showToast(error.message || "Could not delete the project.", "error");
        }
      }
    }
  });

  dom.projectForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = dom.projectFormName.value.trim();
    if (!name) {
      dom.projectFormNameError.textContent = "Project name is required.";
      return;
    }
    dom.projectFormNameError.textContent = "";

    const description = dom.projectFormDescription.value.trim();
    dom.projectFormSubmitBtn.disabled = true;

    try {
      if (dom.projectFormId.value) {
        await updateProject(dom.projectFormId.value, {
          name,
          description,
          status: dom.projectFormStatus.value,
        });
        showToast("Project updated", "success");
      } else {
        await createProject({ name, description });
        showToast("Project added", "success");
      }
      closeModal("projectModal");
      await loadProjects();
      await loadManageProjectsTable();
    } catch (error) {
      showToast(error.message || "Could not save the project.", "error");
    } finally {
      dom.projectFormSubmitBtn.disabled = false;
    }
  });
}

/**
 * Fallback when a project can't be hard-deleted because it has time sessions
 * attached (Postgres FK violation, code 23503 — see the delete handler
 * above). Rather than a dead end, offers to archive it: archived projects
 * are excluded from the active project picker/new timers, but every session
 * already logged against them stays fully intact — nobody's recorded hours
 * disappear from Reports or Overview.
 */
async function offerArchiveInstead(project) {
  const confirmed = await confirmDialog({
    title: "Can't permanently delete this project",
    message: `"${project.name}" has time sessions logged against it, so deleting it would destroy that history. Archive it instead? It'll disappear from the active project list and can't be picked for new timers, but all its logged hours stay intact in Reports and Overview.`,
    confirmLabel: "Archive Project",
  });
  if (!confirmed) return;

  try {
    await updateProject(project.id, {
      name: project.name,
      description: project.description || "",
      status: "archived",
    });
    showToast("Project archived", "success");
    await loadProjects();
    await loadManageProjectsTable();
  } catch (error) {
    showToast(error.message || "Could not archive the project.", "error");
  }
}

async function loadManageProjectsTable() {
  const memberCounts = (await safeCall(getProjectMemberCounts)) || {};
  const filtered = projectsList.filter((p) =>
    p.name.toLowerCase().includes(manageProjectsState.search.toLowerCase())
  );

  const start = (manageProjectsState.page - 1) * manageProjectsState.pageSize;
  const pageRows = filtered.slice(start, start + manageProjectsState.pageSize);

  dom.manageProjectsEmptyState.hidden = filtered.length > 0;
  dom.manageProjectsTableBody.innerHTML = pageRows
    .map(
      (p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(truncate(p.description || "—", 60))}</td>
        <td>${memberCounts[p.id] || 0}</td>
        <td>${new Date(p.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}</td>
        <td><span class="badge badge-${p.status === "active" ? "online" : "offline"}">${p.status}</span></td>
        <td>
          <div class="table-row-actions">
            <button type="button" class="btn btn-outline btn-sm" data-edit-project="${p.id}">Edit</button>
            <button type="button" class="btn btn-danger btn-sm" data-delete-project="${p.id}">Delete</button>
          </div>
        </td>
      </tr>`
    )
    .join("");

  renderPagination(
    dom.manageProjectsPagination,
    { page: manageProjectsState.page, pageSize: manageProjectsState.pageSize, total: filtered.length },
    (page) => {
      manageProjectsState.page = page;
      loadManageProjectsTable();
    }
  );
}

/* ============================================================================
   Utilities
   ========================================================================== */
/**
 * Renders the task_status column as a colored badge (green Completed, blue
 * In Progress, red Blocked/Other), or a neutral "Not specified" for rows
 * recorded before this feature existed (task_status is null). Uses the real
 * badge-task-* classes in Component.css rather than inline colors.
 */
function renderTaskStatusBadge(taskStatus) {
  const labels = { completed: "Completed", in_progress: "In Progress", blocked: "Blocked / Other" };
  const key = labels[taskStatus] ? taskStatus : "none";
  const label = labels[taskStatus] || "Not specified";
  return `<span class="badge badge-task-${key}">${label}</span>`;
}

function truncate(str, maxLength) {
  if (!str) return "";
  return str.length > maxLength ? `${str.slice(0, maxLength)}…` : str;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
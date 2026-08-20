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
  updateWorkSession,
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
import { renderResultsSummary } from "./pagination.js";
import { startHeartbeat } from "./presence.js";

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
    // Resume straight into the track view with no interruption, whether the
    // session is still fresh (user switched tabs/refreshed) or was left
    // running after the tab closed.
    resumeActiveSessionInTrackView(recovered);
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
    stopBtn: document.getElementById("stopBtn"),

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
  // resumeActiveSessionInTrackView()'s `dom.projectSelect.value = ...` silently
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

  const update = () => {
    dom.timerDisplay.textContent = formatDuration(computeElapsedSeconds(session, new Date()));
  };
  update();
  tickInterval = setInterval(update, 1000);
  dom.timerStatus.textContent = "Running";
}

function showTimerMessage(message, type) {
  dom.timerMessage.textContent = message;
  dom.timerMessage.dataset.type = type;
}

function disableAllTimerButtons() {
  [dom.startBtn, dom.stopBtn].forEach((btn) => (btn.disabled = true));
}

function updateButtonStates() {
  const hasValidInputs = Boolean(dom.projectSelect.value) && dom.taskDescription.value.trim().length > 0;

  if (!activeSession) {
    dom.startBtn.disabled = !hasValidInputs;
    dom.stopBtn.disabled = true;
  } else {
    // CHANGED PER CLIENT REQUEST — project and task description used to be
    // locked (disabled) for the whole duration of a running session. They
    // now stay editable at all times; edits are persisted live to the
    // active session row (see persistActiveSessionProject/Task below), so
    // the DB always reflects the latest values the user typed/picked.
    dom.startBtn.disabled = true;
    dom.stopBtn.disabled = false;
  }
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

async function finalizeStop(session) {
  const extraPausedSeconds =
    session.status === "paused"
      ? Math.max(0, Math.floor((Date.now() - new Date(session.paused_at).getTime()) / 1000))
      : 0;
  return stopWorkSession(session.id, extraPausedSeconds, session.total_paused_seconds, session.started_at);
}

/* ============================================================================
   Live editing of an in-progress session
   ----------------------------------------------------------------------------
   CLIENT REQUEST: project and task description must stay editable while the
   timer is running, and every edit should be saved straight to the active
   session row — not just applied at Stop time.
   ========================================================================== */
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Persists a project change on the currently-running session. Immediate
 * (not debounced) since picking a project is a single discrete action, not
 * continuous typing. Guards against an empty selection — you can't point a
 * running session at "no project" — by reverting the dropdown and leaving
 * the DB row untouched.
 */
async function persistActiveSessionProject(projectId) {
  if (!activeSession) return;

  if (!projectId) {
    dom.projectSelectError.textContent = "Please select a project.";
    dom.projectSelect.value = activeSession.project_id;
    updateProjectDescriptionPreview();
    return;
  }

  try {
    activeSession = await updateWorkSession(activeSession.id, { projectId });
    dom.projectSelectError.textContent = "";
    showToast("Project updated", "success");
  } catch (error) {
    showToast(error.message || "Could not update the project.", "error");
    // Revert the visible selection to match what's actually saved in the DB.
    dom.projectSelect.value = activeSession.project_id;
    updateProjectDescriptionPreview();
  }
}

/**
 * Persists a task-description change on the currently-running session,
 * debounced so it fires once typing pauses rather than on every keystroke.
 * Skips saving (silently) while the field is blank — an empty description
 * isn't meaningful to store — and picks back up as soon as text is entered.
 */
const persistActiveSessionTask = debounce(async (taskDescription) => {
  if (!activeSession) return;
  const trimmed = taskDescription.trim();
  if (!trimmed) return;

  try {
    activeSession = await updateWorkSession(activeSession.id, { taskDescription: trimmed });
    dom.taskDescriptionError.textContent = "";
  } catch (error) {
    showToast(error.message || "Could not update the task description.", "error");
  }
}, 600);

/* ============================================================================
   Session recovery
   ========================================================================== */
/**
 * Puts an existing (running) session's data into the track-view UI —
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
  if (activeSession) {
    persistActiveSessionProject(project.id);
  } else {
    updateButtonStates();
  }
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
    if (activeSession) {
      persistActiveSessionProject(dom.projectSelect.value);
    } else {
      updateButtonStates();
    }
  });
  dom.taskDescription.addEventListener("input", () => {
    dom.taskDescriptionError.textContent = "";
    if (activeSession) {
      persistActiveSessionTask(dom.taskDescription.value);
    } else {
      updateButtonStates();
    }
  });

  dom.startBtn.addEventListener("click", handleStart);
  dom.stopBtn.addEventListener("click", handleStop);

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

async function handleStop() {
  if (!activeSession) return;

  // CHANGED PER CLIENT REQUEST: Stop now finalizes the session immediately
  // — the "How's this task?" dialog has been removed entirely, along with
  // task_status everywhere else in the app.
  disableAllTimerButtons();

  try {
    const completed = await finalizeStop(activeSession);
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

  // Scrollable list instead of pages: fetch every matching session in one
  // go (page 1 of a high pageSize) rather than one page-size chunk at a
  // time — #sessionsTableWrapper (see Component.css) scrolls internally.
  const result = await safeCall(() =>
    getSessionsForUser(currentUser.id, {
      from,
      to,
      projectId: sessionsState.projectFilter || undefined,
      page: 1,
      pageSize: 5000,
    })
  );

  const rows = result?.rows || [];
  const count = result?.count || rows.length;

  dom.sessionsEmptyState.hidden = rows.length > 0;
  dom.sessionsTableWrapper.hidden = rows.length === 0;

  dom.sessionsTableBody.innerHTML = rows
    .map(
      (s) => `
      <tr>
        <td class="cell-truncate" title="${escapeHtml(s.projects?.name || "Untitled project")}">${escapeHtml(s.projects?.name || "Untitled project")}</td>
        <td class="cell-wrap">${escapeHtml(truncate(s.task_description, 60))}</td>
        <td>${new Date(s.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</td>
        <td>${s.status === "completed" ? formatDuration(s.duration_seconds) : "—"}</td>
      </tr>`
    )
    .join("");

  renderResultsSummary(dom.sessionsPagination, { total: count, itemLabel: count === 1 ? "session" : "sessions" });
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

  dom.manageProjectsEmptyState.hidden = filtered.length > 0;

  // Scrollable list instead of pages: every matching project renders at
  // once and #manageProjectsTableWrapper (see Component.css) scrolls
  // internally.
  dom.manageProjectsTableBody.innerHTML = filtered
    .map(
      (p) => `
      <tr>
        <td class="cell-truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
        <td class="cell-wrap">${escapeHtml(truncate(p.description || "—", 60))}</td>
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

  renderResultsSummary(dom.manageProjectsPagination, { total: filtered.length, itemLabel: filtered.length === 1 ? "project" : "projects" });
}

/* ============================================================================
   Utilities
   ========================================================================== */
function truncate(str, maxLength) {
  if (!str) return "";
  return str.length > maxLength ? `${str.slice(0, maxLength)}…` : str;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

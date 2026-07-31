// ============================================================================
// Report utilities
// ----------------------------------------------------------------------------
// Small, pure helper functions shared by overview.js, reports.js, profile.js
// (and reused patterns from Project.js). No Supabase/DOM calls here — just
// date bucketing, aggregation, formatting, search and client-side paging so
// every page's charts/tables/exports agree on the same numbers.
// ============================================================================

/**
 * Returns an array of `n` Date objects (midnight, local time), oldest first,
 * ending today. e.g. lastNDays(7) -> [6 days ago, ..., yesterday, today]
 */
export function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    days.push(d);
  }
  return days;
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Sums duration_seconds across a list of sessions (missing values treated as 0). */
export function sumDuration(sessions) {
  return sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
}

/** Groups completed sessions' hours by project name. Returns {labels, values}. */
export function groupHoursByProject(sessions) {
  const byProject = {};
  sessions.forEach((s) => {
    const name = s.projects?.name || "Untitled project";
    byProject[name] = (byProject[name] || 0) + (s.duration_seconds || 0);
  });
  return { labels: Object.keys(byProject), values: Object.values(byProject) };
}

/** Groups completed sessions' hours by user (full_name/email). Returns {labels, values}. */
export function groupHoursByUser(sessions) {
  const byUser = {};
  sessions.forEach((s) => {
    const name = s.profiles?.full_name || s.profiles?.email || "Unknown";
    byUser[name] = (byUser[name] || 0) + (s.duration_seconds || 0);
  });
  const sorted = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
  return { labels: sorted.map((e) => e[0]), values: sorted.map((e) => e[1]) };
}

/** Counts sessions by broad status bucket. Returns {completed, active}. */
export function countByStatus(sessions) {
  let completed = 0;
  let active = 0;
  sessions.forEach((s) => {
    if (s.status === "completed") completed += 1;
    else active += 1;
  });
  return { completed, active };
}

/** Builds a daily-hours series (in hours, 2dp) for completed sessions across the given days. */
export function dailyHoursSeries(completedSessions, days) {
  return days.map((day) => {
    const seconds = completedSessions
      .filter((s) => isSameDay(new Date(s.started_at), day))
      .reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
    return +(seconds / 3600).toFixed(2);
  });
}

/** Running total of a numeric series. */
export function cumulativeSeries(values) {
  let total = 0;
  return values.map((v) => {
    total += v;
    return +total.toFixed(2);
  });
}

export function dayLabelsShort(days) {
  return days.map((d) => d.toLocaleDateString(undefined, { weekday: "short" }));
}

export function dayLabelsMonthDay(days) {
  return days.map((d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" }));
}

/** Case-insensitive search across task description, project name, and user name/email. */
export function filterBySearch(sessions, search) {
  const query = (search || "").trim().toLowerCase();
  if (!query) return sessions;

  return sessions.filter((s) => {
    const haystack = [
      s.task_description,
      s.projects?.name,
      s.profiles?.full_name,
      s.profiles?.email,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

/** Slices an already-sorted array into a page. Returns {rows, count}. */
export function paginateClientSide(sortedArray, page, pageSize) {
  const count = sortedArray.length;
  const start = (page - 1) * pageSize;
  return { rows: sortedArray.slice(start, start + pageSize), count };
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

export function truncate(str, maxLength) {
  if (!str) return "";
  return str.length > maxLength ? `${str.slice(0, maxLength)}…` : str;
}

export function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function secondsToHoursMinutes(totalSeconds) {
  const seconds = Math.max(0, totalSeconds || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
// ============================================================================
// Pagination helper
// ----------------------------------------------------------------------------
// Renders a consistent "Showing X–Y of Z" + page-number control into any
// container, shared by Projects sessions table, Overview, Users, Reports.
// ============================================================================

/**
 * @param {HTMLElement} container - element to render pagination into
 * @param {Object} state
 * @param {number} state.page - current 1-indexed page
 * @param {number} state.pageSize
 * @param {number} state.total - total row count
 * @param {(page: number) => void} onPageChange
 */
export function renderPagination(container, { page, pageSize, total }, onPageChange) {
  if (!container) return;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  const pageNumbers = getVisiblePageNumbers(page, totalPages);

  container.innerHTML = `
    <span class="pagination-info">${total === 0 ? "No results" : `Showing ${start}–${end} of ${total}`}</span>
    <div class="pagination-controls">
      <button type="button" class="page-btn" data-page="prev" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">‹</button>
      ${pageNumbers
        .map((p) =>
          p === "…"
            ? `<span class="pagination-info" aria-hidden="true">…</span>`
            : `<button type="button" class="page-btn ${p === page ? "is-active" : ""}" data-page="${p}">${p}</button>`
        )
        .join("")}
      <button type="button" class="page-btn" data-page="next" ${page >= totalPages ? "disabled" : ""} aria-label="Next page">›</button>
    </div>
  `;

  container.querySelectorAll("[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.page;
      if (target === "prev") return onPageChange(Math.max(1, page - 1));
      if (target === "next") return onPageChange(Math.min(totalPages, page + 1));
      onPageChange(Number(target));
    });
  });
}

/**
 * Replaces renderPagination() for tables that now scroll instead of
 * paginating (Users, Reports "Detailed Report"). Renders just the
 * "Showing all N ___" text into the same container the old page-number
 * controls used to live in — no buttons, since every matching row is
 * already in the DOM and the table-wrapper itself scrolls.
 *
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {number} opts.total
 * @param {string} [opts.itemLabel] - e.g. "users", "sessions"
 */
export function renderResultsSummary(container, { total, itemLabel = "results" }) {
  if (!container) return;
  container.innerHTML = `<span class="pagination-info">${
    total === 0 ? "No results" : `Showing all ${total} ${itemLabel}`
  }</span>`;
}

function getVisiblePageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);

  const result = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) result.push("…");
    result.push(p);
  });
  return result;
}

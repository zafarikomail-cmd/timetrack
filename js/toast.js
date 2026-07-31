// ============================================================================
// Toast notifications
// ----------------------------------------------------------------------------
// Minimal, dependency-free toast system. Any module can call showToast() to
// surface success/error/info feedback without duplicating markup or timers.
// ============================================================================

const ICONS = {
  success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

let container = null;

function getContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-atomic", "false");
  document.body.appendChild(container);
  return container;
}

/**
 * Shows a toast notification.
 * @param {string} message
 * @param {"success"|"error"|"info"} [type="info"]
 * @param {number} [duration=4000] - ms before auto-dismiss
 */
export function showToast(message, type = "info", duration = 4000) {
  const toastEl = document.createElement("div");
  toastEl.className = `toast toast-${type}`;
  toastEl.setAttribute("role", "status");
  toastEl.innerHTML = `
    <span class="toast-icon">${ICONS[type] || ICONS.info}</span>
    <span class="toast-text"></span>
    <button type="button" class="toast-close" aria-label="Dismiss notification">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
  `;
  toastEl.querySelector(".toast-text").textContent = message;

  const remove = () => {
    toastEl.classList.add("is-leaving");
    toastEl.addEventListener("animationend", () => toastEl.remove(), { once: true });
  };

  toastEl.querySelector(".toast-close").addEventListener("click", remove);
  getContainer().appendChild(toastEl);

  if (duration > 0) {
    setTimeout(remove, duration);
  }

  return remove;
}
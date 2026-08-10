// ============================================================================
// Modal helper
// ----------------------------------------------------------------------------
// Wires open/close behavior for any [data-modal] overlay already present in
// the DOM, plus a reusable confirm() dialog for destructive actions
// (delete user, delete project, etc.) so every page shares one component.
// ============================================================================

/**
 * Opens a modal overlay by id and focuses its first focusable element.
 */
export function openModal(modalId) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));

  const focusable = overlay.querySelector("input, textarea, select, button");
  focusable?.focus();

  document.addEventListener("keydown", handleEscapeOnce);

  function handleEscapeOnce(event) {
    if (event.key === "Escape") {
      closeModal(modalId);
      document.removeEventListener("keydown", handleEscapeOnce);
    }
  }
}

/**
 * Closes a modal overlay by id.
 */
export function closeModal(modalId) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;

  overlay.classList.remove("is-open");
  setTimeout(() => {
    overlay.hidden = true;
  }, 200);
}

/**
 * Wires standard dismiss behavior (backdrop click + [data-modal-close]
 * buttons) for a modal overlay. Call once per modal after it's in the DOM.
 */
export function initModalDismissal(modalId) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(modalId);
  });

  overlay.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(modalId));
  });
}

/**
 * Shows a reusable confirmation dialog (used for delete actions).
 * Returns a Promise<boolean> resolved true if the user confirms.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel="Delete"]
 * @param {string} [options.cancelLabel="Cancel"]
 */
export function confirmDialog({ title, message, confirmLabel = "Delete", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirmDialog");
    overlay.querySelector("#confirmDialogTitle").textContent = title;
    overlay.querySelector("#confirmDialogMessage").textContent = message;

    const confirmBtn = overlay.querySelector("#confirmDialogConfirmBtn");
    const cancelBtn = overlay.querySelector("#confirmDialogCancelBtn");
    confirmBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const cleanup = (result) => {
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      closeModal("confirmDialog");
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);

    openModal("confirmDialog");
  });
}

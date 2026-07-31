// ============================================================================
// Navigation module
// ----------------------------------------------------------------------------
// Handles in-page section switching (no reloads), active nav item state,
// page title updates, and the mobile sidebar open/close behavior.
// ============================================================================

const SECTION_PREFIX = "section-";

let navItems = [];
let sections = [];
let pageTitleEl = null;
let onSectionChange = null;
let getRoleFn = null;
let restrictedSections = {};
let onAccessDenied = null;

/**
 * Wires up click/keyboard navigation between sections.
 * @param {Object} options
 * @param {NodeListOf<Element>} options.navItems - nav buttons with [data-section]
 * @param {NodeListOf<Element>} options.sections - content sections with matching ids
 * @param {HTMLElement} options.pageTitleEl - element to update with the section title
 * @param {(sectionKey: string) => void} [options.onChange] - optional callback after switching
 * @param {() => string|null} [options.getRole] - returns the current user's role
 * @param {Record<string, string[]>} [options.restrictedSections] - sectionKey -> allowed roles
 * @param {(sectionKey: string) => void} [options.onAccessDenied] - called (instead of switching) when a role check fails
 */
export function initNavigation({
  navItems: items,
  sections: sects,
  pageTitleEl: titleEl,
  onChange,
  getRole,
  restrictedSections: restricted,
  onAccessDenied: deniedCallback,
}) {
  navItems = Array.from(items);
  sections = Array.from(sects);
  pageTitleEl = titleEl;
  onSectionChange = onChange ?? null;
  getRoleFn = getRole ?? null;
  restrictedSections = restricted ?? {};
  onAccessDenied = deniedCallback ?? null;

  const navList = navItems[0]?.closest("ul");
  if (navList) {
    // Event delegation: a single listener handles all current and future nav items.
    navList.addEventListener("click", (event) => {
      const button = event.target.closest(".nav-item[data-section]");
      if (!button || button.hidden || button.closest("[hidden]")) return;
      switchSection(button.dataset.section);
    });
  }
}

/**
 * Activates the section matching the given key, updates nav state and title.
 * Enforces role restrictions server-side-of-the-UI: this is a defense-in-depth
 * check, not the real security boundary (RLS/Edge Functions are) — but it
 * means a restricted section can never actually render its content just
 * because someone bypassed the (CSS-hidden) nav button, e.g. by calling
 * switchSection() directly from devtools or an old bookmark/hash.
 */
export function switchSection(sectionKey) {
  if (!sectionKey) return;

  const allowedRoles = restrictedSections[sectionKey];
  if (allowedRoles) {
    const role = getRoleFn ? getRoleFn() : null;
    if (!role || !allowedRoles.includes(role)) {
      onAccessDenied?.(sectionKey);
      switchSection("dashboard");
      return;
    }
  }

  const targetSection = sections.find((section) => section.id === `${SECTION_PREFIX}${sectionKey}`);
  if (!targetSection) return;

  sections.forEach((section) => {
    section.hidden = section !== targetSection;
  });

  navItems.forEach((item) => {
    const isActive = item.dataset.section === sectionKey;
    item.classList.toggle("is-active", isActive);
    if (isActive) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  });

  if (pageTitleEl) {
    pageTitleEl.textContent = targetSection.dataset.title || targetSection.id.replace(SECTION_PREFIX, "");
  }

  if (typeof onSectionChange === "function") {
    onSectionChange(sectionKey);
  }
}

/**
 * Wires up the mobile sidebar: menu button opens it, close button and
 * overlay close it, and Escape closes it while it's open.
 */
export function initSidebarToggle({ sidebar, overlay, menuToggle, closeButton }) {
  const openSidebar = () => {
    sidebar.classList.add("is-open");
    overlay.classList.add("is-visible");
    menuToggle.setAttribute("aria-expanded", "true");
  };

  const closeSidebar = () => {
    sidebar.classList.remove("is-open");
    overlay.classList.remove("is-visible");
    menuToggle.setAttribute("aria-expanded", "false");
  };

  menuToggle.addEventListener("click", () => {
    const isOpen = sidebar.classList.contains("is-open");
    isOpen ? closeSidebar() : openSidebar();
  });

  closeButton.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
      closeSidebar();
    }
  });

  // Closing the sidebar automatically after selecting a section on mobile
  // keeps the interaction pattern consistent with familiar mobile apps.
  sidebar.addEventListener("click", (event) => {
    const isNavItem = event.target.closest(".nav-item[data-section]");
    if (isNavItem && window.matchMedia("(max-width: 1024px)").matches) {
      closeSidebar();
    }
  });
}
// ============================================================================
// Avatar helper — single source of truth for initials + color hashing
// ----------------------------------------------------------------------------
// Previously app.js, dashboard.js, and profile.js each had their own copy of
// getInitials()/getAvatarColor(), and two of them used different color
// arrays (AVATAR_PALETTE vs CHART_COLORS). Same hash formula, different
// palettes => the same person could show up as a different color in the
// navbar vs. the dashboard/profile avatar. users.js had no avatar at all.
// Everything now imports from here so a given name always maps to the same
// initials and the same color everywhere in the app.
// ============================================================================

export const AVATAR_PALETTE = [
  "#2563eb", "#7c3aed", "#db2777", "#dc2626",
  "#ea580c", "#16a34a", "#0d9488", "#0284c7",
];

export function getInitials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function getAvatarColor(name) {
  const str = name || "";
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

/** Renders the initials + background color onto an existing avatar element. */
export function paintAvatar(el, name) {
  if (!el) return;
  el.textContent = getInitials(name);
  el.style.backgroundColor = getAvatarColor(name);
  el.setAttribute("title", name || "");
}

export function formatRoleLabel(role) {
  if (role === "super_admin") return "Super Admin";
  if (role === "admin") return "Admin";
  return "Employee";
}
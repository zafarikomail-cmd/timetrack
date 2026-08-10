// ============================================================================
// Chart helper
// ----------------------------------------------------------------------------
// Thin wrapper around the Chart.js UMD build (loaded via CDN in app.html).
// Centralizes the color palette, default styling, and the "no data yet"
// empty-state overlay so every page's charts look and behave consistently.
// ============================================================================

export const CHART_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#ea580c",
  "#16a34a", "#0d9488", "#0284c7", "#d97706",
];

const BASE_FONT = {
  family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
};

// BUG FIXED: charts were rendering "successfully" (no JS error, legends
// showed real data) but the canvas itself stayed blank on every page
// (Overview, Dashboard, Reports). Chart.js's `responsive: true` needs its
// canvas's parent element to have an explicit height to size into — if the
// page's CSS never gives `.chart-canvas-wrapper` one, the canvas silently
// ends up 0×0 and nothing is ever visible, with nothing thrown to catch.
// Rather than depend on every page's CSS getting this exactly right,
// guarantee it here once, for every chart, regardless of page.
function ensureWrapperIsSized(canvas) {
  const wrapper = canvas.parentElement;
  if (!wrapper) return;

  const computedHeight = parseFloat(window.getComputedStyle(wrapper).height) || 0;
  if (computedHeight < 40) {
    wrapper.style.height = "260px";
  }
  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.position = "relative";
  }
}

let datalabelsRegistered = false;
function ensureDatalabelsRegistered() {
  if (datalabelsRegistered || typeof window.Chart === "undefined" || !window.ChartDataLabels) return;
  window.Chart.register(window.ChartDataLabels);
  datalabelsRegistered = true;
}

/**
 * Creates (or re-creates) a chart on the given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {"pie"|"doughnut"|"bar"|"line"} type
 * @param {{labels: string[], datasets: object[]}} data
 * @param {object} [extraOptions]
 * @returns {Chart} the Chart.js instance
 */
export function renderChart(canvas, type, data, extraOptions = {}) {
  if (!canvas) return null;

  if (typeof window.Chart === "undefined") {
    // BUG FIXED: this used to fail completely silently — no thrown error,
    // no console message — if the Chart.js CDN script hadn't finished
    // loading (or failed to load) by the time this ran. That's exactly
    // indistinguishable from "everything worked but drew nothing," which is
    // what every blank-chart report so far looked like. Now it's loud: a
    // console error naming the exact missing global, plus a visible on-page
    // message so this is obvious without opening devtools at all.
    console.error(
      `Chart.js has not loaded (window.Chart is undefined) — cannot render the "${canvas.id}" chart. ` +
      `Check the Network tab for the Chart.js <script> tag in app.html (cdnjs.cloudflare.com) — ` +
      `it may be blocked, slow, or failing to load in this environment.`
    );
    const wrapper = canvas.closest(".chart-canvas-wrapper") || canvas.parentElement;
    setChartEmptyState(wrapper, true, "Chart library failed to load — check your connection and reload");
    return null;
  }

  ensureWrapperIsSized(canvas);
  ensureDatalabelsRegistered();

  // Destroy any existing chart bound to this canvas before re-rendering.
  const existing = window.Chart.getChart(canvas);
  existing?.destroy();

  const isCircular = type === "pie" || type === "doughnut";

  return new window.Chart(canvas, {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: isCircular ? { padding: 8 } : undefined,
      plugins: {
        legend: { display: false }, // we render our own HTML legend for consistency
        tooltip: {
          titleFont: BASE_FONT,
          bodyFont: BASE_FONT,
          padding: 10,
          cornerRadius: 8,
          callbacks: isCircular
            ? {
                label: (ctx) => {
                  const total = ctx.dataset.data.reduce((sum, v) => sum + v, 0);
                  const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : "0.0";
                  return ` ${ctx.label}: ${pct}%`;
                },
              }
            : undefined,
        },
        // Colorful, labeled slices matching the reference style — percentage
        // baked directly onto each pie/doughnut segment, not just on hover.
        datalabels: isCircular
          ? {
              color: "#fff",
              font: { ...BASE_FONT, weight: "700", size: 12 },
              formatter: (value, ctx) => {
                const total = ctx.dataset.data.reduce((sum, v) => sum + v, 0);
                if (!total) return "";
                const pct = (value / total) * 100;
                return pct < 5 ? "" : `${pct.toFixed(1)}%`; // hide labels on slivers, keep it readable
              },
            }
          : { display: false },
      },
      scales: isCircular
        ? {}
        : {
            x: { grid: { display: false }, ticks: { font: BASE_FONT, color: "#64748b" } },
            y: { grid: { color: "#f1f5f9" }, ticks: { font: BASE_FONT, color: "#64748b" }, beginAtZero: true },
          },
      ...extraOptions,
    },
  });
}

/**
 * Renders an HTML legend (color dot + label) into a container element,
 * matching the colors used in a chart's dataset.
 * @param {HTMLElement} container
 * @param {string[]} labels
 * @param {string[]} colors
 */
export function renderLegend(container, labels, colors) {
  if (!container) return;
  container.innerHTML = labels
    .map((label, i) => `
      <span class="legend-item">
        <span class="legend-dot" style="background-color:${colors[i % colors.length]}"></span>
        ${label}
      </span>
    `)
    .join("");
}

/**
 * Shows or hides the "no data yet" overlay on a chart's wrapper element.
 * @param {HTMLElement} wrapper - the .chart-canvas-wrapper element
 * @param {boolean} isEmpty
 * @param {string} [message]
 */
export function setChartEmptyState(wrapper, isEmpty, message = "No data yet") {
  if (!wrapper) return;
  let overlay = wrapper.querySelector(".chart-empty-overlay");

  if (isEmpty) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "chart-empty-overlay";
      wrapper.appendChild(overlay);
    }
    overlay.textContent = message;
  } else {
    overlay?.remove();
  }
}

// ============================================================================
// Export helper
// ----------------------------------------------------------------------------
// Loads ExcelJS lazily from CDN on first use and exports an array of row
// objects to a real, styled .xlsx file (colored header, borders, zebra
// striping, auto-sized columns, frozen header row), optionally embedding
// chart images captured from the page's Chart.js canvases. Shared by
// Overview and Reports so both "Export Excel" buttons behave identically.
// ----------------------------------------------------------------------------
// BUG FIXED: this used to load SheetJS from
// "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.20.3/xlsx.full.min.js" —
// but cdnjs never hosted a 0.20.3 build of xlsx (only up through 0.18.5).
// That <script> 404'd, onerror fired, loadSheetJs() rejected with "Failed
// to load the export library," and every caller's .catch() turned that into
// the generic "Could not export the data" toast. Beyond the broken version,
// SheetJS's free/community build also can't style cells at all (no colors,
// borders, or bold headers) — so "make the export look stylish" wasn't
// achievable with it even once the version was fixed. Switched to ExcelJS
// instead, which supports real cell styling for free and can embed images
// (used below to bake in chart pictures), from a CDN build/version that
// actually exists.
// ============================================================================

let excelJsLoadPromise = null;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve();
  if (excelJsLoadPromise) return excelJsLoadPromise;

  excelJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
    script.onload = resolve;
    script.onerror = () => {
      excelJsLoadPromise = null; // allow a retry on the next export attempt
      reject(new Error("Failed to load the export library."));
    };
    document.head.appendChild(script);
  });

  return excelJsLoadPromise;
}

const HEADER_FILL = "FF2563EB"; // matches CHART_COLORS[0] blue
const HEADER_FONT_COLOR = "FFFFFFFF";
const ZEBRA_FILL = "FFF8FAFC";
const BORDER_COLOR = "FFE2E8F0";

const THIN_BORDER = {
  top: { style: "thin", color: { argb: BORDER_COLOR } },
  left: { style: "thin", color: { argb: BORDER_COLOR } },
  bottom: { style: "thin", color: { argb: BORDER_COLOR } },
  right: { style: "thin", color: { argb: BORDER_COLOR } },
};

/**
 * Exports an array of plain row objects to a downloaded, styled .xlsx file.
 * @param {object[]} rows
 * @param {string} filename - without extension
 * @param {string} [sheetName="Report"]
 * @param {object} [options]
 * @param {{title: string, dataUrl: string}[]} [options.charts] - PNG data
 *   URLs (e.g. from canvas.toDataURL("image/png")) to embed on their own
 *   "Charts" sheet, each with a title placed above it.
 */
export async function exportRowsToExcel(rows, filename, sheetName = "Report", { charts = [] } = {}) {
  await loadExcelJs();

  const workbook = new window.ExcelJS.Workbook();
  workbook.creator = "TimeTrack";
  workbook.created = new Date();

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }], // keep header visible while scrolling
  });

  worksheet.columns = headers.map((header) => ({
    header,
    key: header,
    width: columnWidthFor(header, rows),
  }));

  rows.forEach((row) => worksheet.addRow(row));

  styleHeaderRow(worksheet.getRow(1));
  styleDataRows(worksheet, headers.length);

  if (headers.length) {
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }

  if (charts.length) {
    addChartsSheet(workbook, charts);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, `${filename}.xlsx`);
}

function styleHeaderRow(headerRow) {
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: HEADER_FONT_COLOR }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 22;
}

function styleDataRows(worksheet, columnCount) {
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header already styled
    const isEven = rowNumber % 2 === 0;
    for (let col = 1; col <= columnCount; col += 1) {
      const cell = row.getCell(col);
      cell.border = THIN_BORDER;
      const isNumeric = typeof cell.value === "number";
      cell.alignment = {
        vertical: "middle",
        horizontal: isNumeric ? "right" : "left",
        wrapText: false,
      };
      if (isNumeric) {
        cell.numFmt = "0.00";
      }
      if (isEven) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA_FILL } };
      }
    }
  });
}

/**
 * Sizes a column to comfortably fit its widest cell (header or value),
 * clamped to a sensible range so one long description can't blow out the
 * whole sheet's readability.
 */
function columnWidthFor(header, rows) {
  const longestValue = rows.reduce((max, row) => {
    const len = String(row[header] ?? "").length;
    return Math.max(max, len);
  }, header.length);
  return Math.min(45, Math.max(12, longestValue + 3));
}

/**
 * Adds a "Charts" sheet with each provided chart image stacked vertically
 * under its own title, so exported reports carry the same visual summary
 * that's shown on screen.
 */
function addChartsSheet(workbook, charts) {
  const chartSheet = workbook.addWorksheet("Charts");
  chartSheet.getColumn(1).width = 90;

  const IMAGE_WIDTH = 620;
  const IMAGE_HEIGHT = 320;
  const ROW_HEIGHT_PX = 20;
  const rowsPerImage = Math.ceil(IMAGE_HEIGHT / ROW_HEIGHT_PX) + 2; // + gap rows
  let currentRow = 0;

  charts.forEach(({ title, dataUrl }) => {
    if (!dataUrl) return;

    const titleCell = chartSheet.getCell(currentRow + 1, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, size: 13, color: { argb: "FF0F172A" } };
    currentRow += 1;

    const extension = dataUrl.startsWith("data:image/jpeg") ? "jpeg" : "png";
    const imageId = workbook.addImage({ base64: dataUrl, extension });
    chartSheet.addImage(imageId, {
      tl: { col: 0, row: currentRow },
      ext: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT },
    });

    currentRow += rowsPerImage;
  });
}

/**
 * Exports an array of plain row objects to a downloaded .csv file.
 * No external library needed — built with a small RFC-4180-ish escaper.
 * @param {object[]} rows
 * @param {string} filename - without extension
 */
export function exportRowsToCsv(rows, filename) {
  if (!rows.length) {
    const blob = new Blob([""], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, `${filename}.csv`);
    return;
  }

  const headers = Object.keys(rows[0]);
  const escapeCell = (value) => {
    const str = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [
    headers.map(escapeCell).join(","),
    ...rows.map((row) => headers.map((h) => escapeCell(row[h])).join(",")),
  ];

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `${filename}.csv`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Opens a print-friendly window containing a styled table of the given rows
 * and triggers the browser print dialog. Used by the Reports "Print" button.
 * @param {object[]} rows
 * @param {string} title
 * @param {object} [options]
 * @param {{label: string, value: string}[]} [options.summary] - KPI cards
 *   (e.g. Total Hours, Users, Projects, Sessions) shown above the table.
 * @param {string} [options.meta] - a subtitle line, e.g. the applied filters
 *   and date range, so the printed page is self-explanatory on its own.
 */
export function printRows(rows, title = "Report", { summary = [], meta = "" } = {}) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const printWindow = window.open("", "_blank", "width=900,height=700");

  if (!printWindow) return;

  const summaryHtml = summary.length
    ? `<div class="summary-grid">${summary
        .map(({ label, value }) => `<div class="summary-card"><div class="summary-value">${value}</div><div class="summary-label">${label}</div></div>`)
        .join("")}</div>`
    : "";

  const tableHtml = `
    <table>
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows
          .map(
            (row, i) =>
              `<tr class="${i % 2 === 1 ? "zebra" : ""}">${headers
                .map((h) => `<td>${row[h] ?? ""}</td>`)
                .join("")}</tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; padding: 24px; color: #0f172a; }
          h1 { font-size: 20px; margin-bottom: 4px; }
          .meta { font-size: 12px; color: #64748b; margin-bottom: 4px; }
          .generated-at { font-size: 11px; color: #94a3b8; margin-bottom: 18px; }
          .summary-grid { display: flex; gap: 12px; margin-bottom: 20px; }
          .summary-card { flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
          .summary-value { font-size: 18px; font-weight: 700; color: #2563eb; }
          .summary-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 2px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; }
          th { background: #2563eb; color: #fff; font-weight: 600; }
          tr.zebra { background: #f8fafc; }
          @media print {
            body { padding: 0; }
            .summary-card { break-inside: avoid; }
            tr { break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        ${meta ? `<div class="meta">${meta}</div>` : ""}
        <div class="generated-at">Generated ${generatedAt}</div>
        ${summaryHtml}
        ${tableHtml}
      </body>
    </html>
  `);
  printWindow.document.close();
  printWindow.focus();
  printWindow.onload = () => {
    printWindow.print();
    printWindow.close();
  };
}

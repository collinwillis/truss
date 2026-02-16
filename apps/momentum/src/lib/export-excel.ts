/**
 * Excel workbook export utility for Momentum progress tracking.
 *
 * Generates an XLSX workbook matching the client's 6-section format:
 * Scope | Estimate | Progress | Daily Entries | Weekly Qty | Weekly Earned MH
 */

import * as XLSX from "xlsx";

/** Row shape from the getExportData query. */
interface ExportRow {
  rowType: "wbs" | "phase" | "detail";
  id: string;
  wbsCode: string;
  phaseCode: string;
  description: string;
  size: string;
  flc: string;
  spec: string;
  insulation: string;
  insulationSize: number | null;
  sheet: number | null;
  quantity: number;
  unit: string;
  craftMH: number;
  weldMH: number;
  totalMH: number;
  quantityComplete: number;
  quantityRemaining: number;
  earnedMH: number;
  remainingMH: number;
  percentComplete: number;
  weeklyQty: Record<string, number>;
  weeklyEarnedMH: Record<string, number>;
}

/** Project metadata for the header. */
interface ExportProject {
  name: string;
  proposalNumber: string;
  jobNumber: string;
  owner: string;
  location: string;
  startDate: string;
}

/** Full export data payload from getExportData query. */
export interface ExportData {
  project: ExportProject;
  rows: ExportRow[];
  weekEndings: string[];
}

/**
 * Generate an Excel workbook blob from export data.
 *
 * WHY: Matches the client's existing Excel workbook format so they
 * can transition from manual spreadsheet to software-generated reports.
 */
export function exportProgressWorkbook(data: ExportData): Blob {
  const wb = XLSX.utils.book_new();

  // ── Build "Progress Tracking" sheet ──
  const wsData: (string | number | null)[][] = [];

  // Header rows
  wsData.push(["Progress Tracking Report"]);
  wsData.push(["Project:", data.project.name]);
  wsData.push(["Proposal #:", data.project.proposalNumber, "", "Job #:", data.project.jobNumber]);
  wsData.push(["Owner:", data.project.owner, "", "Location:", data.project.location]);
  wsData.push(["Start Date:", data.project.startDate]);
  wsData.push([]); // blank row

  // Column headers — 6 sections
  const headers: string[] = [
    // Section 1: Scope
    "Type",
    "WBS",
    "Phase",
    "Size",
    "FLC",
    "Description",
    "Spec",
    "Insul",
    "Insul Size",
    "Sht",
    // Section 2: Estimate
    "Qty",
    "Unit",
    "Craft MH",
    "Weld MH",
    "Total MH",
    // Section 3: Progress
    "Qty Complete",
    "Qty Remaining",
    "MH Earned",
    "MH Remaining",
    "% Complete",
  ];

  // Section 5 & 6: Weekly columns
  for (const we of data.weekEndings) {
    headers.push(`Qty ${we}`);
  }
  for (const we of data.weekEndings) {
    headers.push(`Earned ${we}`);
  }

  wsData.push(headers);

  // Data rows
  for (const row of data.rows) {
    const typeLabel = row.rowType === "wbs" ? "W" : row.rowType === "phase" ? "P" : "D";

    const rowData: (string | number | null)[] = [
      typeLabel,
      row.wbsCode,
      row.phaseCode,
      row.size || "",
      row.flc || "",
      row.description,
      row.spec || "",
      row.insulation || "",
      row.insulationSize,
      row.sheet,
      row.rowType === "detail" ? row.quantity : null,
      row.rowType === "detail" ? row.unit : "",
      row.craftMH || null,
      row.weldMH || null,
      row.totalMH || null,
      row.rowType === "detail" ? row.quantityComplete : null,
      row.rowType === "detail" ? row.quantityRemaining : null,
      row.earnedMH || null,
      row.remainingMH || null,
      row.percentComplete > 0 ? row.percentComplete / 100 : null,
    ];

    // Weekly quantities
    for (const we of data.weekEndings) {
      rowData.push(row.weeklyQty[we] ?? null);
    }
    // Weekly earned MH
    for (const we of data.weekEndings) {
      rowData.push(row.weeklyEarnedMH[we] ?? null);
    }

    wsData.push(rowData);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  const scopeWidths = [5, 8, 8, 8, 8, 35, 10, 8, 8, 5];
  const estimateWidths = [8, 6, 10, 10, 10];
  const progressWidths = [12, 12, 10, 10, 10];
  const weeklyWidths = data.weekEndings.flatMap(() => [10, 10]);

  ws["!cols"] = [...scopeWidths, ...estimateWidths, ...progressWidths, ...weeklyWidths].map(
    (w) => ({ wch: w })
  );

  // Freeze panes: freeze header rows and first 6 scope columns
  ws["!freeze"] = { xSplit: 6, ySplit: 7 };

  // Format % Complete column as percentage
  const pctColIndex = 19; // 0-indexed
  const headerRowCount = 7; // rows before data starts
  for (let r = 0; r < data.rows.length; r++) {
    const cellRef = XLSX.utils.encode_cell({ r: r + headerRowCount, c: pctColIndex });
    if (ws[cellRef] && ws[cellRef].v != null) {
      ws[cellRef].z = "0%";
    }
  }

  // Bold WBS rows
  // SheetJS community edition doesn't support styling, but the structure is there
  // for pro edition or post-processing

  XLSX.utils.book_append_sheet(wb, ws, "Progress Tracking");

  // Generate blob
  const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([wbOut], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

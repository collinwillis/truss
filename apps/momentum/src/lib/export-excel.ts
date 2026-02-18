/**
 * Excel workbook export utility for Momentum progress tracking.
 *
 * Generates a styled XLSX workbook matching the client's master template
 * (1247 - Progress Tracking MASTER.xlsx) using ExcelJS. Includes:
 * - Row-level styling (WBS=blue/bold/14pt, Phase=yellow/bold/12pt, Detail=10pt)
 * - Daily entry columns per week (M, Tu, W, Th, F, Sa)
 * - Section headers with merged cells
 * - Number formats (accounting, decimal, percent)
 * - Freeze panes and borders
 */

import ExcelJS from "exceljs";

// ── Types ──

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
  dailyQty: Record<string, number>;
}

/** Project metadata for the header. */
interface ExportProject {
  name: string;
  proposalNumber: string;
  jobNumber: string;
  changeNumber: string;
  description: string;
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

// ── Constants ──

/** Fixed column count: A–T (Scope + Estimate + Progress). */
const FIXED_COL_COUNT = 20;

/** Column widths matching the master template. */
const FIXED_WIDTHS = [
  /* A  Filter     */ 3.43, /* B  WBS        */ 6.71, /* C  PHASE      */ 8.71,
  /* D  SIZE       */ 5.71, /* E  FLC        */ 5.71, /* F  DESCRIPTION*/ 29.0,
  /* G  SPEC       */ 5.71, /* H  INSULATION */ 11.71, /* I  INSUL SIZE */ 8.71,
  /* J  SHT        */ 4.71, /* K  QTY        */ 6.71, /* L  UNIT       */ 5.71,
  /* M  CRAFT MH   */ 10.71, /* N  WELD MH    */ 10.71, /* O  TOTAL MH   */ 10.71,
  /* P  QTY COMP   */ 10.71, /* Q  QTY REM    */ 10.71, /* R  MH EARNED  */ 10.71,
  /* S  MH REM     */ 10.71, /* T  % COMP     */ 8.71,
];

const SEPARATOR_WIDTH = 4.71;
const DAILY_COL_WIDTH = 5.71;
const WEEKLY_COL_WIDTH = 10.71;

const DAY_LABELS = ["M", "Tu", "W", "Th", "F", "Sa"];

/** Style fills matching the master template. */
const FILLS = {
  wbs: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFDDEBF7" } },
  phase: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } },
  header: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9E2F3" } },
  sectionHeader: {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FFB4C6E7" },
  },
};

/** Font presets. */
const FONTS = {
  wbs: { name: "Calibri", size: 14, bold: true },
  phase: { name: "Calibri", size: 12, bold: true },
  detail: { name: "Calibri", size: 10 },
  header: { name: "Calibri", size: 10, bold: true },
  headerSmall: { name: "Calibri", size: 8, bold: true },
  title: { name: "Calibri", size: 11, bold: true },
  totals: { name: "Calibri", size: 11, bold: true },
};

/** Thin border style for cells. */
const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

/** Medium border for section perimeters. */
const mediumBorder: Partial<ExcelJS.Borders> = {
  top: { style: "medium" },
  left: { style: "medium" },
  bottom: { style: "medium" },
  right: { style: "medium" },
};

// ── Helpers ──

/**
 * Get Mon–Sat date strings for the week ending on the given Saturday.
 *
 * WHY: Maps daily entry dates to their position within a week column group.
 */
function getWeekDays(weekEndingSaturday: string): string[] {
  const sat = new Date(weekEndingSaturday + "T12:00:00Z");
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(sat);
    d.setUTCDate(sat.getUTCDate() - (5 - i));
    return d.toISOString().slice(0, 10);
  });
}

/** Format a week-ending date for column headers (e.g., "1/18"). */
function shortDate(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// ── Column Layout Builder ──

interface ColumnLayout {
  /** Total number of columns. */
  totalCols: number;
  /** Column index of separator after fixed columns (1-based). */
  sep1Col: number;
  /** Starting column for daily groups (1-based). */
  dailyStartCol: number;
  /** Map: weekEnding → starting col (1-based) for that week's 6 daily cols. */
  dailyWeekCols: Map<string, number>;
  /** Column index of separator after daily section. */
  sep2Col: number;
  /** Starting column for weekly qty section (1-based). */
  weeklyQtyStartCol: number;
  /** Column index of separator after weekly qty. */
  sep3Col: number;
  /** Starting column for weekly earned MH section (1-based). */
  weeklyEarnedStartCol: number;
  /** Ordered week endings. */
  weekEndings: string[];
}

/** Compute dynamic column layout based on number of weeks. */
function buildColumnLayout(weekEndings: string[]): ColumnLayout {
  const nWeeks = weekEndings.length;

  // After fixed cols: separator
  const sep1Col = FIXED_COL_COUNT + 1; // col U (21)

  // Daily section: 6 cols per week
  const dailyStartCol = sep1Col + 1; // col V (22)
  const dailyWeekCols = new Map<string, number>();
  for (let i = 0; i < nWeeks; i++) {
    dailyWeekCols.set(weekEndings[i]!, dailyStartCol + i * 6);
  }
  const dailyEndCol = dailyStartCol + nWeeks * 6 - 1;

  // Separator after daily
  const sep2Col = nWeeks > 0 ? dailyEndCol + 1 : sep1Col;

  // Weekly Qty Complete: 1 col per week
  const weeklyQtyStartCol = sep2Col + 1;
  const weeklyQtyEndCol = weeklyQtyStartCol + nWeeks - 1;

  // Separator after weekly qty
  const sep3Col = nWeeks > 0 ? weeklyQtyEndCol + 1 : sep2Col;

  // Weekly Earned MH: 1 col per week
  const weeklyEarnedStartCol = sep3Col + 1;
  const weeklyEarnedEndCol = weeklyEarnedStartCol + nWeeks - 1;

  const totalCols = nWeeks > 0 ? weeklyEarnedEndCol : FIXED_COL_COUNT;

  return {
    totalCols,
    sep1Col,
    dailyStartCol,
    dailyWeekCols,
    sep2Col,
    weeklyQtyStartCol,
    sep3Col,
    weeklyEarnedStartCol,
    weekEndings,
  };
}

// ── Main Export Function ──

/**
 * Generate a styled Excel workbook blob from export data.
 *
 * WHY: Matches the client's master Excel template so they can transition
 * from manual spreadsheet to software-generated reports with identical formatting.
 */
export async function exportProgressWorkbook(data: ExportData): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Momentum";
  wb.created = new Date();

  const ws = wb.addWorksheet("Progress Tracking", {
    views: [{ state: "frozen", xSplit: 6, ySplit: 9 }],
  });

  const layout = buildColumnLayout(data.weekEndings);

  // ── Set column widths ──
  setColumnWidths(ws, layout);

  // ── Header area (rows 1–7) ──
  buildHeaderArea(ws, data.project, layout);

  // ── Section header row 8 ──
  buildSectionHeaderRow(ws, layout);

  // ── Column header row 9 ──
  buildColumnHeaderRow(ws, layout);

  // ── Data rows (row 10+) ──
  const dataStartRow = 10;
  let currentRow = dataStartRow;

  for (const row of data.rows) {
    writeDataRow(ws, currentRow, row, layout);
    currentRow++;
  }

  // ── Totals row ──
  writeTotalsRow(ws, currentRow, data.rows, layout);

  // Generate buffer and return as blob
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── Column Width Setup ──

/** Apply column widths to the worksheet. */
function setColumnWidths(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  // Fixed columns A–T
  for (let i = 0; i < FIXED_WIDTHS.length; i++) {
    ws.getColumn(i + 1).width = FIXED_WIDTHS[i];
  }

  if (layout.weekEndings.length === 0) return;

  // Separator after fixed
  ws.getColumn(layout.sep1Col).width = SEPARATOR_WIDTH;

  // Daily columns: 6 per week
  for (const [, startCol] of layout.dailyWeekCols) {
    for (let d = 0; d < 6; d++) {
      ws.getColumn(startCol + d).width = DAILY_COL_WIDTH;
    }
  }

  // Separator after daily
  ws.getColumn(layout.sep2Col).width = SEPARATOR_WIDTH;

  // Weekly qty columns
  for (let i = 0; i < layout.weekEndings.length; i++) {
    ws.getColumn(layout.weeklyQtyStartCol + i).width = WEEKLY_COL_WIDTH;
  }

  // Separator after weekly qty
  ws.getColumn(layout.sep3Col).width = SEPARATOR_WIDTH;

  // Weekly earned MH columns
  for (let i = 0; i < layout.weekEndings.length; i++) {
    ws.getColumn(layout.weeklyEarnedStartCol + i).width = WEEKLY_COL_WIDTH;
  }
}

// ── Header Area (Rows 1–7) ──

/** Build the header area with project metadata and merged cells. */
function buildHeaderArea(
  ws: ExcelJS.Worksheet,
  project: ExportProject,
  layout: ColumnLayout
): void {
  const headerRows: [string, string][] = [
    ["Proposal #:", project.proposalNumber],
    ["Change #:", project.changeNumber],
    ["Job #:", project.jobNumber],
    ["Description:", project.description],
    ["Owner:", project.owner],
    ["Location:", project.location],
    ["Start Date:", project.startDate],
  ];

  for (let i = 0; i < headerRows.length; i++) {
    const rowNum = i + 1;
    const [label, value] = headerRows[i]!;
    const row = ws.getRow(rowNum);

    // Label in col K (11), value merged across L:O (12:15)
    const labelCell = row.getCell(11);
    labelCell.value = label;
    labelCell.font = FONTS.title;
    labelCell.alignment = { horizontal: "right", vertical: "middle" };

    ws.mergeCells(rowNum, 12, rowNum, 15);
    const valueCell = row.getCell(12);
    valueCell.value = value;
    valueCell.font = { name: "Calibri", size: 11 };
    valueCell.alignment = { horizontal: "left", vertical: "middle" };
    valueCell.border = { bottom: { style: "thin" } };

    row.height = 15;
  }
}

// ── Section Header Row (Row 8) ──

/** Build the section header row with merged regions for each section. */
function buildSectionHeaderRow(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  const row = ws.getRow(8);
  row.height = 20;

  // Scope section: A–J
  ws.mergeCells(8, 1, 8, 10);
  const scopeCell = row.getCell(1);
  scopeCell.value = "Scope";
  scopeCell.font = FONTS.header;
  scopeCell.fill = FILLS.sectionHeader;
  scopeCell.alignment = { horizontal: "center", vertical: "middle" };
  scopeCell.border = mediumBorder;
  // Apply fill/border to all cells in the merge
  for (let c = 2; c <= 10; c++) {
    row.getCell(c).fill = FILLS.sectionHeader;
    row.getCell(c).border = mediumBorder;
  }

  // Estimate Basis: K–O
  ws.mergeCells(8, 11, 8, 15);
  const estCell = row.getCell(11);
  estCell.value = "Estimate Basis";
  estCell.font = FONTS.header;
  estCell.fill = FILLS.sectionHeader;
  estCell.alignment = { horizontal: "center", vertical: "middle" };
  estCell.border = mediumBorder;
  for (let c = 12; c <= 15; c++) {
    row.getCell(c).fill = FILLS.sectionHeader;
    row.getCell(c).border = mediumBorder;
  }

  // Progress: P–T
  ws.mergeCells(8, 16, 8, 20);
  const progCell = row.getCell(16);
  progCell.value = "Progress";
  progCell.font = FONTS.header;
  progCell.fill = FILLS.sectionHeader;
  progCell.alignment = { horizontal: "center", vertical: "middle" };
  progCell.border = mediumBorder;
  for (let c = 17; c <= 20; c++) {
    row.getCell(c).fill = FILLS.sectionHeader;
    row.getCell(c).border = mediumBorder;
  }

  if (layout.weekEndings.length === 0) return;

  // Daily section headers: "W/E {date}" merged across 6 daily cols per week
  for (const [we, startCol] of layout.dailyWeekCols) {
    ws.mergeCells(8, startCol, 8, startCol + 5);
    const cell = row.getCell(startCol);
    cell.value = `W/E ${shortDate(we)}`;
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.sectionHeader;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = mediumBorder;
    for (let d = 1; d <= 5; d++) {
      row.getCell(startCol + d).fill = FILLS.sectionHeader;
      row.getCell(startCol + d).border = mediumBorder;
    }
  }

  // Weekly Qty Complete header
  const nWeeks = layout.weekEndings.length;
  if (nWeeks > 0) {
    ws.mergeCells(8, layout.weeklyQtyStartCol, 8, layout.weeklyQtyStartCol + nWeeks - 1);
    const wqCell = row.getCell(layout.weeklyQtyStartCol);
    wqCell.value = "Weekly Qty Complete";
    wqCell.font = FONTS.headerSmall;
    wqCell.fill = FILLS.sectionHeader;
    wqCell.alignment = { horizontal: "center", vertical: "middle" };
    wqCell.border = mediumBorder;
    for (let i = 1; i < nWeeks; i++) {
      row.getCell(layout.weeklyQtyStartCol + i).fill = FILLS.sectionHeader;
      row.getCell(layout.weeklyQtyStartCol + i).border = mediumBorder;
    }

    // Weekly Earned MH header
    ws.mergeCells(8, layout.weeklyEarnedStartCol, 8, layout.weeklyEarnedStartCol + nWeeks - 1);
    const weCell = row.getCell(layout.weeklyEarnedStartCol);
    weCell.value = "Weekly Earned MH";
    weCell.font = FONTS.headerSmall;
    weCell.fill = FILLS.sectionHeader;
    weCell.alignment = { horizontal: "center", vertical: "middle" };
    weCell.border = mediumBorder;
    for (let i = 1; i < nWeeks; i++) {
      row.getCell(layout.weeklyEarnedStartCol + i).fill = FILLS.sectionHeader;
      row.getCell(layout.weeklyEarnedStartCol + i).border = mediumBorder;
    }
  }
}

// ── Column Header Row (Row 9) ──

/** Build column header labels in row 9. */
function buildColumnHeaderRow(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  const row = ws.getRow(9);
  row.height = 30;

  const fixedHeaders = [
    /* A  */ "Filter",
    /* B  */ "WBS",
    /* C  */ "PHASE",
    /* D  */ "SIZE",
    /* E  */ "FLC",
    /* F  */ "DESCRIPTION",
    /* G  */ "SPEC",
    /* H  */ "INSULATION",
    /* I  */ "INSUL SIZE",
    /* J  */ "SHT",
    /* K  */ "QTY",
    /* L  */ "UNIT",
    /* M  */ "CRAFT MH",
    /* N  */ "WELD MH",
    /* O  */ "TOTAL MH",
    /* P  */ "QTY COMP",
    /* Q  */ "QTY REM",
    /* R  */ "MH EARNED",
    /* S  */ "MH REM",
    /* T  */ "% COMP",
  ];

  for (let i = 0; i < fixedHeaders.length; i++) {
    const cell = row.getCell(i + 1);
    cell.value = fixedHeaders[i];
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.header;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = thinBorder;
  }

  if (layout.weekEndings.length === 0) return;

  // Daily day-of-week labels (M, Tu, W, Th, F, Sa) repeated per week
  for (const [, startCol] of layout.dailyWeekCols) {
    for (let d = 0; d < 6; d++) {
      const cell = row.getCell(startCol + d);
      cell.value = DAY_LABELS[d];
      cell.font = FONTS.headerSmall;
      cell.fill = FILLS.header;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = thinBorder;
    }
  }

  // Weekly qty date headers
  for (let i = 0; i < layout.weekEndings.length; i++) {
    const cell = row.getCell(layout.weeklyQtyStartCol + i);
    cell.value = shortDate(layout.weekEndings[i]!);
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.header;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = thinBorder;
  }

  // Weekly earned MH date headers
  for (let i = 0; i < layout.weekEndings.length; i++) {
    const cell = row.getCell(layout.weeklyEarnedStartCol + i);
    cell.value = shortDate(layout.weekEndings[i]!);
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.header;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = thinBorder;
  }
}

// ── Data Row Writing ──

/** Write a single data row (WBS, Phase, or Detail). */
function writeDataRow(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  data: ExportRow,
  layout: ColumnLayout
): void {
  const row = ws.getRow(rowNum);

  // Row-level style based on type
  const isWbs = data.rowType === "wbs";
  const isPhase = data.rowType === "phase";
  const font = isWbs ? FONTS.wbs : isPhase ? FONTS.phase : FONTS.detail;
  const fill = isWbs ? FILLS.wbs : isPhase ? FILLS.phase : undefined;
  row.height = isWbs ? 18.75 : 15.75;

  // Column A: Filter (W/P/D)
  const filterLabel = isWbs ? "W" : isPhase ? "P" : "D";
  setCell(row, 1, filterLabel, font, fill);

  // Column B: WBS
  setCell(row, 2, data.wbsCode, font, fill);

  // Column C: Phase
  setCell(row, 3, data.phaseCode || null, font, fill);

  // Column D: Size
  setCell(row, 4, data.size || null, font, fill);

  // Column E: FLC
  setCell(row, 5, data.flc || null, font, fill);

  // Column F: Description
  setCell(row, 6, data.description, font, fill);

  // Column G: Spec
  setCell(row, 7, data.spec || null, font, fill);

  // Column H: Insulation
  setCell(row, 8, data.insulation || null, font, fill);

  // Column I: Insul Size
  setCell(row, 9, data.insulationSize, font, fill);

  // Column J: Sheet
  setCell(row, 10, data.sheet, font, fill);

  // Column K: Qty (detail rows only)
  setNumCell(row, 11, data.rowType === "detail" ? data.quantity : null, "#,##0", font, fill);

  // Column L: Unit (detail rows only)
  setCell(row, 12, data.rowType === "detail" ? data.unit : null, font, fill);

  // Column M: Craft MH
  setNumCell(row, 13, data.craftMH || null, "#,##0.00", font, fill);

  // Column N: Weld MH
  setNumCell(row, 14, data.weldMH || null, "#,##0.00", font, fill);

  // Column O: Total MH
  setNumCell(row, 15, data.totalMH || null, "#,##0.00", font, fill);

  // Column P: Qty Complete (detail rows only)
  setNumCell(row, 16, data.rowType === "detail" ? data.quantityComplete : null, "0.00", font, fill);

  // Column Q: Qty Remaining (detail rows only)
  setNumCell(
    row,
    17,
    data.rowType === "detail" ? data.quantityRemaining : null,
    "0.00",
    font,
    fill
  );

  // Column R: MH Earned
  setNumCell(row, 18, data.earnedMH || null, "0.00", font, fill);

  // Column S: MH Remaining
  setNumCell(row, 19, data.remainingMH || null, "0.00", font, fill);

  // Column T: % Complete
  const pctValue = data.percentComplete > 0 ? data.percentComplete / 100 : null;
  setNumCell(row, 20, pctValue, "0.00%", font, fill);

  // Apply fill to separator columns and empty cells
  if (fill) {
    if (layout.weekEndings.length > 0) {
      row.getCell(layout.sep1Col).fill = fill;
      row.getCell(layout.sep2Col).fill = fill;
      row.getCell(layout.sep3Col).fill = fill;
    }
  }

  // ── Daily entry columns ──
  if (layout.weekEndings.length > 0) {
    for (const [we, startCol] of layout.dailyWeekCols) {
      const days = getWeekDays(we);
      for (let d = 0; d < 6; d++) {
        const dateStr = days[d]!;
        const val = data.dailyQty?.[dateStr] ?? null;
        const cell = row.getCell(startCol + d);
        cell.value = val && val > 0 ? val : null;
        cell.font = font;
        cell.alignment = { horizontal: "center" };
        cell.border = thinBorder;
        if (fill) cell.fill = fill;
        if (val && val > 0) cell.numFmt = "#,##0";
      }
    }

    // ── Weekly Qty Complete ──
    for (let i = 0; i < layout.weekEndings.length; i++) {
      const we = layout.weekEndings[i]!;
      const val = data.weeklyQty[we] ?? null;
      const cell = row.getCell(layout.weeklyQtyStartCol + i);
      cell.value = val && val > 0 ? val : null;
      cell.font = font;
      cell.alignment = { horizontal: "center" };
      cell.border = thinBorder;
      if (fill) cell.fill = fill;
      if (val && val > 0) cell.numFmt = "#,##0";
    }

    // ── Weekly Earned MH ──
    for (let i = 0; i < layout.weekEndings.length; i++) {
      const we = layout.weekEndings[i]!;
      const val = data.weeklyEarnedMH[we] ?? null;
      const cell = row.getCell(layout.weeklyEarnedStartCol + i);
      cell.value = val && val > 0 ? val : null;
      cell.font = font;
      cell.alignment = { horizontal: "center" };
      cell.border = thinBorder;
      if (fill) cell.fill = fill;
      if (val && val > 0) cell.numFmt = "0.00";
    }
  }

  // Apply borders to fixed columns
  for (let c = 1; c <= FIXED_COL_COUNT; c++) {
    row.getCell(c).border = thinBorder;
  }
}

// ── Totals Row ──

/** Write the totals row at the bottom of the data. */
function writeTotalsRow(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  rows: ExportRow[],
  layout: ColumnLayout
): void {
  const row = ws.getRow(rowNum);
  row.height = 18.75;

  // Sum WBS rows only (they already aggregate phase/detail)
  const wbsRows = rows.filter((r) => r.rowType === "wbs");

  let totalCraftMH = 0;
  let totalWeldMH = 0;
  let totalTotalMH = 0;
  let totalEarnedMH = 0;
  let totalRemainingMH = 0;

  for (const r of wbsRows) {
    totalCraftMH += r.craftMH;
    totalWeldMH += r.weldMH;
    totalTotalMH += r.totalMH;
    totalEarnedMH += r.earnedMH;
    totalRemainingMH += r.remainingMH;
  }

  const totalPct = totalTotalMH > 0 ? totalEarnedMH / totalTotalMH : 0;

  const font = FONTS.totals;
  const fill = FILLS.sectionHeader;

  // Label
  setCell(row, 1, null, font, fill);
  setCell(row, 2, null, font, fill);
  setCell(row, 3, null, font, fill);
  setCell(row, 4, null, font, fill);
  setCell(row, 5, null, font, fill);
  setCell(row, 6, "TOTAL", font, fill);
  setCell(row, 7, null, font, fill);
  setCell(row, 8, null, font, fill);
  setCell(row, 9, null, font, fill);
  setCell(row, 10, null, font, fill);
  setCell(row, 11, null, font, fill);
  setCell(row, 12, null, font, fill);

  // Totals
  setNumCell(row, 13, totalCraftMH || null, "#,##0.00", font, fill);
  setNumCell(row, 14, totalWeldMH || null, "#,##0.00", font, fill);
  setNumCell(row, 15, totalTotalMH || null, "#,##0.00", font, fill);
  setCell(row, 16, null, font, fill);
  setCell(row, 17, null, font, fill);
  setNumCell(row, 18, totalEarnedMH || null, "0.00", font, fill);
  setNumCell(row, 19, totalRemainingMH || null, "0.00", font, fill);
  setNumCell(row, 20, totalPct > 0 ? totalPct : null, "0.00%", font, fill);

  // Apply borders and fill to all fixed columns
  for (let c = 1; c <= FIXED_COL_COUNT; c++) {
    row.getCell(c).border = mediumBorder;
  }

  // Fill separator and dynamic columns
  if (layout.weekEndings.length > 0) {
    row.getCell(layout.sep1Col).fill = fill;
    row.getCell(layout.sep1Col).border = mediumBorder;
    row.getCell(layout.sep2Col).fill = fill;
    row.getCell(layout.sep2Col).border = mediumBorder;
    row.getCell(layout.sep3Col).fill = fill;
    row.getCell(layout.sep3Col).border = mediumBorder;

    // Weekly totals
    for (let i = 0; i < layout.weekEndings.length; i++) {
      const we = layout.weekEndings[i]!;

      // Sum daily cols for totals row (empty for totals)
      const dailyStart = layout.dailyWeekCols.get(we)!;
      for (let d = 0; d < 6; d++) {
        const cell = row.getCell(dailyStart + d);
        cell.fill = fill;
        cell.font = font;
        cell.border = thinBorder;
      }

      // Weekly qty total
      let weekQtyTotal = 0;
      for (const r of wbsRows) {
        weekQtyTotal += r.weeklyQty[we] ?? 0;
      }
      const wqCell = row.getCell(layout.weeklyQtyStartCol + i);
      wqCell.value = weekQtyTotal > 0 ? weekQtyTotal : null;
      wqCell.font = font;
      wqCell.fill = fill;
      wqCell.alignment = { horizontal: "center" };
      wqCell.border = mediumBorder;
      if (weekQtyTotal > 0) wqCell.numFmt = "#,##0";

      // Weekly earned total
      let weekEarnedTotal = 0;
      for (const r of wbsRows) {
        weekEarnedTotal += r.weeklyEarnedMH[we] ?? 0;
      }
      const weCell = row.getCell(layout.weeklyEarnedStartCol + i);
      weCell.value = weekEarnedTotal > 0 ? weekEarnedTotal : null;
      weCell.font = font;
      weCell.fill = fill;
      weCell.alignment = { horizontal: "center" };
      weCell.border = mediumBorder;
      if (weekEarnedTotal > 0) weCell.numFmt = "0.00";
    }
  }
}

// ── Cell Helpers ──

/** Set a cell with text value, font, and optional fill. */
function setCell(
  row: ExcelJS.Row,
  col: number,
  value: string | number | null,
  font: Partial<ExcelJS.Font>,
  fill?: ExcelJS.FillPattern
): void {
  const cell = row.getCell(col);
  cell.value = value ?? null;
  cell.font = font;
  if (fill) cell.fill = fill;
}

/** Set a cell with numeric value and format. */
function setNumCell(
  row: ExcelJS.Row,
  col: number,
  value: number | null,
  numFmt: string,
  font: Partial<ExcelJS.Font>,
  fill?: ExcelJS.FillPattern
): void {
  const cell = row.getCell(col);
  cell.value = value;
  cell.numFmt = numFmt;
  cell.font = font;
  cell.alignment = { horizontal: "right" };
  if (fill) cell.fill = fill;
}

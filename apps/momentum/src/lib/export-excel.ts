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

const FIXED_COL_COUNT = 20;

/** Column widths matching the master template exactly. */
const FIXED_WIDTHS = [
  /* A  Filter      */ 9.71, /* B  WBS         */ 10.14, /* C  PHASE       */ 11.86,
  /* D  SIZE        */ 19.14, /* E  FLC         */ 7, /* F  LINE/DESCRIP*/ 55,
  /* G  SPEC        */ 11, /* H  INSUL       */ 8, /* I  INSL. SIZE  */ 8, /* J  SHT         */ 7,
  /* K  QTY         */ 12.71, /* L  UNIT        */ 12.71, /* M  CRAFT       */ 12.71,
  /* N  WELD        */ 12.71, /* O  TOTAL       */ 12.71, /* P  QTY COMPLETE*/ 12.71,
  /* Q  QTY REMAIN  */ 12.71, /* R  MH EARNED   */ 12.71, /* S  MH REMAIN   */ 12.71,
  /* T  % COMPLETE  */ 12.71,
];

const SEPARATOR_WIDTH = 4.71;
const DAILY_COL_WIDTH = 5.71;
const WEEKLY_COL_WIDTH = 10.71;

const DAY_LABELS = ["M", "Tu", "W", "Th", "F", "Sa"];

/** Accounting number format without $ sign (matches master). */
const ACCT_FMT = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)';

/** Style fills matching the master template. */
const FILLS = {
  wbs: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFDDEBF7" } },
  phase: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } },
  /** Row 9 column headers. */
  header: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9E2F3" } },
  /** Row 8 section headers + medium blue. */
  sectionHeader: {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FFB4C6E7" },
  },
  /** Totals row (light green). */
  totals: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE2EEDA" } },
};

/** Font presets. */
const FONTS = {
  wbs: { name: "Calibri", size: 14, bold: true },
  phase: { name: "Calibri", size: 12, bold: true },
  detail: { name: "Calibri", size: 10 },
  /** Row 9 column headers. */
  headerSmall: { name: "Calibri", size: 8, bold: true },
  /** Row 8 section labels (Estimate Basis, Progress, etc). */
  sectionLabel: { name: "Calibri", size: 14, bold: true },
  /** Metadata label (rows 1-7). */
  metaLabel: { name: "Calibri", size: 11, bold: true },
  metaValue: { name: "Calibri", size: 11 },
  /** Totals row. */
  totals: { name: "Calibri", size: 14, bold: true },
  totalsWeekly: { name: "Calibri", size: 11, bold: false },
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};

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

/** Format a week-ending date for display (e.g., "1/18"). */
function shortDate(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Format date as mm/dd/yy string. */
function mmddyy(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(2);
  return `${mm}/${dd}/${yy}`;
}

// ── Column Layout Builder ──

interface ColumnLayout {
  totalCols: number;
  sep1Col: number;
  dailyStartCol: number;
  dailyWeekCols: Map<string, number>;
  sep2Col: number;
  weeklyQtyStartCol: number;
  sep3Col: number;
  weeklyEarnedStartCol: number;
  weekEndings: string[];
}

/** Compute dynamic column layout based on number of weeks. */
function buildColumnLayout(weekEndings: string[]): ColumnLayout {
  const nWeeks = weekEndings.length;

  const sep1Col = FIXED_COL_COUNT + 1; // col U (21)
  const dailyStartCol = sep1Col + 1; // col V (22)

  const dailyWeekCols = new Map<string, number>();
  for (let i = 0; i < nWeeks; i++) {
    dailyWeekCols.set(weekEndings[i]!, dailyStartCol + i * 6);
  }
  const dailyEndCol = dailyStartCol + nWeeks * 6 - 1;

  const sep2Col = nWeeks > 0 ? dailyEndCol + 1 : sep1Col;
  const weeklyQtyStartCol = sep2Col + 1;
  const weeklyQtyEndCol = weeklyQtyStartCol + nWeeks - 1;

  const sep3Col = nWeeks > 0 ? weeklyQtyEndCol + 1 : sep2Col;
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

  setColumnWidths(ws, layout);
  buildHeaderArea(ws, data.project, layout);
  buildSectionHeaderRow(ws, layout);
  buildColumnHeaderRow(ws, layout);

  const dataStartRow = 10;
  let currentRow = dataStartRow;

  for (const row of data.rows) {
    writeDataRow(ws, currentRow, row, layout);
    currentRow++;
  }

  writeTotalsRow(ws, currentRow, data.rows, layout);

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── Column Width Setup ──

function setColumnWidths(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  for (let i = 0; i < FIXED_WIDTHS.length; i++) {
    ws.getColumn(i + 1).width = FIXED_WIDTHS[i];
  }

  if (layout.weekEndings.length === 0) return;

  ws.getColumn(layout.sep1Col).width = SEPARATOR_WIDTH;

  for (const [, startCol] of layout.dailyWeekCols) {
    for (let d = 0; d < 6; d++) {
      ws.getColumn(startCol + d).width = DAILY_COL_WIDTH;
    }
  }

  ws.getColumn(layout.sep2Col).width = SEPARATOR_WIDTH;

  for (let i = 0; i < layout.weekEndings.length; i++) {
    ws.getColumn(layout.weeklyQtyStartCol + i).width = WEEKLY_COL_WIDTH;
  }

  ws.getColumn(layout.sep3Col).width = SEPARATOR_WIDTH;

  for (let i = 0; i < layout.weekEndings.length; i++) {
    ws.getColumn(layout.weeklyEarnedStartCol + i).width = WEEKLY_COL_WIDTH;
  }
}

// ── Header Area (Rows 1–7) ──

/**
 * Build the header area matching the master template.
 *
 * Row order: Proposal, Job, Change, Description, Owner, Location, Date.
 * Start Date appears separately in P1/Q1.
 */
function buildHeaderArea(
  ws: ExcelJS.Worksheet,
  project: ExportProject,
  _layout: ColumnLayout
): void {
  const today = new Date();
  const todayStr = `${today.toLocaleString("en-US", { month: "long" })} ${today.getDate()}, ${today.getFullYear()}`;

  const headerRows: [string, string][] = [
    ["Proposal #:", project.proposalNumber],
    ["Job #:", project.jobNumber],
    ["Change #:", project.changeNumber],
    ["Description:", project.description],
    ["Owner:", project.owner],
    ["Location:", project.location],
    ["Date:", todayStr],
  ];

  for (let i = 0; i < headerRows.length; i++) {
    const rowNum = i + 1;
    const [label, value] = headerRows[i]!;
    const row = ws.getRow(rowNum);
    row.height = 15;

    // Label in col K (11)
    const labelCell = row.getCell(11);
    labelCell.value = label;
    labelCell.font = FONTS.metaLabel;
    labelCell.alignment = { horizontal: "right", vertical: "middle" };

    // Value merged across L:O (12:15)
    ws.mergeCells(rowNum, 12, rowNum, 15);
    const valueCell = row.getCell(12);
    valueCell.value = value;
    valueCell.font = FONTS.metaValue;
    valueCell.alignment = { horizontal: "left", vertical: "middle" };
    valueCell.border = { bottom: { style: "thin" } };
  }

  // Start Date in P1/Q1 (matching master template)
  if (project.startDate) {
    const r1 = ws.getRow(1);
    const sdLabel = r1.getCell(16); // P1
    sdLabel.value = "Start Date";
    sdLabel.font = FONTS.metaLabel;
    sdLabel.alignment = { horizontal: "right", vertical: "middle" };

    const sdValue = r1.getCell(17); // Q1
    sdValue.value = project.startDate;
    sdValue.font = FONTS.metaValue;
    sdValue.alignment = { horizontal: "left", vertical: "middle" };
  }

  // "Week N" labels in row 6 above each daily week group
  if (_layout.weekEndings.length > 0) {
    const r6 = ws.getRow(6);
    let weekNum = 1;
    for (const [, startCol] of _layout.dailyWeekCols) {
      const cell = r6.getCell(startCol);
      cell.value = `Week ${weekNum}`;
      cell.font = FONTS.headerSmall;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      weekNum++;
    }

    // Sequential numbering in weekly summary columns (row 6)
    for (let i = 0; i < _layout.weekEndings.length; i++) {
      const qtyCell = r6.getCell(_layout.weeklyQtyStartCol + i);
      qtyCell.value = i + 1;
      qtyCell.font = FONTS.headerSmall;
      qtyCell.alignment = { horizontal: "center" };

      const earnCell = r6.getCell(_layout.weeklyEarnedStartCol + i);
      earnCell.value = i + 1;
      earnCell.font = FONTS.headerSmall;
      earnCell.alignment = { horizontal: "center" };
    }
  }
}

// ── Section Header Row (Row 8) ──

/**
 * Build row 8 matching the master template layout:
 * - K8: "Estimate Basis" (14pt bold)
 * - P8: "Progress" (14pt bold)
 * - Daily: "WE" in Monday col, merged date in Tu-Sa
 * - Weekly sections: merged labels
 */
function buildSectionHeaderRow(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  const row = ws.getRow(8);
  row.height = 22.9;

  // K8: "Estimate Basis" — single cell, 14pt bold
  const estCell = row.getCell(11);
  estCell.value = "Estimate Basis";
  estCell.font = FONTS.sectionLabel;
  estCell.alignment = { vertical: "middle" };

  // P8: "Progress" — single cell, 14pt bold
  const progCell = row.getCell(16);
  progCell.value = "Progress";
  progCell.font = FONTS.sectionLabel;
  progCell.alignment = { vertical: "middle" };

  if (layout.weekEndings.length === 0) return;

  // Daily: "WE" in Monday col, week-ending date merged across Tu-Sa (5 cells)
  for (const [we, startCol] of layout.dailyWeekCols) {
    // Monday col: "WE"
    const weLabel = row.getCell(startCol);
    weLabel.value = "WE";
    weLabel.font = FONTS.headerSmall;
    weLabel.alignment = { horizontal: "center", vertical: "middle" };

    // Tu-Sa (5 cells): merged week-ending date
    ws.mergeCells(8, startCol + 1, 8, startCol + 5);
    const dateCell = row.getCell(startCol + 1);
    dateCell.value = mmddyy(we);
    dateCell.font = FONTS.headerSmall;
    dateCell.numFmt = "mm/dd/yy;@";
    dateCell.alignment = { horizontal: "center", vertical: "middle" };
  }

  // "Weekly Quantities Complete" merged header
  const nWeeks = layout.weekEndings.length;
  if (nWeeks > 1) {
    ws.mergeCells(8, layout.weeklyQtyStartCol, 8, layout.weeklyQtyStartCol + nWeeks - 1);
  }
  const wqCell = row.getCell(layout.weeklyQtyStartCol);
  wqCell.value = "Weekly Quantities Complete";
  wqCell.font = FONTS.sectionLabel;
  wqCell.alignment = { horizontal: "center", vertical: "middle" };

  // "Weekly Earned MH" merged header
  if (nWeeks > 1) {
    ws.mergeCells(8, layout.weeklyEarnedStartCol, 8, layout.weeklyEarnedStartCol + nWeeks - 1);
  }
  const weCell = row.getCell(layout.weeklyEarnedStartCol);
  weCell.value = "Weekly Earned MH";
  weCell.font = FONTS.sectionLabel;
  weCell.alignment = { horizontal: "center", vertical: "middle" };
}

// ── Column Header Row (Row 9) ──

function buildColumnHeaderRow(ws: ExcelJS.Worksheet, layout: ColumnLayout): void {
  const row = ws.getRow(9);
  row.height = 40.15;

  const fixedHeaders = [
    /* A  */ "Filter",
    /* B  */ "WBS",
    /* C  */ "PHASE",
    /* D  */ "SIZE",
    /* E  */ "FLC",
    /* F  */ "LINE / DESCRIP",
    /* G  */ "SPEC",
    /* H  */ "INSUL",
    /* I  */ "INSL. SIZE",
    /* J  */ "SHT",
    /* K  */ "QTY",
    /* L  */ "UNIT",
    /* M  */ "CRAFT",
    /* N  */ "WELD",
    /* O  */ "TOTAL",
    /* P  */ "QTY COMPLETE",
    /* Q  */ "QTY REMAINING",
    /* R  */ "MH EARNED",
    /* S  */ "MH REMAINING TO EARN",
    /* T  */ "% COMPLETE",
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

  // Daily day-of-week labels repeated per week
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

  // Weekly qty date headers (mm/dd/yy format)
  for (let i = 0; i < layout.weekEndings.length; i++) {
    const cell = row.getCell(layout.weeklyQtyStartCol + i);
    cell.value = mmddyy(layout.weekEndings[i]!);
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.header;
    cell.numFmt = "mm/dd/yy;@";
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = thinBorder;
  }

  // Weekly earned MH date headers
  for (let i = 0; i < layout.weekEndings.length; i++) {
    const cell = row.getCell(layout.weeklyEarnedStartCol + i);
    cell.value = mmddyy(layout.weekEndings[i]!);
    cell.font = FONTS.headerSmall;
    cell.fill = FILLS.header;
    cell.numFmt = "mm/dd/yy;@";
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

  const isWbs = data.rowType === "wbs";
  const isPhase = data.rowType === "phase";
  const isDetail = data.rowType === "detail";
  const font = isWbs ? FONTS.wbs : isPhase ? FONTS.phase : FONTS.detail;
  const fill = isWbs ? FILLS.wbs : isPhase ? FILLS.phase : undefined;
  row.height = isWbs ? 18.75 : 15.75;

  // Column A: Filter (W/P/D)
  const filterLabel = isWbs ? "W" : isPhase ? "P" : "D";
  setCell(row, 1, filterLabel, font, fill);

  // Column B: WBS
  setCell(row, 2, data.wbsCode, font, fill);

  // Column C: Phase — WBS rows get "WBS" literal (matches master), others get phase code
  setCell(row, 3, isWbs ? "WBS" : data.phaseCode || null, font, fill);

  // Columns D–J: Scope metadata
  setCell(row, 4, data.size || null, font, fill);
  setCell(row, 5, data.flc || null, font, fill);
  setCell(row, 6, data.description, font, fill);
  setCell(row, 7, data.spec || null, font, fill);
  setCell(row, 8, data.insulation || null, font, fill);
  setCell(row, 9, data.insulationSize, font, fill);
  setCell(row, 10, data.sheet, font, fill);

  // Column K: Qty — accounting format, detail only
  setNumCell(row, 11, isDetail ? data.quantity : null, ACCT_FMT, font, fill);

  // Column L: Unit — detail only
  setCell(row, 12, isDetail ? data.unit : null, font, fill);

  // Columns M/N/O: Craft/Weld/Total MH — accounting format
  setNumCell(row, 13, data.craftMH || null, ACCT_FMT, font, fill);
  setNumCell(row, 14, data.weldMH || null, ACCT_FMT, font, fill);
  setNumCell(row, 15, data.totalMH || null, ACCT_FMT, font, fill);

  // Columns P/Q: Qty Complete/Remaining — detail rows only
  setNumCell(row, 16, isDetail ? data.quantityComplete : null, "0.00", font, fill);
  setNumCell(row, 17, isDetail ? data.quantityRemaining : null, "0.00", font, fill);

  // Columns R/S: MH Earned/Remaining
  setNumCell(row, 18, data.earnedMH || null, "0.00", font, fill);
  setNumCell(row, 19, data.remainingMH || null, "0.00", font, fill);

  // Column T: % Complete
  const pctValue = data.percentComplete > 0 ? data.percentComplete / 100 : null;
  setNumCell(row, 20, pctValue, "0.00%", font, fill);

  // Apply thin borders to all fixed columns
  for (let c = 1; c <= FIXED_COL_COUNT; c++) {
    row.getCell(c).border = thinBorder;
  }

  // Medium border on left edge of A and right edge of J, O, T (section boundaries)
  row.getCell(1).border = { ...thinBorder, left: { style: "medium" } };
  row.getCell(10).border = { ...thinBorder, right: { style: "medium" } };
  row.getCell(15).border = { ...thinBorder, right: { style: "medium" } };
  row.getCell(20).border = { ...thinBorder, right: { style: "medium" } };

  // ── Separator columns — fill for W/P, no border; nothing for D ──
  if (layout.weekEndings.length > 0) {
    const sepCols = [layout.sep1Col, layout.sep2Col, layout.sep3Col];
    for (const sc of sepCols) {
      const sepCell = row.getCell(sc);
      sepCell.font = font;
      if (fill) sepCell.fill = fill;
      // No border on separator columns
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
        cell.alignment = { horizontal: "center", vertical: "middle" };
        if (fill) cell.fill = fill;
        if (val && val > 0) cell.numFmt = "#,##0";

        // Week boundary borders: medium on Monday left, Saturday right; thin otherwise
        const isMonday = d === 0;
        const isSaturday = d === 5;
        cell.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
          left: { style: isMonday ? "medium" : "thin" },
          right: { style: isSaturday ? "medium" : "thin" },
        };
      }
    }

    // ── Weekly Qty Complete ──
    for (let i = 0; i < layout.weekEndings.length; i++) {
      const we = layout.weekEndings[i]!;
      const val = data.weeklyQty[we] ?? null;
      const cell = row.getCell(layout.weeklyQtyStartCol + i);
      cell.value = val && val > 0 ? val : null;
      cell.font = font;
      cell.alignment = { horizontal: "center", vertical: "middle" };
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
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = thinBorder;
      if (fill) cell.fill = fill;
      if (val && val > 0) cell.numFmt = "0.00";
    }
  }
}

// ── Totals Row ──

/**
 * Write the totals row matching the master template:
 * Light green fill (#E2EEDA), Calibri 14pt bold, height 30, "T" in A–L.
 */
function writeTotalsRow(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  rows: ExportRow[],
  layout: ColumnLayout
): void {
  const row = ws.getRow(rowNum);
  row.height = 30;

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
  const fill = FILLS.totals;

  // Columns A–L: "T" marker (invisible on green bg, used for SUMIFS filtering)
  for (let c = 1; c <= 12; c++) {
    const cell = row.getCell(c);
    cell.value = "T";
    cell.font = { ...font, color: { argb: "FFE2EEDA" } }; // Same as fill = invisible
    cell.fill = fill;
    cell.alignment = { vertical: "middle" };
    cell.border = mediumBorder;
  }

  // M: Craft MH
  setNumCell(row, 13, totalCraftMH || null, ACCT_FMT, font, fill);
  row.getCell(13).border = mediumBorder;

  // N: Weld MH
  setNumCell(row, 14, totalWeldMH || null, ACCT_FMT, font, fill);
  row.getCell(14).border = mediumBorder;

  // O: Total MH
  setNumCell(row, 15, totalTotalMH || null, ACCT_FMT, font, fill);
  row.getCell(15).border = mediumBorder;

  // P: empty (Qty Complete not summed at totals level)
  setCell(row, 16, null, font, fill);
  row.getCell(16).border = { ...mediumBorder, left: { style: "medium" } };

  // Q: empty
  setCell(row, 17, null, font, fill);
  row.getCell(17).border = mediumBorder;

  // R: MH Earned (sum of WBS rows)
  setNumCell(row, 18, totalEarnedMH || null, "0.00", font, fill);
  row.getCell(18).border = mediumBorder;

  // S: MH Remaining
  setNumCell(row, 19, totalRemainingMH || null, "0.00", font, fill);
  row.getCell(19).border = mediumBorder;

  // T: % Complete
  setNumCell(row, 20, totalPct > 0 ? totalPct : null, "0.00%", font, fill);
  row.getCell(20).border = mediumBorder;

  // Dynamic columns
  if (layout.weekEndings.length > 0) {
    // Separator columns
    for (const sc of [layout.sep1Col, layout.sep2Col, layout.sep3Col]) {
      const cell = row.getCell(sc);
      cell.fill = fill;
      cell.font = font;
      cell.border = mediumBorder;
    }

    for (let i = 0; i < layout.weekEndings.length; i++) {
      const we = layout.weekEndings[i]!;

      // Daily cols: empty with thin borders
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
      wqCell.font = FONTS.totalsWeekly;
      wqCell.fill = fill;
      wqCell.alignment = { horizontal: "center", vertical: "middle" };
      wqCell.border = mediumBorder;
      if (weekQtyTotal > 0) wqCell.numFmt = "#,##0";

      // Weekly earned total
      let weekEarnedTotal = 0;
      for (const r of wbsRows) {
        weekEarnedTotal += r.weeklyEarnedMH[we] ?? 0;
      }
      const weCell = row.getCell(layout.weeklyEarnedStartCol + i);
      weCell.value = weekEarnedTotal > 0 ? weekEarnedTotal : null;
      weCell.font = FONTS.totalsWeekly;
      weCell.fill = fill;
      weCell.alignment = { horizontal: "center", vertical: "middle" };
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
  cell.alignment = { vertical: "middle" };
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
  cell.alignment = { horizontal: "right", vertical: "middle" };
  if (fill) cell.fill = fill;
}

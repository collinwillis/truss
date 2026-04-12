/**
 * Excel export for Precision estimates.
 *
 * Generates a professional workbook with WBS → Phase → Activity hierarchy,
 * color-coded row types, and computed cost summaries.
 *
 * WHY: Construction estimators need to share estimates as Excel files
 * with clients, subcontractors, and internal stakeholders. The format
 * must be clean and print-ready.
 *
 * @module
 */

import ExcelJS from "exceljs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportCosts {
  craftManHours: number;
  welderManHours: number;
  craftCost: number;
  welderCost: number;
  materialCost: number;
  equipmentCost: number;
  subcontractorCost: number;
  costOnlyCost: number;
  totalCost: number;
}

interface ExportActivity {
  _id: string;
  type: string;
  description: string;
  quantity: number;
  unit: string;
  costs: ExportCosts;
}

interface ExportPhase {
  _id: string;
  phaseNumber: number;
  description: string;
  poolName: string;
  activities: ExportActivity[];
  costs: ExportCosts;
}

interface ExportWBS {
  _id: string;
  name: string;
  wbsPoolId: number;
  phases: ExportPhase[];
  costs: ExportCosts;
}

interface ExportProposal {
  proposalNumber: string;
  description: string;
  ownerName: string;
  status?: string | null;
  bidType?: string | null;
  rates: Record<string, number>;
}

/** Shape returned by the getExportData Convex query. */
export interface EstimateExportData {
  proposal: ExportProposal;
  wbs: ExportWBS[];
  totals: ExportCosts;
  activityCount: number;
  phaseCount: number;
  wbsCount: number;
}

// ---------------------------------------------------------------------------
// Styling constants
// ---------------------------------------------------------------------------

const FILLS = {
  header: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD9E2F3" } },
  wbs: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFDDEBF7" } },
  phase: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFFFF2CC" } },
  totals: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFE2EEDA" } },
};

const FONTS = {
  title: { name: "Calibri", size: 16, bold: true },
  subtitle: { name: "Calibri", size: 11, color: { argb: "FF666666" } },
  wbs: { name: "Calibri", size: 12, bold: true },
  phase: { name: "Calibri", size: 10, bold: true },
  detail: { name: "Calibri", size: 10 },
  header: { name: "Calibri", size: 9, bold: true },
  totals: { name: "Calibri", size: 12, bold: true },
};

const BORDERS = {
  thin: {
    top: { style: "thin" as const, color: { argb: "FFD0D0D0" } },
    bottom: { style: "thin" as const, color: { argb: "FFD0D0D0" } },
    left: { style: "thin" as const, color: { argb: "FFD0D0D0" } },
    right: { style: "thin" as const, color: { argb: "FFD0D0D0" } },
  },
};

// ---------------------------------------------------------------------------
// Export function
// ---------------------------------------------------------------------------

/** Generate an Excel workbook from estimate export data. */
export async function exportEstimateWorkbook(data: EstimateExportData): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Precision by Truss";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Estimate", {
    views: [{ state: "frozen", ySplit: 4 }],
  });

  // Column definitions
  sheet.columns = [
    { header: "Type", key: "type", width: 12 },
    { header: "Description", key: "description", width: 45 },
    { header: "Qty", key: "quantity", width: 10 },
    { header: "Unit", key: "unit", width: 8 },
    { header: "Craft MH", key: "craftMH", width: 12 },
    { header: "Weld MH", key: "weldMH", width: 12 },
    { header: "Craft Cost", key: "craftCost", width: 14 },
    { header: "Weld Cost", key: "welderCost", width: 14 },
    { header: "Material", key: "materialCost", width: 14 },
    { header: "Equipment", key: "equipmentCost", width: 14 },
    { header: "Subcontractor", key: "subcontractorCost", width: 14 },
    { header: "Cost Only", key: "costOnlyCost", width: 14 },
    { header: "Total Cost", key: "totalCost", width: 16 },
  ];

  // Title rows
  const titleRow = sheet.addRow([`Estimate #${data.proposal.proposalNumber}`]);
  titleRow.font = FONTS.title;
  sheet.mergeCells(titleRow.number, 1, titleRow.number, 13);

  const subtitleRow = sheet.addRow([`${data.proposal.description} | ${data.proposal.ownerName}`]);
  subtitleRow.font = FONTS.subtitle;
  sheet.mergeCells(subtitleRow.number, 1, subtitleRow.number, 13);

  sheet.addRow([]); // Spacer

  // Header row
  const headerRow = sheet.addRow([
    "Type",
    "Description",
    "Qty",
    "Unit",
    "Craft MH",
    "Weld MH",
    "Craft $",
    "Weld $",
    "Material $",
    "Equip $",
    "Sub $",
    "Cost Only $",
    "Total $",
  ]);
  headerRow.font = FONTS.header;
  headerRow.fill = FILLS.header;
  headerRow.eachCell((cell) => {
    cell.border = BORDERS.thin;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  // Data rows
  for (const wbs of data.wbs) {
    // WBS header row
    const wbsRow = sheet.addRow([
      "",
      wbs.name,
      "",
      "",
      wbs.costs.craftManHours || "",
      wbs.costs.welderManHours || "",
      wbs.costs.craftCost || "",
      wbs.costs.welderCost || "",
      wbs.costs.materialCost || "",
      wbs.costs.equipmentCost || "",
      wbs.costs.subcontractorCost || "",
      wbs.costs.costOnlyCost || "",
      wbs.costs.totalCost || "",
    ]);
    wbsRow.font = FONTS.wbs;
    wbsRow.fill = FILLS.wbs;
    wbsRow.height = 20;
    wbsRow.eachCell((cell) => {
      cell.border = BORDERS.thin;
    });

    for (const phase of wbs.phases) {
      // Phase header row
      const phaseRow = sheet.addRow([
        "",
        `#${phase.phaseNumber} — ${phase.description}`,
        "",
        "",
        phase.costs.craftManHours || "",
        phase.costs.welderManHours || "",
        phase.costs.craftCost || "",
        phase.costs.welderCost || "",
        phase.costs.materialCost || "",
        phase.costs.equipmentCost || "",
        phase.costs.subcontractorCost || "",
        phase.costs.costOnlyCost || "",
        phase.costs.totalCost || "",
      ]);
      phaseRow.font = FONTS.phase;
      phaseRow.fill = FILLS.phase;
      phaseRow.eachCell((cell) => {
        cell.border = BORDERS.thin;
      });

      for (const activity of phase.activities) {
        const actRow = sheet.addRow([
          activity.type.replace("_", " "),
          activity.description,
          activity.quantity,
          activity.unit,
          activity.costs.craftManHours || "",
          activity.costs.welderManHours || "",
          activity.costs.craftCost || "",
          activity.costs.welderCost || "",
          activity.costs.materialCost || "",
          activity.costs.equipmentCost || "",
          activity.costs.subcontractorCost || "",
          activity.costs.costOnlyCost || "",
          activity.costs.totalCost || "",
        ]);
        actRow.font = FONTS.detail;
        actRow.eachCell((cell) => {
          cell.border = BORDERS.thin;
        });

        // Format cost columns as currency
        for (let col = 7; col <= 13; col++) {
          const cell = actRow.getCell(col);
          if (typeof cell.value === "number" && cell.value > 0) {
            cell.numFmt = '"$"#,##0.00';
          }
        }
        // Format MH columns
        for (let col = 5; col <= 6; col++) {
          const cell = actRow.getCell(col);
          if (typeof cell.value === "number" && cell.value > 0) {
            cell.numFmt = "#,##0.0";
          }
        }
      }
    }
  }

  // Grand totals row
  sheet.addRow([]); // Spacer
  const totalsRow = sheet.addRow([
    "",
    "GRAND TOTAL",
    "",
    "",
    data.totals.craftManHours,
    data.totals.welderManHours,
    data.totals.craftCost,
    data.totals.welderCost,
    data.totals.materialCost,
    data.totals.equipmentCost,
    data.totals.subcontractorCost,
    data.totals.costOnlyCost,
    data.totals.totalCost,
  ]);
  totalsRow.font = FONTS.totals;
  totalsRow.fill = FILLS.totals;
  totalsRow.height = 24;
  totalsRow.eachCell((cell) => {
    cell.border = BORDERS.thin;
  });
  for (let col = 5; col <= 13; col++) {
    const cell = totalsRow.getCell(col);
    if (typeof cell.value === "number") {
      cell.numFmt = col <= 6 ? "#,##0.0" : '"$"#,##0.00';
    }
  }

  // Generate blob
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

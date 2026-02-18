/**
 * Excel Workbook Introspection Script
 *
 * Dumps detailed structural information about the Progress Tracking MASTER workbook:
 * column layout, row structure, merged cells, cell styles, number formats,
 * freeze panes, and totals row format.
 */
import ExcelJS from "exceljs";
import path from "path";

const FILE_PATH = path.resolve(
  "/Users/collinwillis/Dev/Personal/truss/1247 - Progress Tracking MASTER.xlsx"
);

function styleSummary(cell) {
  const s = {};
  if (cell.font && Object.keys(cell.font).length > 0) {
    s.font = {};
    if (cell.font.name) s.font.name = cell.font.name;
    if (cell.font.size) s.font.size = cell.font.size;
    if (cell.font.bold) s.font.bold = true;
    if (cell.font.italic) s.font.italic = true;
    if (cell.font.underline) s.font.underline = cell.font.underline;
    if (cell.font.color) s.font.color = cell.font.color;
    if (cell.font.strike) s.font.strike = true;
  }
  if (cell.fill && cell.fill.type) {
    s.fill = cell.fill;
  }
  if (cell.border && Object.keys(cell.border).length > 0) {
    s.border = cell.border;
  }
  if (cell.numFmt) {
    s.numFmt = cell.numFmt;
  }
  if (cell.alignment && Object.keys(cell.alignment).length > 0) {
    s.alignment = cell.alignment;
  }
  if (cell.protection && Object.keys(cell.protection).length > 0) {
    s.protection = cell.protection;
  }
  return Object.keys(s).length > 0 ? s : null;
}

function cellValueStr(cell) {
  if (cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === "object") {
    if (cell.value.formula) {
      return `FORMULA: =${cell.value.formula}  [result: ${cell.value.result}]`;
    }
    if (cell.value.sharedFormula) {
      return `SHARED_FORMULA: =${cell.value.sharedFormula}  [result: ${cell.value.result}]`;
    }
    if (cell.value.richText) {
      return `RICHTEXT: ${cell.value.richText.map((r) => r.text).join("")}`;
    }
    if (cell.value instanceof Date) {
      return `DATE: ${cell.value.toISOString()}`;
    }
    return JSON.stringify(cell.value);
  }
  return String(cell.value);
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(FILE_PATH);

  console.log("=".repeat(100));
  console.log("WORKBOOK INTROSPECTION");
  console.log(`File: ${FILE_PATH}`);
  console.log(`Sheets: ${workbook.worksheets.map((ws) => ws.name).join(", ")}`);
  console.log("=".repeat(100));

  for (const sheet of workbook.worksheets) {
    console.log("\n" + "#".repeat(100));
    console.log(`## SHEET: "${sheet.name}"`);
    console.log("#".repeat(100));

    // Dimensions
    console.log(`\nDimensions: ${sheet.dimensions}`);
    console.log(`Row count: ${sheet.rowCount}`);
    console.log(`Column count: ${sheet.columnCount}`);
    console.log(`Actual row count: ${sheet.actualRowCount}`);
    console.log(`Actual column count: ${sheet.actualColumnCount}`);

    // Freeze Panes / Views
    console.log("\n--- VIEWS / FREEZE PANES ---");
    if (sheet.views && sheet.views.length > 0) {
      for (const view of sheet.views) {
        console.log(JSON.stringify(view, null, 2));
      }
    } else {
      console.log("No views/freeze panes set.");
    }

    // Sheet Properties
    console.log("\n--- SHEET PROPERTIES ---");
    console.log(JSON.stringify(sheet.properties, null, 2));

    // Column Layout
    console.log("\n--- COLUMN LAYOUT ---");
    const maxCol = Math.min(sheet.columnCount, 120);
    for (let c = 1; c <= maxCol; c++) {
      const col = sheet.getColumn(c);
      const letter = col.letter;
      const width = col.width;
      const hidden = col.hidden;
      const outlineLevel = col.outlineLevel;
      console.log(
        `  Col ${letter} (${c}): width=${width ?? "default"}, hidden=${hidden ?? false}, outlineLevel=${outlineLevel ?? 0}`
      );
    }

    // Merged Cells
    console.log("\n--- MERGED CELLS ---");
    const merges = sheet.model.merges || [];
    if (merges.length > 0) {
      for (const m of merges) {
        console.log(`  ${m}`);
      }
    } else {
      console.log("  No merged cells.");
    }

    // Row-by-row dump for first 20 rows
    console.log("\n--- FIRST 20 ROWS (values + row properties) ---");
    const dumpRows = Math.min(20, sheet.rowCount);
    for (let r = 1; r <= dumpRows; r++) {
      const row = sheet.getRow(r);
      const height = row.height;
      const hidden = row.hidden;
      const outlineLevel = row.outlineLevel;
      console.log(
        `\n  ROW ${r}: height=${height ?? "default"}, hidden=${hidden ?? false}, outlineLevel=${outlineLevel ?? 0}`
      );

      const usedCols = Math.min(sheet.columnCount, 120);
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        if (val !== null) {
          const colLetter = sheet.getColumn(c).letter;
          const isMerged = cell.isMerged ? " [MERGED]" : "";
          const masterAddr =
            cell.master && cell.master.address !== cell.address
              ? ` [master=${cell.master.address}]`
              : "";
          console.log(`    ${colLetter}${r} = ${val}${isMerged}${masterAddr}`);
        }
      }
    }

    // Detailed styles for rows 1-15
    console.log("\n--- CELL STYLES FOR ROWS 1-15 ---");
    const styleRows = Math.min(15, sheet.rowCount);
    for (let r = 1; r <= styleRows; r++) {
      const row = sheet.getRow(r);
      console.log(`\n  ROW ${r} styles:`);
      const usedCols = Math.min(sheet.columnCount, 120);
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        const style = styleSummary(cell);
        if (val !== null || style !== null) {
          const colLetter = sheet.getColumn(c).letter;
          console.log(
            `    ${colLetter}${r}: value=${val ?? "null"}, style=${style ? JSON.stringify(style) : "none"}`
          );
        }
      }
    }

    // Search for totals row (last 10 rows)
    console.log("\n--- SEARCHING FOR TOTALS ROW (last 10 rows) ---");
    const startSearch = Math.max(1, sheet.actualRowCount - 10);
    for (let r = startSearch; r <= sheet.actualRowCount; r++) {
      const row = sheet.getRow(r);
      const usedCols = Math.min(sheet.columnCount, 120);
      let hasContent = false;
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        if (val !== null) {
          if (!hasContent) {
            console.log(
              `\n  ROW ${r}: height=${row.height ?? "default"}`
            );
            hasContent = true;
          }
          const colLetter = sheet.getColumn(c).letter;
          const style = styleSummary(cell);
          console.log(
            `    ${colLetter}${r} = ${val}  style=${style ? JSON.stringify(style) : "none"}`
          );
        }
      }
    }

    // Number formats (first 30 rows)
    console.log("\n--- NUMBER FORMATS (sampled from first 30 rows) ---");
    const numFmts = new Set();
    const sampleRows = Math.min(30, sheet.rowCount);
    for (let r = 1; r <= sampleRows; r++) {
      const row = sheet.getRow(r);
      const usedCols = Math.min(sheet.columnCount, 120);
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        if (cell.numFmt) {
          numFmts.add(cell.numFmt);
        }
      }
    }
    if (numFmts.size > 0) {
      for (const fmt of numFmts) {
        console.log(`  "${fmt}"`);
      }
    } else {
      console.log("  No explicit number formats found in sampled rows.");
    }

    // Number formats (last 10 rows)
    console.log("\n--- NUMBER FORMATS (sampled from last 10 rows) ---");
    const numFmts2 = new Set();
    for (let r = startSearch; r <= sheet.actualRowCount; r++) {
      const row = sheet.getRow(r);
      const usedCols = Math.min(sheet.columnCount, 120);
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        if (cell.numFmt) {
          numFmts2.add(cell.numFmt);
        }
      }
    }
    if (numFmts2.size > 0) {
      for (const fmt of numFmts2) {
        console.log(`  "${fmt}"`);
      }
    } else {
      console.log("  No explicit number formats found.");
    }

    // Daily entry column detection
    console.log("\n--- DAILY ENTRY COLUMN DETECTION ---");
    for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      let dateColsFound = [];
      const usedCols = Math.min(sheet.columnCount, 120);
      for (let c = 1; c <= usedCols; c++) {
        const cell = row.getCell(c);
        const val = cell.value;
        if (val instanceof Date || (typeof val === "number" && val > 40000 && val < 50000)) {
          const colLetter = sheet.getColumn(c).letter;
          dateColsFound.push({ col: colLetter, colNum: c, value: val });
        } else if (typeof val === "string" && /\d{1,2}[\/-]\d{1,2}/.test(val)) {
          const colLetter = sheet.getColumn(c).letter;
          dateColsFound.push({ col: colLetter, colNum: c, value: val });
        }
      }
      if (dateColsFound.length > 0) {
        console.log(`  Row ${r} has ${dateColsFound.length} date-like columns:`);
        const show = dateColsFound.length <= 12
          ? dateColsFound
          : [...dateColsFound.slice(0, 6), "...", ...dateColsFound.slice(-6)];
        for (const d of show) {
          if (typeof d === "string") {
            console.log(`    ${d}`);
          } else {
            console.log(`    ${d.col} (col ${d.colNum}): ${d.value instanceof Date ? d.value.toISOString() : d.value}`);
          }
        }
      }
    }

    // Conditional formatting
    console.log("\n--- CONDITIONAL FORMATTING ---");
    if (sheet.conditionalFormattings && sheet.conditionalFormattings.length > 0) {
      for (const cf of sheet.conditionalFormattings) {
        console.log(`  ${JSON.stringify(cf)}`);
      }
    } else {
      console.log("  No conditional formatting found (or not exposed by exceljs).");
    }

    // Data Validations
    console.log("\n--- DATA VALIDATIONS ---");
    if (sheet.dataValidations && sheet.dataValidations.model) {
      const dvs = Object.entries(sheet.dataValidations.model);
      if (dvs.length > 0) {
        for (const [addr, dv] of dvs) {
          console.log(`  ${addr}: ${JSON.stringify(dv)}`);
        }
      } else {
        console.log("  No data validations.");
      }
    } else {
      console.log("  No data validations.");
    }

    // Auto-filter
    console.log("\n--- AUTO FILTER ---");
    if (sheet.autoFilter) {
      console.log(`  ${JSON.stringify(sheet.autoFilter)}`);
    } else {
      console.log("  No auto-filter.");
    }
  }
}

main().catch(console.error);

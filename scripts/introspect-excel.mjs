import ExcelJS from "/Users/collinwillis/Dev/Personal/truss/node_modules/exceljs/lib/exceljs.nodejs.js";

const FILE = "/Users/collinwillis/Dev/Personal/truss/2021_-_Rev1_Progress_2026-02-18.xlsx";

function styleSummary(cell) {
  const s = {};
  if (cell.font && Object.keys(cell.font).length) {
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
    s.fill = {};
    s.fill.type = cell.fill.type;
    if (cell.fill.pattern) s.fill.pattern = cell.fill.pattern;
    if (cell.fill.fgColor) s.fill.fgColor = cell.fill.fgColor;
    if (cell.fill.bgColor) s.fill.bgColor = cell.fill.bgColor;
  }
  if (cell.border && Object.keys(cell.border).length) {
    s.border = {};
    for (const side of ["top", "bottom", "left", "right"]) {
      if (cell.border[side]) s.border[side] = cell.border[side];
    }
  }
  if (cell.numFmt) s.numFmt = cell.numFmt;
  if (cell.alignment && Object.keys(cell.alignment).length) {
    s.alignment = cell.alignment;
  }
  return s;
}

function cellValueStr(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.richText) return "[RichText] " + v.richText.map((r) => r.text).join("");
    if (v.formula) return "[Formula] =" + v.formula + " => " + v.result;
    if (v.sharedFormula) return "[SharedFormula] =" + v.sharedFormula + " => " + v.result;
    if (v instanceof Date) return "[Date] " + v.toISOString();
    return JSON.stringify(v);
  }
  return String(v);
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  console.log("=== WORKBOOK INFO ===");
  console.log("Sheets:", wb.worksheets.map((s) => s.name));
  console.log("");

  for (const ws of wb.worksheets) {
    console.log("\n" + "=".repeat(80));
    console.log("SHEET: \"" + ws.name + "\"");
    console.log("=".repeat(80));

    console.log("\n--- DIMENSIONS ---");
    console.log("Row count:", ws.rowCount);
    console.log("Column count:", ws.columnCount);
    console.log("Actual row count:", ws.actualRowCount);
    console.log("Actual column count:", ws.actualColumnCount);

    console.log("\n--- VIEWS / FREEZE PANES ---");
    console.log(JSON.stringify(ws.views, null, 2));

    console.log("\n--- MERGED CELLS ---");
    const merges = ws.model?.merges || [];
    console.log("Total merged regions: " + merges.length);
    for (let i = 0; i < Math.min(merges.length, 80); i++) {
      console.log("  " + merges[i]);
    }
    if (merges.length > 80) console.log("  ... and " + (merges.length - 80) + " more");

    console.log("\n--- COLUMNS (first 60) ---");
    for (let c = 1; c <= Math.min(ws.columnCount, 60); c++) {
      const col = ws.getColumn(c);
      const letter = col.letter;
      const width = col.width;
      const hidden = col.hidden;
      const style = col.style || {};
      console.log("  Col " + letter + " (" + c + "): width=" + width + ", hidden=" + hidden + ", numFmt=" + (style.numFmt || "general"));
    }

    console.log("\n--- FIRST 15 ROWS (values + styles) ---");
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const row = ws.getRow(r);
      console.log("\n  ROW " + r + ": height=" + row.height + ", hidden=" + row.hidden + ", outlineLevel=" + row.outlineLevel);

      for (let c = 1; c <= Math.min(ws.columnCount, 40); c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        if (val || Object.keys(styleSummary(cell)).length > 0) {
          const colLetter = ws.getColumn(c).letter;
          const st = styleSummary(cell);
          const isMerged = cell.isMerged ? " [MERGED]" : "";
          const master = cell.master !== cell ? " master=" + (cell.master && cell.master.address) : "";
          console.log("    " + colLetter + r + ": value=\"" + val + "\"" + isMerged + master);
          if (Object.keys(st).length > 0) {
            console.log("           style=" + JSON.stringify(st));
          }
        }
      }
    }

    console.log("\n--- REPRESENTATIVE ROW TYPES (by Col A value) ---");
    const typeExamples = {};
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const colAVal = cellValueStr(row.getCell(1)).trim();
      if (colAVal && !typeExamples[colAVal]) {
        typeExamples[colAVal] = r;
      }
    }
    console.log("Distinct Col A values found:", Object.keys(typeExamples));

    for (const [type, rowNum] of Object.entries(typeExamples)) {
      const row = ws.getRow(rowNum);
      console.log("\n  TYPE=\"" + type + "\" (row " + rowNum + "): height=" + row.height + ", outlineLevel=" + row.outlineLevel);

      for (let c = 1; c <= Math.min(ws.columnCount, 40); c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        const colLetter = ws.getColumn(c).letter;
        const st = styleSummary(cell);
        if (val || Object.keys(st).length > 0) {
          const isMerged = cell.isMerged ? " [MERGED]" : "";
          console.log("    " + colLetter + rowNum + ": value=\"" + val + "\"" + isMerged);
          if (Object.keys(st).length > 0) {
            console.log("           style=" + JSON.stringify(st));
          }
        }
      }
    }

    console.log("\n--- LAST 5 DATA ROWS (potential totals) ---");
    const lastRow = ws.rowCount;
    for (let r = Math.max(1, lastRow - 4); r <= lastRow; r++) {
      const row = ws.getRow(r);
      console.log("\n  ROW " + r + ": height=" + row.height + ", hidden=" + row.hidden);
      for (let c = 1; c <= Math.min(ws.columnCount, 40); c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        if (val) {
          const colLetter = ws.getColumn(c).letter;
          const st = styleSummary(cell);
          const isMerged = cell.isMerged ? " [MERGED]" : "";
          console.log("    " + colLetter + r + ": value=\"" + val + "\"" + isMerged);
          if (Object.keys(st).length > 0) {
            console.log("           style=" + JSON.stringify(st));
          }
        }
      }
    }

    console.log("\n--- DAILY ENTRY COLUMNS STRUCTURE (cols G onward, rows 1-10) ---");
    for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
      const row = ws.getRow(r);
      const vals = [];
      for (let c = 7; c <= Math.min(ws.columnCount, 60); c++) {
        const cell = row.getCell(c);
        const val = cellValueStr(cell);
        if (val) {
          const colLetter = ws.getColumn(c).letter;
          vals.push(colLetter + "=" + val);
        }
      }
      if (vals.length) {
        console.log("  Row " + r + ": " + vals.join(" | "));
      }
    }

    console.log("\n--- NUMBER FORMATS FOUND ---");
    const numFmts = new Set();
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= Math.min(ws.columnCount, 60); c++) {
        const cell = row.getCell(c);
        if (cell.numFmt) numFmts.add(cell.numFmt);
      }
    }
    console.log([...numFmts]);

    console.log("\n--- FULL COLUMN COUNT & LAST COLUMNS ---");
    console.log("Total columns:", ws.columnCount);
    if (ws.columnCount > 40) {
      console.log("Columns 41 to end:");
      for (let c = 41; c <= ws.columnCount; c++) {
        const col = ws.getColumn(c);
        console.log("  Col " + col.letter + " (" + c + "): width=" + col.width);
      }
    }

    console.log("\n--- DISTINCT ROW HEIGHTS ---");
    const heightMap = {};
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const h = row.height || "default";
      if (!heightMap[h]) heightMap[h] = [];
      heightMap[h].push(r);
    }
    for (const [h, rows] of Object.entries(heightMap)) {
      const sample = rows.slice(0, 10).join(", ");
      console.log("  Height " + h + ": " + rows.length + " rows (e.g. rows " + sample + ")");
    }

    console.log("\n--- CONDITIONAL FORMATTING ---");
    if (ws.conditionalFormattings && ws.conditionalFormattings.length) {
      for (const cf of ws.conditionalFormattings) {
        console.log(JSON.stringify(cf, null, 2));
      }
    } else {
      console.log("  None found");
    }

    console.log("\n--- DATA VALIDATIONS ---");
    if (ws.dataValidations && ws.dataValidations.model) {
      const dvs = Object.entries(ws.dataValidations.model);
      console.log("  " + dvs.length + " validations found");
      for (const [addr, dv] of dvs.slice(0, 10)) {
        console.log("  " + addr + ": " + JSON.stringify(dv));
      }
    } else {
      console.log("  None found");
    }

    console.log("\n--- AUTO FILTER ---");
    console.log(JSON.stringify(ws.autoFilter, null, 2));

    console.log("\n--- PRINT AREA ---");
    console.log((ws.pageSetup && ws.pageSetup.printArea) || "None");
  }
}

main().catch(console.error);

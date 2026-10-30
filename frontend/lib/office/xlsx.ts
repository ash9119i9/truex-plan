import { OFFICE_LIMITS, type OfficeLimits } from "./limits.ts";
import { formatCode, formatNumber } from "./number-format.ts";
import { mainPart, readRels } from "./package.ts";
import { NS, STOP, parseXml } from "./xml.ts";
import { openZip, type Zip } from "./zip.ts";

// A workbook as the preview shows it: every sheet in tab order, each cell as
// Excel would display it. A formula saved without its result (openpyxl never
// saves results) shows the formula itself.

export type Sheet = {
  name: string;
  hidden: boolean;
  // From A1, padded to the widest row.
  rows: string[][];
  // [row, column] of each cell showing a formula instead of a result.
  formulas: [number, number][];
  // Rows or columns past the caps were left out.
  truncated: boolean;
};

export type Workbook = {
  sheets: Sheet[];
  // Sheets past the cap were left out.
  truncated: boolean;
};

type Context = {
  strings: string[];
  // Each cell style's number format code, by style index.
  formats: string[];
  date1904: boolean;
  limits: OfficeLimits;
};

export function parseXlsx(
  bytes: Uint8Array,
  limits: OfficeLimits = OFFICE_LIMITS,
): Workbook {
  const zip = openZip(bytes, limits);
  const workbook = mainPart(zip, "xl/workbook.xml");
  const rels = readRels(zip, workbook);
  const target = (type: string) =>
    [...rels.values()].find((r) => r.type.endsWith(`/${type}`))?.target;

  const listed: { name: string; hidden: boolean; part: string }[] = [];
  let date1904 = false;
  parseXml(zip.text(workbook), {
    open: (el) => {
      if (el.uri !== NS.sheet) return;
      if (el.local === "workbookPr") {
        const flag = el.attr("date1904");
        date1904 = flag === "1" || flag === "true";
      } else if (el.local === "sheet") {
        const rel = rels.get(el.attr("id", NS.rels) ?? "");
        // Chart and dialog sheets have no cells to show.
        if (!rel || !rel.type.endsWith("/worksheet")) return;
        const state = el.attr("state");
        listed.push({
          name: el.attr("name") ?? `Sheet${listed.length + 1}`,
          hidden: state === "hidden" || state === "veryHidden",
          part: rel.target,
        });
      }
    },
  });

  const strings = target("sharedStrings");
  const styles = target("styles");
  const context: Context = {
    strings: strings && zip.has(strings) ? sharedStrings(zip, strings) : [],
    formats: styles && zip.has(styles) ? cellFormats(zip, styles) : [],
    date1904,
    limits,
  };
  const shown = listed.slice(0, limits.sheets);
  return {
    sheets: shown.map(({ name, hidden, part }) => ({
      name,
      hidden,
      ...(zip.has(part)
        ? readSheet(zip.text(part), context)
        : { rows: [], formulas: [], truncated: false }),
    })),
    truncated: listed.length > shown.length,
  };
}

// The text of each shared string, rich-text runs joined, phonetic hints left out.
function sharedStrings(zip: Zip, part: string): string[] {
  const out: string[] = [];
  let current = "";
  let inText = false;
  let phonetic = 0;
  parseXml(zip.text(part), {
    open: (el) => {
      if (el.uri !== NS.sheet) return;
      if (el.local === "si") current = "";
      else if (el.local === "rPh") phonetic++;
      else if (el.local === "t" && !phonetic) inText = true;
    },
    close: (local, uri) => {
      if (uri !== NS.sheet) return;
      if (local === "si") out.push(current);
      else if (local === "rPh") phonetic--;
      else if (local === "t") inText = false;
    },
    text: (text) => {
      if (inText) current += text;
    },
  });
  return out;
}

function cellFormats(zip: Zip, part: string): string[] {
  const custom = new Map<number, string>();
  const ids: number[] = [];
  let inCellXfs = false;
  parseXml(zip.text(part), {
    open: (el) => {
      if (el.uri !== NS.sheet) return;
      if (el.local === "numFmt")
        custom.set(Number(el.attr("numFmtId")), el.attr("formatCode") ?? "");
      else if (el.local === "cellXfs") inCellXfs = true;
      else if (el.local === "xf" && inCellXfs)
        ids.push(Number(el.attr("numFmtId") ?? 0));
    },
    close: (local, uri) => {
      if (uri === NS.sheet && local === "cellXfs") inCellXfs = false;
    },
  });
  return ids.map((id) => formatCode(id, custom));
}

type Cell = {
  column: number;
  type: string;
  style: number;
  value: string;
  formula: string;
  hasFormula: boolean;
  inline: string;
};

function readSheet(
  xml: string,
  context: Context,
): Pick<Sheet, "rows" | "formulas" | "truncated"> {
  const { sheetRows, sheetColumns } = context.limits;
  const rows: string[][] = [];
  const formulas: [number, number][] = [];
  let truncated = false;
  let row = -1;
  let nextColumn = 0;
  let cell: Cell | null = null;
  let field: "value" | "formula" | "inline" | null = null;
  let phonetic = 0;

  const place = (cell: Cell) => {
    if (cell.column >= sheetColumns) {
      truncated = true;
      return;
    }
    const { text, formula } = cellText(cell, context);
    if (text === "") return;
    while (rows.length <= row) rows.push([]);
    const cells = rows[row];
    while (cells.length < cell.column) cells.push("");
    cells[cell.column] = text;
    if (formula) formulas.push([row, cell.column]);
  };

  parseXml(xml, {
    open: (el) => {
      if (el.uri !== NS.sheet) return;
      switch (el.local) {
        case "row": {
          const r = Number(el.attr("r"));
          row = Number.isInteger(r) && r > row + 1 ? r - 1 : row + 1;
          nextColumn = 0;
          if (row >= sheetRows) {
            truncated = true;
            throw STOP;
          }
          break;
        }
        case "c": {
          const column = columnOf(el.attr("r")) ?? nextColumn;
          nextColumn = column + 1;
          cell = {
            column,
            type: el.attr("t") ?? "n",
            style: Number(el.attr("s") ?? 0),
            value: "",
            formula: "",
            hasFormula: false,
            inline: "",
          };
          break;
        }
        case "v":
          field = "value";
          break;
        case "f":
          if (cell) cell.hasFormula = true;
          field = "formula";
          break;
        case "rPh":
          phonetic++;
          break;
        case "t":
          if (!phonetic) field = "inline";
          break;
      }
    },
    close: (local, uri) => {
      if (uri !== NS.sheet) return;
      if (local === "v" || local === "f" || local === "t") field = null;
      else if (local === "rPh") phonetic--;
      else if (local === "c" && cell) {
        place(cell);
        cell = null;
      }
    },
    text: (text) => {
      if (cell && field) cell[field] += text;
    },
  });

  const width = Math.max(0, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push("");
  return { rows, formulas, truncated };
}

// "AB12" → 27. Null when the reference has no column letters.
function columnOf(ref: string | undefined): number | null {
  const letters = ref?.match(/^[A-Z]{1,3}/i)?.[0];
  if (!letters) return null;
  let column = 0;
  for (const c of letters.toUpperCase())
    column = column * 26 + c.charCodeAt(0) - 64;
  return column - 1;
}

function cellText(
  cell: Cell,
  context: Context,
): { text: string; formula: boolean } {
  if (cell.hasFormula && cell.value === "")
    // A shared formula's later cells carry no text of their own.
    return { text: cell.formula ? `=${cell.formula}` : "=…", formula: true };
  const text = (() => {
    switch (cell.type) {
      case "s":
        return context.strings[Number(cell.value)] ?? "";
      case "inlineStr":
        return cell.inline;
      case "b":
        return cell.value === "1" || cell.value.toLowerCase() === "true"
          ? "TRUE"
          : "FALSE";
      // "str" (a formula's text result), "e" (#DIV/0! …), "d" (an ISO date).
      case "str":
      case "e":
      case "d":
        return cell.value;
      default: {
        if (cell.value === "") return "";
        const value = Number(cell.value);
        if (!Number.isFinite(value)) return cell.value;
        return formatNumber(
          value,
          context.formats[cell.style] ?? "General",
          context.date1904,
        );
      }
    }
  })();
  return { text, formula: false };
}

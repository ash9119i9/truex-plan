import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { parseXlsx } from "../lib/office/xlsx.ts";
import { formatNumber, general } from "../lib/office/number-format.ts";
import { OFFICE_LIMITS, PreviewError } from "../lib/office/limits.ts";

// The .xlsx parser (tasks/office-preview-todo.md, Task 3).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url));
const invoice = () => new Uint8Array(fixture("invoice.xlsx"));
const fails = (code: string) => (error: unknown) =>
  error instanceof PreviewError && error.code === code;

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// A minimal workbook around one or more sheets' <sheetData> contents.
function book(
  sheets: (string | { data: string; state?: string })[],
  extra: { strings?: string; styles?: string; workbookPr?: string } = {},
) {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
  };
  let rels = "";
  let listed = "";
  sheets.forEach((sheet, i) => {
    const { data, state } = typeof sheet === "string" ? { data: sheet } : sheet;
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<worksheet xmlns="${MAIN}"><sheetData>${data}</sheetData></worksheet>`,
    );
    rels += `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
    listed += `<sheet name="S${i + 1}" sheetId="${i + 1}"${state ? ` state="${state}"` : ""} r:id="rId${i + 1}"/>`;
  });
  if (extra.strings) {
    files["xl/sharedStrings.xml"] = strToU8(
      `<sst xmlns="${MAIN}">${extra.strings}</sst>`,
    );
    rels += `<Relationship Id="rS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>`;
  }
  if (extra.styles) {
    files["xl/styles.xml"] = strToU8(
      `<styleSheet xmlns="${MAIN}">${extra.styles}</styleSheet>`,
    );
    rels += `<Relationship Id="rT" Type="${R}/styles" Target="styles.xml"/>`;
  }
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `<workbook xmlns="${MAIN}" xmlns:r="${R}">${extra.workbookPr ?? ""}<sheets>${listed}</sheets></workbook>`,
  );
  return zipSync(files);
}

test("every value in the agent's invoice matches what openpyxl wrote", () => {
  const expected = JSON.parse(
    fixture("invoice.expected.json").toString("utf8"),
  );
  assert.deepEqual(parseXlsx(invoice()), expected);
});

test("formulas without a saved result show the formula and are marked", () => {
  const [sheet] = parseXlsx(invoice()).sheets;
  assert.equal(sheet.rows[4][3], "=SUM(D2:D4)");
  assert.deepEqual(sheet.formulas, [
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 3],
  ]);
  // A formula with a saved result shows the result, unmarked.
  const saved = parseXlsx(
    book(['<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>']),
  );
  assert.deepEqual(saved.sheets[0].rows, [["2"]]);
  assert.deepEqual(saved.sheets[0].formulas, []);
});

test("sparse cells land in their row and column", () => {
  const notes = parseXlsx(invoice()).sheets[1];
  assert.equal(notes.rows[2][2], "42");
  const sparse = parseXlsx(
    book([
      '<row r="2"><c r="B2" t="inlineStr"><is><t>x</t></is></c></row><row r="4"><c r="D4"><v>7</v></c></row>',
    ]),
  ).sheets[0];
  assert.deepEqual(sparse.rows, [
    ["", "", "", ""],
    ["", "x", "", ""],
    ["", "", "", ""],
    ["", "", "", "7"],
  ]);
  // No r attributes: rows and cells follow one another.
  const plain = parseXlsx(
    book([
      "<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>",
    ]),
  );
  assert.deepEqual(plain.sheets[0].rows, [
    ["1", "2"],
    ["3", ""],
  ]);
});

test("shared strings, rich text, booleans, errors and string results read as text", () => {
  const sheet = parseXlsx(
    book(
      [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#DIV/0!</v></c><c r="E1" t="str"><f>A1&amp;"!"</f><v>Hi!</v></c></row>',
      ],
      {
        strings:
          '<si><t>Hi</t></si><si><r><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r><rPh><t>ほ</t></rPh></si>',
      },
    ),
  ).sheets[0];
  assert.deepEqual(sheet.rows, [
    ["Hi", "Bold and plain", "TRUE", "#DIV/0!", "Hi!"],
  ]);
});

test("number formats and both date systems display as Excel shows them", () => {
  const styles =
    '<numFmts><numFmt numFmtId="164" formatCode="d-mmm-yy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/><xf numFmtId="10"/></cellXfs>';
  const data =
    '<row r="1"><c r="A1" s="1"><v>46325</v></c><c r="B1" s="2"><v>1234.5</v></c><c r="C1" s="3"><v>0.1234</v></c><c r="D1"><v>0.30000000000000004</v></c></row>';
  assert.deepEqual(parseXlsx(book([data], { styles })).sheets[0].rows, [
    ["30-Oct-26", "1,234.50", "12.34%", "0.3"],
  ]);
  const in1904 = parseXlsx(
    book([data], { styles, workbookPr: '<workbookPr date1904="1"/>' }),
  );
  assert.equal(in1904.sheets[0].rows[0][0], "31-Oct-30");
});

test("hidden sheets are marked and kept in tab order", () => {
  const workbook = parseXlsx(
    book([
      "<row><c><v>1</v></c></row>",
      { data: "<row><c><v>2</v></c></row>", state: "hidden" },
    ]),
  );
  assert.deepEqual(
    workbook.sheets.map((s) => [s.name, s.hidden]),
    [
      ["S1", false],
      ["S2", true],
    ],
  );
});

test("rows, columns and sheets past the caps set truncated", () => {
  const rows = parseXlsx(invoice(), { ...OFFICE_LIMITS, sheetRows: 2 })
    .sheets[0];
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.truncated, true);
  const columns = parseXlsx(invoice(), { ...OFFICE_LIMITS, sheetColumns: 3 })
    .sheets[0];
  assert.deepEqual(columns.rows[0], ["Item", "Qty", "Price"]);
  assert.equal(columns.truncated, true);
  assert.deepEqual(columns.formulas, []);
  const sheets = parseXlsx(invoice(), { ...OFFICE_LIMITS, sheets: 1 });
  assert.deepEqual(
    sheets.sheets.map((s) => s.name),
    ["Invoice"],
  );
  assert.equal(sheets.truncated, true);
  // A row far past the cap stops the sheet there, without padding up to it.
  const far = parseXlsx(
    book([
      '<row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="A1048576"><v>2</v></c></row>',
    ]),
  );
  assert.deepEqual(far.sheets[0].rows, [["1"]]);
  assert.equal(far.sheets[0].truncated, true);
});

test("malformed sheet XML, a missing workbook or a broken file is corrupt", () => {
  assert.throws(
    () => parseXlsx(book(["<row><c><v>1</v></row>"])),
    fails("corrupt"),
  );
  assert.throws(
    () => parseXlsx(zipSync({ "a.txt": strToU8("x") })),
    fails("corrupt"),
  );
  assert.throws(
    () => parseXlsx(new Uint8Array(fixture("truncated.xlsx"))),
    fails("corrupt"),
  );
  assert.throws(
    () => parseXlsx(new Uint8Array(fixture("bomb.xlsx"))),
    fails("corrupt"),
  );
});

test("number format codes", () => {
  const cases: [number, string, string][] = [
    [1234.5, "#,##0.00", "1,234.50"],
    [1234567, "#,##0", "1,234,567"],
    [-1234.5, "#,##0.00;(#,##0.00)", "(1,234.50)"],
    [-3, "0.00", "-3.00"],
    [-5, "$#,##0", "-$5"],
    [2.5, "0", "3"],
    [123, "00000", "00123"],
    [0.5, "#.##", ".5"],
    [0.1234, "0.00%", "12.34%"],
    [12345, "0.00E+00", "1.23E+04"],
    [1234.5, '"$"#,##0.00', "$1,234.50"],
    [1234.5, "[$€-407]#,##0.00", "€1,234.50"],
    [1234.5, "_($* #,##0.00_)", "$1,234.50"],
    [1500000, "#,##0,", "1,500"],
    [5, '0 "units"', "5 units"],
    [7, "[Red]0", "7"],
    [46325, "m/d/yyyy", "10/30/2026"],
    [46325, "yyyy-mm-dd", "2026-10-30"],
    [46325, "dddd, mmmm d", "Friday, October 30"],
    [0.75, "h:mm AM/PM", "6:00 PM"],
    [0.5, "[$-409]h:mm:ss AM/PM", "12:00:00 PM"],
    [1.5, "[h]:mm:ss", "36:00:00"],
    [60 / 86400, "mm:ss", "01:00"],
    [46325.5, "m/d/yyyy h:mm", "10/30/2026 12:00"],
    [60, "yyyy-mm-dd", "1900-02-29"],
    [61, "yyyy-mm-dd", "1900-03-01"],
    [1, "yyyy-mm-dd", "1900-01-01"],
    [42, "General", "42"],
    [42, "@", "42"],
  ];
  for (const [value, code, shown] of cases)
    assert.equal(formatNumber(value, code), shown, `${value} as ${code}`);
  assert.equal(formatNumber(0, "yyyy-mm-dd", true), "1904-01-01");
  assert.equal(general(123456789012), "1.23457E+11");
  assert.equal(general(0.1 + 0.2), "0.3");
});

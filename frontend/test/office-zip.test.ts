import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { openZip } from "../lib/office/zip.ts";
import { parseXml, NS } from "../lib/office/xml.ts";
import { OFFICE_LIMITS, PreviewError } from "../lib/office/limits.ts";

// Bounded unzip and DOM-free XML (tasks/office-preview-todo.md, Task 2).
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url)),
  );
const fails = (code: string) => (error: unknown) =>
  error instanceof PreviewError && error.code === code;

// A zip whose one part's central-directory field at `offset` is overwritten.
function patched(part: Uint8Array, offset: number, value: number, bytes = 4) {
  const zip = zipSync({ "a.xml": part }, { level: 9 });
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  const central = view.getUint32(end + 16, true);
  if (bytes === 4) view.setUint32(central + offset, value, true);
  else view.setUint16(central + offset, value, true);
  return zip;
}

test("a part that unzips past the limit is refused before inflating", () => {
  // bomb.xlsx declares its 150 MB part honestly: refused on the size alone.
  const zip = openZip(fixture("bomb.xlsx"));
  assert.throws(
    () => zip.read("xl/worksheets/sheet1.xml"),
    (error) =>
      fails("too-large")(error) && (error as PreviewError).inflated === 0,
  );
});

test("a part whose header understates its size stops at the stated size", () => {
  // 8 MB of spaces declared as 1 KB: inflating stops near 1 KB, not at 8 MB.
  const zip = openZip(
    patched(new Uint8Array(8 * 1024 * 1024).fill(32), 24, 1024),
  );
  assert.throws(
    () => zip.read("a.xml"),
    (error) =>
      fails("corrupt")(error) &&
      /larger than it says/.test((error as Error).message) &&
      (error as PreviewError).inflated > 1024 &&
      (error as PreviewError).inflated < 2 * 1024 * 1024,
  );
});

test("parts read from one file share a total limit", () => {
  const limits = { ...OFFICE_LIMITS, totalBytes: 1000 };
  const part = new Uint8Array(600).fill(65);
  const zip = openZip(zipSync({ "a.xml": part, "b.xml": part }), limits);
  assert.equal(zip.read("a.xml").length, 600);
  assert.throws(() => zip.read("b.xml"), fails("too-large"));
});

test("files over the size or part-count limits are refused on open", () => {
  const bytes = fixture("invoice.xlsx");
  assert.throws(
    () => openZip(bytes, { ...OFFICE_LIMITS, fileBytes: 100 }),
    fails("too-large"),
  );
  assert.throws(
    () => openZip(bytes, { ...OFFICE_LIMITS, entries: 3 }),
    fails("too-large"),
  );
});

test("broken and non-zip files reject as corrupt, never with a raw error", () => {
  assert.throws(() => openZip(fixture("truncated.xlsx")), fails("corrupt"));
  assert.throws(() => openZip(fixture("notzip.docx")), fails("corrupt"));
  assert.throws(() => openZip(new Uint8Array(0)), fails("corrupt"));
  assert.throws(
    () => openZip(fixture("invoice.xlsx")).read("nope.xml"),
    fails("corrupt"),
  );
  // Random bytes where the deflate data should be.
  const zip = zipSync({ "a.xml": new Uint8Array(4096).fill(7) }, { level: 9 });
  const local = new DataView(zip.buffer);
  const from = 30 + local.getUint16(26, true) + local.getUint16(28, true);
  zip.fill(0xff, from, from + 8);
  assert.throws(() => openZip(zip).read("a.xml"), fails("corrupt"));
});

test("encrypted parts and unknown compression are unsupported", () => {
  const part = new Uint8Array(100).fill(65);
  assert.throws(
    () => openZip(patched(part, 8, 1, 2)).read("a.xml"),
    fails("unsupported"),
  );
  assert.throws(
    () => openZip(patched(part, 10, 12, 2)).read("a.xml"),
    fails("unsupported"),
  );
});

test("an agent workbook's parts read back intact", () => {
  const zip = openZip(fixture("invoice.xlsx"));
  assert.ok(zip.has("xl/worksheets/sheet2.xml"));
  assert.match(zip.text("xl/workbook.xml"), /name="Invoice"/);
  assert.equal(zip.names.length, 10);
});

test("XML events are namespace-aware and need no DOM", () => {
  assert.equal(
    typeof (globalThis as { DOMParser?: unknown }).DOMParser,
    "undefined",
  );
  const zip = openZip(fixture("invoice.xlsx"));
  const cells: string[] = [];
  let texts = "";
  parseXml(zip.text("xl/worksheets/sheet1.xml"), {
    open: (el) => {
      if (el.local === "c" && el.uri === NS.sheet)
        cells.push(el.attr("r") ?? "");
    },
    text: (t) => (texts += t),
  });
  assert.equal(cells.length, 24);
  assert.ok(cells.includes("D5"));
  assert.match(texts, /Widget/);
  // A prefixed attribute is found by its namespace, not its prefix.
  let id: string | undefined;
  parseXml(
    `<p:sldId xmlns:p="${NS.slide}" xmlns:q="${NS.rels}" id="256" q:id="rId2"/>`,
    {
      open: (el) => (id = el.attr("id", NS.rels)),
    },
  );
  assert.equal(id, "rId2");
});

test("a DOCTYPE or broken XML rejects as corrupt", () => {
  const laughs =
    '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><l>&b;</l>';
  assert.throws(() => parseXml(laughs, { text: () => {} }), fails("corrupt"));
  assert.throws(() => parseXml("<!DOCTYPE l><l>x</l>", {}), fails("corrupt"));
  assert.throws(() => parseXml("<a><b></a>", {}), fails("corrupt"));
});

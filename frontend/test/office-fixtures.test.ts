import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// The Office preview fixtures (tasks/office-preview-todo.md, Task 1), written
// by scripts/office-fixtures.py with the pinned sandbox toolchain.
const dir = new URL("./fixtures/office/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir));

type Entry = {
  name: string;
  size: number;
  method: number;
  packed: number;
  offset: number;
};
// The central directory's entries.
function entries(zip: Buffer): Entry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip =
      nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    out.push({
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
      size: zip.readUInt32LE(at + 24),
      method: zip.readUInt16LE(at + 10),
      packed: zip.readUInt32LE(at + 20),
      offset: zip.readUInt32LE(at + 42),
    });
    at += 46 + skip;
  }
  return out;
}
const names = (file: string) => entries(read(file)).map((e) => e.name);
// One part's text, inflated.
function part(file: string, name: string): string {
  const zip = read(file);
  const entry = entries(zip).find((e) => e.name === name);
  assert.ok(entry, `${file} has no ${name}`);
  const start =
    entry.offset +
    30 +
    zip.readUInt16LE(entry.offset + 26) +
    zip.readUInt16LE(entry.offset + 28);
  const data = zip.subarray(start, start + entry.packed);
  return (entry.method === 8 ? inflateRawSync(data) : data).toString("utf8");
}

const ALL = [
  "report.docx",
  "invoice.xlsx",
  "deck.pptx",
  "brief.pdf",
  "truncated.xlsx",
  "notzip.docx",
  "bomb.xlsx",
];

test("every fixture exists and is under 200 KB", () => {
  for (const file of ALL) {
    assert.ok(existsSync(new URL(file, dir)), `${file} is missing`);
    assert.ok(
      statSync(new URL(file, dir)).size < 200 * 1024,
      `${file} is too big`,
    );
  }
});

test("report.docx has a document, a table and an image", () => {
  const xml = part("report.docx", "word/document.xml");
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /w:val="Heading1"/);
  assert.ok(names("report.docx").some((n) => n.startsWith("word/media/")));
});

test("invoice.xlsx has two sheets, inline strings, styles and bare formulas", () => {
  const list = names("invoice.xlsx");
  assert.ok(list.includes("xl/worksheets/sheet1.xml"));
  assert.ok(list.includes("xl/worksheets/sheet2.xml"));
  assert.ok(list.includes("xl/styles.xml"));
  // openpyxl writes text into each cell, never a shared strings part.
  assert.ok(!list.includes("xl/sharedStrings.xml"));
  const sheet = part("invoice.xlsx", "xl/worksheets/sheet1.xml");
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t>Widget<\/t><\/is><\/c>/);
  // Formulas saved the way openpyxl saves them: no cached value.
  assert.match(
    sheet,
    /<f>SUM\(D2:D4\)<\/f><v\s*\/?>(<\/v>)?|<f>SUM\(D2:D4\)<\/f><\/c>/,
  );
  assert.doesNotMatch(sheet, /<f>SUM\(D2:D4\)<\/f><v>[^<]+<\/v>/);
});

test("deck.pptx has six slides and an image", () => {
  const list = names("deck.pptx");
  const slides = list.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(slides.length, 6);
  assert.ok(list.some((n) => n.startsWith("ppt/media/")));
  assert.match(
    part("deck.pptx", "ppt/slides/slide1.xml"),
    /<p:ph type="ctrTitle"/,
  );
  // Nested bullets: level 1 paragraphs on the bullets slide.
  assert.match(part("deck.pptx", "ppt/slides/slide2.xml"), /<a:pPr lvl="1"/);
  assert.match(part("deck.pptx", "ppt/slides/slide3.xml"), /<a:tbl>/);
});

test("brief.pdf is a 3-page PDF", () => {
  const pdf = read("brief.pdf");
  assert.equal(pdf.toString("latin1", 0, 5), "%PDF-");
  assert.equal(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length, 3);
});

test("the broken fixtures are broken in the intended way", () => {
  // Cut in half: a zip start with no central directory.
  const cut = read("truncated.xlsx");
  assert.equal(cut.readUInt32LE(0), 0x04034b50);
  assert.equal(cut.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])), -1);
  // Text under an Office name.
  assert.notEqual(read("notzip.docx").readUInt32LE(0), 0x04034b50);
  // Unzips past the 100 MB preview limit while staying small on disk.
  const unzipped = entries(read("bomb.xlsx")).reduce(
    (sum, e) => sum + e.size,
    0,
  );
  assert.ok(unzipped > 100 * 1024 * 1024, `bomb unzips to ${unzipped} bytes`);
});

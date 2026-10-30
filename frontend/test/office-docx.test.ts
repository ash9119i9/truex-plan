import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strToU8, unzipSync, zipSync } from "fflate";
import { imageSrc, parseDocx } from "../lib/office/docx.ts";
import { OFFICE_LIMITS, PreviewError } from "../lib/office/limits.ts";
import { runPreview } from "../lib/office/run.ts";
import {
  fileTag,
  hasSource,
  isOffice,
  previewKind,
  sandboxedDocx,
  typeName,
} from "../lib/tenant-files.ts";
import { component } from "./next-details-runtime.ts";

// The Word preview (tasks/office-preview-todo.md, Task 5).
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url)),
  );
const fails = (code: string) => (error: unknown) =>
  error instanceof PreviewError && error.code === code;

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
// The smallest .docx mammoth reads: one body, the document's rels if any, and
// any other parts.
function docx(
  body: string,
  rels = "",
  doctype = "",
  parts: Record<string, Uint8Array> = {},
) {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?>${doctype}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`,
    ),
    ...(rels && {
      "word/_rels/document.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="${RELS}">${rels}</Relationships>`,
      ),
    }),
    ...parts,
  });
}
const para = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

test(".docx is a Word preview with no Source tab; .doc stays download only", () => {
  assert.equal(previewKind("Report.DOCX"), "docx");
  assert.equal(isOffice(previewKind("a.docx")), true);
  assert.equal(hasSource("a.docx"), false);
  assert.equal(typeName("a.docx"), "Word document");
  assert.deepEqual(fileTag("a.docx"), { label: "docx", tone: "docx" });
  assert.equal(previewKind("a.doc"), "none");
});

test("report.docx shows its headings, bullets, table and image", async () => {
  const html = await parseDocx(fixture("report.docx"));
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  assert.match(html, /<h2>Highlights<\/h2>/);
  assert.match(
    html,
    /<ul><li>APAC up 12%<\/li><li>Americas up 4%<\/li><li>EMEA down 3%<\/li><\/ul>/,
  );
  assert.match(html, /<table>.*<p>Region<\/p>.*<p>1,200<\/p>.*<\/table>/);
  assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo[^"]*" \/>/);
});

test("markup in a document's text stays text", async () => {
  const html = await parseDocx(
    docx(
      para("&lt;script&gt;alert(1)&lt;/script&gt;") +
        para('&lt;img src=x onerror="alert(2)"&gt;'),
    ),
  );
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror="alert\(2\)"&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
});

test("links to the web keep their text but lose their address", async () => {
  const html = await parseDocx(
    docx(
      `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>our site</w:t></w:r></w:hyperlink><w:r><w:t> and more</w:t></w:r></w:p>`,
      `<Relationship Id="rId9" Type="${R}/hyperlink" Target="https://evil.example/track" TargetMode="External"/>`,
    ),
  );
  assert.match(html, /<p>our site and more<\/p>/);
  assert.doesNotMatch(html, /evil\.example|href/);
});

test("an image is shown only when its bytes are a raster image", () => {
  const bytes = (...head: number[]) =>
    Uint8Array.from([...head, ...new Array(8).fill(0)]);
  assert.match(
    imageSrc(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) ?? "",
    /^data:image\/png;base64,/,
  );
  assert.match(
    imageSrc(bytes(0xff, 0xd8, 0xff)) ?? "",
    /^data:image\/jpeg;base64,/,
  );
  assert.match(imageSrc(strToU8("GIF89a......")) ?? "", /^data:image\/gif;/);
  assert.match(
    imageSrc(strToU8("RIFF\0\0\0\0WEBPVP8 ")) ?? "",
    /^data:image\/webp;/,
  );
  // SVG can carry script and links; text named .png is not an image.
  assert.equal(imageSrc(strToU8("<svg onload='alert(1)'/>")), null);
  assert.equal(imageSrc(strToU8("hello")), null);
});

test("an image over its limit sends the file to Download", async () => {
  await assert.rejects(
    parseDocx(fixture("report.docx"), { ...OFFICE_LIMITS, imageBytes: 100 }),
    fails("too-large"),
  );
  await assert.rejects(
    parseDocx(fixture("report.docx"), { ...OFFICE_LIMITS, images: 0 }),
    fails("too-large"),
  );
});

test("broken, oversized and hostile packages fail with a typed error", async () => {
  await assert.rejects(parseDocx(fixture("notzip.docx")), fails("corrupt"));
  const whole = fixture("report.docx");
  await assert.rejects(
    parseDocx(whole.subarray(0, whole.length >> 1)),
    fails("corrupt"),
  );
  // Every part is read through the bounded unzip before mammoth sees it.
  await assert.rejects(
    parseDocx(whole, { ...OFFICE_LIMITS, entryBytes: 1000 }),
    fails("too-large"),
  );
  // A zip with no Word document in it.
  await assert.rejects(
    parseDocx(zipSync({ "a.txt": strToU8("hi") })),
    fails("corrupt"),
  );
  await assert.rejects(
    parseDocx(docx(para("&lol;"), "", '<!DOCTYPE d [<!ENTITY lol "lol">]>')),
    fails("corrupt"),
  );
});

test("the worker's request runner returns the HTML or a typed failure", async () => {
  const bytes = fixture("report.docx").slice().buffer;
  const ok = await runPreview({ kind: "docx", bytes });
  assert.equal(ok.ok, true);
  assert.match(
    ok.ok && ok.result.kind === "docx" ? ok.result.html : "",
    /<h1>/,
  );
  const bad = await runPreview({
    kind: "docx",
    bytes: fixture("notzip.docx").slice().buffer,
  });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.code, "corrupt");
});

test("the frame's document allows inline styles and data: images, nothing else", () => {
  const doc = sandboxedDocx("<p>hi</p>");
  const policy = doc.match(/content="([^"]+)"/)?.[1];
  assert.equal(
    policy,
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  );
  assert.match(doc, /<style>[^<]*<\/style>/);
  assert.ok(doc.endsWith("<p>hi</p>"));
});

const { DocView } = component("tenant/doc-view.tsx");

test("the Word view is a frame that can't run scripts", () => {
  const html = renderToStaticMarkup(
    createElement(DocView, { html: "<p>hi</p>" }),
  );
  assert.match(html, /<iframe[^>]* sandbox=""/);
  assert.match(html, /title="Document preview"/);
  assert.match(
    html,
    /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/,
  );
  assert.match(html, /srcDoc="[^"]*img-src data:[^"]*&lt;p&gt;hi&lt;\/p&gt;"/i);
});

test("an image whose bytes aren't a raster image is left out", async () => {
  const parts = unzipSync(fixture("report.docx"));
  parts["word/media/image1.png"] = strToU8(
    "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
  );
  const html = await parseDocx(zipSync(parts));
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  assert.doesNotMatch(html, /<img|svg|alert/);
});

test("images over their total size send the file to Download", async () => {
  await assert.rejects(
    parseDocx(fixture("report.docx"), {
      ...OFFICE_LIMITS,
      imagesTotalBytes: 100,
    }),
    fails("too-large"),
  );
});

test("any DOCTYPE in a Word part is refused, even one mammoth would read", async () => {
  await assert.rejects(
    parseDocx(docx(para("hi"), "", "<!DOCTYPE d>")),
    fails("corrupt"),
  );
});

// Hardening (tasks/office-preview-todo.md, Task 5): found by attacking the
// change; R1–R5 in the harden report.
const relsOf = (inner: string) =>
  strToU8(
    `<?xml version="1.0"?><Relationships xmlns="${RELS}">${inner}</Relationships>`,
  );
const VML = "urn:schemas-microsoft-com:vml";
// A body pointing at footnote 1 and endnote 1, with the notes' own content
// and relationships.
function withNotes(foot: string, end: string, footRels = "", endRels = "") {
  const notes = (kind: "footnote" | "endnote", body: string) =>
    strToU8(
      `<?xml version="1.0"?><w:${kind}s xmlns:w="${W}" xmlns:r="${R}" xmlns:v="${VML}"><w:${kind} w:id="1">${body}</w:${kind}></w:${kind}s>`,
    );
  return docx(
    `<w:p><w:r><w:t>See the notes</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>`,
    `<Relationship Id="rFoot" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="rEnd" Type="${R}/endnotes" Target="endnotes.xml"/>`,
    "",
    {
      "word/footnotes.xml": notes("footnote", foot),
      "word/endnotes.xml": notes("endnote", end),
      "word/_rels/footnotes.xml.rels": relsOf(footRels),
      "word/_rels/endnotes.xml.rels": relsOf(endRels),
    },
  );
}
const link = (id: string, text: string, extra = "") =>
  `<w:p><w:hyperlink r:id="${id}"${extra}><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;
const external = (id: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/hyperlink" Target="${target}" TargetMode="External"/>`;

// R1. fflate can't write a part named __proto__ from an object, so a part with
// a name of the same length is renamed in its zip headers.
function renamed(zip: Uint8Array, from: string, to: string) {
  const [a, b] = [strToU8(from), strToU8(to)];
  assert.equal(a.length, b.length);
  const out = zip.slice();
  let found = 0;
  for (let i = 0; i + a.length <= out.length; i++)
    if (a.every((byte, j) => out[i + j] === byte)) {
      out.set(b, i);
      found++;
    }
  assert.equal(found, 2, "the name is in the local and the central header");
  return out;
}

test("a part named __proto__ is refused, so the zip mammoth reads is the one checked", async () => {
  const file = renamed(
    docx(para("hi"), "", "", { __protoX_: new Uint8Array(5000) }),
    "__protoX_",
    "__proto__",
  );
  await assert.rejects(
    parseDocx(file),
    (error: unknown) =>
      error instanceof PreviewError &&
      error.code === "corrupt" &&
      /__proto__/.test(error.message),
  );
});

test("links in footnotes and endnotes keep their text but lose their address", async () => {
  const html = await parseDocx(
    withNotes(
      link("rF1", "foot web", ' w:tgtFrame="_top"') +
        link("rF2", "foot same-origin"),
      link("rE1", "end web") + link("rE2", "end script"),
      external("rF1", "https://evil.example/foot") +
        external("rF2", "/api/v1/auth/logout"),
      external("rE1", "https://evil.example/end") +
        external("rE2", "javascript:alert(1)"),
    ),
  );
  // Each text ends its paragraph or is followed by the note's back-reference.
  for (const text of ["foot web", "foot same-origin", "end web", "end script"])
    assert.match(html, new RegExp(`>${text}(<| ↑)`));
  // Not even mammoth's own note anchors: in a srcdoc frame "#footnote-1"
  // resolves against the app's address.
  assert.doesNotMatch(html, /href=|target=|evil\.example|\/api\/|javascript:/);
});

test("Word HTML over its cap is too large; image data doesn't count toward it", async () => {
  const full = await parseDocx(fixture("report.docx"));
  const images = [...full.matchAll(/ src="([^"]*)"/g)].reduce(
    (sum, [, src]) => sum + src.length,
    0,
  );
  assert.ok(images > 0);
  const text = full.length - images;
  assert.equal(
    await parseDocx(fixture("report.docx"), {
      ...OFFICE_LIMITS,
      docxHtmlChars: text,
    }),
    full,
  );
  await assert.rejects(
    parseDocx(fixture("report.docx"), {
      ...OFFICE_LIMITS,
      docxHtmlChars: text - 1,
    }),
    fails("too-large"),
  );
});

test("200,000 nested revisions fail as corrupt, not with a stack overflow", async () => {
  const depth = 200_000;
  await assert.rejects(
    parseDocx(
      docx(
        `<w:p>${"<w:ins>".repeat(depth)}<w:r><w:t>deep</w:t></w:r>${"</w:ins>".repeat(depth)}</w:p>`,
      ),
    ),
    fails("corrupt"),
  );
});

test("images in a footnote count toward the image limit", async () => {
  const pict = `<w:r><w:pict><v:shape><v:imagedata r:id="rI"/></v:shape></w:pict></w:r>`;
  const file = withNotes(
    `<w:p>${pict.repeat(3)}</w:p>`,
    para("end"),
    `<Relationship Id="rI" Type="${R}/image" Target="media/image1.png"/>`,
  );
  const withImage = unzipSync(file);
  withImage["word/media/image1.png"] = unzipSync(fixture("report.docx"))[
    "word/media/image1.png"
  ];
  const zipped = zipSync(withImage);
  assert.equal(
    (await parseDocx(zipped)).match(/<img /g)?.length,
    3,
    "all three are read",
  );
  await assert.rejects(
    parseDocx(zipped, { ...OFFICE_LIMITS, images: 2 }),
    fails("too-large"),
  );
});

test("an image stored outside the file is never fetched or shown", async () => {
  const html = await parseDocx(
    docx(
      `<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rX"/></v:shape></w:pict></w:r></w:p>`.replace(
        "<w:pict>",
        `<w:pict xmlns:v="${VML}">`,
      ) + para("after"),
      `<Relationship Id="rX" Type="${R}/image" Target="https://evil.example/pixel.png" TargetMode="External"/>`,
    ),
  );
  assert.match(html, /<p>after<\/p>/);
  assert.doesNotMatch(html, /<img|evil\.example/);
});

test("anchor and field links become their text", async () => {
  const field = (instr: string, text: string) =>
    `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${text}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const html = await parseDocx(
    docx(
      `<w:p><w:bookmarkStart w:id="0" w:name="sec"/><w:r><w:t>Section</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>` +
        `<w:p><w:hyperlink w:anchor="sec" w:tgtFrame="_top"><w:r><w:t>to section</w:t></w:r></w:hyperlink></w:p>` +
        `<w:p><w:fldSimple w:instr='HYPERLINK "https://evil.example/simple"'><w:r><w:t>simple field</w:t></w:r></w:fldSimple></w:p>` +
        field('HYPERLINK "https://evil.example/complex"', "complex field"),
    ),
  );
  for (const text of ["to section", "complex field"])
    assert.match(html, new RegExp(`<p>${text}</p>`));
  // mammoth 1.13 doesn't read simple fields: their text is lost, not linked.
  assert.doesNotMatch(html, /simple field/);
  assert.doesNotMatch(html, /href=|target=|evil\.example/);
});

test("a DOCTYPE in a part with any name is refused", async () => {
  // The package's rels may point the main document at any part name.
  const file = unzipSync(docx(para("hi")));
  file["word/main.bin"] = strToU8(
    new TextDecoder()
      .decode(file["word/document.xml"])
      .replace("?>", "?><!DOCTYPE d>"),
  );
  delete file["word/document.xml"];
  file["_rels/.rels"] = relsOf(
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/main.bin"/>`,
  );
  await assert.rejects(
    parseDocx(zipSync(file)),
    (error: unknown) =>
      error instanceof PreviewError &&
      error.code === "corrupt" &&
      /DOCTYPE/.test(error.message),
  );
});

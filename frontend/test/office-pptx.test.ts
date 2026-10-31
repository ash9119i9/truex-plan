import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { OFFICE_LIMITS, PreviewError } from "../lib/office/limits.ts";
import { parsePptx } from "../lib/office/pptx.ts";
import { runPreview } from "../lib/office/run.ts";
import { isOffice, previewKind } from "../lib/tenant-files.ts";

// The PowerPoint preview: one card per slide with its title, text and raster
// images. deck.pptx is written by scripts/office-fixtures.py.
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url)),
  );

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const SLIDE = `${R}/slide`;

// A minimal deck: each slide is { title, body[] } or raw slide XML.
function deck(slides: Array<string | { title: string; body: string[] }>) {
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${REL}"><Relationship Id="r1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ),
    "ppt/presentation.xml": strToU8(
      `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="s${i}"/>`)
        .join("")}</p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships xmlns="${REL}">${slides
        .map(
          (_, i) =>
            `<Relationship Id="s${i}" Type="${SLIDE}" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  slides.forEach((slide, i) => {
    const xml =
      typeof slide === "string"
        ? slide
        : `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${slide.title}</a:t></a:r></a:p></p:txBody></p:sp>` +
          `<p:sp><p:txBody>${slide.body
            .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
            .join("")}</p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(xml);
  });
  return zipSync(files);
}

test(".pptx is a slides preview parsed in the worker; .ppt stays download only", () => {
  assert.equal(previewKind("deck.pptx"), "slides");
  assert.equal(previewKind("Deck.PPTX"), "slides");
  assert.equal(previewKind("old.ppt"), "none");
  assert.equal(isOffice("slides"), true);
});

test("deck.pptx shows every slide's title, text, table and image in order", () => {
  const { slides, truncated } = parsePptx(fixture("deck.pptx"));
  assert.equal(truncated, false);
  assert.deepEqual(
    slides.map((s) => s.title),
    ["Q3 review", "What changed", "By region", "Trend", "Risks", "Next steps"],
  );
  assert.deepEqual(slides[0]!.paragraphs, ["Invoice desk"]);
  assert.deepEqual(slides[1]!.paragraphs, [
    "Revenue",
    "APAC up 12%",
    "EMEA down 3%",
    "Costs flat",
  ]);
  // Table cells are body text.
  for (const cell of ["Region", "Revenue", "APAC", "1,200", "EMEA", "800"])
    assert.ok(slides[2]!.paragraphs.includes(cell), cell);
  assert.equal(slides[3]!.images.length, 1);
  assert.match(slides[3]!.images[0]!, /^data:image\/png;base64,/);
  assert.deepEqual(slides[5]!.paragraphs, ["Hire two reps", "Review pricing"]);
});

test("markup in a slide's text stays text", () => {
  const { slides } = parsePptx(
    deck([
      {
        title: "&lt;b&gt;Hi&lt;/b&gt;",
        body: ["&lt;script&gt;x()&lt;/script&gt;"],
      },
    ]),
  );
  assert.equal(slides[0]!.title, "<b>Hi</b>");
  assert.deepEqual(slides[0]!.paragraphs, ["<script>x()</script>"]);
});

test("an image is kept only when its bytes are a raster image", () => {
  const xml = `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="i1"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`;
  const bytes = deck([xml]);
  // Add the slide's rels and an "image" that is really SVG.
  const files: Record<string, Uint8Array> = { ...unzipSync(bytes) };
  files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
    `<Relationships xmlns="${REL}"><Relationship Id="i1" Type="${R}/image" Target="../media/a.png"/></Relationships>`,
  );
  files["ppt/media/a.png"] = strToU8('<svg onload="alert(1)"/>');
  const { slides } = parsePptx(zipSync(files));
  assert.deepEqual(slides[0]!.images, []);
});

test("slides past the cap are left for the download", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    title: `S${i + 1}`,
    body: [],
  }));
  const { slides, truncated } = parsePptx(deck(many), {
    ...OFFICE_LIMITS,
    slides: 3,
  });
  assert.deepEqual(
    slides.map((s) => s.title),
    ["S1", "S2", "S3"],
  );
  assert.equal(truncated, true);
});

test("broken, empty and hostile packages fail with a typed error", () => {
  const code = (bytes: Uint8Array) => {
    try {
      parsePptx(bytes);
      return "ok";
    } catch (error) {
      assert.ok(error instanceof PreviewError, String(error));
      return error.code;
    }
  };
  assert.equal(code(strToU8("not a zip")), "corrupt");
  assert.equal(code(zipSync({ "a.txt": strToU8("x") })), "corrupt");
  const doctype = deck([
    `<!DOCTYPE x [<!ENTITY e "boom">]><p:sld xmlns:p="${P}"/>`,
  ]);
  assert.equal(code(doctype), "corrupt");
  assert.equal(code(new Uint8Array(OFFICE_LIMITS.fileBytes + 1)), "too-large");
});

test("the worker's request runner returns the deck or a typed failure", async () => {
  const bytes = fixture("deck.pptx");
  const ok = await runPreview({
    kind: "slides",
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  });
  assert.equal(ok.ok, true);
  assert.equal(
    ok.ok && ok.result.kind === "slides" && ok.result.deck.slides.length,
    6,
  );
  const bad = await runPreview({
    kind: "slides",
    bytes: strToU8("nope").buffer as ArrayBuffer,
  });
  assert.deepEqual(bad.ok ? null : bad.code, "corrupt");
});

test("a slide list entry that points at a part that isn't a slide is skipped", () => {
  const files: Record<string, Uint8Array> = {
    ...unzipSync(deck([{ title: "Real", body: [] }])),
  };
  // A second entry whose relationship is a notes slide, not a slide.
  files["ppt/presentation.xml"] = strToU8(
    `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="s0"/><p:sldId id="257" r:id="n1"/></p:sldIdLst></p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(
    `<Relationships xmlns="${REL}"><Relationship Id="s0" Type="${SLIDE}" Target="slides/slide1.xml"/><Relationship Id="n1" Type="${R}/notesSlide" Target="slides/slide1.xml"/></Relationships>`,
  );
  const { slides } = parsePptx(zipSync(files));
  assert.deepEqual(
    slides.map((s) => s.title),
    ["Real"],
  );
});

test("a presentation with more text than the limit sends the file to Download", () => {
  const bytes = deck([{ title: "T", body: ["x".repeat(50), "y".repeat(50)] }]);
  assert.throws(
    () => parsePptx(bytes, { ...OFFICE_LIMITS, docxHtmlChars: 60 }),
    (error: unknown) =>
      error instanceof PreviewError && error.code === "too-large",
  );
  // Under the limit it reads.
  assert.equal(parsePptx(bytes).slides[0]!.paragraphs.length, 2);
});

test("pictures that aren't shown don't count toward the image limit", () => {
  const files: Record<string, Uint8Array> = {
    ...unzipSync(
      deck([
        `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>` +
          Array.from(
            { length: 5 },
            (_, i) =>
              `<p:pic><p:blipFill><a:blip r:embed="i${i}"/></p:blipFill></p:pic>`,
          ).join("") +
          `</p:spTree></p:cSld></p:sld>`,
      ]),
    ),
  };
  files["ppt/slides/_rels/slide1.xml.rels"] = strToU8(
    `<Relationships xmlns="${REL}">${Array.from(
      { length: 5 },
      (_, i) =>
        `<Relationship Id="i${i}" Type="${R}/image" Target="../media/m${i}.emf"/>`,
    ).join("")}</Relationships>`,
  );
  // EMF pictures: never shown, so they must not use up the limit of 2.
  for (let i = 0; i < 5; i++)
    files[`ppt/media/m${i}.emf`] = strToU8("\u0001\u0000\u0000\u0000EMF");
  const { slides } = parsePptx(zipSync(files), { ...OFFICE_LIMITS, images: 2 });
  assert.deepEqual(slides[0]!.images, []);
});

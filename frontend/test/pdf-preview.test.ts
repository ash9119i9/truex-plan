import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PreviewError } from "../lib/office/limits.ts";
import { PDF_LIMITS, openPdf, pageScale, type Pdfjs } from "../lib/pdf.ts";
import { hasSource, isOffice, previewKind } from "../lib/tenant-files.ts";

// The PDF preview: which files get it, and the scale each page is drawn at.
// The drawing itself runs pdf.js in the browser; here pdf.js's Node build
// checks it reads the fixture.

test(".pdf is a PDF preview with no Source tab, not an Office file", () => {
  assert.equal(previewKind("guide.pdf"), "pdf");
  assert.equal(previewKind("GUIDE.PDF"), "pdf");
  assert.equal(isOffice("pdf"), false);
  assert.equal(hasSource("guide.pdf"), false);
});

test("a page fits the viewer, at the screen's density", () => {
  const a4 = { width: 595, height: 842 };
  const s = pageScale(a4, 595, 2);
  assert.equal(s.css, 1);
  assert.equal(s.pixels, 2);
  // Never wider than the page width cap.
  assert.equal(pageScale(a4, 5000, 1).css, PDF_LIMITS.pageWidth / 595);
  // A ratio under 1 still draws at least one pixel per CSS pixel.
  assert.equal(pageScale(a4, 595, 0.5).pixels, 1);
});

test("a huge page's canvas is capped by its pixel count", () => {
  const huge = { width: 14_400, height: 14_400 };
  const { pixels } = pageScale(huge, 900, 3);
  const drawn = huge.width * pixels * huge.height * pixels;
  assert.ok(
    drawn <= PDF_LIMITS.canvasPixels + 1,
    `${drawn} > ${PDF_LIMITS.canvasPixels}`,
  );
});

test("pdf.js reads the fixture's pages and text", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(
    readFileSync(new URL("./fixtures/office/brief.pdf", import.meta.url)),
  );
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
  assert.ok(doc.numPages >= 1);
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items
    .map((i) => ("str" in i ? i.str : ""))
    .join(" ");
  assert.ok(text.trim().length > 0, "page 1 has text");
  await doc.destroy();
});

// Stand-ins for pdf.js and its worker, so the preview's own stopping and
// timing rules are tested without a browser.
function fakePdfjs(open: () => Promise<unknown>) {
  return {
    getDocument: () => ({
      promise: open(),
      destroy: async () => undefined,
    }),
    PDFWorker: class {
      constructor(_options: unknown) {}
      destroy() {}
    },
  } as unknown as Pdfjs;
}
function workers() {
  const made: Array<{ terminated: number }> = [];
  const create = () => {
    const worker = {
      terminated: 0,
      terminate() {
        worker.terminated++;
      },
    };
    made.push(worker);
    return worker;
  };
  return { made, create };
}
const tooLong = (error: unknown) =>
  error instanceof PreviewError && error.code === "too-large";
const bytes = () => new ArrayBuffer(4);

test("a PDF that never opens ends as too long, and its worker is stopped", async () => {
  const w = workers();
  await assert.rejects(
    openPdf(bytes(), {
      loadPdfjs: async () => fakePdfjs(() => new Promise(() => undefined)),
      createWorker: w.create,
      timeoutMs: 30,
    }),
    tooLong,
  );
  assert.deepEqual(
    w.made.map((x) => x.terminated),
    [1],
  );
});

test("a broken PDF stops its worker", async () => {
  const w = workers();
  await assert.rejects(
    openPdf(bytes(), {
      loadPdfjs: async () =>
        fakePdfjs(() => Promise.reject(new Error("bad xref"))),
      createWorker: w.create,
    }),
    /bad xref/,
  );
  assert.deepEqual(
    w.made.map((x) => x.terminated),
    [1],
  );
});

test("each PDF gets its own worker; closing one never stops another", async () => {
  const w = workers();
  const doc = { numPages: 1, getPage: async () => ({}) };
  const deps = {
    loadPdfjs: async () => fakePdfjs(async () => doc),
    createWorker: w.create,
  };
  const a = await openPdf(bytes(), deps);
  const b = await openPdf(bytes(), deps);
  a.close();
  a.close();
  assert.deepEqual(
    w.made.map((x) => x.terminated),
    [1, 0],
  );
  b.close();
  assert.deepEqual(
    w.made.map((x) => x.terminated),
    [1, 1],
  );
});

test("a page that never finishes drawing ends as too long and stops the worker", async () => {
  const w = workers();
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 100 * scale,
    }),
    render: () => ({ promise: new Promise<void>(() => undefined) }),
    cleanup() {},
  };
  const pdf = await openPdf(bytes(), {
    loadPdfjs: async () =>
      fakePdfjs(async () => ({ numPages: 1, getPage: async () => page })),
    createWorker: w.create,
    timeoutMs: 30,
    ratio: () => 1,
  });
  const canvas = {
    width: 0,
    height: 0,
    style: { width: "" },
    getContext: () => ({}),
  } as unknown as HTMLCanvasElement;
  await assert.rejects(pdf.render(1, canvas, 100, 1), tooLong);
  assert.deepEqual(
    w.made.map((x) => x.terminated),
    [1],
  );
});

test("a long PDF's pages together stay within the total pixel budget", () => {
  const letter = { width: 612, height: 792 };
  const shown = PDF_LIMITS.pages;
  const { pixels } = pageScale(letter, 900, 3, PDF_LIMITS, shown);
  const total = shown * letter.width * pixels * letter.height * pixels;
  assert.ok(
    total <= PDF_LIMITS.totalPixels + shown,
    `${Math.round(total)} > ${PDF_LIMITS.totalPixels}`,
  );
  // One page alone keeps full density.
  assert.equal(pageScale(letter, 612, 2, PDF_LIMITS, 1).pixels, 2);
});

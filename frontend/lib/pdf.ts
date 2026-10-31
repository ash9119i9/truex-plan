import { PreviewError } from "./office/limits.ts";

// PDF previews with pdf.js: each page drawn on a canvas in the PDF's own
// colours, so the app's theme never changes how a page looks. No annotation
// or text layer is drawn, so a PDF's links, forms and scripts never reach the
// page. pdf.js is loaded only when a PDF opens. Each file gets its own pdf.js
// worker, stopped when the file closes, fails or takes too long, so a file
// that hangs pdf.js can never hold up the next one.

export const PDF_LIMITS = {
  // Pages drawn per file; the rest are left for the download.
  pages: 50,
  // Pixels per page canvas, so a huge page can't exhaust memory.
  canvasPixels: 16_777_216,
  // Pixels of all of a file's page canvases together (about 200 MB): a long
  // file's pages are drawn at a lower density instead of exhausting memory.
  totalPixels: 50_000_000,
  // A page is never drawn wider than this, in CSS pixels.
  pageWidth: 900,
  // Opening the file, and drawing any one page, stop after this.
  timeoutMs: 15_000,
};
export type PdfLimits = typeof PDF_LIMITS;

// The scale a page is drawn at: its CSS width fits the viewer (at most
// `limits.pageWidth`); its canvas has the screen's pixel density, capped by
// the per-page limit and by its share of the file's total (`pages` drawn).
export function pageScale(
  page: { width: number; height: number },
  cssWidth: number,
  ratio: number,
  limits: PdfLimits = PDF_LIMITS,
  pages = 1,
): { css: number; pixels: number } {
  const css = Math.min(Math.max(cssWidth, 1), limits.pageWidth) / page.width;
  const budget = Math.min(
    limits.canvasPixels,
    limits.totalPixels / Math.max(pages, 1),
  );
  const cap = Math.sqrt(budget / (page.width * page.height));
  return { css, pixels: Math.min(css * Math.max(ratio, 1), cap) };
}

// The parts of pdf.js used here, so tests can stand in for it.
type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: unknown; viewport: unknown }): {
    promise: Promise<void>;
  };
  cleanup(): void;
};
type PdfDocument = { numPages: number; getPage(n: number): Promise<PdfPage> };
export type Pdfjs = {
  getDocument(source: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
  PDFWorker: new (options: { port: unknown }) => { destroy(): void };
};
export type PdfWorkerPort = { terminate(): void };
export type PdfDeps = {
  loadPdfjs?: () => Promise<Pdfjs>;
  createWorker?: () => PdfWorkerPort;
  timeoutMs?: number;
  ratio?: () => number;
};

export type OpenPdf = {
  pages: number;
  // Draws page `page` of `shown` into `canvas`, fitted to `cssWidth`.
  render: (
    page: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    shown: number,
  ) => Promise<void>;
  close: () => void;
};

const loadRealPdfjs = async () =>
  (await import("pdfjs-dist")) as unknown as Pdfjs;
const startRealWorker = (): PdfWorkerPort =>
  new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
const screenRatio = () =>
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;

export async function openPdf(
  bytes: ArrayBuffer,
  {
    loadPdfjs = loadRealPdfjs,
    createWorker = startRealWorker,
    timeoutMs = PDF_LIMITS.timeoutMs,
    ratio = screenRatio,
  }: PdfDeps = {},
): Promise<OpenPdf> {
  const pdfjs = await loadPdfjs();
  const port = createWorker();
  let closed = false;
  let close = () => {
    closed = true;
    port.terminate();
  };
  try {
    // This file's own pdf.js worker: never shared, so closing it can't break
    // another file's preview.
    const worker = new pdfjs.PDFWorker({ port });
    const task = pdfjs.getDocument({
      // A copy: pdf.js hands its data to the worker, detaching the buffer.
      data: new Uint8Array(bytes.slice(0)),
      worker,
      // No font program compiled with eval, and no XFA forms.
      isEvalSupported: false,
      enableXfa: false,
    });
    close = () => {
      if (closed) return;
      closed = true;
      // Terminating the worker stops a pdf.js loop that pdf.js's own cancel
      // message can't interrupt.
      port.terminate();
      worker.destroy();
      task.destroy().catch(() => undefined);
    };
    const doc = await bounded(task.promise, timeoutMs, close);
    return {
      pages: doc.numPages,
      async render(number, canvas, cssWidth, shown) {
        const page = await bounded(doc.getPage(number), timeoutMs, close);
        const base = page.getViewport({ scale: 1 });
        const scale = pageScale(base, cssWidth, ratio(), PDF_LIMITS, shown);
        const viewport = page.getViewport({ scale: scale.pixels });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.round(base.width * scale.css)}px`;
        const context = canvas.getContext("2d");
        if (!context)
          throw new PreviewError(
            "too-large",
            "The page is too large to preview.",
          );
        await bounded(
          page.render({ canvasContext: context, viewport }).promise,
          timeoutMs,
          close,
        );
        page.cleanup();
      },
      close: () => close(),
    };
  } catch (error) {
    close();
    throw error;
  }
}

// `work`, or a "took too long" failure after `ms`, which first calls
// `onTimeout` so the stuck work is stopped.
function bounded<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(
        new PreviewError("too-large", "The file took too long to preview."),
      );
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

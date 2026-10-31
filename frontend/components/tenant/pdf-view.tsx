"use client";
import { useEffect, useRef, useState } from "react";
import { PDF_LIMITS, openPdf, type OpenPdf } from "@/lib/pdf";

// A PDF in the file viewer: its pages, in order, drawn by pdf.js in the
// PDF's own colours (lib/pdf.ts). The page canvases are added to their own
// element, which React never renders into, and freed when the file closes.
export function PdfView({
  bytes,
  onDownload,
}: {
  bytes: ArrayBuffer;
  onDownload?: (() => void) | null;
}) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    "loading" | "unreadable" | { pages: number; shown: number }
  >("loading");

  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;
    let cancelled = false;
    let pdf: OpenPdf | undefined;
    setState("loading");
    (async () => {
      try {
        pdf = await openPdf(bytes);
        if (cancelled) return pdf.close();
        const shown = Math.min(pdf.pages, PDF_LIMITS.pages);
        setState({ pages: pdf.pages, shown });
        const width = host.clientWidth || 640;
        for (let n = 1; n <= shown && !cancelled; n++) {
          const canvas = document.createElement("canvas");
          canvas.className = "fv-pdf-page";
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `Page ${n} of ${pdf.pages}`);
          host.appendChild(canvas);
          await pdf.render(n, canvas, width, shown);
        }
      } catch {
        if (cancelled) return;
        pdf?.close();
        freeCanvases(host);
        setState("unreadable");
      }
    })();
    return () => {
      cancelled = true;
      pdf?.close();
      freeCanvases(host);
    };
  }, [bytes]);

  return (
    <div className="fv-pdf">
      {state === "loading" && (
        <p className="fv-note" role="status">
          Loading the preview…
        </p>
      )}
      {state === "unreadable" && (
        <div className="fv-note">
          <p>This file couldn&apos;t be read for a preview.</p>
          {onDownload && (
            <button type="button" className="tx-btn" onClick={onDownload}>
              Download it
            </button>
          )}
        </div>
      )}
      <div ref={pagesRef} className="fv-pdf-pages" />
      {typeof state === "object" && state.pages > state.shown && (
        <p className="fv-note">
          The preview shows the first {state.shown} of {state.pages} pages.
          Download the file to see the rest.
        </p>
      )}
    </div>
  );
}

// Zero-sized canvases release their pixel memory at once, not at the next
// garbage collection.
function freeCanvases(host: HTMLElement) {
  for (const canvas of host.querySelectorAll("canvas")) {
    canvas.width = 0;
    canvas.height = 0;
  }
  host.replaceChildren();
}

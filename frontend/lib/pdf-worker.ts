// The pdf.js worker (lib/pdf.ts starts it once): parses PDF bytes off the
// page's thread. Imported for its side effect: it listens on this worker.
import "pdfjs-dist/build/pdf.worker.min.mjs";

# Implementation Plan: Office file preview

Idea: [docs/ideas/office-file-preview.md](../docs/ideas/office-file-preview.md) · Tasks: [office-preview-todo.md](office-preview-todo.md)

## Overview

The file viewer (`frontend/components/tenant/file-viewer.tsx`) previews PDF, Word, Excel and PowerPoint files that agents make, inside the Activity panel and in the floating fallback. The work is frontend only. The browser already has the file bytes (`cachedFileContent`), and the viewer only needs new renderers. No platform-next, runtime-adapter or sandbox changes.

## Architecture Decisions

- **One new kind per format.** `previewKind` (`frontend/lib/tenant-files.ts`) gains `pdf`, `docx`, `sheet` and `slides`. `useFileContent` loads them as bytes (`ArrayBuffer`), not text. They have no Source tab, and `hasSource` stays false for them.
- **Parse in a Web Worker and return plain data.** One module worker (`frontend/lib/office/worker.ts`) unzips and parses `.docx`, `.xlsx` and `.pptx` and posts back plain objects:
  - `{ sheets: [{ name, rows, formulas, truncated }] }`
  - `{ html }`
  - `{ slides: [{ title, blocks, images }] }`
  
  React renders them. No HTML from a parser reaches the page directly. Word HTML goes only into the existing sandboxed frame (`sandboxedHtml`: no scripts from the network, `img-src data:`). The viewer stops the worker after a timeout or when the file changes.
- **Parsers are pure and testable in Node.** `lib/office/{zip,xml,xlsx,pptx}.ts` take bytes and return data, with no DOM. That lets `node --test` run them against fixtures, and the same code runs in the worker. Node has no `DOMParser`, and neither does a worker, so the tests show the parsers don't depend on one.
- **Our own small parsers for Excel and PowerPoint.** These run over `fflate` (MIT, no dependencies) and an XML parser that works without a DOM. Task 2 picks the XML parser. mammoth handles Word. pdf.js handles PDF.
  - SheetJS is rejected: the npm copy, 0.18.5, has known security issues (CVE-2023-30533, CVE-2024-22363).
  - exceljs is rejected: it's Node-first, and its last release was in 2024.
- **Limits enforced before and during unzipping.** These are set in `lib/office/limits.ts`:
  - File size
  - Number of zip entries
  - Unzipped size for each entry and for the whole file
  - Rows and columns, reusing the CSV caps
  - Slides and images
  - Time
  
  Going over a limit gives the existing "too large to preview" message. Any parse failure gives "can't be previewed" with a Download button. Neither crashes.
- **Libraries load on demand.** Each library is imported dynamically when a file of its type opens. The chat route's First Load JS must not grow. Task 9 measures this.
- **Formulas without a saved value show the formula.** This is because openpyxl saves no results. Recalculating in the sandbox is a separate, later idea.
- **Read the Next 16 docs first.** Before Tasks 2 and 6, read the docs in `frontend/node_modules/next/dist/docs/` on module workers (`new Worker(new URL(..., import.meta.url))`) and on how pdf.js's worker file gets bundled (`frontend/AGENTS.md`).

## Task List

### Phase 0: Risk first
- [ ] Task 1: Fixtures from the pinned toolchain
- [ ] Task 2: Bounded unzip and worker XML parsing (spike)

### Phase 1: Excel (exact)
- [ ] Task 3: `.xlsx` parser
- [ ] Task 4: Sheet preview in the viewer, through the worker

### Checkpoint A: one format end to end

### Phase 2: Word and PDF
- [ ] Task 5: `.docx` preview with mammoth in the sandboxed frame
- [ ] Task 6: PDF preview with pdf.js

### Phase 3: PowerPoint
- [ ] Task 7: `.pptx` parser
- [ ] Task 8: Slide cards in the viewer

### Checkpoint B: all four formats

### Phase 4: Prove it
- [ ] Task 9: Hostile files, timing and bundle size

### Checkpoint C: complete

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A zip bomb or a huge XML part freezes or crashes the tab | High | Parse in a worker. Cap unzipped size while streaming, before allocating. Stop the worker on timeout. Task 9 runs hostile fixtures. |
| Word HTML or slide text runs script in the app | High | Word HTML goes only through `sandboxedHtml`. Slides and sheets are rendered by React as text. Image URLs are only `blob:`/`data:` made from bytes we checked. |
| A preview library bloats the chat route | Med | Dynamic import per format, measured with `next build` in Task 9. |
| pdf.js's worker doesn't bundle with Turbopack | Med | Read the Next docs before Task 6. If bundling fails, fall back to copying the worker file into `public/` with a version check. |
| Agent spreadsheets show formulas, not numbers | Med | Shown on purpose and marked as formulas. Recalculating in the sandbox is tracked as a separate idea. |
| Excel dates and numbers look wrong | Med | Format codes are handled for common built-ins (general, 0, 0.00, %, dates, times). Anything else shows the raw value. Tested with fixtures. |
| Uploaded files use the same path and are messier | Med | Same worker and limits. Failures fall back to Download. Upload quality isn't a target in v1. |

## Open Questions

- Final file size and unzipped size limits. Starting values are 20 MB and 100 MB, adjusted with Task 9's timings.
- Should rows and columns beyond the cap get a "show more" button, or keep the current "download for the whole file" note? The plan keeps the note.

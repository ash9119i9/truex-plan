# Office file preview

## Problem Statement

How might we let people read the PDF, Word, Excel and PowerPoint files an agent makes inside the Activity panel, without leaving the chat or changing the agent?

## Recommended Direction

Preview in the browser only. The file already reaches the browser when someone opens it (`cachedFileContent` in `lib/tenant-files.ts`), so this is a frontend change: no platform-next, runtime-adapter or sandbox work. Each format gets one renderer that turns the file into something the viewer already knows how to show:

| Format | Renderer | Shown as |
|---|---|---|
| PDF | pdf.js (`pdfjs-dist`, Apache-2.0) | All pages, drawn to canvas, scripting off |
| Word (`.docx`) | mammoth (BSD-2) → HTML | The existing sandboxed frame (`sandboxedHtml`) |
| Excel (`.xlsx`) | Small parser over fflate (MIT, no deps) | The existing `CsvGrid`, with sheet tabs |
| PowerPoint (`.pptx`) | Small parser over fflate | One card per slide: title, text, tables, images |

Excel is the bar to meet exactly: every sheet, every cell value, in sheet order. One gap is known. openpyxl, which the agent uses (`runtime-adapter/toolchain/requirements.in`), saves a formula such as `=SUM(B2:B9)` with no result, and Excel only calculates it on open. A cell with a formula and no saved value shows the formula, marked as a formula, instead of a blank. Word and PowerPoint aim for readable content, not layout: slide design, themes, charts and page breaks are lost.

Every renderer loads only when a file of its type opens, so the chat's JavaScript does not grow. Unzipping and parsing run in a Web Worker with limits on file size, unzipped size and time, so a broken or hostile file stalls the worker, not the tab. Agent files count as untrusted: a document the agent read can steer what it writes.

Claude does the same split. Its file skills (anthropics/skills, `xlsx` and `pptx`) fix formula values and render slides inside the sandbox, and the chat itself only offers a download. We keep fidelity work out of the viewer the same way, and recalculating spreadsheets in the sandbox stays a separate, later improvement.

## Key Assumptions to Validate

- [ ] **Agent files are simple.** python-docx, openpyxl, python-pptx and reportlab write a small, predictable part of each format. Test: generate a fixture set with the pinned toolchain from realistic prompts (report, invoice sheet with formulas, 8-slide deck, multi-page PDF) and check each renderer against it.
- [ ] **XML can be parsed in a worker.** `DOMParser` does not exist in Web Workers. mammoth brings `@xmldom/xmldom`. The Excel and PowerPoint parsers need the same or a SAX parser. Test: a spike that parses a fixture's `sheet1.xml` in a worker.
- [ ] **Previews are fast enough.** A 5 MB workbook or a 30-slide deck renders in under 2 s on a laptop. Test: time each fixture in the worker.
- [ ] **The chat route doesn't grow.** Test: compare the chat route's First Load JS before and after with `next build`.
- [ ] **The app's CSP allows workers.** `next.config.ts` sets only `frame-src`, `object-src` and `base-uri`, so same-origin workers and blob URLs load. Re-check if the CSP is tightened.
- [ ] **Uploads are safe on the same path.** Uploads open in the same viewer (`SentFiles` in `chat-transcript.tsx`), so they will use these renderers too. We test only agent files. The worker, the limits and the sandboxed frame are what keep a hostile upload contained.

## MVP Scope

In:
- PDF, `.docx`, `.xlsx`, `.pptx` preview in the file viewer, both inside the Activity panel and in the floating fallback.
- Excel: sheet tabs, values, dates and numbers as Excel would show them for common formats, formulas shown where there's no saved value, and the existing row and column caps with a "download for the whole file" note.
- PowerPoint: slides in order, with title, text, bullets, tables and images.
- Limits: refuse to preview over a set file size or unzipped size, with the existing "too large to preview" and "Download it" fallback. Any parse failure falls back the same way.
- Fixtures made with the pinned toolchain, and tests for each renderer, its limits and its failures.

Out: everything in Not Doing.

## Not Doing (and Why)

- **Server or sandbox conversion (LibreOffice).** Out of scope by decision. It adds hundreds of MB and seconds per file, and the browser already has the file.
- **Calculating formulas in the browser.** Formula engines are large or restrictively licensed. Showing the formula is honest and cheap.
- **Slide design, themes, charts and SmartArt.** No browser renderer does this reliably. Readable content first.
- **Legacy formats (`.doc`, `.xls`, `.ppt`).** The agent can't write them.
- **SheetJS from npm.** The npm copy (0.18.5) is stale, with known prototype-pollution (CVE-2023-30533) and ReDoS (CVE-2024-22363) issues. The fixed builds are only on SheetJS's own CDN.
- **exceljs.** Last published 2024-12, and its dependencies (`archiver`, `tmp`, `unzipper`) are Node-first.
- **Editing in the preview.** The viewer is read-only.
- **Tuning for uploaded files.** Uploads get the same preview, but messy real-world files aren't a target yet.
- **Version diffs and "ask about this cell".** Later. The structured output (rows, slides) leaves room for both.

## Open Questions

- Size limits: 20 MB per file, matching the upload limit, and 100 MB unzipped? Pick these after the timing test.
- PDF: pdf.js (consistent everywhere, about 1 MB loaded on demand) or the browser's built-in viewer (free, but the sandboxed frame blocks it, and iOS Safari shows only the first page)? This plan assumes pdf.js.
- Should the floating fallback panel (window at or below 1080px) get these previews in v1, or only the Activity panel? This plan assumes both, because the viewer component is shared.

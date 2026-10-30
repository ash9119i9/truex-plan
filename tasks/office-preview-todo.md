# Todo: Office file preview

Plan: `tasks/office-preview-plan.md` · Idea: `docs/ideas/office-file-preview.md`

Standard checks: `npm --prefix frontend test`, `npm --prefix frontend run typecheck`, `npm --prefix frontend run build`. Root `npm test` is not evidence. Two tests were already failing before this work: "every component is reachable from a route" (`agent-avatar.tsx`) and "system CSS copies match" (`type.css`). They are not caused by these tasks and must not get worse.

---

## Phase 0: Risk first

## Task 1: Fixtures from the pinned toolchain

**Description:** A script that writes the test files the way the agent does, using the pinned sandbox libraries (`runtime-adapter/toolchain/requirements.in`: python-docx, openpyxl, python-pptx, reportlab, pillow). It writes small, realistic agent files and a few broken ones, and the output is committed.

**Acceptance criteria:**
- [x] `frontend/scripts/office-fixtures.py` writes the following to `frontend/test/fixtures/office/`:
  - `report.docx`: headings, bullets, a table, an image
  - `invoice.xlsx`: 2 sheets, strings, numbers, a date, a percent, a boolean, `=SUM` and `=B2*C2` formulas with no saved values
  - `deck.pptx`: 6 slides with a title, bullets on 2 levels, a table and an image
  - `brief.pdf`: 3 pages
- [x] The broken set: `truncated.xlsx` (cut in half), `notzip.docx` (text with a `.docx` name), and `bomb.xlsx` (a 150 MB part, past the 100 MB unzipped limit, that compresses to 150 KB, written by streaming).
  - Changed from "1 GB+ part under 1 MB": a 1 GB part compresses to about 1 MB, which breaks the 200 KB fixture limit below. 150 MB is enough to cross the 100 MB limit.
- [x] Every fixture is under 200 KB. The script's header says how to run it with `.runtime/toolchain/python/bin/python3`.

**Verification:**
- [ ] Running the script twice gives files that open in Excel, Word, PowerPoint or Preview (manual check, once).
  - Ran twice. Each run reopens every good fixture with the library that wrote it (`check()` in the script). Opening them in Office or Preview is still to do by hand.

**Findings (2026-10-30), for Tasks 3 and 7:**
- openpyxl 3.1.5 writes no `xl/sharedStrings.xml`. Every text cell is `t="inlineStr"` with `<is><t>…</t></is>`. The parser must read inline strings, not only shared ones.
- openpyxl saves a formula as `<f>B2*C2</f><v></v>`: an empty `<v>`, not a missing one. "No saved value" means missing or empty.
- Numbers are written with `t="n"`, booleans with `t="b"`. The date is serial `46325` with style `s="1"` (`yyyy-mm-dd`). The percent is `0.2` with `s="2"` (`0%`).
- python-pptx depends on xlsxwriter (for chart data), which does write shared strings and saves formula results as `0`. A workbook written with xlsxwriter would show `0` in formula cells, not the formula.

**Dependencies:** None

**Files likely touched:** `frontend/scripts/office-fixtures.py`, `frontend/test/fixtures/office/*`

**Estimated scope:** Small

## Task 2: Bounded unzip and worker XML parsing (spike)

**Description:** `lib/office/zip.ts` reads a zip with fflate. It reads only the entries it's asked for and stops the moment an entry, the entry count or the total unzipped size goes over its limit. `lib/office/xml.ts` parses XML with no DOM. Pick `@xmldom/xmldom` (which mammoth already brings in) or `saxes` after measuring both on `invoice.xlsx`'s sheet XML. Also show that a module worker loads under Next 16 and Turbopack.

**Acceptance criteria:**
- [x] `bomb.xlsx` is refused once the unzipped size passes its limit, without allocating the full part. A test checks peak memory, or the bytes read, during the refusal.
  - Its part declares 150 MB, so it's refused on the declared size with 0 bytes inflated. A second test declares 1 KB for 8 MB of data: inflating stops just past 1 KB.
- [x] `truncated.xlsx` and `notzip.docx` reject with a typed `PreviewError` (`"corrupt"`), and never with an uncaught exception.
- [x] The decision on the XML parser, with its timing and size, is written under this task.
- [x] A throwaway page or test shows a worker created with `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })` loads in `next dev` and `next build`. What was learned is noted here.

**Findings (2026-10-30):**
- **XML parser: saxes 6.0.0 (ISC, one dependency, xmlchars).** Measured on a 30.8 MB sheet (50,000 rows × 10 inline-string cells) in Node 24:

  | Parser | Time | Extra heap | min+gzip |
  |---|---|---|---|
  | saxes | 384 ms (462 ms with namespaces on) | 85 MB | 8.1 KB |
  | @xmldom/xmldom 0.9.12 | 7,653 ms | 2,238 MB | 30.8 KB |

  xmldom builds the whole tree, so a large sheet could exhaust the worker's memory. saxes streams. Its last release was 2022, but it is small and has no open advisories that I found. `parseXml` rejects any DOCTYPE, so entity-expansion attacks are refused as corrupt.
- **Unzip: fflate 0.8.3 (MIT, no dependencies).** `openZip` reads the central directory and inflates only the parts asked for, in 1 KB pieces. It stops as soon as the output passes the part's declared size, so a lying header can't make it allocate more. Zip64, encrypted parts and unknown compression methods are "unsupported".
- **Worker under Next 16 and Turbopack:** `new Worker(new URL("../../../lib/office/worker-probe.ts", import.meta.url), { type: "module" })` from a client page ran the unzip and XML code with no DOM (`DOMParser` undefined) in `next dev` and in `next build` + `next start`, loaded in headless Chrome. No config was needed, and the app's CSP allows it. The build also copied the probe's raw `.ts` source into `.next/static/media/` next to the compiled chunk. The worker ran the compiled chunk. Check in Task 4 whether the real worker's source is copied too: it's our own client code, so this isn't a secret, but it's a duplicate asset. The probe page and module are removed.

**Verification:**
- [x] `npm --prefix frontend test -- test/office-zip.test.ts`, then typecheck.

**Dependencies:** 1

**Files likely touched:** `frontend/lib/office/zip.ts`, `frontend/lib/office/xml.ts`, `frontend/lib/office/limits.ts`, `frontend/test/office-zip.test.ts`, `frontend/package.json`

**Estimated scope:** Medium

## Phase 1: Excel (exact)

## Task 3: `.xlsx` parser

**Description:** `lib/office/xlsx.ts` turns workbook bytes into `{ sheets: [{ name, rows, formulas, truncated }] }`. It reads the following parts:
- `workbook.xml` and its rels, for sheet order and names, with hidden sheets marked
- `sharedStrings.xml`, including rich-text runs
- `styles.xml`, for number formats
- Each sheet's cells: shared strings, inline strings, numbers, booleans, errors, and dates using the workbook's 1900 or 1904 date system

A cell with a formula and no saved value is listed in `formulas` and shows the formula text.

**Acceptance criteria:**
- [x] Every value in `invoice.xlsx` matches what openpyxl reports for each cell (the expected values are kept with the fixture). The date and percent cells are formatted like Excel shows them.
- [x] Formula cells come back as `=SUM(...)` text and are marked. Sparse cells (`A1`, `D7`) land in the right row and column.
- [x] Rows and columns past the CSV caps set `truncated`. Malformed XML gives `PreviewError("corrupt")`.

**Verification:**
- [x] `npm --prefix frontend test -- test/office-xlsx.test.ts`, then typecheck.

**Notes (2026-10-30):**
- The parser was written with its tests, so the tests passed on their first run. To check they catch bugs, 9 behaviours were broken one at a time: formulas shown blank, no row cap, no column cap, phonetic hints read as text, 1904 dates ignored, hidden sheets not marked, sparse rows collapsed, no 1900 leap-day quirk, negative format section ignored. Each made at least one test fail.
- Number formats live in `lib/office/number-format.ts`: built-in ids, fixed decimals, grouping, thousands scaling, percent, scientific, currency brackets, quoted text, colours, dates, 12/24-hour times and elapsed time. Fractions (`# ?/?`) and conditions (`[>100]`) fall back to General.
- Relationship lookup is shared in `lib/office/package.ts` for Task 7. Targets that leave the package (`../../x`) or are external are dropped.

**Dependencies:** 2

**Files likely touched:** `frontend/lib/office/xlsx.ts`, `frontend/test/office-xlsx.test.ts`, `frontend/test/fixtures/office/invoice.expected.json`

**Estimated scope:** Medium

## Task 4: Sheet preview in the viewer, through the worker

**Description:** Connect the worker (`lib/office/worker.ts`) to a client function, `parseInWorker(kind, bytes, { timeoutMs })`, that stops the worker on timeout or abort. Add the `sheet` kind to `previewKind`. `useFileContent` loads Office files as bytes, applying the file size limit first. Then show the result in `FileViewer`:
- Sheet tabs, using the existing `Tabs` component
- A grid adapted from `CsvGrid`
- Formula cells styled differently, with a tooltip saying "Formula, calculated when opened in Excel"

**Acceptance criteria:**
- [ ] Opening `invoice.xlsx` in the Activity panel shows both sheets with the right values, and switching tabs works with mouse and keyboard.
  - Partly shown. Render tests show both sheet tabs and every value. The real worker in headless Chrome returned both sheets (`Invoice` with `=SUM(D2:D4)`, `Notes`). Not yet opened in the live Activity panel, which needs a signed-in chat. Keyboard switching comes from the shared `Tabs` component and isn't tested here. Left for the user's final test.
- [ ] Changing files or closing the viewer while a file is parsing stops its worker, so no stale result appears.
  - Partly shown. Client tests show aborting stops the worker, ignores a late answer, and starts no worker once aborted. The viewer aborts in its effect cleanup, but no test runs that effect (the repo's component tests render on the server only).
- [ ] A timeout, a limit or a corrupt file shows the existing message and the Download button. `typeName`, `fileTag` and `hasSource` are correct for `.xlsx`.
  - Partly shown. `typeName`, `fileTag` and `hasSource` are tested. The worker returns typed failures for corrupt and over-limit files, and the client turns a timeout into "too-large". The viewer's "too large" and "couldn't be read" messages aren't render-tested.

**Verification:**
- [x] `npm --prefix frontend test`, typecheck and build pass. (819/820; the one failure is the `type.css` test that failed before this work.)
- [x] Server-render tests of the sheet view, following the `test/next-details-runtime.ts` pattern.
- [ ] Manual check: open an agent-made `.xlsx` in the Activity panel and in the floating fallback (window narrower than 1080px).

**Notes (2026-10-30):**
- Breaking the client's stop rules one at a time (never stopping the worker, ignoring abort, starting after abort) made tests fail each time.
- The build copies the worker's own source to `.next/static/media/worker.<hash>.ts`, next to the compiled chunk. It's only the 9-line wiring file with its comments, not the parsers, and holds nothing secret. Left as is.
- Headless Chrome probe: on every run that finished, the results were right. Some runs still showed "waiting", most likely because Chrome saved the page at its load event, before the fetch and worker finished. Not proven.

**Dependencies:** 3

**Files likely touched:** `frontend/lib/office/worker.ts`, `frontend/lib/office/client.ts`, `frontend/lib/tenant-files.ts`, `frontend/components/tenant/file-viewer.tsx`, `frontend/styles/app/viewer.css`

**Estimated scope:** Medium

### Checkpoint A: one format end to end
- [x] All standard checks pass. The two failures from before are unchanged. (The `agent-avatar.tsx` failure has since cleared, after changes outside this work; the `type.css` failure remains.)
- [ ] Spreadsheets preview from both the chat card and the Activity panel's Files tab.
- [ ] Review with the user before Phase 2.
  - Deferred: the user asked for every task to be built and tested, and will test everything at the end.

## Phase 2: Word and PDF

## Task 5: `.docx` preview with mammoth in the sandboxed frame

**Description:** The worker runs mammoth's `convertToHtml`, with images as data URLs (capped by the image limits). The viewer shows the HTML through `sandboxedHtml`, with a small style sheet so headings, lists and tables read well in light and dark themes. Add the `docx` kind.

**Acceptance criteria:**
- [ ] `report.docx` shows its headings, bullets, table and image.
  - Partly shown. The HTML has both headings, the 3 bullets, the table and the PNG as a `data:` URL, and the render test shows `DocView` puts it in the frame. Not yet seen in a browser frame or the live Activity panel. Left for the user's final test.
- [x] A `<script>` or `onerror=` in the document's text appears as text, never runs, and fetches nothing. The frame's CSP allows `img-src data:` only.
  - Text is escaped. The frame has `sandbox=""` (no scripts at all, unlike the HTML preview's `allow-scripts`). Its policy is exactly `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. An SVG or other non-raster image is left out.
  - This box was first ticked too early: links in footnotes and endnotes kept their `href`, so a click in the frame could send a same-origin GET to the app. Hardening found it and it is fixed: every `<a>` is now removed from the HTML, in the body, notes and comments, including mammoth's own note anchors.
- [ ] Corrupt files, oversized images and timeouts fall back to Download.
  - Partly shown. `notzip.docx`, a cut-off file, a zip with no document and any DOCTYPE give `"corrupt"`. Too many images, one over 5 MB, or over 20 MB in all give `"too-large"`. The viewer already maps these to its Download messages, and Task 4's client tests cover the timeout. As in Task 4, the viewer's messages aren't render-tested.

**Verification:**
- [x] `npm --prefix frontend test -- test/office-docx.test.ts`, typecheck and build pass. (13/13 docx tests; full suite 832/833, the one failure is the `type.css` test that failed before this work.)
- [ ] Manual check in both themes.

**Notes (2026-10-30):**
- Every part goes through the bounded `openZip` first and is re-zipped uncompressed (`level: 0`) for mammoth, so mammoth's own JSZip never inflates anything we haven't size-checked. mammoth's embedded style maps and external file access are off.
- mammoth catches an image converter's error and just leaves the image out, so a limit is remembered and thrown after the conversion.
- The page reads as white paper in both themes, as Word shows it.
- Breaking each protection one at a time (no unlinking, SVG allowed, image limit swallowed, total image limit off, DOCTYPE check off) made a test fail each time.
- `runPreview` is now async, because mammoth is. The worker awaits it, and the Task 4 sheet tests now await it too.
- Hardening (2026-10-30), after a fresh-context attack on the change. Fixed, each with a test seen failing first:
  - A zip part named `__proto__` set the parts object's prototype, and fflate then zipped one entry per byte, past `openZip`'s entry limit. A 1.3 KB file used about 2.7 GB. Now refused as corrupt.
  - Links in footnotes and endnotes kept their address (see the box above).
  - The DOCTYPE check looked only at `.xml` and `.rels` names, but the package's rels can point at any name. Every part is checked now.
  - Word HTML had no size cap. `docxHtmlChars` (5 MB, image data not counted) now gives "too-large".
  - Pinned as tests: 200,000 nested revisions give corrupt; images in footnotes count toward the image limit; an external image is never fetched; anchor and field links become text.
  - 10 mutations of the guards, each caught by a test. The 21 Word tests passed 5 runs in a row.
  - mammoth 1.13 doesn't read `w:fldSimple`, so a simple field's text is lost from the preview. Download still has it.
- Risk for Task 9: mammoth parses with `@xmldom/xmldom`, which builds the whole tree. Task 2 measured 2.2 GB of heap for a 30 MB sheet, and one Word part may be up to 64 MB. That stays inside the worker: a crash shows "couldn't be read" and the 15 s timeout still stops it. Task 9 should measure a large `document.xml` and probably lower `entryBytes` for Word. The new HTML cap applies only after parsing, so it doesn't bound this memory. The attack measured 300,000 short paragraphs (about 10 MB of XML) at about 1.4 GB.
- Not tested in a browser yet: the platform browser fixture has uploads off, so a `.docx` can't be attached in the signed-in chat. Left for the user's final test.

**Dependencies:** 4 (worker and client)

**Files likely touched:** `frontend/lib/office/docx.ts`, `frontend/lib/office/worker.ts`, `frontend/components/tenant/file-viewer.tsx`, `frontend/test/office-docx.test.ts`

**Estimated scope:** Small

## Task 6: PDF preview with pdf.js

**Description:** Add the `pdf` kind. Import `pdfjs-dist` dynamically, using its own worker, with `isEvalSupported: false` and scripting, XFA and font downloading off. Draw each page to a canvas as it scrolls into view, so a 300-page PDF doesn't draw every page. Show "Page N of M" and cap the number of pages drawn.

**Acceptance criteria:**
- [ ] `brief.pdf` shows all 3 pages, sharp on high-resolution screens. Pages fit the panel's width at 360px and 560px.
- [ ] Changing files stops loading and drawing, and frees the canvases.
- [ ] An encrypted or corrupt PDF falls back to Download with a clear message.

**Verification:**
- [ ] typecheck and build pass. The chat route's First Load JS is unchanged (pdf.js is loaded only on demand).
- [ ] Manual check: a 100-page PDF scrolls smoothly.

**Dependencies:** 4

**Files likely touched:** `frontend/lib/office/pdf.ts`, `frontend/components/tenant/pdf-view.tsx`, `frontend/components/tenant/file-viewer.tsx`, `frontend/styles/app/viewer.css`, `frontend/package.json`

**Estimated scope:** Medium

## Phase 3: PowerPoint

## Task 7: `.pptx` parser

**Description:** `lib/office/pptx.ts` turns deck bytes into `{ slides: [{ title, blocks, images }] }`:
- Slide order comes from `presentation.xml`'s `sldIdLst` and its rels, not from file names.
- Each slide's text frames become blocks: paragraphs with bullet level, and tables as rows.
- The title comes from the title placeholder.
- Images come from the slide's rels into `ppt/media`. They are checked by their first bytes (magic bytes) and returned as typed byte arrays.
- Speaker notes are skipped.

**Acceptance criteria:**
- [ ] `deck.pptx` gives 6 slides in order, with titles, bullet levels, the table and the image matching the fixture's expected JSON.
- [ ] An image whose bytes don't match its type is left out. A rel pointing outside the package (`../../`) is ignored.
- [ ] Slides, blocks and images over their limits set `truncated`.

**Verification:**
- [ ] `npm --prefix frontend test -- test/office-pptx.test.ts`, then typecheck.

**Dependencies:** 2

**Files likely touched:** `frontend/lib/office/pptx.ts`, `frontend/test/office-pptx.test.ts`, `frontend/test/fixtures/office/deck.expected.json`

**Estimated scope:** Medium

## Task 8: Slide cards in the viewer

**Description:** Add the `slides` kind, parsed in the worker. Show one card per slide, with a slide number, the title as a heading, then bullets, tables and images. Image blob URLs are revoked when the file changes.

**Acceptance criteria:**
- [ ] `deck.pptx` reads top to bottom in the Activity panel at both widths. Slide headings form a heading outline screen readers can navigate.
- [ ] No blob URLs are left behind after switching files (tested by counting created and revoked URLs).
- [ ] Failures fall back to Download.

**Verification:**
- [ ] `npm --prefix frontend test`, typecheck and build pass. Server-render tests of the slide cards.

**Dependencies:** 4, 7

**Files likely touched:** `frontend/components/tenant/slide-view.tsx`, `frontend/components/tenant/file-viewer.tsx`, `frontend/lib/office/worker.ts`, `frontend/styles/app/viewer.css`

**Estimated scope:** Medium

### Checkpoint B: all four formats
- [ ] All standard checks pass.
- [ ] Each fixture previews from the chat card and from the Files tab, in both themes.
- [ ] Review with the user.

## Phase 4: Prove it

## Task 9: Hostile files, timing and bundle size

**Description:** Measure the risks the plan relies on and write the numbers down. Then set the final limits from them.

**Acceptance criteria:**
- [ ] `bomb.xlsx`, `truncated.xlsx`, `notzip.docx`, a 50,000-row sheet and a 200-slide deck each end in a preview or a fallback within the time limit, and the tab never freezes. The worker is stopped on timeout.
- [ ] Measured in the worker on a laptop and recorded here: parse time for a 5 MB workbook and a 30-slide deck, and first-page time for a 100-page PDF.
- [ ] The chat route's First Load JS from `next build` is recorded before and after the work, and shows no growth.
- [ ] The limits in `lib/office/limits.ts` are set from these numbers, and the plan's open question about limits is answered.

**Verification:**
- [ ] `npm --prefix frontend test`, typecheck and build pass. Numbers are recorded under this task.

**Dependencies:** 5, 6, 8

**Files likely touched:** `frontend/test/office-limits.test.ts`, `frontend/lib/office/limits.ts`, `frontend/scripts/office-fixtures.py`

**Estimated scope:** Small

### Checkpoint C: complete
- [ ] Every acceptance criterion in `docs/ideas/office-file-preview.md`'s MVP scope is met.
- [ ] Final diff reviewed, remaining risks stated, ready for review.

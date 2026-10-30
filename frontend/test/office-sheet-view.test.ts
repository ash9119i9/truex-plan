import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInWorker, type PreviewWorker } from "../lib/office/client.ts";
import { runPreview } from "../lib/office/run.ts";
import { PreviewError } from "../lib/office/limits.ts";
import { parseXlsx } from "../lib/office/xlsx.ts";
import {
  fileTag,
  hasSource,
  isOffice,
  previewKind,
  typeName,
} from "../lib/tenant-files.ts";
import { component } from "./next-details-runtime.ts";

// The sheet preview through the worker (tasks/office-preview-todo.md, Task 4).
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/office/${name}`, import.meta.url));
const bytesOf = (name: string) => {
  const buffer = fixture(name);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.length,
  );
};

// A worker that answers with `respond`, or never when it returns undefined.
function fakeWorker(
  respond: (worker: PreviewWorker & { emit: (data: unknown) => void }) => void,
) {
  const state = { started: 0, terminated: 0, posted: [] as unknown[] };
  const createWorker = () => {
    state.started++;
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(message: unknown) {
        state.posted.push(message);
        queueMicrotask(() => respond(worker));
      },
      terminate() {
        state.terminated++;
      },
      emit(data: unknown) {
        worker.onmessage?.({ data } as MessageEvent);
      },
    } as PreviewWorker & { emit: (data: unknown) => void };
    return worker;
  };
  return { state, createWorker };
}
const fails = (code: string) => (error: unknown) =>
  error instanceof PreviewError && error.code === code;

test(".xlsx is a sheet preview with no Source tab", () => {
  assert.equal(previewKind("Invoice.XLSX"), "sheet");
  assert.equal(isOffice(previewKind("a.xlsx")), true);
  assert.equal(isOffice(previewKind("a.csv")), false);
  assert.equal(hasSource("a.xlsx"), false);
  assert.equal(hasSource("a.csv"), true);
  assert.equal(typeName("a.xlsx"), "Spreadsheet");
  assert.deepEqual(fileTag("a.xlsx"), { label: "xlsx", tone: "xlsx" });
  // Legacy Excel isn't a format the agent writes: still download only.
  assert.equal(previewKind("a.xls"), "none");
});

test("the worker's request runner returns the workbook or a typed failure", async () => {
  const ok = await runPreview({
    kind: "sheet",
    bytes: bytesOf("invoice.xlsx"),
  });
  assert.equal(ok.ok, true);
  assert.equal(
    ok.ok && ok.result.kind === "sheet" && ok.result.workbook.sheets[0].name,
    "Invoice",
  );
  assert.deepEqual(
    await runPreview({ kind: "sheet", bytes: bytesOf("truncated.xlsx") }),
    {
      ok: false,
      code: "corrupt",
      message: "Not a readable file: no zip directory.",
    },
  );
  const bomb = await runPreview({ kind: "sheet", bytes: bytesOf("bomb.xlsx") });
  assert.equal(bomb.ok, false);
});

test("a worker's answer resolves and the worker is stopped", async () => {
  const workbook = parseXlsx(new Uint8Array(fixture("invoice.xlsx")));
  const { state, createWorker } = fakeWorker((w) =>
    w.emit({ ok: true, result: { kind: "sheet", workbook } }),
  );
  const bytes = bytesOf("invoice.xlsx");
  const result = await parseInWorker("sheet", bytes, { createWorker });
  assert.equal(result.kind === "sheet" && result.workbook.sheets.length, 2);
  assert.deepEqual(state, {
    started: 1,
    terminated: 1,
    posted: [{ kind: "sheet", bytes }],
  });
});

test("a worker's failure rejects with its code and the worker is stopped", async () => {
  const { state, createWorker } = fakeWorker((w) =>
    w.emit({ ok: false, code: "corrupt", message: "Not a readable file." }),
  );
  await assert.rejects(
    parseInWorker("sheet", new ArrayBuffer(4), { createWorker }),
    fails("corrupt"),
  );
  assert.equal(state.terminated, 1);
  const crashed = fakeWorker((w) => w.onerror?.({} as ErrorEvent));
  await assert.rejects(
    parseInWorker("sheet", new ArrayBuffer(4), {
      createWorker: crashed.createWorker,
    }),
    fails("unsupported"),
  );
  assert.equal(crashed.state.terminated, 1);
});

test("a worker that never answers is stopped at the timeout", async () => {
  const { state, createWorker } = fakeWorker(() => {});
  await assert.rejects(
    parseInWorker("sheet", new ArrayBuffer(4), { createWorker, timeoutMs: 20 }),
    fails("too-large"),
  );
  assert.equal(state.terminated, 1);
});

test("aborting stops the worker, and a late answer is ignored", async () => {
  let late: (() => void) | undefined;
  const { state, createWorker } = fakeWorker((w) => {
    late = () =>
      w.emit({
        ok: true,
        result: { kind: "sheet", workbook: { sheets: [], truncated: false } },
      });
  });
  const abort = new AbortController();
  const pending = parseInWorker("sheet", new ArrayBuffer(4), {
    createWorker,
    signal: abort.signal,
  });
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  abort.abort(new Error("closed"));
  await assert.rejects(pending, /closed/);
  assert.equal(state.terminated, 1);
  late?.();
  assert.equal(state.terminated, 1);
  // Already aborted: no worker starts.
  const before = state.started;
  await assert.rejects(
    parseInWorker("sheet", new ArrayBuffer(4), {
      createWorker,
      signal: abort.signal,
    }),
    /closed/,
  );
  assert.equal(state.started, before);
});

const { SheetView, columnName } = component("tenant/sheet-view.tsx");
const render = (workbook: unknown) =>
  renderToStaticMarkup(createElement(SheetView, { workbook }));

test("the sheet view shows tabs, column letters, row numbers and values", () => {
  const html = render(parseXlsx(new Uint8Array(fixture("invoice.xlsx"))));
  assert.match(html, /role="tablist" aria-label="Sheets"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Invoice/);
  assert.match(html, />Notes</);
  assert.match(html, /<th scope="col">G<\/th>/);
  assert.match(html, /<th scope="row">5<\/th>/);
  assert.match(html, /<td>Widget<\/td><td>3<\/td><td>2.5<\/td>/);
  assert.match(html, /<td>2026-10-30<\/td><td>FALSE<\/td><td>20%<\/td>/);
  assert.match(html, /role="tabpanel"/);
});

test("formula cells are marked and explained", () => {
  const html = render(parseXlsx(new Uint8Array(fixture("invoice.xlsx"))));
  assert.match(html, /4 cells show their formula instead of a value/);
  assert.match(
    html,
    /<td class="fv-formula" title="Formula[^"]*" aria-describedby="[^"]+">=SUM\(D2:D4\)<\/td>/,
  );
  assert.equal(html.match(/class="fv-formula"/g)?.length, 4);
});

test("one sheet has no tabs; empty, truncated and hidden sheets say so", () => {
  const sheet = (extra: object) => ({
    name: "Only",
    hidden: false,
    rows: [["1"]],
    formulas: [],
    truncated: false,
    ...extra,
  });
  const single = render({ sheets: [sheet({})], truncated: false });
  assert.doesNotMatch(single, /role="tab/);
  assert.match(
    render({ sheets: [sheet({ rows: [] })], truncated: false }),
    /This sheet is empty/,
  );
  assert.match(render({ sheets: [], truncated: false }), /no sheets to show/);
  assert.match(
    render({ sheets: [sheet({ truncated: true })], truncated: false }),
    /Showing the first rows and columns/,
  );
  assert.match(
    render({
      sheets: [sheet({}), sheet({ name: "B", hidden: true })],
      truncated: true,
    }),
    /B \(hidden\)[\s\S]*Showing the first 2 sheets/,
  );
});

test("column letters follow Excel past Z", () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), [
    "A",
    "Z",
    "AA",
    "AZ",
    "ZZ",
    "AAA",
  ]);
});

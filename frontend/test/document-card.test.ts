import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { documentKind } from "../lib/document-kind.ts";
import { docSize, splitName } from "../lib/tenant-files.ts";
import { component } from "./next-details-runtime.ts";

const { DocumentCard } = component("tenant/document-card.tsx");
const { FileCard, FileActionsContext } = component("tenant/file-card.tsx");
const { DraftFileChip } = component("tenant/chat-composer.tsx");

const MB = 1024 * 1024;

test("sizes follow the DocumentCard format", () => {
  assert.equal(docSize(2.4 * MB), "2.4 MB");
  assert.equal(docSize(2 * MB), "2 MB");
  assert.equal(docSize(4300), "4.2 KB");
  assert.equal(docSize(10), "0.1 KB");
  assert.equal(docSize(480 * 1024), "480 KB");
  assert.equal(docSize(1000 * 1024), "1,000 KB");
});

test("the extension stays pinned when it is short", () => {
  assert.deepEqual(splitName("quarterly-report-final.xlsx"), {
    base: "quarterly-report-final",
    ext: ".xlsx",
  });
  assert.deepEqual(splitName("README"), { base: "README", ext: "" });
  assert.deepEqual(splitName("a.verylongextension"), {
    base: "a.verylongextension",
    ext: "",
  });
});

test("an unknown type is its extension up to five letters, else File", () => {
  assert.equal(documentKind("x.dmgx").label, "DMGX");
  assert.equal(documentKind("x.abcdef").label, "File");
});

const card = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(DocumentCard, props));

test("a DocumentCard is one quiet row: kind tile, pinned name, type and size, Download", () => {
  const html = card({
    name: "Q3 forecast.xlsx",
    size: 2.4 * MB,
    state: "ready",
    onOpen() {},
    onDownload() {},
  });
  assert.match(html, /^<article class="dc"/);
  assert.match(
    html,
    /class="dc-tile" aria-hidden="true"><svg class="tx-ic"[^>]*><use href="#i-sheet"/,
  );
  assert.match(
    html,
    /<span class="dc-base">Q3 forecast<\/span><span class="dc-ext">\.xlsx<\/span>/,
  );
  assert.match(html, /class="dc-meta">Excel · 2\.4 MB</);
  assert.match(html, /aria-label="Download Q3 forecast\.xlsx"/);
  assert.doesNotMatch(html, /disabled/);
});

test("a file still being written or not saved says so with a glyph and a word", () => {
  const writing = card({
    name: "notes.md",
    size: 0,
    state: "writing",
    onOpen() {},
  });
  assert.match(writing, /class="dc is-writing"/);
  assert.match(writing, /tx-spin[\s\S]*Writing…/);
  assert.match(
    writing,
    /disabled=""[^>]*title="Not available to download yet"|title="Not available to download yet"[^>]*disabled=""/,
  );

  const unsaved = card({
    name: "notes.md",
    size: 0,
    state: "unsaved",
    onRetry() {},
  });
  assert.match(unsaved, /class="dc is-unsaved"/);
  assert.match(unsaved, /#i-alert[\s\S]*Couldn’t save this file/);
  assert.match(unsaved, /aria-label="Retry saving notes\.md"/);
});

test("a reply's files are a stack of DocumentCards", () => {
  const actions = {
    open() {},
    content: async () => new Blob(),
    download() {},
    active: null,
    retry() {},
    retryState: () => undefined,
  };
  const file = (path: string) => ({
    id: path,
    runId: "r1",
    path,
    size: 2048,
    version: 1,
    createdAt: "2026-10-28T10:00:00.000Z",
  });
  const html = renderToStaticMarkup(
    createElement(
      FileActionsContext.Provider,
      { value: actions },
      createElement(FileCard, {
        runId: "r1",
        files: [file("a.md"), file("b.csv")],
        writing: [{ path: "c.txt" }],
      }),
    ),
  );
  assert.match(
    html,
    /<section class="dc-stack" aria-label="Files from this reply">/,
  );
  assert.equal((html.match(/<article class="dc/g) ?? []).length, 3);
});

const chip = (file: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(DraftFileChip, {
      file: { key: "k", name: "brief.pdf", size: 2.4 * MB, ...file },
      removable: true,
      onRemove() {},
    }),
  );

test("an attachment chip shows uploading, ready and failed with a glyph and a word", () => {
  const up = chip({ state: "uploading" });
  assert.match(up, /<li class="ac is-uploading" role="listitem"/);
  assert.match(up, /tx-spin[\s\S]*Uploading/);
  const ready = chip({ state: "ready", uploadId: "u" });
  assert.match(ready, /class="ac-meta">PDF · 2\.4 MB</);
  const failed = chip({ state: "failed", error: "Over 25 MB" });
  assert.match(failed, /class="ac is-failed"/);
  assert.match(failed, /#i-alert[\s\S]*Upload failed · Over 25 MB/);
  assert.match(failed, /aria-label="Remove brief\.pdf"/);
});

test("file rows moved off the old stylesheet onto tokens-only CSS", () => {
  // chat-files.css lost these rules in Task 19 and was deleted in Task 32.
  const path = new URL("../styles/v2/chat-files.css", import.meta.url);
  if (existsSync(path))
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /^\.(file-card|file-row|draft-file|sent-files|sent-image|composer-files)\b/m,
    );
  assert.match(
    readFileSync(new URL("./design-system.test.ts", import.meta.url), "utf8"),
    /"styles\/app\/files\.css"/,
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { documentKind, uploadAccept } from "../lib/document-kind.ts";

test("classifies SAP code, text and office files for icons and labels", () => {
  assert.deepEqual(documentKind("zdemo.ABAP"), { kind: "code", label: "ABAP" });
  assert.deepEqual(documentKind("view.cds"), { kind: "code", label: "CDS" });
  assert.deepEqual(documentKind("page.html"), { kind: "code", label: "HTML" });
  assert.deepEqual(documentKind("notes.md"), {
    kind: "text",
    label: "Markdown",
  });
  assert.deepEqual(documentKind("data.xlsx"), {
    kind: "sheet",
    label: "Excel",
  });
  assert.deepEqual(documentKind("deck.pptx"), {
    kind: "slides",
    label: "PowerPoint",
  });
  assert.deepEqual(documentKind("archive.zip"), {
    kind: "document",
    label: "ZIP",
  });
  assert.deepEqual(documentKind("README"), { kind: "document", label: "File" });
  for (const extension of [
    "abap",
    "cds",
    "json",
    "xml",
    "yaml",
    "sql",
    "js",
    "ts",
  ])
    assert.ok(uploadAccept.split(",").includes("." + extension));
});

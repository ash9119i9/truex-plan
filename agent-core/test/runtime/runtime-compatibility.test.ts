import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../../src/runtime/client";
import { BusinessRuntime } from "../../src/runtime/business-runtime";

test("business runtime inherits the canonical client prototype", () => {
  assert.equal(
    Object.getPrototypeOf(BusinessRuntime.prototype),
    CodexClient.prototype,
  );
});

test("missing, invalid and corrupt markers preserve availability and resume errors", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "runtime-compatibility-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = new BusinessRuntime("unused-codex", home);
  mkdirSync(join(home, "business-threads"));
  writeFileSync(join(home, "business-threads", "corrupt.json"), "{");
  for (const id of ["missing", "../invalid", "corrupt"]) {
    assert.equal(client.documentToolsAvailable(id), false);
    assert.equal(client.visualizationToolsAvailable(id), false);
    assert.equal(client.tenant(id), "default");
    await assert.rejects(client.request("thread/resume", { threadId: id }), {
      status: 409,
      code: "LEGACY_SESSION",
      message: "Start a new Truex conversation",
    });
  }
});

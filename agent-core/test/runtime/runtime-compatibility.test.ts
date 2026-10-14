import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as legacyClient from "../../src/client";
import * as runtimeClient from "../../src/runtime/client";
import * as legacyRuntime from "../../src/business-runtime";
import * as runtime from "../../src/runtime/business-runtime";
import * as legacyTenancy from "../../src/tenancy";
import * as tenancy from "../../src/runtime/tenancy";
import * as legacyHistory from "../../src/history";
import * as history from "../../src/runtime/history";
import * as legacySchema from "../../src/schema";
import * as schema from "../../src/protocol/schema";
import * as legacyRequests from "../../src/requests";
import * as requests from "../../src/protocol/requests";
import * as legacyTrace from "../../src/trace";
import * as trace from "../../src/telemetry/trace";
import * as legacyRedact from "../../src/redact";
import * as redact from "../../src/telemetry/redact";

test("legacy imports preserve exports and constructor identity", () => {
  for (const [legacy, current] of [
    [legacyClient, runtimeClient],
    [legacyRuntime, runtime],
    [legacyTenancy, tenancy],
    [legacyHistory, history],
    [legacySchema, schema],
    [legacyRequests, requests],
    [legacyTrace, trace],
    [legacyRedact, redact],
  ]) {
    assert.deepEqual(Object.keys(legacy).sort(), Object.keys(current).sort());
    for (const key of Object.keys(legacy))
      assert.equal(
        (legacy as Record<string, unknown>)[key],
        (current as Record<string, unknown>)[key],
      );
  }
  assert.equal(
    Object.getPrototypeOf(runtime.BusinessRuntime.prototype),
    legacyClient.CodexClient.prototype,
  );
});

test("missing, invalid and corrupt markers preserve availability and resume errors", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "runtime-compatibility-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = new legacyRuntime.BusinessRuntime("unused-codex", home);
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

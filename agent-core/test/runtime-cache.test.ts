import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { DisabledScriptRunner } from "../src/script-runner";
import { RuntimeCache, runtimeCacheEnabled } from "../src/runtime-cache";

const enabled = (t: any, value: string | undefined) => {
  const previous = process.env.CACHE_RUNTIME_METADATA;
  if (value === undefined) delete process.env.CACHE_RUNTIME_METADATA;
  else process.env.CACHE_RUNTIME_METADATA = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CACHE_RUNTIME_METADATA;
    else process.env.CACHE_RUNTIME_METADATA = previous;
  });
};

test("runtime metadata caching is opt-in and bounded by entries and bytes", (t) => {
  enabled(t, undefined);
  assert.equal(runtimeCacheEnabled(), false);
  const cache = new RuntimeCache<string>(2, 14, 60_000);
  cache.set("a", "one", 4);
  cache.set("b", "two", 4);
  assert.equal(cache.get("a"), "one");
  cache.set("c", "three", 4);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.size, 2);
  assert.equal(cache.retainedBytes, 12);
  cache.set("huge", "oversized", 15);
  assert.equal(cache.get("huge"), undefined);
  cache.set("x".repeat(20), "a", 1);
  assert.equal(cache.get("x".repeat(20)), undefined);
  cache.set("a", "replacement", 12);
  assert.equal(cache.size, 1);
  assert.equal(cache.retainedBytes, 14);
  const expired = new RuntimeCache<string>(2, 10, 0);
  expired.set("a", "a", 1);
  assert.equal(expired.get("a"), undefined);
  assert.equal(expired.retainedBytes, 0);
  cache.clear();
  assert.equal(cache.retainedBytes, 0);
  assert.throws(() => new RuntimeCache(0, 10, 1000), /bounds/);
});

for (const flag of [undefined, "on"]) {
  test(`marker authority survives replacement, corruption and removal (cache ${flag ?? "off"})`, async (t) => {
    enabled(t, flag);
    const home = mkdtempSync(join(tmpdir(), "truex-marker-cache-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const runtime = new BusinessRuntime(
      "codex",
      home,
      undefined,
      new DisabledScriptRunner(),
    );
    mkdirSync(join(home, "business-threads"));
    const marker = join(home, "business-threads", "thread_1.json");
    const workspace = join(home, "legacy-workspace");
    writeFileSync(
      marker,
      JSON.stringify({
        cwd: workspace,
        documentTools: 1,
        visualizationTools: 1,
      }),
    );
    assert.equal(runtime.tenant("thread_1"), "default");
    assert.equal(runtime.documentToolsAvailable("thread_1"), true);
    assert.deepEqual(await runtime.files.list("thread_1"), []);
    writeFileSync(
      marker,
      JSON.stringify({ cwd: workspace, tenantId: "acme", documentTools: 1 }),
    );
    assert.equal(runtime.tenant("thread_1"), "acme");
    const old = statSync(marker);
    writeFileSync(
      marker,
      JSON.stringify({ cwd: workspace, tenantId: "evil", documentTools: 0 }),
    );
    utimesSync(marker, old.atime, old.mtime);
    assert.equal(runtime.tenant("thread_1"), "evil");
    assert.equal(runtime.documentToolsAvailable("thread_1"), false);
    writeFileSync(marker, "{broken");
    assert.equal(runtime.documentToolsAvailable("thread_1"), false);
    assert.equal(runtime.visualizationToolsAvailable("thread_1"), false);
    await assert.rejects(
      runtime.files.list("thread_1"),
      (error: any) => error.code === "LEGACY_SESSION",
    );
    rmSync(marker);
    await assert.rejects(
      runtime.files.list("thread_1"),
      (error: any) => error.code === "LEGACY_SESSION",
    );
    assert.equal(runtime.documentToolsAvailable("../thread_1"), false);
  });
}

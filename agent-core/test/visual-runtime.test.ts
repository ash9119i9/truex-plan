import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { DisabledScriptRunner } from "../src/script-runner";
import { HttpError } from "../src/errors";
import type { HtmlPreviewInput, HtmlPreviewResult } from "../src/html-preview";

const html =
  "<!doctype html><html><head><title>Fixture</title></head><body>Preview</body></html>";
test("preview admission uses authoritative tenant scope, releases on cancellation and preserves old visual tools", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "truex-preview-admission-"));
  const calls: HtmlPreviewInput[] = [];
  const runtime = new BusinessRuntime(
    "unused-fixture-binary",
    home,
    undefined,
    new DisabledScriptRunner(),
    {
      enabled: true,
      run(input): Promise<HtmlPreviewResult> {
        calls.push(input);
        return new Promise((_resolve, reject) =>
          input.signal!.addEventListener(
            "abort",
            () => reject(new HttpError(499, "Fixture preview cancelled")),
            { once: true },
          ),
        );
      },
    },
  );
  t.after(async () => {
    runtime.stop();
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, "business-threads"), { recursive: true });
  for (const id of ["a1", "a2", "a3", "b1", "old"]) {
    const cwd = join(home, id);
    await mkdir(cwd);
    await writeFile(
      join(home, "business-threads", id + ".json"),
      JSON.stringify({
        cwd,
        tenantId: id.startsWith("b") ? "tenant-b" : "tenant-a",
        documentTools: 1,
        visualizationTools: 1,
        ...(id === "old" ? {} : { visualReplies: 1, htmlPreview: 1 }),
      }),
    );
  }
  const preview = (threadId: string) =>
    runtime.executeTool({
      threadId,
      turnId: "turn",
      callId: "call",
      namespace: null,
      tool: "html_preview",
      arguments: { html },
    });
  const first = preview("a1"),
    second = preview("a2");
  const overloaded = await preview("a3");
  assert.equal(overloaded.success, false);
  assert.match(JSON.stringify(overloaded), /tenant already has two/);
  const otherTenant = preview("b1");
  assert.equal(
    calls.length,
    3,
    "A second tenant can obtain its own admission slot",
  );
  assert.ok(
    calls.every((call) => call.html.includes("Content-Security-Policy")),
  );
  assert.deepEqual(
    calls.map((call) => call.scope),
    ["a1", "a2", "b1"],
  );
  runtime.emit("notification", {
    method: "turn/completed",
    params: { threadId: "a1", turn: { id: "turn" } },
  });
  assert.equal((await first).success, false);
  const reclaimed = preview("a3");
  assert.equal(calls.length, 4, "Cancellation frees the tenant admission slot");
  runtime.stop();
  assert.ok(
    (await Promise.all([second, otherTenant, reclaimed])).every(
      (result) => result.success === false,
    ),
  );
  assert.equal((await preview("old")).success, false);
  const unavailable = await runtime.executeTool({
    threadId: "old",
    tool: "html_render",
    arguments: { title: "New", html, height: 420 },
  });
  assert.equal(unavailable.success, false);
  assert.match(JSON.stringify(unavailable), /new conversation/);
  const legacy = await runtime.executeTool({
    threadId: "old",
    tool: "create_visualization",
    arguments: {
      title: "Legacy",
      description: "Legacy remains available",
      html: "<div>Legacy</div>",
    },
  });
  assert.equal(legacy.success, true);
  assert.match(JSON.stringify(legacy), /truex-visualization:/);
  assert.equal(
    (
      await runtime.executeTool({
        threadId: "old",
        namespace: "unexpected",
        tool: "conversation_files",
        arguments: {},
      })
    ).success,
    false,
  );
});

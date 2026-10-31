import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BridgeHarness, envelope } from "../support/agentcore";
import { completed, readSse, streamedText } from "../support/harness";
import { ModelFixture } from "../support/model-fixture";

// RUNTIME_MODE=agentcore end to end: runs stream through /invocations to the
// real pinned Codex. RUNTIME_CODEX_BINARY, when set, runs the same checks
// against a packaged binary (the image's, for example).

const codex: Record<string, string> = process.env.RUNTIME_CODEX_BINARY
  ? { RUNTIME_CODEX_BINARY: process.env.RUNTIME_CODEX_BINARY }
  : {};
const chat = { tenantId: "tenant1", chatId: "chat1" };

function startRun(model: ModelFixture, runId = `run_${randomUUID()}`) {
  return {
    method: "POST",
    path: "/v1/runs",
    body: {
      runId,
      ...chat,
      threadId: null,
      input: { text: "hello", clientMessageId: `msg_${randomUUID()}` },
      agentPrompt: "You are a helpful assistant.",
      model: {
        modelName: "fixture-model",
        gatewayUrl: model.url,
        gatewayToken: model.token,
        contextWindow: 100_000,
        autoCompactTokenLimit: 80_000,
      },
    },
  };
}

describe("AgentCore runs (real Codex)", () => {
  const model = new ModelFixture();
  const h = new BridgeHarness(codex);
  before(async () => {
    await model.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await model.close();
  });

  let runId = "";

  test("a run streams through /invocations; ping is busy while it runs", async () => {
    model.script.push({
      kind: "reply",
      text: "Answer through AgentCore.",
      chunk: 4,
      delayMs: 30,
    });
    const invocation = startRun(model);
    runId = invocation.body.runId;
    const res = await h.invoke(invocation);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const pings: unknown[] = [];
    const events = await readSse(res, async (event) => {
      if (event.type === "run.accepted") pings.push((await h.ping()).body);
    });
    assert.equal(completed(events).status, "completed");
    assert.equal(streamedText(events), "Answer through AgentCore.");
    assert.deepEqual(pings, [{ status: "HealthyBusy" }]);
    assert.deepEqual((await h.ping()).body, { status: "Healthy" });
    assert.ok(model.lastRequest().authorized);
    // Chat state lives under RUNTIME_STATE_DIR (session storage on AgentCore).
    assert.ok(
      existsSync(join(h.stateDir, "t", "tenant1", "c", "chat1", "home")),
    );
  });

  test("a cut stream resumes from its cursor", async () => {
    const res = await h.invoke({
      method: "GET",
      path: `/v1/runs/${runId}/events`,
      query: { ...chat, after: "2" },
    });
    const events = await readSse(res);
    assert.equal(events[0]!.seq, 3);
    assert.equal(completed(events).status, "completed");
  });

  test("a busy chat answers CHAT_BUSY inside the envelope", async () => {
    model.script.push({ kind: "hangAfterCreated" });
    const first = startRun(model);
    const res = await h.invoke(first);
    const reading = readSse(res);
    const second = await envelope(await h.invoke(startRun(model)));
    assert.deepEqual(
      [second.status, second.body.error?.code],
      [409, "CHAT_BUSY"],
    );
    const stop = await envelope(
      await h.invoke({
        method: "POST",
        path: `/v1/runs/${first.body.runId}/stop`,
        body: chat,
      }),
    );
    assert.ok([200, 202].includes(stop.status));
    assert.equal(completed(await reading).status, "stopped");
  });
});

describe("AgentCore shutdown (real Codex)", () => {
  const model = new ModelFixture();
  const h = new BridgeHarness({ ...codex, RUNTIME_DRAIN_MS: "200" });
  before(async () => {
    await model.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await model.close();
  });

  // bridge.shutdown() is what main.ts runs on SIGTERM.
  test("shutdown drains: ping Unhealthy, new work DRAINING, the run ends RUNTIME_SHUTDOWN", async () => {
    model.script.push({ kind: "hangAfterCreated" });
    const res = await h.invoke(startRun(model));
    let stopping: Promise<void> | undefined;
    const events = await readSse(res, async (event) => {
      if (event.type !== "run.accepted") return;
      stopping = h.bridge.shutdown();
      assert.deepEqual(await h.ping(), {
        status: 503,
        body: { status: "Unhealthy" },
      });
      const refused = await envelope(await h.invoke(startRun(model)));
      assert.equal(refused.body.error?.code, "DRAINING");
    });
    assert.equal(
      (completed(events).error as { code?: string } | null)?.code,
      "RUNTIME_SHUTDOWN",
    );
    await stopping;
  });
});

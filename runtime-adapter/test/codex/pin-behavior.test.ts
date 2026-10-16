import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { threadStartParams } from "../../src/codex/config";
import {
  CodexProcess,
  RpcTimeout,
  type Notification,
} from "../../src/codex/rpc";
import { ModelFixture, sleep } from "../support/model-fixture";
import { TOKEN } from "../support/harness";

// Codex behaviors the adapter is built around, asserted directly against the
// pinned binary. If an upgrade changes one of these, this file fails and the
// matching adapter safeguard needs a fresh look.

describe("pinned Codex behavior", () => {
  const model = new ModelFixture();
  let root = "";
  let codex: CodexProcess;
  const notes: Notification[] = [];
  let threadId = "";

  before(async () => {
    await model.start();
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-pin-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const { codexBinary } = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: root,
    });
    codex = new CodexProcess({
      binary: codexBinary,
      home: root,
      workspace,
      rpcMs: 10_000,
    });
    codex.setListener((n) => notes.push(n));
    await codex.initialize();
    const started = await codex.request<{ thread: { id: string } }>(
      "thread/start",
      threadStartParams(
        {
          modelName: "fixture-model",
          gatewayUrl: model.url,
          gatewayToken: model.token,
          contextWindow: 100_000,
          autoCompactTokenLimit: 80_000,
        },
        "PIN TEST PROMPT",
        workspace,
      ),
    );
    threadId = started.thread.id;
  });

  after(async () => {
    await codex.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });

  const completions = () => notes.filter((n) => n.method === "turn/completed");
  async function waitFor(count: number, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (completions().length < count && Date.now() < deadline)
      await sleep(10);
  }

  test("an overlapping turn/start is accepted and merged, never completed on its own", async () => {
    model.script.push({
      kind: "reply",
      text: "w ".repeat(60),
      chunk: 4,
      delayMs: 30,
    });
    const before = completions().length;
    const first = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "first", text_elements: [] }],
    });
    await sleep(150);
    const second = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "second", text_elements: [] }],
    });
    await waitFor(before + 1);
    await sleep(1500);
    const ids = completions()
      .slice(before)
      .map((n) => (n.params.turn as { id: string }).id);
    assert.ok(ids.includes(first.turn.id));
    // Either the second ID equals the first (merged) or it never completes.
    if (second.turn.id !== first.turn.id)
      assert.ok(!ids.includes(second.turn.id));
    model.script.length = 0;
  });

  test("an interrupt repeated after the first is acknowledged gets no answer", async () => {
    model.script.push({
      kind: "reply",
      text: "w ".repeat(200),
      chunk: 2,
      delayMs: 30,
    });
    const before = completions().length;
    const turn = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      clientUserMessageId: "pin-interrupt",
      input: [{ type: "text", text: "interrupt me", text_elements: [] }],
    });
    while (
      !notes.some(
        (n) =>
          n.method === "item/agentMessage/delta" &&
          n.params.turnId === turn.turn.id,
      )
    )
      await sleep(10);
    const params = { threadId, turnId: turn.turn.id };
    await codex.request("turn/interrupt", params);
    const second = await codex.request("turn/interrupt", params, 3000).then(
      () => "answered",
      (error: unknown) =>
        error instanceof RpcTimeout ? "no answer" : String(error),
    );
    assert.equal(second, "no answer");
    await waitFor(before + 1);
    const done = completions().at(-1)!.params.turn as { status: string };
    assert.equal(done.status, "interrupted");

    // Codex keeps the user message (with its client ID) but drops the
    // partial assistant text of an interrupted turn.
    const page = await codex.request<{
      data: Array<{ id: string; items: Array<Record<string, unknown>> }>;
    }>("thread/turns/list", { threadId, limit: 1, itemsView: "full" });
    const items = page.data[0]!.items;
    assert.equal(page.data[0]!.id, turn.turn.id);
    assert.equal(
      items.find((i) => i.type === "userMessage")?.clientId,
      "pin-interrupt",
    );
    assert.equal(items.filter((i) => i.type === "agentMessage").length, 0);
  });
});

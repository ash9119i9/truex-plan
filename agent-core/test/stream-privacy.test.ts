import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { publicEvent, publicSnapshot } from "../../platform/src/public";

const secret = "sk-private-stream-canary-9142";
class Runtime extends EventEmitter {
  async request(method: string) {
    return method === "thread/start" ? { thread: { id: "root" } } : {};
  }
  respond() {}
  notice(method: string, params: any) {
    this.emit("notification", { method, params });
  }
}
async function fixture(t: any) {
  const runtime = new Runtime();
  const home = mkdtempSync(join(tmpdir(), "stream-privacy-"));
  const manager = new ThreadManager(runtime, home);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  await manager.create({
    config: {
      "model_providers.fixture": { experimental_bearer_token: secret },
    },
  });
  return { runtime, manager };
}

test("split credentials never enter answer/thinking streams, reconnect snapshots or durable records", async (t) => {
  const { runtime, manager } = await fixture(t);
  for (const method of [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
  ]) {
    const turnId = method.replaceAll("/", "_");
    runtime.notice("turn/started", { threadId: "root", turn: { id: turnId } });
    for (let split = 1; split < secret.length; split++) {
      const itemId = `item_${split}`;
      const params = { threadId: "root", turnId, itemId };
      runtime.notice(method, {
        ...params,
        delta: "Model: GPT. Provider: OpenAI. " + secret.slice(0, split),
      });
      runtime.notice(method, { ...params, delta: secret.slice(split) + " 🌏" });
      const snap = publicSnapshot(manager.snapshot("root"));
      assert.ok(
        !JSON.stringify(snap).includes(secret),
        `${method}, split ${split}`,
      );
      runtime.notice("item/completed", {
        threadId: "root",
        turnId,
        item:
          method === "item/agentMessage/delta"
            ? {
                id: itemId,
                type: "agentMessage",
                text: "Model: GPT. Provider: OpenAI. " + secret + " 🌏",
              }
            : {
                id: itemId,
                type: "reasoning",
                summary: ["Model: GPT. Provider: OpenAI. " + secret + " 🌏"],
              },
      });
    }
    runtime.notice("turn/completed", {
      threadId: "root",
      turn: { id: turnId, status: "completed" },
    });
  }
  const events = manager.threads
    .get("root")!
    .events.map(publicEvent)
    .filter(Boolean);
  for (const type of ["message.delta", "reasoning.delta"]) {
    const combined = events
      .filter((e: any) => e.type === type)
      .map((e: any) => e.data.delta)
      .join("");
    assert.ok(
      !combined.includes(secret),
      `${type} replay exposes a split credential`,
    );
    assert.match(combined, /Model: GPT\. Provider: OpenAI\./);
    assert.match(combined, /🌏/u);
  }
  assert.ok(!JSON.stringify(manager.records("root")).includes(secret));
  assert.ok(
    !JSON.stringify(publicSnapshot(manager.snapshot("root"))).includes(secret),
  );
});

test("helper transcripts and root replay redact split credentials independently", async (t) => {
  const { runtime, manager } = await fixture(t);
  runtime.notice("turn/started", { threadId: "root", turn: { id: "main" } });
  runtime.notice("thread/started", {
    thread: {
      id: "helper",
      source: {
        subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
      },
    },
  });
  runtime.notice("turn/started", {
    threadId: "helper",
    turn: { id: "child_turn" },
  });
  for (const [threadId, turnId] of [
    ["root", "main"],
    ["helper", "child_turn"],
  ]) {
    runtime.notice("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "answer",
      delta: secret.slice(0, 9),
    });
  }
  assert.ok(
    !JSON.stringify(manager.agent("root", "helper")).includes(
      secret.slice(0, 9),
    ),
  );
  for (const [threadId, turnId] of [
    ["root", "main"],
    ["helper", "child_turn"],
  ]) {
    runtime.notice("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "answer",
      delta: secret.slice(9) + " safe",
    });
    runtime.notice("item/completed", {
      threadId,
      turnId,
      item: { id: "answer", type: "agentMessage", text: secret + " safe" },
    });
    runtime.notice("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed" },
    });
  }
  assert.equal(
    manager.agent("root", "helper").messages[0].text,
    "[REDACTED] safe",
  );
  const events = manager.threads
    .get("root")!
    .events.map(publicEvent)
    .filter(Boolean);
  const childDeltas = events
    .filter(
      (e: any) =>
        e.type === "subagent.event" && e.data.kind === "message.delta",
    )
    .map((e: any) => e.data.delta)
    .join("");
  assert.equal(childDeltas, "[REDACTED] safe");
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("completion preserves ordinary prefixes; interruption masks and releases unfinished credentials", async (t) => {
  const { runtime, manager } = await fixture(t);
  runtime.notice("turn/started", { threadId: "root", turn: { id: "first" } });
  runtime.notice("item/agentMessage/delta", {
    threadId: "root",
    turnId: "first",
    itemId: "text",
    delta: "ordinary s",
  });
  runtime.notice("item/completed", {
    threadId: "root",
    turnId: "first",
    item: { id: "text", type: "agentMessage", text: "ordinary s" },
  });
  const first = manager.threads
    .get("root")!
    .events.filter((e) => e.type === "message.delta")
    .map((e) => e.data.delta)
    .join("");
  assert.equal(first, "ordinary s");
  runtime.notice("turn/completed", {
    threadId: "root",
    turn: { id: "first", status: "completed" },
  });
  runtime.notice("turn/started", { threadId: "root", turn: { id: "second" } });
  runtime.notice("item/reasoning/textDelta", {
    threadId: "root",
    turnId: "second",
    itemId: "thinking",
    delta: "before " + secret.slice(0, 12),
  });
  assert.equal(manager.snapshot("root").thinking!.at(-1)!.raw, "before ");
  runtime.notice("turn/completed", {
    threadId: "root",
    turn: { id: "second", status: "interrupted" },
  });
  assert.equal(
    manager.snapshot("root").thinking!.at(-1)!.raw,
    "before [REDACTED]",
  );
  runtime.notice("turn/started", { threadId: "root", turn: { id: "third" } });
  runtime.notice("item/reasoning/textDelta", {
    threadId: "root",
    turnId: "third",
    itemId: "thinking",
    delta: "unrelated text",
  });
  assert.equal(
    manager.snapshot("root").thinking!.at(-1)!.raw,
    "unrelated text",
  );
});

test("archiving a parent releases helper prefixes and ignores late dropped-helper deltas", async (t) => {
  const { runtime, manager } = await fixture(t);
  runtime.notice("turn/started", { threadId: "root", turn: { id: "main" } });
  runtime.notice("thread/started", {
    thread: {
      id: "helper",
      source: {
        subagent: { thread_spawn: { parent_thread_id: "root", depth: 1 } },
      },
    },
  });
  runtime.notice("turn/started", {
    threadId: "helper",
    turn: { id: "child_turn" },
  });
  runtime.notice("item/agentMessage/delta", {
    threadId: "helper",
    turnId: "child_turn",
    itemId: "answer",
    delta: secret.slice(0, 12),
  });
  const helper = (manager as any).children.get("helper");
  assert.equal((manager as any).textStreams.size, 1);
  runtime.notice("turn/completed", {
    threadId: "root",
    turn: { id: "main", status: "completed" },
  });
  await manager.capability("root", "thread/archive", {});
  assert.equal((manager as any).textStreams.size, 0);
  assert.equal(helper.transcript[0].text, "[REDACTED]");
  const eventCount = manager.threads.get("root")!.events.length;
  runtime.notice("item/agentMessage/delta", {
    threadId: "helper",
    turnId: "child_turn",
    itemId: "answer",
    delta: secret.slice(12),
  });
  assert.equal((manager as any).textStreams.size, 0);
  assert.equal(helper.transcript[0].text, "[REDACTED]");
  assert.equal(manager.threads.get("root")!.events.length, eventCount);
});

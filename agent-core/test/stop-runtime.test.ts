import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");

function deadline<T>(promise: Promise<T>, label: string, ms = 15000) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Lose only the host's completion notification. Codex still processes its
// terminal event, replies to interruption and exposes its native thread status.
class MissingCompletionRuntime extends BusinessRuntime {
  lostCompletions: any[] = [];
  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === "notification" && args[0]?.method === "turn/completed") {
      this.lostCompletions.push(args[0]);
      return true;
    }
    return super.emit(event, ...args);
  }
}

function nextDelta(client: BusinessRuntime, threadId: string) {
  let listener: (message: any) => void;
  const promise = new Promise<void>((resolve) => {
    listener = (message) => {
      if (
        message.method === "item/agentMessage/delta" &&
        message.params?.threadId === threadId
      )
        resolve();
    };
    client.on("notification", listener);
  });
  return deadline(
    promise,
    "The native runtime did not stream partial text",
  ).finally(() => client.off("notification", listener));
}

async function fixture(t: TestContext, loseCompletion = false) {
  const home = mkdtempSync(join(tmpdir(), "truex-stop-runtime-"));
  const streams = new Map<
    string,
    { response: ServerResponse; finish: () => void }
  >();
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    if (!req.url?.includes("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const id = ++requests;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (event: any) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: "response.created", response: { id: `response_${id}` } });
    emit({
      type: "response.output_item.added",
      item: {
        type: "message",
        role: "assistant",
        id: `message_${id}`,
        content: [],
      },
    });
    emit({ type: "response.output_text.delta", delta: "Evidence so far." });
    streams.set(String(req.headers.authorization), {
      response: res,
      finish() {
        emit({
          type: "response.output_text.delta",
          delta: " Late provider output.",
        });
        emit({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: `message_${id}`,
            content: [
              {
                type: "output_text",
                text: "Evidence so far. Late provider output.",
              },
            ],
          },
        });
        emit({
          type: "response.completed",
          response: {
            id: `response_${id}`,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      },
    });
    // Deliberately omit response.completed and keep the connection open.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = (key: string) => ({
    model: "gpt-5",
    modelProvider: "fixture",
    config: {
      "model_providers.fixture": {
        name: "fixture",
        base_url: `http://127.0.0.1:${address.port}/v1`,
        wire_api: "responses",
        experimental_bearer_token: key,
      },
      model_reasoning_effort: "low",
    },
  });
  let client: BusinessRuntime = loseCompletion
    ? new MissingCompletionRuntime(binary, home, 15000)
    : new BusinessRuntime(binary, home, 15000);
  let manager = new ThreadManager(client, home);
  let started = false;
  const stopProcess = async () => {
    manager.close();
    if (!started) return;
    const exited = new Promise<void>((resolve) => client.once("exit", resolve));
    client.stop();
    await deadline(exited, "The spawned native runtime did not exit");
    started = false;
  };
  t.after(async () => {
    try {
      await stopProcess();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
  await client.start();
  started = true;
  return {
    config,
    streams,
    get client() {
      return client;
    },
    get manager() {
      return manager;
    },
    get requests() {
      return requests;
    },
    async restart() {
      await stopProcess();
      client = new BusinessRuntime(binary, home, 15000);
      manager = new ThreadManager(client, home);
      await client.start();
      started = true;
    },
  };
}

test(
  "pinned runtime: Stop interrupts a hanging response despite a lost completion and leaves another conversation running",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const f = await fixture(t, true);
    const a = await f.manager.create(f.config("stop-a"));
    const b = await f.manager.create(f.config("stop-b"));
    const aDelta = nextDelta(f.client, a.threadId);
    const bDelta = nextDelta(f.client, b.threadId);
    const [turnA] = await Promise.all([
      f.manager.message(a.threadId, "Investigate A", "stop_message_a"),
      f.manager.message(b.threadId, "Investigate B", "stop_message_b"),
    ]);
    await Promise.all([aDelta, bDelta]);
    const streamA = f.streams.get("Bearer stop-a")!;
    const streamB = f.streams.get("Bearer stop-b")!;
    assert.ok(streamA && streamB);
    await f.manager.interrupt(a.threadId);
    streamA.finish();
    const snapshot = f.manager.snapshot(a.threadId);
    assert.equal(snapshot.state.kind, "idle");
    assert.equal(snapshot.messages[0].text, "Evidence so far.");
    assert.equal(f.manager.snapshot(b.threadId).state.kind, "running");
    assert.equal(streamB.response.destroyed, false);
    const runtime = f.client as MissingCompletionRuntime;
    assert.ok(
      runtime.lostCompletions.some((e) => e.params.threadId === a.threadId),
      "The test must actually lose the native completion notification",
    );
    const completions = f.manager
      .records(a.threadId)
      .filter((r) => r.event.type === "turn.completed");
    assert.equal(completions.length, 1);
    assert.equal(completions[0].event.turnId, turnA.turnId);
    assert.equal(completions[0].event.data.turn.status, "interrupted");
    assert.equal(
      (
        await f.client.request("thread/read", {
          threadId: a.threadId,
          includeTurns: true,
        })
      ).thread.turns.find((turn: any) => turn.id === turnA.turnId).status,
      "interrupted",
    );
    assert.equal(
      (
        await f.client.request("thread/read", {
          threadId: b.threadId,
          includeTurns: false,
        })
      ).thread.status.type,
      "active",
    );
    await f.manager.interrupt(b.threadId);
    streamB.finish();
    assert.equal(
      f.manager.snapshot(a.threadId).messages[0].text,
      "Evidence so far.",
    );
    assert.equal(
      f.manager
        .records(a.threadId)
        .filter((r) => r.event.type === "turn.completed").length,
      1,
      "Late provider completion must not terminalize the stopped turn again",
    );
    assert.equal(f.requests, 2, "Stop must not start another model request");
  },
);

test(
  "pinned runtime: Stop pauses an active goal across runtime restart and cold resume",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const config = f.config("stop-goal");
    const { threadId } = await f.manager.create(config);
    const delta = nextDelta(f.client, threadId);
    await f.manager.capability(threadId, "thread/goal/set", {
      objective: "Investigate the supplied business report",
      status: "active",
    });
    await delta;
    assert.equal(f.manager.snapshot(threadId).state.kind, "running");
    await f.manager.interrupt(threadId);
    const goal = await f.manager.capability(threadId, "thread/goal/get", {});
    assert.equal(goal.goal.status, "paused");
    assert.equal(
      goal.goal.objective,
      "Investigate the supplied business report",
    );
    const requestsBeforeRestart = f.requests;
    await f.restart();
    const resumed = await f.manager.resume(threadId, config);
    assert.equal(resumed.state.kind, "idle");
    assert.equal((resumed.goal as any).status, "paused");
    const persisted = await f.manager.capability(
      threadId,
      "thread/goal/get",
      {},
    );
    assert.equal(persisted.goal.status, "paused");
    assert.equal(persisted.goal.objective, goal.goal.objective);
    assert.equal(
      (
        await f.client.request("thread/read", {
          threadId,
          includeTurns: false,
        })
      ).thread.status.type,
      "idle",
    );
    assert.equal(
      f.requests,
      requestsBeforeRestart,
      "Cold resume must not restart the paused goal's model work",
    );
  },
);

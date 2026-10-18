import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { ChatStore } from "../../src/modules/chats/chat-store";
import {
  RunExecutor,
  type Dispatch,
  type LiveEvent,
} from "../../src/modules/chats/run-executor";
import type {
  AdapterEvent,
  RuntimeClient,
} from "../../src/modules/chats/runtime-client";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function dispatchFor(runId: ObjectId): Dispatch {
  return {
    dbName: "truex_next_t",
    chatId: new ObjectId(),
    runId,
    ownerId: new ObjectId(),
    replySeq: 2,
    ref: { tenantId: "t", chatId: "c" },
    mode: "start",
    body: {} as Dispatch["body"],
  };
}

describe("RunExecutor", () => {
  test("text streams while the runtime's acceptance is saved; the reply is saved after it", async () => {
    const order: string[] = [];
    const acceptance = deferred();
    const deltaSent = deferred();
    const store = {
      markAccepted: async () => {
        order.push("accepted:start");
        await acceptance.promise;
        order.push("accepted:done");
      },
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async () => {
        order.push("settled");
        return { run: {}, messages: [] };
      },
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "run.accepted",
          data: { threadId: "thread-1", turnId: "turn-1" },
        };
        yield {
          seq: 2,
          type: "text.delta",
          data: { itemId: "a", delta: "Hi" },
        };
        // The run ends only once the delta reached the browser.
        await deltaSent.promise;
        yield {
          seq: 3,
          type: "run.completed",
          data: {
            status: "completed",
            delivery: "accepted",
            items: [{ itemId: "a", text: "Hi" }],
          },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const runId = new ObjectId();
    const events: LiveEvent["type"][] = [];
    executor.begin(dispatchFor(runId));
    executor.subscribe(runId, {
      send: (event) => {
        events.push(event.type);
        if (event.type === "delta") {
          order.push("delta");
          deltaSent.resolve();
        }
      },
      end: () => undefined,
    });

    // The delta arrives while the acceptance write is still held.
    await deltaSent.promise;
    assert.deepEqual(order, ["accepted:start", "delta"]);
    // The outcome is shown at once; saving waits for the acceptance.
    for (let i = 0; i < 20 && !events.includes("completed"); i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes("completed"));
    assert.ok(!order.includes("settled"));

    acceptance.resolve();
    await executor.drain(5_000);
    assert.deepEqual(order, [
      "accepted:start",
      "delta",
      "accepted:done",
      "settled",
    ]);
  });

  test("a failed acceptance write does not stop the reply", async () => {
    let settled = false;
    const store = {
      markAccepted: async () => {
        throw new Error("write failed");
      },
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async () => {
        settled = true;
        return { run: {}, messages: [] };
      },
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "run.accepted",
          data: { threadId: "thread-1", turnId: "turn-1" },
        };
        yield {
          seq: 2,
          type: "run.completed",
          data: { status: "completed", delivery: "accepted", items: [] },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    executor.begin(dispatchFor(new ObjectId()));
    await executor.drain(5_000);
    assert.equal(settled, true);
  });
});

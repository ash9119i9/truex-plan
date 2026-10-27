import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { ChatStore, Settlement } from "../../src/modules/chats/chat-store";
import {
  RunExecutor,
  writtenPaths,
  type Dispatch,
  type LiveEvent,
} from "../../src/modules/chats/run-executor";
import {
  AdapterRefusal,
  AdapterUnreachable,
  type AdapterEvent,
  type ChatRef,
  type RuntimeClient,
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

  test("tool calls stream live, keep stream order and reach the settlement", async () => {
    let outcome: Settlement | undefined;
    const store = {
      markAccepted: async () => undefined,
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async (...args: unknown[]) => {
        outcome = args[4] as Settlement;
        return { run: {}, messages: [] };
      },
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "run.accepted",
          data: { threadId: "t", turnId: "u" },
        };
        yield {
          seq: 2,
          type: "text.delta",
          data: { itemId: "a", delta: "Looking" },
        };
        yield {
          seq: 3,
          type: "tool.started",
          data: { itemId: "call-1", connector: "github", tool: "list_issues" },
        };
        yield {
          seq: 4,
          type: "tool.completed",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "list_issues",
            status: "completed",
            durationMs: 1200,
          },
        };
        // A start repeated after completion never reopens the call.
        yield {
          seq: 5,
          type: "tool.started",
          data: { itemId: "call-1", connector: "github", tool: "list_issues" },
        };
        // An unknown error code is never passed through as free text.
        yield {
          seq: 6,
          type: "tool.completed",
          data: {
            itemId: "call-2",
            connector: "github",
            tool: "get_issue",
            status: "failed",
            errorCode: "provider said: secret detail",
          },
        };
        yield {
          seq: 7,
          type: "run.completed",
          data: {
            status: "completed",
            delivery: "accepted",
            items: [
              { type: "reply", itemId: "a", text: "Looking", completed: true },
              {
                type: "tool",
                itemId: "call-1",
                connector: "github",
                tool: "list_issues",
                status: "completed",
                durationMs: 1200,
              },
              {
                type: "tool",
                itemId: "call-2",
                connector: "github",
                tool: "get_issue",
                status: "failed",
                errorCode: "provider said: secret detail",
              },
              {
                type: "reply",
                itemId: "b",
                text: "Two open.",
                completed: true,
              },
            ],
          },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const runId = new ObjectId();
    const tools: LiveEvent[] = [];
    executor.begin(dispatchFor(runId));
    executor.subscribe(runId, {
      send: (event) => {
        if (event.type === "tool") tools.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    assert.deepEqual(
      tools.map((e) => e.type === "tool" && [e.data.itemId, e.data.status]),
      [
        ["call-1", "inProgress"],
        ["call-1", "completed"],
        ["call-2", "failed"],
      ],
    );
    const last = tools.at(-1);
    assert.equal(last?.type === "tool" && last.data.errorCode, "UNKNOWN");
    assert.deepEqual(
      outcome?.items.map((i) =>
        i.type === "input" || i.type === "skill" || i.type === "network"
          ? i.type
          : i.itemId,
      ),
      ["a", "call-1", "call-2", "b"],
    );
    const failedTool = outcome?.items[2];
    assert.equal(
      failedTool?.type === "tool" && failedTool.errorCode,
      "UNKNOWN",
    );
  });

  test("a connector refusing the token is relayed and reported once", async () => {
    const reported: string[] = [];
    const store = {
      markAccepted: async () => undefined,
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async () => ({ run: {}, messages: [] }),
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "run.accepted",
          data: { threadId: "t", turnId: "u" },
        };
        yield {
          seq: 2,
          type: "connector.status",
          data: { connector: "github", status: "failed", reason: "auth" },
        };
        yield {
          seq: 3,
          type: "connector.status",
          data: { connector: "github", status: "failed", reason: "auth" },
        };
        yield {
          seq: 4,
          type: "connector.status",
          data: { connector: "jira", status: "failed", reason: "unreachable" },
        };
        yield {
          seq: 5,
          type: "run.completed",
          data: { status: "completed", delivery: "accepted", items: [] },
        };
      },
    };
    const dispatch = dispatchFor(new ObjectId());
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
      {
        tokenRejected: async (dbName, userId, slug) => {
          assert.equal(dbName, dispatch.dbName);
          assert.ok(userId.equals(dispatch.ownerId));
          reported.push(slug);
        },
      },
    );
    const events: LiveEvent[] = [];
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "connector") events.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    assert.deepEqual(reported, ["github"]);
    assert.deepEqual(
      events.map((e) => e.type === "connector" && e.data),
      [
        { connector: "github", status: "failed", reason: "auth" },
        { connector: "github", status: "failed", reason: "auth" },
        { connector: "jira", status: "failed", reason: "unreachable" },
      ],
    );
  });
});

// ── Approvals ────────────────────────────────────────────────────────

// A fire-and-forget write (recordApproval / allowToolForChat) is awaited by
// the reader off the reply path, so after drain() returns a few microtask
// turns let any pending audit/chat-allow writes settle before asserting.
async function settleWrites(): Promise<void> {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setImmediate(resolve));
}

// A store that records every approval audit and chat-allow call. Everything
// else the reader touches is a safe no-op.
function approvalStore() {
  const recorded: Array<{
    _id: string;
    connector: string;
    tool: string;
    decision: string;
    auto: boolean;
    params: Array<{ name: string; value: string }>;
  }> = [];
  const allowed: Array<{ connector: string; tool: string }> = [];
  const store = {
    markAccepted: async () => undefined,
    renewLease: async () => true,
    markUncertain: async () => undefined,
    settleWithRetry: async () => ({ run: {}, messages: [] }),
    recordApproval: async (_dbName: string, doc: (typeof recorded)[number]) => {
      recorded.push({
        _id: doc._id,
        connector: doc.connector,
        tool: doc.tool,
        decision: doc.decision,
        auto: doc.auto,
        params: doc.params,
      });
    },
    allowToolForChat: async (
      _dbName: string,
      _chatId: ObjectId,
      _ownerId: ObjectId,
      connector: string,
      tool: string,
    ) => {
      allowed.push({ connector, tool });
    },
  };
  return { store, recorded, allowed };
}

// Runs the executor over a scripted event list and collects the live events a
// subscriber sees. The subscriber is registered before draining, so the
// snapshot and every later event are captured.
async function driveApprovals(
  events: AdapterEvent[],
  store: object,
  collect: (type: LiveEvent["type"]) => boolean,
): Promise<{ events: LiveEvent[]; dispatch: Dispatch }> {
  const client = {
    async *startRun(): AsyncGenerator<AdapterEvent> {
      for (const event of events) yield event;
    },
  };
  const executor = new RunExecutor(
    store as unknown as ChatStore,
    client as unknown as RuntimeClient,
  );
  const dispatch = dispatchFor(new ObjectId());
  const captured: LiveEvent[] = [];
  executor.begin(dispatch);
  executor.subscribe(dispatch.runId, {
    send: (event) => {
      if (collect(event.type)) captured.push(event);
    },
    end: () => undefined,
  });
  await executor.drain(5_000);
  await settleWrites();
  return { events: captured, dispatch };
}

const EXPIRES_MS = Date.UTC(2026, 9, 20, 16, 0, 0);

function requested(
  seq: number,
  over: Record<string, unknown> = {},
): AdapterEvent {
  return {
    seq,
    type: "approval.requested",
    data: {
      approvalId: "ap_1",
      itemId: "call-1",
      connector: "github",
      tool: "create_branch",
      params: [{ name: "branch", value: "feature/x" }],
      expiresAt: EXPIRES_MS,
      ...over,
    },
  };
}

function resolved(
  seq: number,
  decision: string,
  over: Record<string, unknown> = {},
): AdapterEvent {
  return {
    seq,
    type: "approval.resolved",
    data: {
      approvalId: "ap_1",
      itemId: "call-1",
      connector: "github",
      tool: "create_branch",
      params: [{ name: "branch", value: "feature/x" }],
      decision,
      ...over,
    },
  };
}

const completed = (seq: number): AdapterEvent => ({
  seq,
  type: "run.completed",
  data: { status: "completed", delivery: "accepted", items: [] },
});

describe("RunExecutor approvals", () => {
  test("a requested approval is a pending live event with an ISO expiresAt and is in the snapshot", async () => {
    // The tool call is seen first so the snapshot carries both.
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "tool.started",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
          },
        };
        yield requested(2);
        // Hold so the subscriber snapshots while the approval is pending.
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield completed(3);
      },
    };
    const { store } = approvalStore();
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    const approvals: LiveEvent[] = [];
    let snapshot: LiveEvent | undefined;
    executor.begin(dispatch);
    // Give the stream a tick to place the pending approval, then subscribe.
    await new Promise((resolve) => setTimeout(resolve, 10));
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "snapshot" && !snapshot) snapshot = event;
        if (event.type === "approval") approvals.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);

    assert.ok(snapshot?.type === "snapshot");
    const inSnapshot =
      snapshot.type === "snapshot" ? snapshot.data.approvals : [];
    assert.deepEqual(
      inSnapshot.map((a) => [a.approvalId, a.status]),
      [["ap_1", "pending"]],
    );
    // The epoch millis became an ISO string on the snapshot's pending card.
    assert.equal(inSnapshot[0]?.expiresAt, new Date(EXPIRES_MS).toISOString());
  });

  test("a resolved approval emits its decision, audits once, broadcasts once, and settles the tool item", async () => {
    const { store, recorded, allowed } = approvalStore();
    let outcomeItems: unknown;
    (store as { settleWithRetry: unknown }).settleWithRetry = async (
      ...args: unknown[]
    ) => {
      outcomeItems = (args[4] as Settlement).items;
      return { run: {}, messages: [] };
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "tool.started",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
          },
        };
        yield requested(2);
        yield resolved(3, "allow");
        yield {
          seq: 4,
          type: "tool.completed",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
            status: "completed",
          },
        };
        yield {
          seq: 5,
          type: "run.completed",
          data: {
            status: "completed",
            delivery: "accepted",
            items: [
              {
                type: "tool",
                itemId: "call-1",
                connector: "github",
                tool: "create_branch",
                status: "completed",
                approval: "allow",
              },
            ],
          },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    const approvals: LiveEvent[] = [];
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "approval") approvals.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    await settleWrites();

    // One pending event, one resolved with the decision.
    assert.deepEqual(
      approvals.map((e) => e.type === "approval" && e.data.status),
      ["pending", "allow"],
    );
    // Audited exactly once; not an allow_for_chat, so no chat allow.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.decision, "allow");
    assert.equal(allowed.length, 0);
    // The settled tool item carries the approval decision.
    const items = outcomeItems as Array<{ approval?: string }>;
    assert.equal(items[0]?.approval, "allow");
  });

  test("a replayed resolved event writes the audit once and broadcasts once", async () => {
    const { store, recorded } = approvalStore();
    const { events } = await driveApprovals(
      [
        requested(1),
        resolved(2, "deny"),
        // A reconnect replays the same resolution.
        resolved(3, "deny"),
        completed(4),
      ],
      store,
      (type) => type === "approval",
    );
    assert.deepEqual(
      events.map((e) => e.type === "approval" && e.data.status),
      ["pending", "deny"],
    );
    assert.equal(recorded.length, 1);
  });

  test("allow_for_chat (non-auto) also allows the tool for the chat", async () => {
    const { store, recorded, allowed } = approvalStore();
    await driveApprovals(
      [
        requested(1),
        resolved(2, "allow_for_chat", { auto: false }),
        completed(3),
      ],
      store,
      () => false,
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.auto, false);
    assert.deepEqual(allowed, [{ connector: "github", tool: "create_branch" }]);
  });

  test("an auto allow_for_chat audits but never re-allows the tool", async () => {
    const { store, recorded, allowed } = approvalStore();
    await driveApprovals(
      [
        requested(1),
        resolved(2, "allow_for_chat", { auto: true }),
        completed(3),
      ],
      store,
      () => false,
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.auto, true);
    assert.equal(allowed.length, 0);
  });

  test("a deny never allows the tool for the chat", async () => {
    const { store, recorded, allowed } = approvalStore();
    await driveApprovals(
      [requested(1), resolved(2, "deny"), completed(3)],
      store,
      () => false,
    );
    assert.equal(recorded.length, 1);
    assert.equal(allowed.length, 0);
  });

  test("a DENIED tool call keeps its errorCode and approval at settle", async () => {
    const { store } = approvalStore();
    let outcomeItems: Array<{
      errorCode?: string;
      approval?: string;
    }> = [];
    (store as { settleWithRetry: unknown }).settleWithRetry = async (
      ...args: unknown[]
    ) => {
      outcomeItems = (args[4] as Settlement)
        .items as unknown as typeof outcomeItems;
      return { run: {}, messages: [] };
    };
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "tool.started",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
          },
        };
        yield requested(2);
        yield resolved(3, "deny");
        // A denied call fails with DENIED.
        yield {
          seq: 4,
          type: "tool.completed",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
            status: "failed",
            errorCode: "DENIED",
          },
        };
        yield {
          seq: 5,
          type: "run.completed",
          data: {
            status: "completed",
            delivery: "accepted",
            items: [
              {
                type: "tool",
                itemId: "call-1",
                connector: "github",
                tool: "create_branch",
                status: "failed",
                errorCode: "DENIED",
                approval: "deny",
              },
            ],
          },
        };
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    executor.begin(dispatchFor(new ObjectId()));
    await executor.drain(5_000);
    assert.equal(outcomeItems[0]?.errorCode, "DENIED");
    assert.equal(outcomeItems[0]?.approval, "deny");
  });

  test("a later tool.completed without an approval keeps the resolved approval", async () => {
    const { store } = approvalStore();
    const toolEvents: LiveEvent[] = [];
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "tool.started",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
          },
        };
        yield requested(2);
        yield resolved(3, "allow");
        // The completion event carries no approval; the earlier one is kept.
        yield {
          seq: 4,
          type: "tool.completed",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
            status: "completed",
          },
        };
        yield completed(5);
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "tool") toolEvents.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    const last = toolEvents.at(-1);
    assert.equal(last?.type === "tool" && last.data.status, "completed");
    assert.equal(last?.type === "tool" && last.data.approval, "allow");
  });

  test("a run.snapshot without the pending approval closes its card", async () => {
    const { store } = approvalStore();
    const approvals: LiveEvent[] = [];
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield {
          seq: 1,
          type: "tool.started",
          data: {
            itemId: "call-1",
            connector: "github",
            tool: "create_branch",
          },
        };
        yield requested(2);
        // A reconnect snapshot: the tool ended "allow" and no approval is
        // pending, so the card closes resolved with the tool's approval.
        yield {
          seq: 3,
          type: "run.snapshot",
          data: {
            items: [
              {
                type: "tool",
                itemId: "call-1",
                connector: "github",
                tool: "create_branch",
                status: "completed",
                approval: "allow",
              },
            ],
            approvals: [],
          },
        };
        yield completed(4);
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "approval") approvals.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    assert.deepEqual(
      approvals.map((e) => e.type === "approval" && e.data.status),
      ["pending", "allow"],
    );
  });

  test("a run.snapshot without a pending approval and no tool approval closes it cancelled", async () => {
    const { store } = approvalStore();
    const approvals: LiveEvent[] = [];
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield requested(1);
        // No tool item carrying an approval, no pending approval: cancelled.
        yield {
          seq: 2,
          type: "run.snapshot",
          data: { items: [], approvals: [] },
        };
        yield completed(3);
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "approval") approvals.push(event);
      },
      end: () => undefined,
    });
    await executor.drain(5_000);
    assert.deepEqual(
      approvals.map((e) => e.type === "approval" && e.data.status),
      ["pending", "cancelled"],
    );
  });

  test("params are bounded to 12 entries and 500 characters", async () => {
    const { store } = approvalStore();
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`,
      value: "v".repeat(600),
    }));
    const { events } = await driveApprovals(
      [requested(1, { params: many }), completed(2)],
      store,
      (type) => type === "approval",
    );
    const pending = events[0];
    assert.ok(pending?.type === "approval");
    assert.equal(pending.data.params.length, 12);
    assert.equal(pending.data.params[0]?.value.length, 500);
  });

  test("a requested event after resolution does not reopen the card", async () => {
    const { store } = approvalStore();
    const { events } = await driveApprovals(
      [
        requested(1),
        resolved(2, "allow"),
        // A late/replayed request for a resolved approval is ignored.
        requested(3),
        completed(4),
      ],
      store,
      (type) => type === "approval",
    );
    assert.deepEqual(
      events.map((e) => e.type === "approval" && e.data.status),
      ["pending", "allow"],
    );
  });
});

describe("RunExecutor.answerApproval", () => {
  const ref: ChatRef = { tenantId: "t", chatId: "c" };
  const approvalId = "ap_00000000-0000-0000-0000-000000000000";

  function executorWith(client: object): RunExecutor {
    const store = {
      markAccepted: async () => undefined,
      renewLease: async () => true,
      markUncertain: async () => undefined,
      settleWithRetry: async () => ({ run: {}, messages: [] }),
    };
    return new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
  }

  test("a clean answer is 'answered'", async () => {
    const executor = executorWith({
      answerApproval: async () => undefined,
    });
    assert.equal(
      await executor.answerApproval(new ObjectId(), ref, approvalId, "allow"),
      "answered",
    );
  });

  test("APPROVAL_RESOLVED maps to 'resolved'", async () => {
    const executor = executorWith({
      answerApproval: async () => {
        throw new AdapterRefusal(409, "APPROVAL_RESOLVED", false);
      },
    });
    assert.equal(
      await executor.answerApproval(new ObjectId(), ref, approvalId, "allow"),
      "resolved",
    );
  });

  for (const code of ["APPROVAL_NOT_FOUND", "RUN_NOT_FOUND", "RUN_ENDED"]) {
    test(`${code} maps to 'not_found'`, async () => {
      const executor = executorWith({
        answerApproval: async () => {
          throw new AdapterRefusal(404, code, false);
        },
      });
      assert.equal(
        await executor.answerApproval(new ObjectId(), ref, approvalId, "deny"),
        "not_found",
      );
    });
  }

  test("another refusal code rethrows", async () => {
    const executor = executorWith({
      answerApproval: async () => {
        throw new AdapterRefusal(400, "INVALID_REQUEST", false);
      },
    });
    await assert.rejects(
      executor.answerApproval(new ObjectId(), ref, approvalId, "allow"),
      (error: unknown) =>
        error instanceof AdapterRefusal && error.code === "INVALID_REQUEST",
    );
  });

  test("AdapterUnreachable rethrows (the caller may retry)", async () => {
    const executor = executorWith({
      answerApproval: async () => {
        throw new AdapterUnreachable("timeout");
      },
    });
    await assert.rejects(
      executor.answerApproval(new ObjectId(), ref, approvalId, "allow"),
      (error: unknown) => error instanceof AdapterUnreachable,
    );
  });
});

// ── Coding: commands and file changes ────────────────────────────────

function codingStore() {
  const base = approvalStore();
  const coding: Array<Record<string, unknown>> = [];
  const kinds: Array<string | undefined> = [];
  const recordApproval = base.store.recordApproval;
  const store = {
    ...base.store,
    recordApproval: async (dbName: string, doc: Record<string, unknown>) => {
      kinds.push(doc.kind as string | undefined);
      await recordApproval(dbName, doc as never);
    },
    allowCodingForChat: async (
      _dbName: string,
      _chatId: ObjectId,
      _ownerId: ObjectId,
      allow: Record<string, unknown>,
    ) => {
      coding.push(allow);
    },
  };
  return { ...base, store, coding, kinds };
}

const SCOPE = "a".repeat(64);

function commandApproval(
  seq: number,
  type: "approval.requested" | "approval.resolved",
  over: Record<string, unknown> = {},
): AdapterEvent {
  return {
    seq,
    type,
    data: {
      approvalId: "ap_c1",
      itemId: "call_c1",
      kind: "command",
      connector: "@workspace",
      tool: "command",
      params: [
        { name: "command", value: "npm test" },
        { name: "cwd", value: "." },
      ],
      allowForChat: true,
      scope: SCOPE,
      ...(type === "approval.requested"
        ? { expiresAt: EXPIRES_MS }
        : { decision: "allow_for_chat", auto: false }),
      ...over,
    },
  };
}

describe("RunExecutor coding activity", () => {
  test("a command streams as activity and output, and settles with its output and approval", async () => {
    const { store } = codingStore();
    let outcomeItems: unknown;
    (store as { settleWithRetry: unknown }).settleWithRetry = async (
      ...args: unknown[]
    ) => {
      outcomeItems = (args[4] as Settlement).items;
      return { run: {}, messages: [] };
    };
    const { events } = await driveApprovals(
      [
        {
          seq: 1,
          type: "command.started",
          data: { itemId: "call_c1", command: "npm test" },
        },
        commandApproval(2, "approval.requested"),
        commandApproval(3, "approval.resolved"),
        {
          seq: 4,
          type: "command.output",
          data: { itemId: "call_c1", delta: "ok 1\n" },
        },
        {
          seq: 5,
          type: "command.completed",
          data: {
            itemId: "call_c1",
            command: "npm test",
            status: "completed",
            exitCode: 0,
            durationMs: 1200,
          },
        },
        {
          seq: 6,
          type: "run.completed",
          data: {
            status: "completed",
            delivery: "accepted",
            items: [
              {
                type: "command",
                itemId: "call_c1",
                command: "npm test",
                status: "completed",
                exitCode: 0,
                durationMs: 1200,
                output: "ok 1\n",
                outputTruncated: false,
                approval: "allow_for_chat",
              },
            ],
          },
        },
      ],
      store,
      (type) => type === "activity" || type === "output" || type === "approval",
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["activity", "approval", "approval", "output", "activity"],
    );
    const card = events[1]!;
    assert.equal(card.type === "approval" && card.data.kind, "command");
    assert.equal(card.type === "approval" && card.data.scope, SCOPE);
    const done = events[4]!;
    assert.deepEqual(done.type === "activity" && done.data, {
      type: "command",
      itemId: "call_c1",
      command: "npm test",
      status: "completed",
      exitCode: 0,
      durationMs: 1200,
      output: "ok 1\n",
      outputTruncated: false,
      approval: "allow_for_chat",
    });
    const items = outcomeItems as Array<Record<string, unknown>>;
    assert.equal(items[0]?.type, "command");
    assert.equal(items[0]?.output, "ok 1\n");
  });

  test("a file change being written streams as progress until it is an activity", async () => {
    const { store } = codingStore();
    const progress = (seq: number, data: Record<string, unknown>) => ({
      seq,
      type: "file_change.progress",
      data,
    });
    const files = [{ path: "guide.md", kind: "add" }];
    const { events } = await driveApprovals(
      [
        progress(1, { itemId: "call_f1", files, lines: 3 }),
        // Malformed: ignored.
        progress(2, { itemId: "call_f1", files, lines: -1 }),
        progress(3, { itemId: "call_f1", files: [], lines: 4 }),
        progress(4, { itemId: "call_f1", files, lines: 40 }),
        {
          seq: 5,
          type: "file_change.started",
          data: { itemId: "call_f1", files },
        },
        // Late progress for an activity, and an end for it: both ignored.
        progress(6, { itemId: "call_f1", files, lines: 41 }),
        progress(7, { itemId: "call_f1", ended: true }),
        // A patch Codex rejected ends without an activity.
        progress(8, { itemId: "call_f2", files, lines: 1 }),
        progress(9, { itemId: "call_f2", ended: true }),
        progress(10, { itemId: "call_f2", ended: true }),
        completed(11),
      ],
      store,
      (type) => type === "progress" || type === "activity",
    );
    assert.deepEqual(
      events.map((e) => [e.type, (e.data as { itemId: string }).itemId]),
      [
        ["progress", "call_f1"],
        ["progress", "call_f1"],
        ["activity", "call_f1"],
        ["progress", "call_f2"],
        ["progress", "call_f2"],
      ],
    );
    assert.deepEqual(events[1]!.data, {
      itemId: "call_f1",
      files: [{ path: "guide.md", kind: "add" }],
      lines: 40,
    });
    assert.deepEqual(events[4]!.data, { itemId: "call_f2", ended: true });
  });

  test("a new file's text: live pieces in order, the whole of it in a reconnect snapshot", async () => {
    const { store } = codingStore();
    const files = [{ path: "guide.md", kind: "add" }];
    const piece = (seq: number, offset: number, text: string) => ({
      seq,
      type: "file_change.progress",
      data: {
        itemId: "call_f1",
        files,
        lines: 1,
        preview: { path: "guide.md", offset, text, truncated: false },
      },
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const client = {
      async *startRun(): AsyncGenerator<AdapterEvent> {
        yield piece(1, 0, "# Gui");
        yield piece(2, 5, "de\n");
        // A gap: dropped, the kept text stands.
        yield piece(3, 99, "lost");
        await paused;
        yield completed(4);
      },
    };
    const executor = new RunExecutor(
      store as unknown as ChatStore,
      client as unknown as RuntimeClient,
    );
    const dispatch = dispatchFor(new ObjectId());
    const live: LiveEvent[] = [];
    executor.begin(dispatch);
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "progress") live.push(event);
      },
      end: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    let snapshot: Record<string, unknown> | undefined;
    executor.subscribe(dispatch.runId, {
      send: (event) => {
        if (event.type === "snapshot")
          snapshot = event.data as unknown as Record<string, unknown>;
      },
      end: () => undefined,
    });
    resume();
    await executor.drain(5_000);
    await settleWrites();
    assert.deepEqual(
      live.map((e) => (e.data as { preview?: { text: string } }).preview?.text),
      ["# Gui", "de\n", undefined],
    );
    const writing = snapshot!.writing as Array<Record<string, unknown>>;
    assert.deepEqual(writing[0]!.preview, {
      path: "guide.md",
      offset: 0,
      text: "# Guide\n",
      truncated: false,
    });
  });

  test("Allow for this chat stores the command's scope; push stores nothing", async () => {
    const { store, coding, kinds, allowed } = codingStore();
    await driveApprovals(
      [
        commandApproval(1, "approval.requested"),
        commandApproval(2, "approval.resolved"),
        commandApproval(3, "approval.resolved", {
          approvalId: "ap_c3",
          itemId: "call_c3",
          tool: "push",
          allowForChat: false,
          scope: undefined,
        }),
        completed(4),
      ],
      store,
      () => false,
    );
    assert.deepEqual(coding, [{ command: SCOPE }]);
    assert.deepEqual(kinds, ["command", "command"]);
    assert.equal(allowed.length, 0, "no connector allow for coding cards");
  });

  test("a coding approval that does not come from the workspace is ignored", async () => {
    const { store, recorded } = codingStore();
    const { events } = await driveApprovals(
      [
        commandApproval(1, "approval.requested", { connector: "github" }),
        commandApproval(2, "approval.resolved", { connector: "github" }),
        completed(3),
      ],
      store,
      (type) => type === "approval",
    );
    assert.equal(events.length, 0);
    assert.equal(recorded.length, 0);
  });

  test("a file change card keeps its bounded diff; a snapshot restores activity items", async () => {
    const { store } = codingStore();
    const { events } = await driveApprovals(
      [
        {
          seq: 1,
          type: "run.snapshot",
          data: {
            status: "running",
            items: [
              {
                type: "file_change",
                itemId: "call_f1",
                files: [
                  { path: "src/a.py", kind: "add" },
                  { path: "bad", kind: "explode" },
                ],
                status: "inProgress",
              },
            ],
            approvals: [
              {
                approvalId: "ap_f1",
                itemId: "call_f1",
                kind: "file_change",
                connector: "@workspace",
                tool: "file_change",
                params: [{ name: "add", value: "src/a.py" }],
                allowForChat: true,
                scope: "file_change",
                diff: "x".repeat(20_000),
                expiresAt: EXPIRES_MS,
              },
            ],
          },
        },
        completed(2),
      ],
      store,
      (type) => type === "activity" || type === "approval",
    );
    const activity = events.find((e) => e.type === "activity");
    assert.deepEqual(
      activity?.type === "activity" &&
        activity.data.type === "file_change" &&
        activity.data.files,
      [{ path: "src/a.py", kind: "add" }],
    );
    const card = events.find((e) => e.type === "approval");
    assert.equal(card?.type === "approval" && card.data.diff?.length, 16_000);
    assert.equal(card?.type === "approval" && card.data.diffTruncated, true);
  });

  test("the files a run wrote are its completed edits' final paths", () => {
    const change = (
      status: "completed" | "failed",
      files: Array<{
        path: string;
        kind: "add" | "update" | "delete" | "move";
        movePath?: string;
      }>,
    ) => ({ type: "file_change" as const, itemId: "i", status, files });
    assert.deepEqual(
      [
        ...writtenPaths([
          change("completed", [
            { path: "a.md", kind: "add" },
            { path: "b.md", kind: "add" },
            { path: "old.md", kind: "update" },
          ]),
          change("failed", [{ path: "never.md", kind: "add" }]),
          change("completed", [
            { path: "b.md", kind: "delete" },
            { path: "old.md", kind: "move", movePath: "new.md" },
          ]),
        ]),
      ],
      ["a.md", "new.md"],
    );
  });
});

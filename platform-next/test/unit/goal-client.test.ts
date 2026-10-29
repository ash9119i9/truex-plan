import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AdapterRefusal,
  AdapterUnreachable,
  goalUpdate,
  RuntimeClient,
  type GoalRunContext,
} from "../../src/modules/chats/runtime-client";

// The platform's side of the goal contract (runtime-adapter/README.md,
// "Goals") against a fake adapter: what each method sends, and how answers
// and chat-stream events are parsed.

const TOKEN = "adapter-token-0123456789abcdef0123";
const ref = { tenantId: "t1", chatId: "c1" };
const STREAM = "4f1c2a9e0b7d3c5a6e8f9012";
const goals = { maxTokenBudget: 3_000_000 };

const goal = (overrides: Record<string, unknown> = {}) => ({
  threadId: "019a0000-0000-7000-8000-000000000001",
  objective: "Write the quarterly summary.",
  status: "active",
  tokenBudget: 300_000,
  tokensUsed: 1200,
  timeUsedSeconds: 4,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_004,
  ...overrides,
});
// What the platform keeps of a goal: Codex's fields without the thread ID.
const parsed = (overrides: Record<string, unknown> = {}) => {
  const { threadId: _thread, ...rest } = goal(overrides);
  return rest;
};

const context: GoalRunContext = {
  threadId: null,
  agentPrompt: "You are helpful.",
  model: {
    modelName: "fixture-model",
    gatewayUrl: "https://gateway.example.com/p/abc/v1",
    gatewayToken: "token-0123456789abcdef",
    contextWindow: 100_000,
    autoCompactTokenLimit: 80_000,
  },
};

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

describe("runtime client goal contract", () => {
  let server: Server;
  let client: RuntimeClient;
  let seen: Seen[] = [];
  // The fake adapter's next answer: a JSON body, or SSE frames.
  let answer: { status: number; json?: unknown; sse?: string } = {
    status: 200,
    json: {},
  };

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body: raw ? JSON.parse(raw) : undefined,
        });
        if (answer.sse !== undefined) {
          res.writeHead(answer.status, { "content-type": "text/event-stream" });
          res.end(answer.sse);
        } else {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(JSON.stringify(answer.json));
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    client = new RuntimeClient(`http://127.0.0.1:${port}`, TOKEN);
  });
  after(() => server.close());
  beforeEach(() => {
    seen = [];
  });

  test("setGoal PUTs the goal with the run context and returns the goal", async () => {
    answer = { status: 200, json: { goal: goal() } };
    const result = await client.setGoal(ref, {
      goals,
      status: "active",
      objective: "Write the quarterly summary.",
      tokenBudget: 300_000,
      run: context,
    });
    assert.deepEqual(result, parsed());
    assert.deepEqual(seen, [
      {
        method: "PUT",
        url: "/v1/chats/c1/goal",
        authorization: `Bearer ${TOKEN}`,
        body: {
          tenantId: "t1",
          goals,
          status: "active",
          objective: "Write the quarterly summary.",
          tokenBudget: 300_000,
          run: context,
        },
      },
    ]);
  });

  test("a pause sends no run context", async () => {
    answer = { status: 200, json: { goal: goal({ status: "paused" }) } };
    const result = await client.setGoal(ref, { goals, status: "paused" });
    assert.equal(result.status, "paused");
    assert.deepEqual(seen[0]?.body, {
      tenantId: "t1",
      goals,
      status: "paused",
    });
  });

  test("getGoal reads the goal, or null when there is none", async () => {
    answer = { status: 200, json: { goal: goal({ tokenBudget: null }) } };
    assert.deepEqual(await client.getGoal(ref), parsed({ tokenBudget: null }));
    answer = { status: 200, json: { goal: null } };
    assert.equal(await client.getGoal(ref), null);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.body]),
      [
        ["GET", "/v1/chats/c1/goal?tenantId=t1", undefined],
        ["GET", "/v1/chats/c1/goal?tenantId=t1", undefined],
      ],
    );
  });

  test("clearGoal DELETEs and reports whether there was a goal", async () => {
    answer = { status: 200, json: { cleared: true } };
    assert.equal(await client.clearGoal(ref), true);
    answer = { status: 200, json: { cleared: false } };
    assert.equal(await client.clearGoal(ref), false);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url]),
      [
        ["DELETE", "/v1/chats/c1/goal?tenantId=t1"],
        ["DELETE", "/v1/chats/c1/goal?tenantId=t1"],
      ],
    );
  });

  test("a malformed goal answer is a failed call, not a goal", async () => {
    for (const json of [
      {},
      { goal: goal({ status: "done" }) },
      { goal: goal({ tokensUsed: -1 }) },
      { goal: { ...goal(), objective: undefined } },
    ]) {
      answer = { status: 200, json };
      await assert.rejects(
        client.setGoal(ref, { goals, status: "paused" }),
        AdapterUnreachable,
      );
      await assert.rejects(client.getGoal(ref), AdapterUnreachable);
    }
    answer = { status: 200, json: { cleared: "yes" } };
    await assert.rejects(client.clearGoal(ref), AdapterUnreachable);
  });

  test("the adapter's refusals arrive as AdapterRefusal", async () => {
    answer = {
      status: 501,
      json: {
        error: { code: "NOT_IMPLEMENTED", message: "…", retryable: false },
      },
    };
    await assert.rejects(
      client.getGoal(ref),
      (error: unknown) =>
        error instanceof AdapterRefusal &&
        error.status === 501 &&
        error.code === "NOT_IMPLEMENTED",
    );
  });

  test("chatEvents reads the chat stream from the cursor and parses each event", async () => {
    const frames = [
      [1, "goal.updated", { goal: goal(), turnId: null, origin: "user" }],
      [
        2,
        "run.started",
        {
          runId: "bb946c34679677cfec85fa9a",
          turnId: "turn-1",
          trigger: "goal",
        },
      ],
      [
        3,
        "goal.updated",
        {
          goal: goal({ status: "complete" }),
          turnId: "turn-1",
          origin: "model",
        },
      ],
      [4, "goal.cleared", {}],
      [
        5,
        "chat.snapshot",
        {
          streamId: STREAM,
          goal: goal(),
          origin: "user",
          activeRun: {
            runId: "bb946c34679677cfec85fa9a",
            turnId: "turn-1",
            trigger: "goal",
          },
        },
      ],
      [
        6,
        "chat.snapshot",
        { streamId: STREAM, goal: null, origin: null, activeRun: null },
      ],
      // A member's run that Codex has not accepted yet has no turn.
      [
        7,
        "chat.snapshot",
        {
          streamId: STREAM,
          goal: null,
          origin: null,
          activeRun: {
            runId: "0123456789abcdef01234567",
            turnId: null,
            trigger: "user",
          },
        },
      ],
    ] as const;
    answer = {
      status: 200,
      sse:
        ": hb\n\n" +
        frames
          .map(
            ([seq, type, data]) =>
              `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
          )
          .join(""),
    };
    const events = [];
    for await (const event of client.chatEvents(
      ref,
      { streamId: STREAM, seq: 7 },
      AbortSignal.timeout(5000),
    ))
      events.push(event);
    assert.deepEqual(
      seen.map((s) => [s.method, s.url]),
      [["GET", `/v1/chats/c1/events?tenantId=t1&after=7&streamId=${STREAM}`]],
    );
    assert.deepEqual(events, [
      {
        seq: 1,
        type: "goal.updated",
        goal: parsed(),
        turnId: null,
        origin: "user",
      },
      {
        seq: 2,
        type: "run.started",
        runId: "bb946c34679677cfec85fa9a",
        turnId: "turn-1",
        trigger: "goal",
      },
      {
        seq: 3,
        type: "goal.updated",
        goal: parsed({ status: "complete" }),
        turnId: "turn-1",
        origin: "model",
      },
      { seq: 4, type: "goal.cleared" },
      {
        seq: 5,
        type: "chat.snapshot",
        streamId: STREAM,
        goal: parsed(),
        origin: "user",
        activeRun: {
          runId: "bb946c34679677cfec85fa9a",
          turnId: "turn-1",
          trigger: "goal",
        },
      },
      {
        seq: 6,
        type: "chat.snapshot",
        streamId: STREAM,
        goal: null,
        origin: null,
        activeRun: null,
      },
      {
        seq: 7,
        type: "chat.snapshot",
        streamId: STREAM,
        goal: null,
        origin: null,
        activeRun: {
          runId: "0123456789abcdef01234567",
          turnId: null,
          trigger: "user",
        },
      },
    ]);
  });

  test("malformed chat events are dropped, not thrown", async () => {
    const bad: Array<[string, unknown]> = [
      [
        "goal.updated",
        { goal: goal({ status: "done" }), turnId: null, origin: "user" },
      ],
      [
        "goal.updated",
        { goal: goal({ tokenBudget: 0 }), turnId: null, origin: "user" },
      ],
      [
        "goal.updated",
        { goal: goal({ updatedAt: 1.5 }), turnId: null, origin: "user" },
      ],
      [
        "goal.updated",
        { goal: goal({ objective: "" }), turnId: null, origin: "user" },
      ],
      ["goal.updated", { goal: goal(), turnId: 5, origin: "user" }],
      ["goal.updated", { goal: goal(), turnId: null, origin: "automatic" }],
      ["goal.updated", { turnId: null, origin: "user" }],
      ["run.started", { runId: "run_1", turnId: "turn-1", trigger: "goal" }],
      [
        "run.started",
        {
          runId: "BB946C34679677CFEC85FA9A",
          turnId: "turn-1",
          trigger: "goal",
        },
      ],
      [
        "run.started",
        { runId: "bb946c34679677cfec85fa9a", turnId: "", trigger: "goal" },
      ],
      [
        "run.started",
        {
          runId: "bb946c34679677cfec85fa9a",
          turnId: "turn-1",
          trigger: "user",
        },
      ],
      ["chat.snapshot", { streamId: STREAM, goal: goal(), origin: "user" }],
      [
        "chat.snapshot",
        { streamId: STREAM, goal: goal(), origin: null, activeRun: null },
      ],
      ["chat.snapshot", { goal: null, origin: null, activeRun: null }],
      [
        "chat.snapshot",
        { streamId: "a.b", goal: null, origin: null, activeRun: null },
      ],
      [
        "chat.snapshot",
        {
          streamId: STREAM,
          goal: null,
          origin: null,
          activeRun: { runId: "x", turnId: "t", trigger: "goal" },
        },
      ],
      [
        "chat.snapshot",
        {
          streamId: STREAM,
          goal: null,
          origin: null,
          activeRun: {
            runId: "0123456789abcdef01234567",
            turnId: "",
            trigger: "user",
          },
        },
      ],
      ["run.completed", { status: "completed" }],
    ];
    const good = { goal: goal(), turnId: null, origin: "user" };
    answer = {
      status: 200,
      sse: [...bad, ["goal.updated", good] as [string, unknown]]
        .map(
          ([type, data], i) =>
            `id: ${i + 1}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
        )
        .join(""),
    };
    const events = [];
    for await (const event of client.chatEvents(
      ref,
      null,
      AbortSignal.timeout(5000),
    ))
      events.push(event);
    // A first read sends no stream ID, so the adapter starts with a snapshot.
    assert.deepEqual(
      seen.map((s) => s.url),
      ["/v1/chats/c1/events?tenantId=t1&after=0"],
    );
    assert.deepEqual(events, [
      {
        seq: bad.length + 1,
        type: "goal.updated",
        goal: parsed(),
        turnId: null,
        origin: "user",
      },
    ]);
  });

  test("goalUpdate parses a run stream's goal.updated data", () => {
    assert.deepEqual(
      goalUpdate({ goal: goal(), turnId: "turn-1", origin: "model" }),
      {
        goal: parsed(),
        turnId: "turn-1",
        origin: "model",
      },
    );
    assert.equal(
      goalUpdate({ goal: goal({ status: 1 }), turnId: null, origin: "user" }),
      null,
    );
    assert.equal(goalUpdate({}), null);
  });
});

describe("goalRunId", () => {
  test("is the adapter's goal run ID: the same digest of thread and turn", async () => {
    const { goalRunId } = await import("../../src/modules/goals/goal-watcher");
    const thread = "019a0000-0000-7000-8000-000000000001";
    const turn = "019a0000-0000-7000-8000-000000000002";
    // runtime-adapter/test/unit/unit.test.ts pins the same value.
    assert.equal(
      goalRunId(thread, turn).toHexString(),
      "bb946c34679677cfec85fa9a",
    );
    assert.notEqual(
      goalRunId(thread, `${turn}x`).toHexString(),
      goalRunId(thread, turn).toHexString(),
    );
  });
});

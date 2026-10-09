import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addApps,
  addApprovals,
  applyChatEvent,
  historyEntries,
  mergeHistoryEntries,
  visibleEntries,
  type Entry,
} from "../lib/chat.ts";
import type { DomainEvent, Message } from "../../shared/contracts.ts";

const event = (
  type: DomainEvent["type"],
  data: Record<string, unknown>,
  itemId = "answer",
  turnId = "turn",
) => ({ type, data, itemId, turnId }) as DomainEvent;
const history = (extra = {}) =>
  historyEntries([
    {
      _id: "saved",
      role: "assistant",
      text: "Hello",
      turnId: "turn",
      messageIndex: 0,
      ...extra,
    } as Message,
  ]);

test("history, replay, and a snapshot render one authoritative reply", () => {
  let entries = history({ itemId: "stored", runtimeItemId: "runtime" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 0 }, "runtime"),
  );
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 0 }, "runtime"),
  );
  entries = applyChatEvent(
    entries,
    event("snapshot", {
      state: { kind: "idle" },
      messages: [
        {
          id: "runtime",
          turnId: "turn",
          text: "Hello",
          messageIndex: 0,
          final: true,
        },
      ],
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "message" && entries[0].text, "Hello");
});
test("a final adopts its stream even when runtime changes the ID", () => {
  let entries = applyChatEvent([], event("message.delta", { delta: "Hel" }));
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 0 }, "final-id"),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind === "message" && entries[0].text, "Hello");
});
test("different messages and turns are not collapsed by identical text", () => {
  let entries = history({ itemId: "first" });
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello", messageIndex: 1 }, "second"),
  );
  entries = applyChatEvent(
    entries,
    event(
      "message.final",
      { text: "Hello", messageIndex: 0 },
      "first",
      "other-turn",
    ),
  );
  assert.equal(entries.length, 3);
});
test("late reasoning is placed before the saved answer and updated in place", () => {
  let entries = applyChatEvent(
    history(),
    event("reasoning.delta", { delta: "Consider this." }, "reason"),
  );
  entries = applyChatEvent(
    entries,
    event(
      "item.completed",
      {
        item: { id: "reason", type: "reasoning", summary: ["Consider this."] },
      },
      "reason",
    ),
  );
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["thinking", "message"],
  );
  assert.equal(
    entries[0].kind === "thinking" && entries[0].text,
    "Consider this.",
  );
});
test("raw reasoning and summary streams never concatenate duplicate content", () => {
  let entries: Entry[] = [];
  for (const method of [
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
  ])
    entries = applyChatEvent(
      entries,
      event("reasoning.delta", { delta: "Consider this.", method }, "reason"),
    );
  assert.equal(entries.length, 1);
  assert.equal(
    entries[0].kind === "thinking" && entries[0].text,
    "Consider this.",
  );
});
test("runtime agentMessage items cannot create a second answer row", () => {
  const entries = history();
  assert.deepEqual(
    applyChatEvent(
      entries,
      event("item.completed", {
        item: { id: "answer", type: "agentMessage", text: "Hello" },
      }),
    ),
    entries,
  );
});
test("completing a turn closes only its own partial content", () => {
  let entries = applyChatEvent(
    [],
    event("reasoning.delta", { delta: "First" }, "r1"),
  );
  entries = applyChatEvent(
    entries,
    event("reasoning.delta", { delta: "Second" }, "r2", "other"),
  );
  entries = applyChatEvent(entries, event("turn.completed", {}));
  assert.equal(entries[0].kind === "thinking" && entries[0].done, true);
  assert.equal(entries[1].kind === "thinking" && !!entries[1].done, false);
});

test("provider replay on a second unfinished item stays hidden, including after completion", () => {
  let entries = history({ text: " Hello there", itemId: "final" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 1 }, "shadow"),
  );
  assert.equal(visibleEntries(entries).length, 1);
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: " there", messageIndex: 1 }, "shadow"),
  );
  entries = applyChatEvent(entries, event("turn.completed", {}));
  assert.equal(visibleEntries(entries).length, 1);
  // A genuine second completed reply is still retained.
  entries = applyChatEvent(
    entries,
    event("message.final", { text: "Hello there", messageIndex: 1 }, "shadow"),
  );
  assert.equal(visibleEntries(entries).length, 2);
});
test("a partial replay that diverges becomes a separate visible message", () => {
  let entries = history({ text: "Hello there" });
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: "Hello", messageIndex: 1 }, "second"),
  );
  entries = applyChatEvent(
    entries,
    event("message.delta", { delta: " again", messageIndex: 1 }, "second"),
  );
  assert.equal(visibleEntries(entries).length, 2);
});

test("reconnect restores thinking before its answer without duplicating either", () => {
  const initial = historyEntries([
    {
      _id: "saved",
      sessionId: "s",
      role: "assistant",
      text: "Order shipped",
      turnId: "t",
      itemId: "m",
      at: "now",
    },
  ] as any);
  const snapshot = {
    type: "snapshot",
    data: {
      state: { kind: "idle" },
      thinking: [
        {
          id: "r",
          turnId: "t",
          summary: "Checked order status",
          raw: "",
          done: true,
        },
      ],
      messages: [{ id: "m", turnId: "t", text: "Order shipped", final: true }],
    },
  } as any;
  const once = applyChatEvent(initial, snapshot);
  const twice = applyChatEvent(once, snapshot);
  assert.deepEqual(
    twice.map((e) => e.kind),
    ["thinking", "message"],
  );
  assert.equal(
    twice[0].kind === "thinking" && twice[0].text,
    "Checked order status",
  );
});

test("command submissions and structured results survive history plus replayed goal answers", () => {
  const command: Message = {
    _id: "s:command:request",
    clientId: "request",
    sessionId: "s",
    role: "user",
    text: "/goal Write\n a report",
    at: "2026-01-01",
    delivery: "accepted",
    command: {
      method: "thread/goal/set",
      params: { objective: "Write\n a report" },
      state: "succeeded",
      result: {
        goal: {
          objective: "Write\n a report",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
  };
  let entries = historyEntries([command]);
  entries = applyChatEvent(
    entries,
    event(
      "message.final",
      { text: "First answer", messageIndex: 0 },
      "a",
      "t1",
    ),
  );
  entries = applyChatEvent(
    entries,
    event(
      "message.final",
      { text: "Continuation", messageIndex: 0 },
      "b",
      "t2",
    ),
  );
  entries = applyChatEvent(
    entries,
    event(
      "message.final",
      { text: "First answer", messageIndex: 0 },
      "a",
      "t1",
    ),
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "message");
  if (entries[0].kind === "message") {
    assert.equal(entries[0].text, command.text);
    assert.equal(entries[0].command?.result?.goal?.status, "active");
    assert.equal(entries[0].id, "request");
  }
});

test("reconnect preserves completed command results and keeps thinking before the answer", () => {
  const request: Message = {
    _id: "command",
    clientId: "request",
    role: "user",
    sessionId: "s",
    text: "/goal Report",
    at: "2026-01-01",
    command: {
      method: "thread/goal/set",
      params: { objective: "Report" },
      state: "running",
    },
  };
  const answer: Message = {
    _id: "answer",
    role: "assistant",
    sessionId: "s",
    text: "Report ready",
    at: "2026-01-02",
    turnId: "turn",
    itemId: "answer",
  };
  const live: Entry[] = [
    {
      ...historyEntries([request])[0],
      command: { ...request.command!, state: "succeeded" },
    } as Entry,
    {
      kind: "thinking",
      id: "thinking",
      turnId: "turn",
      text: "Considering the request",
      done: true,
    },
    ...historyEntries([answer]),
  ];
  const restored = mergeHistoryEntries([request, answer], live);
  assert.equal(restored.length, 3);
  assert.equal(restored[1].kind, "thinking");
  assert.equal(restored[2].kind, "message");
  if (restored[0].kind === "message")
    assert.equal(restored[0].command?.state, "succeeded");
});

test("resolved approvals stay in the chat after their turn, once", () => {
  const record = {
    requestId: "r1",
    turnId: "turn",
    outcome: "answered" as const,
    items: [
      {
        kind: "toolApproval" as const,
        action: "Get deployed artifact",
        decision: "allowedOnce" as const,
      },
    ],
  };
  const list: Entry[] = [
    { kind: "message", id: "u", role: "user", text: "hi" },
    { kind: "thinking", id: "t", turnId: "turn", text: "…" },
    { kind: "message", id: "later", role: "user", text: "next" },
  ];
  const live = applyChatEvent(
    list,
    event("approval.resolved", { requestId: "r1", audit: record }),
  );
  assert.deepEqual(
    live.map((e) => e.id),
    ["u", "t", "approval:r1", "later"],
  );
  // History reloads merge the same record instead of duplicating it.
  assert.equal(
    addApprovals(live, [record]).filter((e) => e.kind === "approval").length,
    1,
  );
  const merged = mergeHistoryEntries([], live);
  assert.equal(merged.filter((e) => e.kind === "approval").length, 1);
  // Approvals without an audit record (non-input requests) add nothing.
  assert.equal(
    applyChatEvent(list, event("approval.resolved", { requestId: "x" })),
    list,
  );
});

const appRef = (over: Record<string, unknown> = {}) => ({
  id: "A".repeat(32),
  turnId: "turn",
  server: "sap",
  tool: "get_order",
  ...over,
});
const appIds = (list: Entry[]) =>
  list.flatMap((e) => (e.kind === "app" ? [e.app.id] : []));

test("an app appears above the turn's answer, once, however often it is reported", () => {
  // Live: the app arrives while the answer has not started.
  let list = applyChatEvent(
    [],
    event("mcp.app", { app: appRef() }, "A".repeat(32)),
  );
  assert.deepEqual(appIds(list), ["A".repeat(32)]);
  list = applyChatEvent(
    list,
    event("message.delta", { delta: "Order 42 shipped." }, "answer"),
  );
  assert.deepEqual(
    list.map((e) => e.kind),
    ["app", "message"],
  );
  // The same app again (a replayed event, a snapshot) adds nothing.
  list = applyChatEvent(
    list,
    event("mcp.app", { app: appRef() }, "A".repeat(32)),
  );
  list = applyChatEvent(list, event("snapshot", { mcpApps: [appRef()] }));
  assert.deepEqual(appIds(list), ["A".repeat(32)]);
  // When the answer is already shown, the app goes above it.
  const late = applyChatEvent(
    history(),
    event("mcp.app", { app: appRef() }, "x"),
  );
  assert.deepEqual(
    late.map((e) => e.kind),
    ["app", "message"],
  );
});

test("a reloaded conversation brings its apps back from the snapshot", () => {
  const list = applyChatEvent(
    history(),
    event("snapshot", {
      mcpApps: [
        appRef(),
        appRef({ id: "B".repeat(32), turnId: "other", tool: "t2" }),
      ],
      messages: [],
    }),
  );
  assert.deepEqual(appIds(list).sort(), ["A".repeat(32), "B".repeat(32)]);
  const mine = list.findIndex((e) => e.kind === "app" && e.turnId === "turn");
  const answer = list.findIndex(
    (e) => e.kind === "message" && e.turnId === "turn",
  );
  assert.ok(mine >= 0 && mine < answer, "above its own turn's answer");
});

test("app entries are ignored when they are not usable", () => {
  for (const apps of [
    undefined,
    null,
    "x",
    5,
    {},
    [null],
    [{}],
    [{ id: 5 }],
    [{ turnId: "t" }],
  ])
    assert.deepEqual(addApps([], apps), [], JSON.stringify(apps));
  assert.deepEqual(applyChatEvent([], event("mcp.app", {})), []);
  assert.deepEqual(applyChatEvent([], event("mcp.app", { app: null })), []);
});

test("history merged with live events keeps an app above its answer", () => {
  const live = addApps([], [appRef()]);
  const merged = mergeHistoryEntries(
    [
      {
        _id: "saved",
        role: "assistant",
        text: "Done",
        turnId: "turn",
        messageIndex: 0,
      } as Message,
    ],
    live,
  );
  assert.deepEqual(
    merged.map((e) => e.kind),
    ["app", "message"],
  );
  assert.deepEqual(appIds(merged), ["A".repeat(32)]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addApprovals,
  applyChatEvent,
  historyEntries,
  mergeHistoryEntries,
  mergeHistoryWindow,
  upsertMessage,
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

// Compatibility oracle: the prior hydration path delegates to the live merger.
// Keep it here so indexing cannot quietly change alias/legacy matching behavior.
function hydrateWithLiveMerger(messages: Message[]): Entry[] {
  return messages.reduce<Entry[]>((list, m) => {
    if (m.role === "assistant")
      return upsertMessage(list, {
        turnId: m.turnId,
        itemId: m.runtimeItemId || m.itemId,
        aliases: [m.itemId, m.runtimeItemId].filter(Boolean) as string[],
        messageIndex: m.messageIndex,
        text: m.text,
        final: true,
      });
    const id = m.clientId || m.itemId || m._id;
    return list.some((entry) => entry.id === id)
      ? list
      : [
          ...list,
          {
            kind: "message",
            id,
            role: m.role,
            text: m.text,
            turnId: m.turnId,
            delivery: m.delivery,
            command: m.command,
            steer: m.steer,
            final: true,
          },
        ];
  }, []);
}

test("indexed history preserves alias precedence and removes superseded ordinal/text indexes", () => {
  const message = (extra: Partial<Message>): Message => ({
    _id: "saved",
    role: "assistant",
    text: "Same",
    sessionId: "session",
    at: "now",
    turnId: "turn",
    ...extra,
  });
  const messages = [
    message({ itemId: "a", messageIndex: 0 }),
    message({ itemId: "b", messageIndex: 1 }),
    // Identity wins over the conflicting ordinal; now both rows have ordinal 1.
    message({
      itemId: "a",
      runtimeItemId: "runtime-a",
      messageIndex: 1,
      text: "Changed",
    }),
    message({ itemId: "runtime-a", messageIndex: 2, text: "Moved" }),
    // The superseded ordinal 1 must still resolve to b, while ordinal 0 is free.
    message({ itemId: "fresh-b", messageIndex: 1, text: "B final" }),
    message({ itemId: "c", messageIndex: 0, text: "C final" }),
    message({ text: "Same", turnId: "other" }),
    message({ text: "Same", turnId: "other", runtimeItemId: "legacy-adopted" }),
    message({ itemId: "distinct", turnId: "third", text: "Same" }),
  ];
  const entries = historyEntries(messages);
  assert.deepEqual(entries, hydrateWithLiveMerger(messages));
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((entry) => entry.kind === "message" && entry.text),
    ["Moved", "B final", "C final", "Same", "Same"],
  );
});

test("indexed history matches the live merger across deterministic mixed identity collisions", () => {
  let seed = 0x739c24;
  const pick = <T>(values: T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return values[seed % values.length];
  };
  for (let fixture = 0; fixture < 80; fixture++) {
    const messages = Array.from({ length: 80 }, (_, i): Message => ({
      _id: `saved-${i % 5}`,
      sessionId: "session",
      at: "now",
      role: pick(["assistant", "assistant", "user"]),
      text: pick(["Same", "Changed", "", "订单 ✓", "a\u0000b"]),
      turnId: pick([undefined, "turn-a", "turn-b", "__proto__"]),
      itemId: pick([undefined, "", "a", "b", "constructor"]),
      runtimeItemId: pick([undefined, "", "a", "c", "constructor"]),
      messageIndex: pick([undefined, 0, 1, 2, Number.NaN]),
      clientId: pick([undefined, "request", "answer:turn-a:a"]),
      delivery: pick([undefined, "pending", "accepted"]),
      steer: pick([undefined, true, false]),
    }));
    assert.deepEqual(
      historyEntries(messages),
      hydrateWithLiveMerger(messages),
      `fixture ${fixture}`,
    );
  }
});

test("history hydration does not mutate saved messages or collapse distinct same-text items in a large turn", () => {
  const messages = Array.from({ length: 2000 }, (_, i): Message =>
    Object.freeze({
      _id: `saved-${i}`,
      sessionId: "session",
      role: "assistant",
      at: "now",
      itemId: `item-${i}`,
      messageIndex: i,
      turnId: "one-large-turn",
      text: "Same",
    }),
  );
  const entries = historyEntries(messages);
  assert.equal(entries.length, messages.length);
  assert.equal(
    entries.at(-1)?.kind === "message" && entries.at(-1)?.id,
    "answer:one-large-turn:item-1999",
  );
});

const savedMessage = (
  id: string,
  role: "user" | "assistant",
  turnId: string,
  text = id,
): Message => ({
  _id: id,
  itemId: id,
  sessionId: "session",
  role,
  turnId,
  text,
  at: "now",
  ...(role === "user" ? { clientId: id, delivery: "accepted" as const } : {}),
});

test("recent history windows update their rows without moving the loaded older prefix or active tail", () => {
  const a = [
    savedMessage("ua", "user", "a"),
    savedMessage("aa", "assistant", "a"),
  ];
  const b = [
    savedMessage("ub", "user", "b"),
    savedMessage("ab", "assistant", "b"),
  ];
  const live = [
    ...historyEntries([...a, ...b]),
    { kind: "message", id: "uc", role: "user", text: "C", delivery: "pending" },
    { kind: "thinking", id: "rc", turnId: "c", text: "Considering" },
    {
      kind: "message",
      id: "ac",
      role: "assistant",
      itemId: "ac",
      turnId: "c",
      text: "Partial",
      final: false,
    },
  ] as Entry[];
  const result = mergeHistoryWindow(
    [
      b[0],
      { ...b[1], text: "Authoritative B" },
      savedMessage("uc", "user", "c", "C"),
    ],
    live,
  );
  assert.deepEqual(
    result.map((entry) => entry.id),
    live.map((entry) => entry.id),
  );
  assert.equal(result[0], live[0]);
  assert.equal(result[1], live[1]);
  assert.equal(
    result[3].kind === "message" && result[3].text,
    "Authoritative B",
  );
  assert.equal(result[4].kind === "message" && result[4].delivery, "accepted");
  assert.equal(result[5], live[5]);
  assert.equal(result[6], live[6]);
});

test("older pages prepend once and preserve existing anchor, reasoning, helper, and approval objects", () => {
  const live: Entry[] = [
    ...historyEntries([savedMessage("u", "user", "t")]),
    { kind: "thinking", id: "r", turnId: "t", text: "Reasoning", done: true },
    { kind: "agents", id: "helpers", turnId: "t", threadIds: ["helper"] },
    ...historyEntries([savedMessage("a", "assistant", "t")]),
    {
      kind: "approval",
      id: "approval:r",
      turnId: "t",
      record: {
        requestId: "r",
        turnId: "t",
        outcome: "answered",
        items: [],
      },
    },
  ];
  const page = [
    savedMessage("older-u", "user", "older"),
    savedMessage("older-a", "assistant", "older"),
  ];
  const result = mergeHistoryWindow(page, live, { older: true });
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["older-u", "answer:older:older-a", ...live.map((entry) => entry.id)],
  );
  assert.equal(result.length, live.length + 2);
  live.forEach((entry, i) => assert.equal(result[i + 2], entry));
  assert.equal(mergeHistoryWindow(page, result, { older: true }), result);
});

test("a persisted final adopts stream aliases and keeps its stable row ID", () => {
  const live: Entry[] = [
    {
      kind: "message",
      id: "stable-row",
      role: "assistant",
      itemId: "runtime-before",
      aliases: ["stored"],
      turnId: "t",
      text: "Part",
      final: false,
    },
  ];
  const saved = {
    ...savedMessage("stored", "assistant", "t", "Complete"),
    runtimeItemId: "runtime-after",
    messageIndex: 0,
  };
  const result = mergeHistoryWindow([saved], live);
  assert.equal(result.length, 1);
  const answer = result[0];
  assert.equal(answer.id, "stable-row");
  if (answer.kind === "message") {
    assert.equal(answer.text, "Complete");
    assert.equal(answer.final, true);
    assert.equal(answer.itemId, "runtime-after");
    assert.deepEqual(answer.aliases, [
      "stored",
      "runtime-before",
      "runtime-after",
    ]);
  }
  assert.equal(mergeHistoryWindow([saved], result), result);
});

test("history accepts a pending user without downgrading a terminal command result", () => {
  const live: Entry[] = [
    {
      kind: "message",
      id: "client",
      role: "user",
      text: "/goal Report",
      delivery: "pending",
      command: {
        method: "thread/goal/set",
        params: {},
        state: "succeeded",
        result: { sessionId: "created-session" },
      },
    },
  ];
  const message: Message = {
    ...savedMessage("stored-user", "user", "t", "/goal Report"),
    clientId: "client",
    command: { method: "thread/goal/set", params: {}, state: "running" },
  };
  const result = mergeHistoryWindow([message], live);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "client");
  assert.equal(result[0].kind === "message" && result[0].delivery, "accepted");
  assert.equal(
    result[0].kind === "message" && result[0].command,
    live[0].kind === "message" && live[0].command,
  );
});

test("a delta received during an older fetch remains live after the page is prepended", () => {
  const live = applyChatEvent(
    historyEntries([savedMessage("u", "user", "t")]),
    event("message.delta", { delta: "Hel" }, "answer", "t"),
  );
  const advanced = applyChatEvent(
    live,
    event("message.delta", { delta: "lo" }, "answer", "t"),
  );
  const result = mergeHistoryWindow(
    [
      savedMessage("old-u", "user", "old"),
      savedMessage("old-a", "assistant", "old"),
    ],
    advanced,
    { older: true },
  );
  assert.equal(result.at(-1), advanced.at(-1));
  assert.equal(
    result.at(-1)?.kind === "message" &&
      (result.at(-1) as Extract<Entry, { kind: "message" }>).text,
    "Hello",
  );
  assert.equal(
    result.at(-1)?.kind === "message" &&
      (result.at(-1) as Extract<Entry, { kind: "message" }>).final,
    false,
  );
});

test("new recent rows fit before a pending active tail even when their window has no shared row", () => {
  const live: Entry[] = [
    ...historyEntries([
      savedMessage("a-u", "user", "a"),
      savedMessage("a-a", "assistant", "a"),
    ]),
    {
      kind: "message",
      id: "c-u",
      role: "user",
      text: "C",
      delivery: "pending",
    },
    { kind: "thinking", id: "c-r", turnId: "c", text: "Working" },
  ];
  const result = mergeHistoryWindow(
    [savedMessage("b-u", "user", "b"), savedMessage("b-a", "assistant", "b")],
    live,
  );
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["a-u", "answer:a:a-a", "b-u", "answer:b:b-a", "c-u", "c-r"],
  );
  assert.equal(result[0], live[0]);
  assert.equal(result[4], live[2]);
});

test("a newly persisted answer stays after reasoning/helpers and before a trailing resolved approval", () => {
  const user = savedMessage("u", "user", "t");
  const live: Entry[] = [
    ...historyEntries([user]),
    { kind: "thinking", id: "r", turnId: "t", text: "Considering", done: true },
    { kind: "agents", id: "helpers", turnId: "t", threadIds: ["helper"] },
    {
      kind: "approval",
      id: "approval:r",
      turnId: "t",
      record: {
        requestId: "r",
        turnId: "t",
        outcome: "answered",
        items: [],
      },
    },
    {
      kind: "message",
      id: "later",
      role: "user",
      text: "Next",
      delivery: "pending",
    },
  ];
  const result = mergeHistoryWindow(
    [user, savedMessage("a", "assistant", "t")],
    live,
  );
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["u", "r", "helpers", "answer:t:a", "approval:r", "later"],
  );
  assert.equal(result[1], live[1]);
  assert.equal(result[4], live[3]);
});

test("empty or repeated windows leave the transcript reference unchanged", () => {
  const messages = [
    savedMessage("u", "user", "t"),
    savedMessage("a", "assistant", "t"),
  ];
  const entries = historyEntries(messages);
  assert.equal(mergeHistoryWindow([], entries), entries);
  assert.equal(mergeHistoryWindow(messages, entries), entries);
});

test("a stale history response cannot replace newer SSE text or finalize its live stream", () => {
  const saved = savedMessage("answer", "assistant", "t", "Hello");
  for (const final of [false, true]) {
    const live: Entry[] = [
      {
        kind: "message",
        id: "stable",
        itemId: "answer",
        aliases: ["answer"],
        role: "assistant",
        turnId: "t",
        text: "Hello world",
        final,
      },
    ];
    const result = mergeHistoryWindow([saved], live, { preserveLive: true });
    assert.equal(result, live);
    assert.equal(result[0].kind === "message" && result[0].text, "Hello world");
    assert.equal(result[0].kind === "message" && result[0].final, final);
    assert.equal(mergeHistoryWindow([saved], live, { older: true }), live);
  }
});

test("history can finalize a cached partial when no new live event arrived during its request", () => {
  const live: Entry[] = [
    {
      kind: "message",
      id: "stable",
      itemId: "answer",
      role: "assistant",
      turnId: "t",
      text: "Hel",
      final: false,
    },
  ];
  const result = mergeHistoryWindow(
    [savedMessage("answer", "assistant", "t", "Hello")],
    live,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "stable");
  assert.equal(result[0].kind === "message" && result[0].text, "Hello");
  assert.equal(result[0].kind === "message" && result[0].final, true);
});

test("legacy unfinished reasoning before a saved final does not move new recent rows ahead of old history", () => {
  const live: Entry[] = [
    ...historyEntries([savedMessage("a-u", "user", "a")]),
    {
      kind: "thinking",
      id: "legacy-reason",
      turnId: "a",
      text: "Old reasoning",
    },
    ...historyEntries([savedMessage("a-a", "assistant", "a")]),
    {
      kind: "message",
      id: "c-u",
      role: "user",
      text: "Waiting",
      delivery: "accepted",
    },
  ];
  const result = mergeHistoryWindow(
    [savedMessage("b-u", "user", "b"), savedMessage("b-a", "assistant", "b")],
    live,
  );
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["a-u", "legacy-reason", "answer:a:a-a", "b-u", "answer:b:b-a", "c-u"],
  );
});

test("older rows with a reused turn ID prepend without adopting an unrelated active item", () => {
  const live: Entry[] = [
    {
      kind: "message",
      id: "steer",
      role: "user",
      turnId: "shared-turn",
      text: "Follow up",
      delivery: "accepted",
    },
    {
      kind: "message",
      id: "active",
      itemId: "new-item",
      role: "assistant",
      turnId: "shared-turn",
      text: "New partial",
      final: false,
    },
  ];
  const page = [
    savedMessage("old-user", "user", "shared-turn"),
    savedMessage("old-item", "assistant", "shared-turn", "Old final"),
  ];
  const result = mergeHistoryWindow(page, live, { older: true });
  assert.deepEqual(
    result.map((entry) => entry.id),
    ["old-user", "answer:shared-turn:old-item", "steer", "active"],
  );
  assert.equal(result[3], live[1]);
});

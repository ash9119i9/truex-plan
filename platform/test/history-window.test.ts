import { test } from "node:test";
import assert from "node:assert/strict";
import { historyAnchor, historyWindow } from "../src/history-window";
import {
  publicSnapshot,
  recentSnapshot,
  PublicEventStream,
} from "../src/public";
import { orderConversation } from "../../shared/command-history";
import type { Message } from "../../shared/contracts";

const at = "2026-10-05T00:00:00.000Z";
function transcript(count: number) {
  const messages: Message[] = [];
  for (let index = 0; index < count; index++) {
    const turnId = `turn-${index}`;
    messages.push(
      {
        _id: `user-${index}`,
        sessionId: "s",
        role: "user",
        text: `Question ${index}`,
        turnId,
        order: index * 2,
        at,
      },
      {
        _id: `answer-${index}`,
        sessionId: "s",
        role: "assistant",
        text: `Answer ${index}`,
        turnId,
        order: index * 2 + 1,
        at,
      },
    );
    if (index % 7 === 0)
      messages.push({
        _id: `command-${index}`,
        sessionId: "s",
        role: "user",
        text: "/goal",
        turnId,
        at,
        command: {
          clientId: `cmd-${index}`,
          method: "thread/goal/get",
          params: {},
          state: "succeeded",
          afterMessageId: `user-${index}`,
        },
      });
  }
  return orderConversation(messages);
}
const encode = (sessionId: string, beforeMessageId: string) =>
  Buffer.from(JSON.stringify({ sessionId, beforeMessageId })).toString(
    "base64url",
  );

test("recent ten requests and older twenty preserve same-time runtime order and command anchors without gaps", () => {
  const ordered = transcript(65);
  let page = historyWindow(ordered, "s");
  assert.equal(
    page.messages.filter((m) => m.role === "user" && !m.command).length,
    10,
  );
  assert.equal(page.messages[0]._id, "user-55");
  let merged = page.messages;
  const sizes: number[] = [];
  while (page.historyWindow.hasOlder) {
    page = historyWindow(
      ordered,
      "s",
      historyAnchor("s", page.historyWindow.beforeCursor),
    );
    sizes.push(
      page.messages.filter((m) => m.role === "user" && !m.command).length,
    );
    merged = [...page.messages, ...merged];
  }
  assert.deepEqual(sizes, [20, 20, 15]);
  assert.deepEqual(merged, ordered);
  assert.equal(new Set(merged.map((m) => m._id)).size, ordered.length);
});

test("newest inserts do not shift an anchored older page", () => {
  const original = transcript(65);
  const cursor = historyWindow(original, "s").historyWindow.beforeCursor;
  assert.deepEqual(
    historyWindow(transcript(66), "s", historyAnchor("s", cursor)).messages,
    historyWindow(original, "s", historyAnchor("s", cursor)).messages,
  );
});

test("empty, short, command-only and leading assistant histories remain readable", () => {
  assert.deepEqual(historyWindow([], "s"), {
    messages: [],
    historyWindow: { hasOlder: false, beforeCursor: null },
  });
  const short = transcript(10);
  const leading: Message = {
    _id: "leading",
    sessionId: "s",
    role: "assistant",
    text: "Imported context",
    at,
  };
  assert.deepEqual(historyWindow([leading, ...short], "s").messages, [
    leading,
    ...short,
  ]);
  const commandOnly = short.filter((m) => m.command);
  assert.deepEqual(historyWindow(commandOnly, "s").messages, commandOnly);
});

test("malformed and cross-session cursors fail validation; a removed anchor produces actionable conflict", () => {
  for (const invalid of [
    null,
    {},
    [],
    "",
    "not-json",
    "!",
    "x".repeat(2049),
    encode("another", "user-1"),
    encode("s", ""),
    encode("s", "x".repeat(501)),
  ])
    assert.throws(
      () => historyAnchor("s", invalid),
      (error: any) =>
        error.status === 400 && error.code === "INVALID_HISTORY_CURSOR",
    );
  assert.equal(historyAnchor("s", undefined), undefined);
  assert.throws(
    () =>
      historyWindow(
        transcript(10),
        "s",
        historyAnchor("s", encode("s", "missing")),
      ),
    (error: any) =>
      error.status === 409 &&
      error.code === "HISTORY_CURSOR_STALE" &&
      /Reopen/.test(error.message),
  );
});

test("recent snapshots retain complete newest turns and active reasoning while preserving actions and state", () => {
  const projected = publicSnapshot({
    cursor: "g:20",
    state: { kind: "running", turnId: "active-old" },
    messages: [
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `a-${i}`,
        turnId: `turn-${i}`,
        text: `Answer ${i}`,
      })),
      {
        id: "active-answer",
        turnId: "active-old",
        text: "In flight",
        final: false,
      },
      { id: "another-answer", turnId: "turn-14", text: "Same newest turn" },
    ],
    thinking: [
      { id: "old", turnId: "turn-0", raw: "Old" },
      { id: "new", turnId: "turn-14", raw: "New" },
      { id: "active", turnId: "active-old", raw: "Working" },
    ],
    pending: [
      {
        requestId: "request",
        method: "item/tool/requestUserInput",
        detail: {},
        expiresAt: at,
        responseSchema: null,
      },
    ],
    goal: { objective: "Finish", status: "active" },
    plan: [{ step: "Working", status: "inProgress" }],
  });
  const recent = recentSnapshot(projected);
  assert.equal(new Set(recent.messages.map((m: any) => m.turnId)).size, 10);
  assert.ok(recent.messages.some((m: any) => m.id === "active-answer"));
  assert.ok(recent.messages.some((m: any) => m.id === "another-answer"));
  assert.deepEqual(
    recent.thinking.map((entry: any) => entry.id),
    ["new", "active"],
  );
  assert.deepEqual(recent.pending, projected.pending);
  assert.deepEqual(recent.goal, projected.goal);
  assert.deepEqual(recent.state, projected.state);
  assert.deepEqual(recent.plan, projected.plan);
  assert.equal(recent.cursor, projected.cursor);
  const loaded = recentSnapshot(projected, new Set(["turn-0"]));
  assert.deepEqual(
    new Set(loaded.messages.map((m: any) => m.turnId)),
    new Set(["turn-0", "active-old"]),
  );
  assert.deepEqual(
    loaded.thinking.map((entry: any) => entry.id),
    ["old", "active"],
  );
});

test("stream projection bounds snapshot content without changing subsequent events or frame cursors", () => {
  const snapshot = {
    type: "snapshot",
    cursor: "g:20",
    data: {
      state: { kind: "idle" },
      messages: Array.from({ length: 15 }, (_, i) => ({
        id: `a-${i}`,
        turnId: `turn-${i}`,
        text: `Answer ${i}`,
      })),
    },
  };
  const stream = new PublicEventStream((event) =>
    event.type === "snapshot"
      ? { ...event, data: recentSnapshot(event.data) }
      : undefined,
  );
  const output = stream.push(
    new TextEncoder().encode(
      `id: g:20\ndata: ${JSON.stringify(snapshot)}\n\nid: g:21\ndata: ${JSON.stringify({ type: "message.delta", cursor: "g:21", turnId: "turn-14", itemId: "a-14", data: { delta: "!" } })}\n\n`,
    ),
  );
  const events = output
    .trim()
    .split("\n\n")
    .map((frame) =>
      JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data:"))!
          .slice(5),
      ),
    );
  assert.equal(events[0].data.messages.length, 10);
  assert.equal(events[0].data.messages[0].turnId, "turn-5");
  assert.equal(events[1].data.delta, "!");
  assert.match(output, /id: g:20/);
  assert.match(output, /id: g:21/);
});

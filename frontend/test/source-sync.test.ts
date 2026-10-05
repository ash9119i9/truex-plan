import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceSourceSync,
  beginSourceSync,
  overlaySourceEntries,
  readSyncMarker,
  sourceCursor,
  SynchronizationWaiter,
} from "../lib/source-sync.ts";
import type { DomainEvent, Snapshot } from "../../shared/contracts.ts";
import { applyChatEvent, mergeHistoryWindow, type Entry } from "../lib/chat.ts";

const snapshot = (sequence = 10): DomainEvent => ({
  type: "snapshot",
  threadId: "runtime-thread",
  seq: sequence,
  cursor: `generation:${sequence}`,
  at: "2026-10-05T00:00:00Z",
  data: {
    cursor: `generation:${sequence}`,
    state: { kind: "running", turnId: "turn" },
    pending: [],
    messages: [
      {
        id: "answer",
        turnId: "turn",
        text: "A",
        final: false,
        messageIndex: 0,
      },
    ],
    thinking: [
      { id: "reasoning", turnId: "turn", raw: "R", summary: "", done: false },
    ],
    plan: [],
    timings: [],
    subAgents: [],
  },
});
const marker = (
  mode: "snapshot" | "replay",
  sequence = 10,
  fromCursor: string | null = null,
): DomainEvent => ({
  type: "sync.completed",
  threadId: "runtime-thread",
  seq: sequence,
  cursor: `generation:${sequence}`,
  at: "2026-10-05T00:00:00Z",
  data: {
    protocol: 1,
    mode,
    fromCursor,
    highWaterCursor: `generation:${sequence}`,
    snapshot: { ...snapshot(sequence).data, messages: [], thinking: [] },
  },
});
const delta = (sequence: number, text: string): DomainEvent => ({
  type: "message.delta",
  threadId: "runtime-thread",
  seq: sequence,
  cursor: `generation:${sequence}`,
  at: "2026-10-05T00:00:00Z",
  turnId: "turn",
  itemId: "answer",
  data: { delta: text, messageIndex: 0 },
});
const fresh = () =>
  advanceSourceSync(beginSourceSync(null, true), [
    snapshot(),
    marker("snapshot"),
  ]).state;

test("canonical safe cursors reject zero padding, unsafe integers and malformed generations", () => {
  for (const value of [
    null,
    "generation:01",
    "generation:-1",
    "generation:1.0",
    "generation:9007199254740992",
    ":1",
    "a:b:1",
  ])
    assert.equal(sourceCursor(value), null, String(value));
  assert.deepEqual(sourceCursor("generation:0"), {
    generation: "generation",
    sequence: 0,
  });
});

test("a marker during HTTP recovery never makes a mixed durable display eligible", () => {
  const early = advanceSourceSync(beginSourceSync(null), [
    snapshot(),
    marker("snapshot"),
  ]);
  assert.equal(early.state.phase, "cold");
  assert.equal(early.state.pair, null);
  const handoff = advanceSourceSync(beginSourceSync(null, true), [
    marker("snapshot"),
  ]);
  assert.equal(handoff.failure, "invalid_marker");
  const valid = fresh();
  assert.equal(valid.phase, "ready");
  assert.equal(valid.pair?.cursor, "generation:10");
  assert.deepEqual(
    valid.pair?.entries.map((entry) => entry.kind),
    ["thinking", "message"],
  );
});

test("zero-gap warm replay restores running/pending authority without another transcript snapshot", () => {
  const pair = fresh().pair!;
  const event = marker("replay", 10, pair.cursor);
  event.data.snapshot.pending = [
    {
      requestId: "approval",
      method: "tool",
      detail: { action: "fixture" },
      expiresAt: "2026-10-05T00:01:00Z",
      responseSchema: null,
    },
  ];
  const warm = advanceSourceSync(beginSourceSync(pair), [event]);
  assert.equal(warm.failure, null);
  assert.equal(warm.state.phase, "ready");
  assert.equal(warm.operational?.state.kind, "running");
  assert.equal(warm.operational?.pending[0].requestId, "approval");
  assert.deepEqual(warm.state.pair?.entries, pair.entries);
});

test("missing deltas apply once before same-cursor marker; public filtered sequence gaps are allowed", () => {
  const current = beginSourceSync(fresh().pair);
  const next = advanceSourceSync(current, [
    delta(11, "B"),
    delta(13, "C"),
    marker("replay", 14, "generation:10"),
  ]);
  assert.equal(next.failure, null);
  assert.equal(next.state.pair?.cursor, "generation:14");
  assert.equal(
    next.state.pair?.entries.find((entry) => entry.kind === "message")?.text,
    "ABC",
  );
  assert.equal(current.pair?.cursor, "generation:10");
  const repeated = advanceSourceSync(next.state, [delta(13, "C")]);
  assert.equal(repeated.accepted.length, 0);
  assert.equal(
    repeated.state.pair?.entries.find((entry) => entry.kind === "message")
      ?.text,
    "ABC",
  );
});

test("wrong marker envelope, thread, generation, mode and coverage fail closed with no partial pair", () => {
  for (const change of [
    (event: DomainEvent) => {
      event.data.protocol = 2;
    },
    (event: DomainEvent) => {
      event.data.fromCursor = "generation:9";
    },
    (event: DomainEvent) => {
      event.data.highWaterCursor = "generation:12";
    },
    (event: DomainEvent) => {
      event.threadId = "wrong-thread";
    },
    (event: DomainEvent) => {
      event.data.snapshot.messages = [{ id: "mixed", text: "HTTP" }];
    },
    (event: DomainEvent) => {
      event.data.snapshot.pending = null;
    },
    (event: DomainEvent) => {
      event.data.mode = "snapshot";
    },
  ]) {
    const current = beginSourceSync(fresh().pair);
    const event = marker("replay", 11, "generation:10");
    change(event);
    const failed = advanceSourceSync(current, [delta(11, "B"), event]);
    assert.ok(failed.failure);
    assert.equal(failed.state.pair, null);
    assert.deepEqual(failed.accepted, []);
    assert.equal(
      current.pair?.entries.find((entry) => entry.kind === "message")?.text,
      "A",
    );
  }
  const restart = delta(11, "B");
  restart.cursor = "new-generation:11";
  assert.equal(
    advanceSourceSync(beginSourceSync(fresh().pair), [restart]).failure,
    "generation_changed",
  );
  assert.equal(
    advanceSourceSync(beginSourceSync(fresh().pair), [snapshot()]).failure,
    "unexpected_snapshot",
  );
});

test("oversized source projection is disqualified rather than silently truncated", () => {
  const next = advanceSourceSync(beginSourceSync(fresh().pair), [
    delta(11, "x".repeat(4_194_304)),
  ]);
  assert.equal(next.failure, "projection_limit");
  assert.equal(next.state.pair, null);
});

test("display overlays retain durable commands/users while the source pair stays isolated", () => {
  const pair = fresh().pair!;
  const display: Entry[] = [
    { kind: "message", id: "durable-user", role: "user", text: "User" },
    {
      kind: "message",
      id: "command",
      role: "user",
      text: "Goal",
      command: { method: "thread/goal/set", params: {} } as any,
    },
  ];
  const merged = overlaySourceEntries(display, pair.entries);
  assert.equal(merged[0], display[0]);
  assert.equal(merged[1], display[1]);
  assert.equal(
    (
      merged.find(
        (entry) => entry.kind === "message" && entry.role === "assistant",
      ) as Extract<Entry, { kind: "message" }>
    )?.text,
    "A",
  );
  assert.ok(
    pair.entries.every(
      (entry) => entry.kind !== "message" || entry.role === "assistant",
    ),
  );
  const duplicate = overlaySourceEntries(merged, pair.entries);
  assert.equal(duplicate.length, merged.length);
});

test("operational marker state requires coherent source cursor and valid running state", () => {
  const event = marker("snapshot");
  assert.ok(readSyncMarker(event));
  event.data.snapshot.cursor = "generation:9";
  assert.equal(readSyncMarker(event), null);
  event.data.snapshot.cursor = "generation:10";
  delete event.data.snapshot.state.turnId;
  assert.equal(readSyncMarker(event), null);
});

test("readiness deadlines, navigation cancellation and stale markers are deterministic", async () => {
  let run: (() => void) | null = null;
  const waiter = new SynchronizationWaiter((callback, milliseconds) => {
    assert.equal(milliseconds, 5000);
    run = callback;
    return () => {
      if (run === callback) run = null;
    };
  });
  const first = waiter.wait("A", 1);
  const second = waiter.wait("B", 2);
  assert.equal(await first, false);
  waiter.complete("A", 1);
  assert.ok(run);
  waiter.complete("B", 2);
  assert.equal(await second, true);
  const timeout = waiter.wait("B", 3);
  (run as unknown as () => void)();
  assert.equal(await timeout, false);
  const cancelled = waiter.wait("B", 4);
  waiter.cancel();
  assert.equal(await cancelled, false);
});

test("overlay preserves reasoning fallback identity and accepts its next itemless delta", () => {
  const initial = advanceSourceSync(fresh(), [
    {
      ...delta(11, "ignored"),
      type: "reasoning.delta",
      itemId: undefined,
      data: { delta: "fallback" },
    },
  ]);
  assert.equal(initial.failure, null);
  const source = initial.state.pair!.entries;
  const display = overlaySourceEntries([], source);
  const fallback = source.find(
    (entry) => entry.kind === "thinking" && !entry.itemId,
  )!;
  assert.equal(display.filter((entry) => entry.id === fallback.id).length, 1);
  const nextEvent: DomainEvent = {
    ...delta(12, "ignored"),
    type: "reasoning.delta",
    itemId: undefined,
    data: { delta: " suffix" },
  };
  const next = advanceSourceSync(initial.state, [nextEvent]);
  const overlay = overlaySourceEntries(display, next.state.pair!.entries);
  assert.equal(overlay.filter((entry) => entry.id === fallback.id).length, 1);
  const latest = overlay.find((entry) => entry.id === fallback.id);
  assert.ok(latest?.kind === "thinking");
  assert.equal(latest.text, "fallback suffix");
});

test("implicit EventSource reconnect marker cannot silently reuse the original replay boundary", () => {
  const warm = advanceSourceSync(beginSourceSync(fresh().pair), [
    marker("replay", 10, "generation:10"),
  ]);
  const advanced = advanceSourceSync(warm.state, [delta(11, "suffix")]);
  const reconnect = advanceSourceSync(advanced.state, [
    marker("replay", 11, "generation:11"),
  ]);
  assert.equal(reconnect.failure, "invalid_marker");
  assert.equal(reconnect.state.pair, null);
  assert.deepEqual(reconnect.accepted, []);
});

test("long-history cold hydration and repeated warm overlays preserve every request/answer order and identity", () => {
  const history: any[] = Array.from({ length: 1000 }, (_, index) => ({
    _id: `message-${index}`,
    clientId: index % 2 ? undefined : `client-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `${index % 2 ? "reply" : "question"} ${index}`,
    turnId: `turn-${Math.floor(index / 2)}`,
    itemId: `item-${index}`,
    runtimeItemId: index % 2 ? `item-${index}` : undefined,
    messageIndex: index % 2 ? 0 : undefined,
  }));
  const recent = history.slice(-20);
  const sourceSnapshotEvent: DomainEvent = {
    ...snapshot(),
    data: {
      ...snapshot().data,
      state: { kind: "idle" },
      thinking: [],
      messages: recent
        .filter((m) => m.role === "assistant")
        .map((m) => ({
          id: m.itemId,
          turnId: m.turnId,
          text: m.text,
          final: true,
          messageIndex: 0,
        })),
    },
  };
  const source = advanceSourceSync(beginSourceSync(null, true), [
    sourceSnapshotEvent,
    marker("snapshot"),
  ]);
  assert.equal(source.failure, null);
  let display = applyChatEvent([], sourceSnapshotEvent);
  display = mergeHistoryWindow(recent, display, { preserveLive: true });
  const expected = recent.map((m) => m.text);
  assert.deepEqual(
    display.map((e: any) => e.text),
    expected,
  );
  const ids = display.map((e) => e.id);
  const users = display.filter(
    (e) => e.kind === "message" && e.role === "user",
  );
  for (let iteration = 0; iteration < 30; iteration++) {
    const resumed = advanceSourceSync(beginSourceSync(source.state.pair), [
      marker("replay", 10, "generation:10"),
    ]);
    display = overlaySourceEntries(
      mergeHistoryWindow(recent, display),
      resumed.state.pair!.entries,
    );
    assert.deepEqual(
      display.map((e: any) => e.text),
      expected,
    );
    assert.deepEqual(
      display.map((e) => e.id),
      ids,
    );
    assert.deepEqual(
      display.filter((e) => e.kind === "message" && e.role === "user"),
      users,
    );
  }
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { coalesceChatEvents } from "../lib/chat-batch.ts";
import { applyChatEvent, type Entry } from "../lib/chat.ts";
import type { DomainEvent } from "../../shared/contracts.ts";
import { transport } from "../lib/transport.ts";
import { advanceSourceSync, type SourceSync } from "../lib/source-sync.ts";

let seq = 0;
function event(
  type: DomainEvent["type"] = "message.delta",
  data: DomainEvent["data"] = { delta: "x", messageIndex: 0 },
  identity: Partial<DomainEvent> = {},
): DomainEvent {
  return {
    type,
    data,
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    seq: ++seq,
    cursor: `c${seq}`,
    at: "2026-10-05T00:00:00.000Z",
    ...identity,
  };
}

function oracle(events: DomainEvent[], initial: Entry[] = []) {
  const before = structuredClone({ events, initial });
  const expected = events.reduce(applyChatEvent, initial);
  const projected = coalesceChatEvents(events);
  const actual = projected.reduce(applyChatEvent, initial);
  assert.deepEqual(actual, expected);
  assert.deepEqual({ events, initial }, before, "inputs must remain unchanged");
  return { actual, projected };
}

test("1000 compatible answer deltas use one projection application with exact state", () => {
  const events = Array.from({ length: 1000 }, () => event());
  const { actual, projected } = oracle(events);
  assert.equal(projected.length, 1);
  assert.equal(actual.length, 1);
  assert.equal(
    actual[0].kind === "message" && actual[0].text,
    "x".repeat(1000),
  );
  assert.equal(events.length, 1000);
  assert.equal(events.at(-1)?.cursor, `c${seq}`);
});

const reasoning = (
  delta = "x",
  data: Record<string, unknown> = {},
  identity: Partial<DomainEvent> = {},
) =>
  event(
    "reasoning.delta",
    { delta, method: "item/reasoning/textDelta", ...data },
    { itemId: "reason", ...identity },
  );

test("1000 adjacent reasoning fragments coalesce per exact raw or summary channel", () => {
  for (const method of [
    undefined,
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
  ]) {
    const { actual, projected } = oracle(
      Array.from({ length: 1000 }, () => reasoning("x", { method })),
    );
    assert.equal(projected.length, 1);
    assert.equal(
      actual[0].kind === "thinking" && actual[0].text,
      "x".repeat(1000),
    );
  }
});

test("reasoning identities, channels, indexed parts and ordinals are ordering boundaries", () => {
  const variations = [
    reasoning("b", {}, { threadId: "other" }),
    reasoning("b", {}, { turnId: "other" }),
    reasoning("b", {}, { itemId: "other" }),
    reasoning("b", { method: "item/reasoning/summaryTextDelta" }),
    reasoning("b", { method: undefined }),
    reasoning("b", { channel: "content" }),
    reasoning("b", { contentIndex: 0 }),
    reasoning("b", { summaryIndex: 0 }),
    reasoning("b", { messageIndex: 0 }),
  ];
  for (const middle of variations) {
    const { projected } = oracle([
      reasoning("a"),
      reasoning("a"),
      middle,
      reasoning("c"),
      reasoning("c"),
    ]);
    assert.equal(projected.length, 3);
    assert.equal(projected[1], middle);
  }
  const { projected } = oracle([
    reasoning("a", {
      contentIndex: 2,
      summaryIndex: 0,
      messageIndex: 1,
      channel: "content",
      itemId: "reason",
    }),
    reasoning("b", {
      contentIndex: 2,
      summaryIndex: 0,
      messageIndex: 1,
      channel: "content",
      itemId: "reason",
    }),
    reasoning("c", {
      contentIndex: 3,
      summaryIndex: 0,
      messageIndex: 1,
      channel: "content",
      itemId: "reason",
    }),
    reasoning("d", {
      contentIndex: 3,
      summaryIndex: 1,
      messageIndex: 1,
      channel: "content",
      itemId: "reason",
    }),
    reasoning("e", {
      contentIndex: 3,
      summaryIndex: 1,
      messageIndex: 1,
      channel: "summary",
      itemId: "reason",
    }),
  ]);
  assert.deepEqual(
    projected.map((frame) => frame.data.delta),
    ["ab", "c", "d", "e"],
  );
});

test("reasoning malformed identities, channels, signals and payloads remain passthrough", () => {
  const frames = [
    ...[undefined, ""].flatMap((missing) => [
      reasoning("x", {}, { threadId: missing }),
      reasoning("x", {}, { turnId: missing }),
      reasoning("x", {}, { itemId: missing }),
    ]),
    ...[null, -1, 0.5, NaN, Infinity, "0", {}].flatMap((value) =>
      ["messageIndex", "summaryIndex", "contentIndex"].map((key) =>
        reasoning("x", { [key]: value }),
      ),
    ),
    ...[null, 1, {}].map((channel) => reasoning("x", { channel })),
    reasoning("x", { method: "unknown" }),
    reasoning("x", { signals: [] }),
    reasoning("x", { status: "done" }),
    reasoning("x", { done: true }),
    reasoning("x", { itemId: "conflicting" }),
    ...[{}, { delta: null }, { delta: 5 }, [], null, undefined].map(
      (data) => ({ ...reasoning(), data }) as DomainEvent,
    ),
  ];
  for (const frame of frames) {
    const input = [reasoning(), frame, frame, reasoning()];
    const projected = coalesceChatEvents(input);
    assert.equal(projected.length, 4);
    assert.equal(projected[1], frame);
    let expected: Entry[] | undefined;
    let failure: unknown;
    try {
      expected = input.reduce(applyChatEvent, []);
    } catch (error) {
      failure = error;
    }
    if (failure instanceof Error)
      assert.throws(() => projected.reduce(applyChatEvent, []), {
        name: failure.name,
        message: failure.message,
      });
    else assert.deepEqual(projected.reduce(applyChatEvent, []), expected);
  }
});

test("reasoning final, tool, snapshot, turn, answer and approval frames remain barriers", () => {
  const barriers = [
    event("message.delta", { delta: "answer" }),
    event("message.final", { text: "answer" }),
    event(
      "item.started",
      { item: { type: "reasoning", id: "reason" } },
      { itemId: "reason" },
    ),
    event(
      "item.completed",
      { item: { type: "reasoning", id: "reason", summary: ["final"] } },
      { itemId: "reason" },
    ),
    event("item.completed", { item: { type: "tool", id: "tool" } }),
    event("turn.completed", {}),
    event("turn.started", {}),
    event("snapshot", { messages: [], state: { kind: "idle" } }),
    event("approval.requested", {}),
    event("error", {}),
    event("resync.required", {}),
  ];
  for (const barrier of barriers) {
    const { projected } = oracle([
      reasoning("a"),
      reasoning("b"),
      barrier,
      reasoning("c"),
      reasoning("d"),
    ]);
    assert.equal(projected.length, 3);
    assert.equal(projected[1], barrier);
  }
});

test("late, completed, Unicode and interleaved reasoning preserve the full reducer oracle", () => {
  const initial = oracle([
    event("message.final", { text: "Saved answer" }),
    reasoning("prefix:"),
  ]).actual;
  for (const done of [false, true]) {
    const entries = initial.map((entry) =>
      entry.kind === "thinking" ? { ...entry, done } : entry,
    );
    const { projected } = oracle(
      [
        reasoning("\ud83d"),
        reasoning("\ude00\u0000界"),
        reasoning(""),
        reasoning("summary", { method: "item/reasoning/summaryTextDelta" }),
        event("message.delta", { delta: "answer" }),
        reasoning("tail"),
        reasoning("end"),
      ],
      entries,
    );
    assert.equal(projected.length, 4);
  }
});

test("source projection retains original cursor accounting across reasoning batches and stale replays", () => {
  let state: SourceSync = {
    phase: "ready",
    fromCursor: null,
    snapshotCursor: null,
    pair: { protocol: 1, threadId: "thread", cursor: "g:0", entries: [] },
  };
  const input = [
    reasoning("a"),
    reasoning("b"),
    reasoning("c", { method: "item/reasoning/summaryTextDelta" }),
    reasoning("d", { method: "item/reasoning/summaryTextDelta" }),
    event(),
    event(),
    event(
      "item.completed",
      { item: { id: "reason", type: "reasoning", summary: ["final"] } },
      { itemId: "reason" },
    ),
    reasoning("ignored"),
    reasoning("ignored"),
    event("turn.completed", {}),
  ].map((frame, index) => ({
    ...frame,
    seq: index + 1,
    cursor: `g:${index + 1}`,
  }));
  let expected: Entry[] = [];
  for (const batch of [
    input.slice(0, 2),
    [input[1], input[0], ...input.slice(2, 6)],
    input.slice(6),
  ]) {
    const result = advanceSourceSync(state, batch);
    assert.equal(result.failure, null);
    expected = result.accepted.reduce(applyChatEvent, expected);
    assert.deepEqual(result.state.pair?.entries, expected);
    assert.equal(result.state.pair?.cursor, result.accepted.at(-1)?.cursor);
    state = result.state;
  }
  assert.equal(state.pair?.cursor, "g:10");
  assert.equal(advanceSourceSync(state, input).accepted.length, 0);
});

test("thread, turn, item and ordinal differences split adjacent runs", () => {
  const events = [
    event(),
    event(),
    event(
      "message.delta",
      { delta: "y", messageIndex: 0 },
      { threadId: "other" },
    ),
    event(),
    event(
      "message.delta",
      { delta: "t", messageIndex: 0 },
      { turnId: "other" },
    ),
    event(
      "message.delta",
      { delta: "i", messageIndex: 0 },
      { itemId: "other" },
    ),
    event("message.delta", { delta: "o", messageIndex: 1 }),
    event(),
    event(),
  ];
  const { projected } = oracle(events);
  assert.equal(projected.length, 7);
  assert.deepEqual(
    projected.map((e) => e.data.delta),
    ["xx", "y", "x", "t", "i", "o", "xx"],
  );
});

test("every non-answer frame is an ordering barrier, including both reasoning channels", () => {
  const barriers = [
    event(
      "reasoning.delta",
      { delta: "summary", method: "item/reasoning/summaryTextDelta" },
      { itemId: "reason" },
    ),
    event(
      "reasoning.delta",
      { delta: "raw", method: "item/reasoning/textDelta" },
      { itemId: "reason" },
    ),
    event(
      "item.completed",
      { item: { id: "reason", type: "reasoning", summary: ["summary"] } },
      { itemId: "reason" },
    ),
    event("message.final", { text: "final", messageIndex: 0 }),
    event("turn.started", {}),
    event("turn.completed", {}),
    event("snapshot", { messages: [], state: { kind: "idle" } }),
    event("approval.requested", { requestId: "approval" }),
    event("approval.resolved", {
      audit: {
        requestId: "approval",
        turnId: "turn",
        outcome: "answered",
        items: [],
      },
    }),
    event("error", { message: "failure" }),
    event("resync.required", {}),
    event("subagent.event", { kind: "message.delta", delta: "helper" }),
  ];
  for (const barrier of barriers) {
    const { projected } = oracle([event(), event(), barrier, event(), event()]);
    assert.equal(projected.length, 3, barrier.type);
    assert.equal(projected[1], barrier);
  }
});

test("missing identities and invalid ordinals stay uncoalesced without changing legacy behavior", () => {
  for (const identity of [
    { threadId: undefined },
    { turnId: undefined },
    { itemId: undefined },
    { threadId: "" },
    { turnId: "" },
    { itemId: "" },
  ]) {
    const events = [
      event("message.delta", { delta: "a" }, identity),
      event("message.delta", { delta: "b" }, identity),
    ];
    assert.equal(oracle(events).projected.length, 2);
  }
  for (const messageIndex of [null, -1, 0.5, NaN, Infinity, "0", {}]) {
    const events = [
      event("message.delta", { delta: "a", messageIndex }),
      event("message.delta", { delta: "b", messageIndex }),
    ];
    assert.equal(oracle(events).projected.length, 2);
  }
  assert.equal(
    oracle([
      event("message.delta", { delta: "a" }),
      event("message.delta", { delta: "b" }),
    ]).projected.length,
    1,
  );
});

test("malformed payloads preserve the reducer's original result or failure", () => {
  for (const data of [
    {},
    { delta: null },
    { delta: 5 },
    { delta: {} },
    { delta: [] },
    [],
    null,
    undefined,
  ]) {
    const malformed = { ...event(), data: data as DomainEvent["data"] };
    const events = [event(), malformed, event()];
    const projected = coalesceChatEvents(events);
    assert.equal(projected.length, 3);
    assert.equal(projected[1], malformed);
    let expected: Entry[] | undefined;
    let failure: unknown;
    try {
      expected = events.reduce(applyChatEvent, []);
    } catch (error) {
      failure = error;
    }
    if (failure instanceof Error)
      assert.throws(() => projected.reduce(applyChatEvent, []), {
        name: failure.name,
        message: failure.message,
      });
    else assert.deepEqual(projected.reduce(applyChatEvent, []), expected);
  }
});

test("aliases, completed replay, conflicting ordinals and Unicode retain exact reducer state", () => {
  const initial: Entry[] = [
    {
      kind: "message",
      id: "saved",
      role: "assistant",
      turnId: "turn",
      itemId: "stored",
      aliases: ["runtime", "item"],
      messageIndex: 0,
      text: "prefix:",
      final: false,
    },
    {
      kind: "message",
      id: "ordinal",
      role: "assistant",
      turnId: "turn",
      itemId: "other",
      messageIndex: 0,
      text: "other",
      final: false,
    },
    {
      kind: "message",
      id: "final",
      role: "assistant",
      turnId: "complete",
      itemId: "item",
      text: "done",
      final: true,
    },
  ];
  oracle(
    [
      event("message.delta", { delta: "\ud83d", messageIndex: 0 }),
      event("message.delta", { delta: "\ude00\u0000\n", messageIndex: 0 }),
      event("message.delta", { delta: "", messageIndex: 0 }),
      event(
        "message.delta",
        { delta: "a", messageIndex: 0 },
        { turnId: "complete" },
      ),
      event(
        "message.delta",
        { delta: "b", messageIndex: 0 },
        { turnId: "complete" },
      ),
      event(
        "message.final",
        { text: "prefix:😀\u0000\n", messageIndex: 0 },
        { itemId: "runtime" },
      ),
      event(),
      event(),
    ],
    initial,
  );
});

test("seeded randomized batches equal the unoptimized reducer at every publication boundary", () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const pick = <T>(values: T[]): T => values[random() % values.length];
  for (let fixture = 0; fixture < 200; fixture++) {
    let initial: Entry[] = [
      {
        kind: "message",
        id: "legacy",
        role: "assistant",
        turnId: "turn",
        text: "legacy",
        final: false,
      },
      {
        kind: "message",
        id: "aliased",
        role: "assistant",
        turnId: "t1",
        itemId: "stored",
        aliases: ["i1", "item"],
        messageIndex: 1,
        text: "old",
        final: fixture % 2 === 0,
      },
    ];
    let events: DomainEvent[] = [];
    for (let i = 0; i < 100; i++) {
      const identity = {
        threadId: pick(["thread", "thread2", ""]),
        turnId: pick(["turn", "t1", undefined]),
        itemId: pick(["item", "i1", "i2", undefined]),
      };
      const messageIndex = pick([undefined, 0, 1, 2, NaN]);
      const type = pick([
        "message.delta",
        "message.delta",
        "message.delta",
        "message.final",
        "reasoning.delta",
        "turn.completed",
        "approval.requested",
        "error",
        "snapshot",
      ] as DomainEvent["type"][]);
      const delta = pick(["a", "", "😀", "\n", "界", "\ud83d", "\ude00"]);
      const data =
        type === "message.final"
          ? { text: delta, messageIndex }
          : type === "snapshot"
            ? { messages: [], state: { kind: "idle" } }
            : {
                delta,
                messageIndex,
                method: pick([
                  undefined,
                  "item/reasoning/textDelta",
                  "item/reasoning/summaryTextDelta",
                ]),
              };
      const next = event(type, data, identity);
      events.push(next);
      if (
        (type === "message.delta" || type === "reasoning.delta") &&
        i % 3 === 0
      )
        events.push({ ...next, data: { ...data, delta: "b" } });
      if (i % 10 === 9) {
        initial = oracle(events, initial).actual;
        events = [];
      }
    }
  }
});

// Exercise the real ordered-batch/transport handoff without a browser or API.
function streamFixture(
  t: TestContext,
  consume: (events: DomainEvent[]) => boolean | void,
) {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const store = new Map<string, string>();
  let scheduleId = 0;
  let source: FakeSource;
  class FakeSource {
    readyState = 1;
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage:
      ((message: { data: string; lastEventId: string }) => void) | null = null;
    constructor(_url: string) {
      source = this;
    }
    addEventListener() {}
    close() {
      this.closed = true;
    }
  }
  function install(name: string, value: unknown) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  install("EventSource", FakeSource);
  install("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  install("requestAnimationFrame", (run: () => void) => {
    frames.set(++scheduleId, run);
    return scheduleId;
  });
  install("cancelAnimationFrame", (id: number) => frames.delete(id));
  install("setTimeout", (run: () => void) => {
    timers.set(++scheduleId, run);
    return scheduleId;
  });
  install("clearTimeout", (id: number) => timers.delete(id));
  const stop = transport.subscribe(
    "test",
    () => assert.fail("batch delivery required"),
    () => {},
    { onBatch: consume },
  );
  t.after(stop);
  const advance = (jobs: Map<number, () => void>) => {
    for (const [id, run] of [...jobs]) {
      jobs.delete(id);
      run();
    }
  };
  return {
    store,
    source: source!,
    stop,
    paint: () => advance(frames),
    timer: () => advance(timers),
    emit: (value: DomainEvent) =>
      source.onmessage!({
        data: JSON.stringify(value),
        lastEventId: value.cursor,
      }),
  };
}

for (const type of ["message.delta", "reasoning.delta"] as const)
  for (const publication of ["paint", "timer", "navigation"] as const)
    test(`coalesced ${type} projection preserves raw events and terminal cursor during ${publication} publication`, (t) => {
      let entries: Entry[] = [];
      let applications = 0;
      const accepted: DomainEvent[] = [];
      const stream = streamFixture(t, (raw) => {
        assert.equal(
          stream.store.size,
          0,
          "checkpoint follows accepted publication",
        );
        entries = coalesceChatEvents(raw).reduce((state, frame) => {
          applications++;
          return applyChatEvent(state, frame);
        }, entries);
        accepted.push(...raw);
      });
      const input = Array.from({ length: 1000 }, () =>
        type === "message.delta" ? event() : reasoning(),
      );
      for (const value of input) stream.emit(value);
      assert.equal(entries.length, 0);
      if (publication === "paint") stream.paint();
      else if (publication === "timer") stream.timer();
      else stream.stop.flush!();
      stream.paint();
      stream.timer();
      assert.equal(applications, 1);
      assert.deepEqual(entries, input.reduce(applyChatEvent, []));
      assert.deepEqual(
        accepted,
        input.map((frame) => ({ ...frame, threadId: "test" })),
      );
      assert.ok(
        input.every((frame) => frame.threadId === "thread"),
        "wire fixtures remain unchanged by trusted subscription scope stamping",
      );
      assert.equal(stream.store.get("cursor:test"), input.at(-1)?.cursor);
    });

test("rejected navigation ownership publishes and acknowledges no coalesced state", (t) => {
  let active = true;
  let entries: Entry[] = [];
  let calls = 0;
  const stream = streamFixture(t, (raw) => {
    calls++;
    if (!active) return false;
    entries = coalesceChatEvents(raw).reduce(applyChatEvent, entries);
  });
  stream.emit(event());
  stream.emit(event());
  active = false;
  stream.stop.flush!();
  stream.paint();
  stream.emit(event("turn.completed", {}));
  assert.equal(calls, 1);
  assert.deepEqual(entries, []);
  assert.equal(stream.store.size, 0);
  assert.equal(stream.source.closed, true);
});

test("malformed transport frame flushes coalesced accepted text without acknowledging the rejected cursor", (t) => {
  t.mock.method(console, "error", () => {});
  let entries: Entry[] = [];
  const stream = streamFixture(t, (raw) => {
    entries = coalesceChatEvents(raw).reduce(applyChatEvent, entries);
  });
  const input = [event(), event()];
  for (const value of input) stream.emit(value);
  stream.source.onmessage!({ data: "bad json", lastEventId: "bad-cursor" });
  stream.paint();
  stream.emit(event());
  assert.deepEqual(entries, input.reduce(applyChatEvent, []));
  assert.equal(stream.store.get("cursor:test"), input.at(-1)?.cursor);
  assert.equal(stream.source.closed, true);
});

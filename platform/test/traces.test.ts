import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { summariseTraces, sessionTraces } from "../src/traces";
import type { DomainEvent, TurnTrace } from "../../shared/contracts";

const usage = (input: number, output: number) => ({
  inputTokens: input,
  cachedInputTokens: 1,
  outputTokens: output,
  reasoningOutputTokens: 2,
  totalTokens: input + output,
  contextWindow: 1000,
  contextUsedTokens: input,
});
const trace = (n: number, extra: Partial<TurnTrace> = {}): TurnTrace => ({
  turnId: `turn-${n}`,
  threadId: "t",
  startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  totalMs: n * 100,
  status: "completed",
  steps: [],
  usage: usage(10, 5),
  helperUsage: null,
  rateLimits: null,
  privacy: { scannedChars: 10, findings: [] },
  ...extra,
});

test("summary: empty list", () => {
  assert.deepEqual(summariseTraces([]), {
    turns: 0,
    avgTotalMs: null,
    p95TotalMs: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    helperTokens: 0,
    privacyFindings: 0,
  });
});

test("summary: averages, nearest-rank p95, null usage and totals skipped", () => {
  const traces = [
    ...Array.from({ length: 20 }, (_, i) => trace(i + 1)),
    trace(21, { totalMs: null, usage: null }),
    trace(22, {
      helperUsage: { ...usage(3, 4), totalTokens: 7 },
      privacy: {
        scannedChars: 50,
        findings: [
          {
            kind: "email",
            source: "userMessage",
            count: 2,
            sample: "a***@x.com",
          },
          { kind: "secret", source: "toolOutput", count: 1, sample: "sk-***" },
        ],
      },
    }),
  ];
  const s = summariseTraces(traces);
  assert.equal(s.turns, 22);
  // totalMs 100..2000 and 2200; the null one is skipped.
  const totals = [...Array.from({ length: 20 }, (_, i) => (i + 1) * 100), 2200];
  assert.equal(s.avgTotalMs, totals.reduce((a, b) => a + b, 0) / 21);
  // ceil(0.95 * 21) = 20th value.
  assert.equal(s.p95TotalMs, 2000);
  assert.equal(s.inputTokens, 21 * 10);
  assert.equal(s.cachedInputTokens, 21);
  assert.equal(s.outputTokens, 21 * 5);
  assert.equal(s.reasoningOutputTokens, 42);
  assert.equal(s.helperTokens, 7);
  assert.equal(s.privacyFindings, 3);
  assert.equal(summariseTraces([trace(3)]).p95TotalMs, 300);
  assert.equal(sessionTraces(traces).traces, traces);
});

test(
  "MongoDB: traces upsert per turn, replay is idempotent, oldest first",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "traces_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const completed = (tr: TurnTrace, seq: number) =>
      ({
        type: "turn.completed",
        threadId: "t",
        turnId: tr.turnId,
        seq,
        cursor: `a:${seq}`,
        at: tr.startedAt,
        data: { timing: { turnId: tr.turnId, totalMs: 1 }, trace: tr },
      }) as DomainEvent;
    const a = trace(2),
      b = trace(1);
    await Promise.all([
      store.persist("s", completed(a, 1)),
      store.persist("s", completed(a, 1)),
    ]);
    await store.persist("s", completed(b, 2));
    await store.persist("s", completed({ ...a, status: "interrupted" }, 1));
    await store.persist("other", completed(trace(3), 3));
    // A turn.completed without a trace writes nothing.
    await store.persist("s", {
      ...completed(trace(4), 4),
      data: { timing: { turnId: "turn-4" } },
    });
    assert.equal(await store.traces.countDocuments({ sessionId: "s" }), 2);
    const rows = await store.sessionTraces("s");
    assert.deepEqual(
      rows.map((r) => r.turnId),
      ["turn-1", "turn-2"],
    );
    assert.equal(rows[1].status, "interrupted");
    assert.equal("sessionId" in rows[0] || "_id" in rows[0], false);
    assert.deepEqual(
      (await store.sessionTraces("s", 1)).map((r) => r.turnId),
      ["turn-2"],
    );
    const indexes = await store.traces.indexes();
    assert.ok(
      indexes.some((i) => i.key.sessionId === 1 && i.key.startedAt === 1),
    );
  },
);

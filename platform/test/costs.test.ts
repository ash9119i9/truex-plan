import { test } from "node:test";
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  Costs,
  costMicros,
  parseRate,
  priceIn,
  priceTrace,
  resolveRates,
  stampEvent,
  usageIncrement,
  usageRange,
  usd,
  type PriceDocument,
} from "../src/costs";
import { PublicEventStream, publicCost, publicTrace } from "../src/public";
import { Store } from "../src/store";
import type {
  DomainEvent,
  Session,
  TraceCost,
  TurnTrace,
} from "../../shared/contracts";

const price = (over: Partial<PriceDocument> = {}): PriceDocument => ({
  _id: "p1",
  modelName: "m1",
  currency: "USD",
  inputPerMTok: "3",
  cachedInputPerMTok: "0.3",
  cacheWritePerMTok: "3.75",
  outputPerMTok: "15",
  effectiveFrom: "2026-10-01T00:00:00.000Z",
  effectiveTo: null,
  ...over,
});
const rates = (p = price()) => resolveRates(p)!;
const counts = (over: Record<string, number> = {}) => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  ...over,
});

test("rates parse exactly and reject anything ambiguous", () => {
  assert.equal(parseRate("1.25"), 1_250_000n);
  assert.equal(parseRate(0.125), 125_000n);
  assert.equal(parseRate("15"), 15_000_000n);
  for (const bad of ["", "abc", "-1", "1e3", "1.1234567", "$3", null, {}, NaN])
    assert.equal(parseRate(bad), null, String(bad));
});

test("cost is exact integer micro-USD with cached and cache-write split", () => {
  // 1,000,000 input tokens at $3/M is exactly $3.
  assert.equal(costMicros(counts({ inputTokens: 1_000_000 }), rates()), 3e6);
  // 7386 in, 106 out at $3 / $15 per M: 22158 + 1590 micro-USD.
  assert.equal(
    costMicros(counts({ inputTokens: 7386, outputTokens: 106 }), rates()),
    23748,
  );
  // Cached tokens are billed at the cached rate, not also at the input rate.
  assert.equal(
    costMicros(
      counts({ inputTokens: 1_000_000, cachedInputTokens: 600_000 }),
      rates(),
    ),
    400_000 * 3 + 600_000 * 0.3,
  );
  // Cache writes use their own rate and are not billed twice.
  assert.equal(
    costMicros(
      counts({ inputTokens: 1_000_000, cacheWriteInputTokens: 200_000 }),
      rates(),
    ),
    800_000 * 3 + 200_000 * 3.75,
  );
});

test("zero usage costs exactly zero, and odd counts never go negative", () => {
  assert.equal(costMicros(counts(), rates()), 0);
  // cached larger than input is clamped to input, never negative plain input
  assert.equal(
    costMicros(counts({ inputTokens: 10, cachedInputTokens: 99 }), rates()),
    3,
  );
  assert.equal(
    costMicros(counts({ inputTokens: -5, outputTokens: NaN }), rates()),
    0,
  );
});

test("one rounding per request, half up", () => {
  const r = rates(price({ inputPerMTok: "0.5", outputPerMTok: "0.5" }));
  // 1 token at 0.5 micro-USD rounds up to 1; 3 tokens = 1.5 -> 2
  assert.equal(costMicros(counts({ inputTokens: 1 }), r), 1);
  assert.equal(costMicros(counts({ inputTokens: 3 }), r), 2);
});

test("a missing optional rate falls back to the input rate; bad ones are unusable", () => {
  const r = resolveRates(
    price({ cachedInputPerMTok: undefined, cacheWritePerMTok: undefined }),
  )!;
  assert.equal(r.cachedInput, r.input);
  assert.equal(resolveRates(price({ inputPerMTok: "free" })), null);
  assert.equal(resolveRates(price({ outputPerMTok: "" })), null);
  assert.equal(resolveRates(price({ cachedInputPerMTok: "x" })), null);
});

test("usd formats micro-USD without float drift", () => {
  assert.equal(usd(0), "0.000000");
  assert.equal(usd(23748), "0.023748");
  assert.equal(usd(12_000_001), "12.000001");
});

test("usage ranges default, validate and cap", () => {
  const r = usageRange({});
  assert.ok(Date.parse(r.to) > Date.parse(r.from));
  for (const bad of [
    { from: "nope" },
    { from: "2026-02-01", to: "2026-01-01" },
    { from: "2020-01-01", to: "2026-01-01" },
    { from: 5 },
  ])
    assert.throws(() => usageRange(bad as any), { code: "INVALID_RANGE" });
  assert.deepEqual(usageRange({ from: "2026-01-01", to: "2026-02-01" }), {
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-02-01T00:00:00.000Z",
  });
});

const session = { _id: "s1", userId: "u1", agentId: "a1" } as Session;
const call = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  at: "2026-10-05T10:00:00.000Z",
  source: "main",
  inputTokens: 1000,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 100,
  reasoningOutputTokens: 0,
  totalTokens: 1100,
  ...over,
});
const trace = (over: Record<string, unknown> = {}) =>
  ({
    turnId: "t1",
    startedAt: "2026-10-05T10:00:00.000Z",
    usage: null,
    helperUsage: null,
    ...over,
  }) as unknown as TurnTrace;
const turn = (calls: unknown[] | undefined, type = "turn.completed") =>
  ({
    type,
    turnId: "t1",
    at: "2026-10-05T10:00:05.000Z",
    data: { trace: trace(calls === undefined ? {} : { calls }) },
  }) as unknown as DomainEvent;
const traceOf = (e: unknown) => (e as any).data.trace as TurnTrace;

test("a trace's requests are priced one by one and totalled, main and helper", () => {
  const priced = priceTrace(
    trace({ calls: [call(0), call(1, { source: "helper", outputTokens: 0 })] }),
    "m1",
    [price()],
  )!;
  assert.equal(priced.calls[0].costMicros, 3000 + 1500);
  assert.equal(priced.calls[0].pricingId, "p1");
  assert.deepEqual(priced.calls[0].rates, {
    input: "3",
    cachedInput: "0.3",
    cacheWrite: "3.75",
    output: "15",
  });
  assert.equal(priced.calls[1].source, "helper");
  assert.deepEqual(priced.cost, {
    costMicros: 7500,
    requests: 2,
    unpricedRequests: 0,
    inputTokens: 2000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    modelName: "m1",
  });
});

test("an unpriced model keeps its tokens and has no cost, not zero", () => {
  for (const [model, prices] of [
    ["m1", []],
    [null, [price()]],
    ["m1", [price({ outputPerMTok: "n/a" })]],
  ] as const) {
    const priced = priceTrace(trace({ calls: [call(0)] }), model, prices)!;
    assert.equal(priced.calls[0].costMicros, null);
    assert.equal(priced.calls[0].pricingId, null);
    assert.equal(priced.calls[0].rates, null);
    assert.equal(priced.cost.costMicros, 0);
    assert.equal(priced.cost.unpricedRequests, 1);
    assert.equal(priced.cost.inputTokens, 1000);
  }
});

test("a partly priced turn counts only what it can price", () => {
  const fresh = price({ effectiveFrom: "2026-10-05T10:00:00.000Z" });
  const priced = priceTrace(
    trace({
      calls: [
        call(0, { at: "2026-10-05T09:59:59.999Z" }),
        call(1, { at: "2026-10-05T10:00:00.000Z" }),
      ],
    }),
    "m1",
    [fresh],
  )!;
  assert.equal(priced.calls[0].costMicros, null);
  assert.equal(priced.calls[1].costMicros, 4500);
  assert.equal(priced.cost.unpricedRequests, 1);
  assert.equal(priced.cost.costMicros, 4500);
});

test("the price in force at the request time is used, period ends exclusive", () => {
  const old = price({
    _id: "old",
    inputPerMTok: "1",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2026-10-01T00:00:00.000Z",
  });
  const now = price({ _id: "new", inputPerMTok: "2" });
  assert.equal(priceIn([old, now], "2026-09-30T23:59:59.999Z")?.["_id"], "old");
  assert.equal(priceIn([old, now], "2026-10-01T00:00:00.000Z")?.["_id"], "new");
  assert.equal(priceIn([old, now], "2025-12-31T00:00:00.000Z"), null);
  const priced = priceTrace(
    trace({
      calls: [
        call(0, { at: "2026-09-30T23:59:59.999Z" }),
        call(1, { at: "2026-10-01T00:00:00.000Z" }),
      ],
    }),
    "m1",
    [old, now],
  )!;
  assert.deepEqual(
    priced.calls.map((c) => c.pricingId),
    ["old", "new"],
  );
});

test("a runtime that sends only turn sums is priced from them", () => {
  const priced = priceTrace(
    trace({
      usage: {
        inputTokens: 2000,
        cachedInputTokens: 1000,
        outputTokens: 100,
        reasoningOutputTokens: 10,
        totalTokens: 2100,
      },
      helperUsage: {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1000,
      },
    }),
    "m1",
    [price()],
  )!;
  // 1000 plain at 3 + 1000 cached at 0.3 + 100 out at 15, then 1000 at 3.
  assert.equal(priced.cost.costMicros, 4800 + 3000);
  assert.equal(priced.cost.requests, 2);
  assert.deepEqual(
    priced.calls.map((c) => c.source),
    ["main", "helper"],
  );
});

test("junk calls and a turn with no usage are not priced", () => {
  assert.equal(
    priceTrace(trace({ calls: [null, { seq: -1 }, { seq: "x" }] }), "m1", [
      price(),
    ]),
    null,
  );
  assert.equal(priceTrace(trace(), "m1", [price()]), null);
  assert.equal(priceTrace(trace({ calls: [] }), "m1", [price()]), null);
});

test("stamping puts the cost on the trace and leaves the input alone", () => {
  const event = turn([call(0)]);
  const stamped = stampEvent(event, "m1", [price()]);
  assert.equal(traceOf(stamped).cost?.costMicros, 4500);
  assert.equal(traceOf(stamped).calls?.[0].costMicros, 4500);
  assert.equal(traceOf(event).cost, undefined);
  assert.equal(traceOf(event).calls?.[0].costMicros, undefined);
  // Not a finished turn, or nothing to price: returned as it came.
  const other = turn([call(0)], "message.final");
  assert.equal(stampEvent(other, "m1", [price()]), other);
  const empty = turn([]);
  assert.equal(stampEvent(empty, "m1", [price()]), empty);
  const bare = { type: "turn.completed", data: {} } as unknown as DomainEvent;
  assert.equal(stampEvent(bare, "m1", [price()]), bare);
});

test("per-request calls are stored only when the runtime sent them", () => {
  const sums = {
    usage: {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      totalTokens: 1100,
    },
  };
  const e = {
    type: "turn.completed",
    data: { trace: trace(sums) },
  } as unknown as DomainEvent;
  const t = traceOf(stampEvent(e, "m1", [price()]));
  assert.equal(t.cost?.costMicros, 4500);
  assert.equal("calls" in t, false);
});

test("a session total adds one turn's sums", () => {
  const cost: TraceCost = {
    costMicros: 7500,
    requests: 2,
    unpricedRequests: 1,
    inputTokens: 2000,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 20,
    outputTokens: 100,
    reasoningOutputTokens: 5,
  };
  assert.deepEqual(usageIncrement(cost), {
    "usage.turns": 1,
    "usage.costMicros": 7500,
    "usage.requests": 2,
    "usage.unpricedRequests": 1,
    "usage.inputTokens": 2000,
    "usage.cachedInputTokens": 10,
    "usage.cacheWriteInputTokens": 20,
    "usage.outputTokens": 100,
    "usage.reasoningOutputTokens": 5,
  });
  const junk = usageIncrement({ costMicros: NaN, requests: -3 } as any);
  assert.equal(junk["usage.costMicros"], 0);
  assert.equal(junk["usage.requests"], 0);
});

test("public traces carry the totals and never the model or prices", () => {
  const stamped = traceOf(stampEvent(turn([call(0)]), "m1", [price()]));
  const out = publicTrace({ ...stamped, steps: [], privacy: {} })!;
  assert.equal(out.cost?.costMicros, 4500);
  assert.equal(out.cost?.requests, 1);
  assert.equal("modelName" in (out.cost as object), false);
  assert.equal("calls" in out, false);
  assert.equal(publicCost(undefined), null);
  assert.equal(publicTrace({ turnId: "t", steps: [] })?.cost, undefined);
});

const snapshot = (...traces: unknown[]) =>
  ({ type: "snapshot", data: { traces } }) as unknown as DomainEvent;

test("a snapshot's turns are priced, so a reload keeps their cost", () => {
  const e = snapshot(
    trace({ turnId: "a", calls: [call(0)] }),
    trace({
      turnId: "b",
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        totalTokens: 1100,
      },
    }),
    trace({ turnId: "c" }),
  );
  const out = (stampEvent(e, "m1", [price()]).data as any).traces;
  assert.equal(out[0].cost.costMicros, 4500);
  // A runtime with only turn sums is priced from them.
  assert.equal(out[1].cost.costMicros, 4500);
  // Nothing to price: left as it came, never given a zero cost.
  assert.equal(out[2].cost, undefined);
  // The input is not changed.
  assert.equal((e.data as any).traces[0].cost, undefined);
});

test("a turn that is already stored keeps the cost it was stored with", () => {
  const stored = new Map([
    [
      "a",
      {
        costMicros: 999,
        requests: 1,
        unpricedRequests: 0,
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
      },
    ],
  ]);
  const out = (
    stampEvent(
      snapshot(
        trace({ turnId: "a", calls: [call(0)] }),
        trace({ turnId: "b", calls: [call(0)] }),
      ),
      "m1",
      [price()],
      stored,
    ).data as any
  ).traces;
  assert.equal(out[0].cost.costMicros, 999);
  assert.equal(out[1].cost.costMicros, 4500);
  // A replayed finished turn shows what was saved, not today's price.
  const replay = stampEvent(
    turn([call(0)]),
    "m1",
    [price()],
    new Map([["t1", stored.get("a")!]]),
  );
  assert.equal(traceOf(replay).cost?.costMicros, 999);
  // A snapshot with no traces is returned as it came.
  const none = snapshot();
  assert.equal(stampEvent(none, "m1", [price()]), none);
});

// A tiny in-memory stand-in for the collections stamp() reads.
function fakeStore(prices: PriceDocument[] = [price()]) {
  const storedRows: { turnId: string; cost: TraceCost }[] = [];
  const store = {
    traces: {
      find() {
        return {
          sort: () => ({ limit: () => ({ toArray: async () => storedRows }) }),
        };
      },
    },
    pricing: {
      find(q: any) {
        const rows = prices
          .filter((p) => p.modelName === q.modelName)
          .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
        return { sort: () => ({ toArray: async () => rows }) };
      },
    },
    agents: {
      async findOne() {
        return { modelProfileId: "prof" };
      },
    },
    profiles: {
      async findOne() {
        return { modelName: "m1" };
      },
    },
  };
  return { store: store as unknown as Store, prices, storedRows };
}

test("stamping a finished turn prices it by the agent's model", async () => {
  const { store } = fakeStore();
  const stamped = await new Costs(store).stamp(session, turn([call(0)]));
  assert.equal(traceOf(stamped).cost?.costMicros, 4500);
  assert.equal(traceOf(stamped).cost?.modelName, "m1");
});

test("a session override prices by the model actually used", async () => {
  const { store } = fakeStore([price({ modelName: "other" })]);
  const stamped = await new Costs(store).stamp(
    { ...session, settings: { model: "other" } } as Session,
    turn([call(0)]),
  );
  assert.equal(traceOf(stamped).cost?.modelName, "other");
  assert.equal(traceOf(stamped).cost?.unpricedRequests, 0);
});

test("a database failure while stamping propagates so it is redelivered", async () => {
  const { store } = fakeStore();
  (store as any).pricing.find = () => {
    throw Object.assign(new Error("down"), { code: 6 });
  };
  await assert.rejects(
    new Costs(store).stamp(session, turn([call(0)])),
    /down/,
  );
});

test("events that are not finished turns are returned untouched", async () => {
  const { store } = fakeStore();
  const costs = new Costs(store);
  const message = turn([call(0)], "message.final");
  assert.equal(await costs.stamp(session, message), message);
});

test("the live pricer prices in the same step and follows price changes", async () => {
  const { store, prices } = fakeStore([]);
  const pricer = await new Costs(store).livePricer(session);
  // No price yet: the turn is unpriced, not free.
  const unpriced = traceOf(pricer.stamp(turn([call(0)])));
  assert.equal(unpriced.cost?.costMicros, 0);
  assert.equal(unpriced.cost?.unpricedRequests, 1);
  prices.push(price());
  await pricer.refresh();
  const priced = traceOf(pricer.stamp(turn([call(0)])));
  assert.equal(priced.cost?.costMicros, 4500);
  assert.equal(priced.cost?.unpricedRequests, 0);
  const message = turn([call(0)], "message.final");
  assert.equal(pricer.stamp(message), message);
});

test("the live pricer prices a reload's snapshot and keeps stored costs", async () => {
  const { store, storedRows } = fakeStore();
  storedRows.push({
    turnId: "a",
    cost: {
      costMicros: 999,
      requests: 1,
      unpricedRequests: 0,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    },
  });
  const pricer = await new Costs(store).livePricer(session);
  const out = (
    pricer.stamp(
      snapshot(
        trace({ turnId: "a", calls: [call(0)] }),
        trace({ turnId: "b", calls: [call(0)] }),
      ),
    ).data as any
  ).traces;
  assert.equal(out[0].cost.costMicros, 999);
  assert.equal(out[1].cost.costMicros, 4500);
});

test("a conversation's snapshot comes back priced, or as it was when pricing is down", async () => {
  const { store } = fakeStore();
  const costs = new Costs(store);
  const raw = { traces: [trace({ turnId: "a", calls: [call(0)] })], other: 1 };
  const priced = await costs.pricedSnapshot(session, raw);
  assert.equal(priced.traces[0].cost?.costMicros, 4500);
  assert.equal(priced.other, 1);
  assert.equal(raw.traces[0].cost, undefined);
  (store as any).pricing.find = () => {
    throw new Error("down");
  };
  assert.equal(await costs.pricedSnapshot(session, raw), raw);
});

test("a live pricer that cannot load sends turns without a cost", async () => {
  const { store } = fakeStore();
  (store as any).pricing.find = () => {
    throw new Error("down");
  };
  const pricer = await new Costs(store).livePricer(session);
  const event = turn([call(0)]);
  assert.equal(pricer.stamp(event), event);
});

// --- MongoDB --------------------------------------------------------------

let mongo: MongoMemoryServer;
let db: Store;
before(
  async () => {
    mongo = await MongoMemoryServer.create();
    db = await new Store(mongo.getUri(), "costs_test").connect();
  },
  { timeout: 120000 },
);
after(async () => {
  await db?.client.close();
  await mongo?.stop();
});

const done = (
  id: string,
  at: string,
  calls: unknown[],
  model: string | null = "m1",
  prices: PriceDocument[] = [price()],
) =>
  stampEvent(
    {
      type: "turn.completed",
      turnId: id,
      at,
      data: { trace: trace({ turnId: id, startedAt: at, calls }) },
    } as unknown as DomainEvent,
    model,
    prices,
  );
const own = async (id: string, userId: string | null = "u1") => {
  await db.sessions.insertOne({
    _id: id,
    userId: userId ?? undefined,
    agentId: "a1",
    threadId: "th",
    agentCoreHost: "h",
    status: "active",
    cwd: "/",
    createdAt: "2026-10-05T00:00:00.000Z",
  } as any);
};

test("MongoDB: a turn's trace stores its cost and owner; a replay counts once", async () => {
  await own("s1");
  const first = done("t1", "2026-10-05T10:00:00.000Z", [call(0), call(1)]);
  await Promise.all([
    db.persist("s1", first, "u1"),
    db.persist("s1", first, "u1"),
  ]);
  await db.persist("s1", first, "u1");
  const doc = await db.traces.findOne({ _id: "s1:t1" });
  assert.equal(doc?.userId, "u1");
  assert.equal(doc?.cost?.costMicros, 9000);
  assert.equal(doc?.calls?.[0].costMicros, 4500);
  assert.equal(await db.traces.countDocuments({ sessionId: "s1" }), 1);
  let usage = (await db.sessions.findOne({ _id: "s1" }))?.usage;
  assert.deepEqual(usage, {
    turns: 1,
    costMicros: 9000,
    requests: 2,
    unpricedRequests: 0,
    inputTokens: 2000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 200,
    reasoningOutputTokens: 0,
    turnIds: ["t1"],
  });
  // A second turn adds to it.
  await db.persist(
    "s1",
    done("t2", "2026-10-05T11:00:00.000Z", [call(0)]),
    "u1",
  );
  usage = (await db.sessions.findOne({ _id: "s1" }))?.usage;
  assert.equal(usage?.turns, 2);
  assert.equal(usage?.costMicros, 13500);
  assert.deepEqual(usage?.turnIds, ["t1", "t2"]);
  // The stored trace read for clients carries neither owner nor session id.
  const rows = await db.sessionTraces("s1");
  assert.equal("userId" in rows[0], false);
  assert.equal(rows[0].cost?.costMicros, 9000);
});

test("MongoDB: a turn with no cost leaves the session total alone", async () => {
  await own("s2");
  await db.persist(
    "s2",
    {
      type: "turn.completed",
      turnId: "t1",
      at: "2026-10-05T10:00:00.000Z",
      data: { trace: trace() },
    } as unknown as DomainEvent,
    "u1",
  );
  assert.equal(await db.traces.countDocuments({ sessionId: "s2" }), 1);
  assert.equal((await db.sessions.findOne({ _id: "s2" }))?.usage, undefined);
});

test("MongoDB: an unpriced turn is counted and shows as unpriced", async () => {
  await own("s3");
  await db.persist(
    "s3",
    done("t1", "2026-10-05T10:00:00.000Z", [call(0)], "m1", []),
    "u1",
  );
  const usage = (await db.sessions.findOne({ _id: "s3" }))?.usage;
  assert.equal(usage?.costMicros, 0);
  assert.equal(usage?.unpricedRequests, 1);
  assert.equal(usage?.inputTokens, 1000);
});

test("MongoDB: session cost reads the stored total, or sums traces without one", async () => {
  const costs = new Costs(db);
  const stored = await costs.sessionCost("s1");
  assert.equal(stored.total.costMicros, 13500);
  assert.equal(stored.total.costUsd, "0.013500");
  assert.equal(stored.total.requests, 3);
  // Newest turn first, one entry per turn.
  assert.deepEqual(
    stored.turns.map((t) => [t.turnId, t.costMicros]),
    [
      ["t2", 4500],
      ["t1", 9000],
    ],
  );
  assert.equal("turnIds" in stored.total, false);
  // A conversation that has no running total yet is summed from its traces.
  await db.sessions.updateOne({ _id: "s1" }, { $unset: { usage: "" } });
  const summed = await costs.sessionCost("s1");
  assert.deepEqual(summed.total, stored.total);
  assert.deepEqual((await costs.sessionCost("nobody")).total.costMicros, 0);
});

test("MongoDB: user and admin totals come from traces, by model and day", async () => {
  await own("s4", "u2");
  const p2 = price({ _id: "p2", modelName: "m2", inputPerMTok: "10" });
  await db.persist(
    "s4",
    done("t1", "2026-10-06T09:00:00.000Z", [call(0)], "m2", [p2]),
    "u2",
  );
  const costs = new Costs(db);
  const range = {
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
  };
  const u1 = await costs.userUsage("u1", range);
  // s1 (13500) and s3 (unpriced) belong to u1; s2 has no cost.
  assert.equal(u1.total.costMicros, 13500);
  assert.equal(u1.total.requests, 4);
  assert.equal(u1.total.unpricedRequests, 1);
  assert.deepEqual(
    u1.byModel.map((m) => [m.model, m.costMicros]),
    [["m1", 13500]],
  );
  assert.deepEqual(
    u1.byDay.map((d) => d.day),
    ["2026-10-05"],
  );
  const u2 = await costs.userUsage("u2", range);
  // 1000 in at $10/M and 100 out at $15/M.
  assert.equal(u2.total.costMicros, 10000 + 1500);
  assert.deepEqual(
    u2.byModel.map((m) => m.model),
    ["m2"],
  );
  assert.deepEqual(
    (
      await costs.userUsage("u1", {
        from: "2026-10-06T00:00:00.000Z",
        to: "2026-11-01T00:00:00.000Z",
      })
    ).total.costMicros,
    0,
  );
  const all = await costs.allUsersUsage(range);
  assert.equal(all.total.costMicros, 13500 + 11500);
  assert.deepEqual(
    all.users.map((u) => u.userId),
    ["u1", "u2"],
  );
});

test("MongoDB: a reload's runtime snapshot keeps the stored cost, even after a price change", async () => {
  await own("s5");
  await db.persist(
    "s5",
    done("t1", "2026-10-05T10:00:00.000Z", [call(0)]),
    "u1",
  );
  // The price goes up afterwards; the runtime knows nothing of any cost.
  await db.pricing.insertOne(
    price({
      _id: "p-new",
      modelName: "m1",
      inputPerMTok: "30",
      effectiveFrom: "2026-10-06T00:00:00.000Z",
    }),
  );
  await db.agents.insertOne({ _id: "a-s5", modelProfileId: "prof" } as any);
  await db.profiles.insertOne({ _id: "prof", modelName: "m1" } as any);
  const s = { _id: "s5", userId: "u1", agentId: "a-s5" } as Session;
  const costs = new Costs(db);
  const reload = await costs.pricedSnapshot(s, {
    traces: [
      trace({
        turnId: "t1",
        startedAt: "2026-10-05T10:00:00.000Z",
        calls: [call(0)],
      }),
      // A turn not stored yet is priced from the price in force when it ran.
      trace({
        turnId: "t2",
        startedAt: "2026-10-07T10:00:00.000Z",
        calls: [call(0, { at: "2026-10-07T10:00:00.000Z" })],
      }),
    ],
  });
  assert.equal(reload.traces[0].cost?.costMicros, 4500);
  assert.equal(reload.traces[1].cost?.costMicros, 30000 + 1500);
});

test("MongoDB: trace indexes serve per-user and per-time totals", async () => {
  const keys = (await db.traces.indexes()).map((i) => JSON.stringify(i.key));
  assert.ok(keys.includes('{"userId":1,"startedAt":1}'));
  assert.ok(keys.includes('{"startedAt":1}'));
});

// --- Live stream ----------------------------------------------------------

const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;
const publicOf = (out: string) =>
  JSON.parse(
    out
      .split("\n")
      .find((l) => l.startsWith("data:"))!
      .slice(5),
  );

test("one live event carries a turn's tokens and its cost together", async () => {
  const { store } = fakeStore();
  const pricer = await new Costs(store).livePricer(session);
  const stream = new PublicEventStream(undefined, (raw) =>
    raw?.type === "turn.completed" ? pricer.stamp(raw) : raw,
  );
  const raw = turn([call(0)]) as any;
  raw.data.trace.usage = {
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
    totalTokens: 1100,
    contextWindow: 1000,
    contextUsedTokens: 1000,
  };
  const event = publicOf(stream.push(new TextEncoder().encode(frame(raw))));
  assert.equal(event.data.trace.usage.inputTokens, 1000);
  assert.equal(event.data.trace.cost.costMicros, 4500);
  assert.equal("calls" in event.data.trace, false);
  assert.equal("modelName" in event.data.trace.cost, false);
});

test("the stream's hook prices turns and snapshots, which is what a reload receives", async () => {
  const { store, storedRows } = fakeStore();
  storedRows.push({
    turnId: "old",
    cost: {
      costMicros: 999,
      requests: 1,
      unpricedRequests: 0,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    },
  });
  const pricer = await new Costs(store).livePricer(session);
  const stream = new PublicEventStream(undefined, pricer.prepare);
  const out = (e: unknown) =>
    publicOf(stream.push(new TextEncoder().encode(frame(e))));
  const snap = out({
    type: "snapshot",
    cursor: "c",
    data: {
      traces: [
        trace({ turnId: "old", calls: [call(0)], steps: [], privacy: {} }),
        trace({ turnId: "new", calls: [call(0)], steps: [], privacy: {} }),
      ],
    },
  });
  assert.equal(snap.type, "snapshot");
  assert.deepEqual(
    snap.data.traces.map((t: any) => [t.turnId, t.cost?.costMicros]),
    [
      ["old", 999],
      ["new", 4500],
    ],
  );
  assert.equal(
    snap.data.traces.some(
      (t: any) => "modelName" in (t.cost ?? {}) || "calls" in t,
    ),
    false,
  );
  // A turn finishing on the same stream is priced too.
  assert.equal(out(turn([call(0)])).data.trace.cost.costMicros, 4500);
  // Other events pass untouched, and a new turn reloads the price list.
  assert.equal(
    out({ type: "turn.started", turnId: "t9", data: {} }).type,
    "turn.started",
  );
});

test("a pricing failure never drops the live event", () => {
  const stream = new PublicEventStream(undefined, () => {
    throw new Error("pricing broke");
  });
  const out = stream.push(new TextEncoder().encode(frame(turn([call(0)]))));
  const event = publicOf(out);
  assert.equal(event.type, "turn.completed");
  assert.equal(event.data.trace.cost, undefined);
});

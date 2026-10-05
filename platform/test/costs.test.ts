import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Costs,
  costMicros,
  parseRate,
  resolveRates,
  usageRange,
  usd,
  type PriceDocument,
  type UsageRequestDocument,
} from "../src/costs";
import type { DomainEvent, Session } from "../../shared/contracts";
import type { Store } from "../src/store";

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

// A tiny in-memory stand-in for the four collections record() touches.
function fakeStore(prices: PriceDocument[] = [price()]) {
  const requests = new Map<string, UsageRequestDocument>();
  const store = {
    pricing: {
      async findOne(q: any) {
        const at = q.effectiveFrom.$lte;
        return (
          prices
            .filter(
              (p) =>
                p.modelName === q.modelName &&
                p.effectiveFrom <= at &&
                (!p.effectiveTo || p.effectiveTo > at),
            )
            .sort((a, b) =>
              b.effectiveFrom.localeCompare(a.effectiveFrom),
            )[0] ?? null
        );
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
    usageRequests: {
      async insertMany(docs: UsageRequestDocument[]) {
        const errors: any[] = [];
        for (const d of docs) {
          if (requests.has(d._id)) errors.push({ code: 11000 });
          else requests.set(d._id, d);
        }
        if (errors.length)
          throw Object.assign(new Error("dup"), {
            code: 11000,
            writeErrors: errors,
          });
      },
    },
  };
  return { store: store as unknown as Store, requests };
}

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
const turn = (calls: unknown[], type = "turn.completed") =>
  ({
    type,
    turnId: "t1",
    at: "2026-10-05T10:00:05.000Z",
    data: { trace: { turnId: "t1", calls } },
  }) as unknown as DomainEvent;

test("every model request gets its own priced document", async () => {
  const { store, requests } = fakeStore();
  await new Costs(store).record(
    session,
    turn([call(0), call(1, { source: "helper", outputTokens: 0 })]),
  );
  assert.equal(requests.size, 2);
  const first = requests.get("s1:t1:0")!;
  assert.equal(first.costStatus, "priced");
  assert.equal(first.costMicros, 3000 + 1500);
  assert.equal(first.userId, "u1");
  assert.equal(first.pricingId, "p1");
  assert.deepEqual(first.rates, {
    input: "3",
    cachedInput: "0.3",
    cacheWrite: "3.75",
    output: "15",
  });
  assert.equal(requests.get("s1:t1:1")!.source, "helper");
});

test("replaying the same turn adds nothing and does not throw", async () => {
  const { store, requests } = fakeStore();
  const costs = new Costs(store);
  const event = turn([call(0), call(1)]);
  await costs.record(session, event);
  await costs.record(session, event);
  assert.equal(requests.size, 2);
});

test("an unpriced model keeps its tokens and has no cost, not zero", async () => {
  const { store, requests } = fakeStore([]);
  await new Costs(store).record(session, turn([call(0)]));
  const doc = requests.get("s1:t1:0")!;
  assert.equal(doc.costStatus, "unpriced");
  assert.equal(doc.costMicros, null);
  assert.equal(doc.inputTokens, 1000);
  assert.equal(doc.pricingId, null);
});

test("an unusable price document is unpriced rather than guessed", async () => {
  const { store, requests } = fakeStore([price({ outputPerMTok: "n/a" })]);
  await new Costs(store).record(session, turn([call(0)]));
  assert.equal(requests.get("s1:t1:0")!.costStatus, "unpriced");
});

test("the price in force at the request time is used, period ends exclusive", async () => {
  const old = price({
    _id: "old",
    inputPerMTok: "1",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2026-10-01T00:00:00.000Z",
  });
  const now = price({ _id: "new", inputPerMTok: "2" });
  const { store, requests } = fakeStore([old, now]);
  await new Costs(store).record(
    session,
    turn([
      call(0, { at: "2026-09-30T23:59:59.999Z" }),
      call(1, { at: "2026-10-01T00:00:00.000Z" }),
    ]),
  );
  assert.equal(requests.get("s1:t1:0")!.pricingId, "old");
  assert.equal(requests.get("s1:t1:1")!.pricingId, "new");
});

test("a session override prices by the model actually used", async () => {
  const { store, requests } = fakeStore([price({ modelName: "other" })]);
  await new Costs(store).record(
    { ...session, settings: { model: "other" } } as Session,
    turn([call(0)]),
  );
  assert.equal(requests.get("s1:t1:0")!.modelName, "other");
  assert.equal(requests.get("s1:t1:0")!.costStatus, "priced");
});

test("non-completed events, missing calls and junk calls are ignored", async () => {
  const { store, requests } = fakeStore();
  const costs = new Costs(store);
  await costs.record(session, turn([call(0)], "message.final"));
  await costs.record(session, turn([]));
  await costs.record(session, {
    type: "turn.completed",
    data: { trace: { turnId: "t1" } },
  } as unknown as DomainEvent);
  await costs.record(session, turn([null, { seq: -1 }, { seq: "x" }]));
  assert.equal(requests.size, 0);
});

test("a database failure other than a replay propagates so it is redelivered", async () => {
  const { store } = fakeStore();
  (store as any).usageRequests.insertMany = async () => {
    throw Object.assign(new Error("down"), { code: 6 });
  };
  await assert.rejects(
    new Costs(store).record(session, turn([call(0)])),
    /down/,
  );
});

test("sessions without an owner are recorded with a null user", async () => {
  const { store, requests } = fakeStore();
  await new Costs(store).record(
    { ...session, userId: undefined } as Session,
    turn([call(0)]),
  );
  assert.equal(requests.get("s1:t1:0")!.userId, null);
});

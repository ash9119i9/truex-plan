// Cost of model requests: priced from truex_model_pricing and stored on the
// turn's own trace (trace.cost, and a price on each trace.calls entry). The
// session keeps running totals (session.usage); user and admin totals are
// aggregated from traces on read. Money is integer micro-USD; rates are
// decimal strings and are never held as floats. An unknown price is
// "unpriced", never zero.
import type {
  CostTotals,
  DomainEvent,
  RateSnapshot,
  Session,
  SessionCost,
  SessionUsage,
  TraceCost,
  TurnCost,
  TurnTrace,
  UsageCall,
  UsageSummary,
} from "../../shared/contracts";
import { log } from "../../shared/logging";
import { idCandidates } from "./documents";
import { ApiError } from "./errors";
import type { Store } from "./store";

// USD per 1M tokens. Cached-input and cache-write default to the input rate.
export interface PriceDocument {
  _id: string;
  /** What the provider bills by (the model name sent to it). */
  modelName: string;
  /** Optional link to the truex_models profile this price was set for. */
  modelId?: string;
  currency: "USD";
  inputPerMTok: string;
  cachedInputPerMTok?: string;
  cacheWritePerMTok?: string;
  outputPerMTok: string;
  effectiveFrom: string;
  /** Exclusive. Null or missing means open-ended. */
  effectiveTo?: string | null;
  note?: string;
}

const SCALE = 1_000_000n;
const MAX_RANGE_MS = 366 * 24 * 3600 * 1000;
const DEFAULT_RANGE_MS = 30 * 24 * 3600 * 1000;
const ADMIN_USER_LIMIT = 1000;
// Matches the traces the session keeps (store.sessionTraces).
const TURN_LIMIT = 200;

// "1.25" or 1.25 -> 1_250_000n (rate x 1e6). Anything else is invalid.
export function parseRate(value: unknown): bigint | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export interface ScaledRates {
  snapshot: RateSnapshot;
  input: bigint;
  cachedInput: bigint;
  cacheWrite: bigint;
  output: bigint;
}
// Null when the price document is unusable (missing or malformed rate).
export function resolveRates(
  price: Pick<
    PriceDocument,
    | "inputPerMTok"
    | "cachedInputPerMTok"
    | "cacheWritePerMTok"
    | "outputPerMTok"
  >,
): ScaledRates | null {
  const input = parseRate(price.inputPerMTok);
  const output = parseRate(price.outputPerMTok);
  if (input === null || output === null) return null;
  const optional = (value: unknown, fallback: bigint) =>
    value === undefined || value === null ? fallback : parseRate(value);
  const cachedInput = optional(price.cachedInputPerMTok, input);
  const cacheWrite = optional(price.cacheWritePerMTok, input);
  if (cachedInput === null || cacheWrite === null) return null;
  return {
    snapshot: {
      input: String(price.inputPerMTok),
      cachedInput: String(price.cachedInputPerMTok ?? price.inputPerMTok),
      cacheWrite: String(price.cacheWritePerMTok ?? price.inputPerMTok),
      output: String(price.outputPerMTok),
    },
    input,
    cachedInput,
    cacheWrite,
    output,
  };
}

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? BigInt(Math.floor(value))
    : 0n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const tokens = (value: unknown) => Number(count(value));

// Input tokens include the cached and cache-write tokens, so the plain input
// is what is left after both. Reasoning tokens are part of output. Rounded
// once, half up, for the whole request.
export function costMicros(
  call: Pick<
    UsageCall,
    | "inputTokens"
    | "cachedInputTokens"
    | "cacheWriteInputTokens"
    | "outputTokens"
  >,
  rates: ScaledRates,
): number {
  const input = count(call.inputTokens);
  const cached = min(count(call.cachedInputTokens), input);
  const written = min(count(call.cacheWriteInputTokens), input - cached);
  const plain = input - cached - written;
  const total =
    plain * rates.input +
    cached * rates.cachedInput +
    written * rates.cacheWrite +
    count(call.outputTokens) * rates.output;
  return Number((total + SCALE / 2n) / SCALE);
}

export const usd = (micros: number) =>
  `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, "0")}`;

const isoOf = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

// The price in force at a moment: the latest one that has started and not
// ended. Period ends are exclusive.
export function priceIn(
  prices: readonly PriceDocument[],
  at: string,
): PriceDocument | null {
  let best: PriceDocument | null = null;
  for (const p of prices) {
    if (p.effectiveFrom > at) continue;
    if (p.effectiveTo && p.effectiveTo <= at) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  return best;
}

export interface PricedTrace {
  calls: UsageCall[];
  cost: TraceCost;
}

// The requests to price. Newer runtimes report every request; an older one
// reports only the turn's sums, which are priced as one main (and one helper)
// request, with no cache-write split.
function callsOf(trace: TurnTrace, fallbackAt: string): UsageCall[] {
  const reported = (Array.isArray(trace.calls) ? trace.calls : []).filter(
    (c) => c && typeof c === "object" && Number.isInteger(c.seq) && c.seq >= 0,
  );
  if (reported.length) return reported;
  const out: UsageCall[] = [];
  const sums = (source: "main" | "helper", u: any): UsageCall[] =>
    u && typeof u === "object"
      ? [
          {
            seq: out.length,
            at: fallbackAt,
            source,
            inputTokens: u.inputTokens,
            cachedInputTokens: u.cachedInputTokens,
            cacheWriteInputTokens: 0,
            outputTokens: u.outputTokens,
            reasoningOutputTokens: u.reasoningOutputTokens,
            totalTokens: u.totalTokens,
          },
        ]
      : [];
  out.push(...sums("main", trace.usage));
  out.push(...sums("helper", trace.helperUsage));
  return out;
}

// Prices every request of a finished turn and totals them. Pure: `prices` are
// all the prices ever set for the model, so no lookup happens here. Null when
// the turn reported no usage at all.
export function priceTrace(
  trace: TurnTrace,
  modelName: string | null,
  prices: readonly PriceDocument[],
  eventAt?: unknown,
): PricedTrace | null {
  const fallbackAt =
    isoOf(eventAt) ?? isoOf(trace.startedAt) ?? new Date().toISOString();
  const calls: UsageCall[] = callsOf(trace, fallbackAt).map((c) => {
    const at = isoOf(c.at) ?? fallbackAt;
    const price = modelName ? priceIn(prices, at) : null;
    const rates = price ? resolveRates(price) : null;
    const priced: UsageCall = {
      seq: c.seq,
      at,
      source: c.source === "helper" ? "helper" : "main",
      inputTokens: tokens(c.inputTokens),
      cachedInputTokens: tokens(c.cachedInputTokens),
      cacheWriteInputTokens: tokens(c.cacheWriteInputTokens),
      outputTokens: tokens(c.outputTokens),
      reasoningOutputTokens: tokens(c.reasoningOutputTokens),
      totalTokens: tokens(c.totalTokens),
      costMicros: rates ? costMicros(c, rates) : null,
      pricingId: price && rates ? price._id : null,
      rates: rates?.snapshot ?? null,
    };
    return priced;
  });
  if (!calls.length) return null;
  const sum = (pick: (c: UsageCall) => number) =>
    calls.reduce((a, c) => a + pick(c), 0);
  return {
    calls,
    cost: {
      costMicros: sum((c) => c.costMicros ?? 0),
      requests: calls.length,
      unpricedRequests: sum((c) => (c.costMicros === null ? 1 : 0)),
      inputTokens: sum((c) => c.inputTokens),
      cachedInputTokens: sum((c) => c.cachedInputTokens),
      cacheWriteInputTokens: sum((c) => c.cacheWriteInputTokens),
      outputTokens: sum((c) => c.outputTokens),
      reasoningOutputTokens: sum((c) => c.reasoningOutputTokens),
      modelName,
    },
  };
}

// What a turn cost as already stored, by turn id. A turn that is sent again (a
// replayed event, a snapshot after a reload) shows this, not a new price.
export type StoredCosts = ReadonlyMap<string, TraceCost>;

// A trace from a runtime snapshot with its cost set. The runtime never prices
// anything, so without this a reload would replace a stored cost with none.
function costedTrace(
  trace: any,
  modelName: string | null,
  prices: readonly PriceDocument[],
  stored?: StoredCosts,
) {
  if (!trace || typeof trace !== "object" || !trace.turnId || trace.cost)
    return trace;
  const cost =
    stored?.get(trace.turnId) ?? priceTrace(trace, modelName, prices)?.cost;
  return cost ? { ...trace, cost } : trace;
}

// A finished turn, or a snapshot of turns, with their cost on the trace; the
// event unchanged when it is neither or reported no usage. The runtime's
// per-request list is kept only if it sent one. Costs in `stored` win over a
// new price, so a turn always shows the cost it was saved with.
export function stampEvent<
  E extends Pick<DomainEvent, "type" | "data"> & { at?: unknown },
>(
  event: E,
  modelName: string | null,
  prices: readonly PriceDocument[],
  stored?: StoredCosts,
): E {
  if (event.type === "snapshot") {
    const traces = (event.data as any)?.traces;
    if (!Array.isArray(traces) || !traces.length) return event;
    return {
      ...event,
      data: {
        ...event.data,
        traces: traces.map((t) => costedTrace(t, modelName, prices, stored)),
      },
    };
  }
  const trace = (event.data as any)?.trace as TurnTrace | undefined;
  if (event.type !== "turn.completed" || !trace?.turnId) return event;
  const priced = priceTrace(trace, modelName, prices, event.at);
  if (!priced) return event;
  const { calls, ...rest } = trace;
  return {
    ...event,
    data: {
      ...event.data,
      trace: {
        ...rest,
        ...(Array.isArray(calls) && calls.length
          ? { calls: priced.calls }
          : {}),
        cost: stored?.get(trace.turnId) ?? priced.cost,
      },
    },
  };
}

// The $inc that adds one turn to a session's running totals.
export function usageIncrement(cost: TraceCost) {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    "usage.turns": 1,
    "usage.costMicros": n(cost.costMicros),
    "usage.requests": n(cost.requests),
    "usage.unpricedRequests": n(cost.unpricedRequests),
    "usage.inputTokens": n(cost.inputTokens),
    "usage.cachedInputTokens": n(cost.cachedInputTokens),
    "usage.cacheWriteInputTokens": n(cost.cacheWriteInputTokens),
    "usage.outputTokens": n(cost.outputTokens),
    "usage.reasoningOutputTokens": n(cost.reasoningOutputTokens),
  };
}

export function usageRange(query: { from?: unknown; to?: unknown }) {
  const bad = () =>
    new ApiError(
      400,
      "Use ISO dates for from and to, at most 366 days apart.",
      "INVALID_RANGE",
    );
  const pick = (v: unknown) => {
    if (v === undefined || v === "") return null;
    if (typeof v !== "string") throw bad();
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw bad();
    return ms;
  };
  const to = pick(query.to) ?? Date.now();
  const from = pick(query.from) ?? to - DEFAULT_RANGE_MS;
  if (from >= to || to - from > MAX_RANGE_MS) throw bad();
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}

// Totals over traces that carry a cost.
const sums = {
  costMicros: { $sum: "$cost.costMicros" },
  requests: { $sum: "$cost.requests" },
  unpricedRequests: { $sum: "$cost.unpricedRequests" },
  inputTokens: { $sum: "$cost.inputTokens" },
  cachedInputTokens: { $sum: "$cost.cachedInputTokens" },
  cacheWriteInputTokens: { $sum: "$cost.cacheWriteInputTokens" },
  outputTokens: { $sum: "$cost.outputTokens" },
  reasoningOutputTokens: { $sum: "$cost.reasoningOutputTokens" },
};
const empty = (): UsageSummary => summary({});
function summary(
  row: Partial<Record<keyof CostTotals, unknown>>,
): UsageSummary {
  const n = (k: keyof CostTotals) =>
    typeof row[k] === "number" ? (row[k] as number) : 0;
  return {
    costMicros: n("costMicros"),
    costUsd: usd(n("costMicros")),
    requests: n("requests"),
    unpricedRequests: n("unpricedRequests"),
    inputTokens: n("inputTokens"),
    cachedInputTokens: n("cachedInputTokens"),
    cacheWriteInputTokens: n("cacheWriteInputTokens"),
    outputTokens: n("outputTokens"),
    reasoningOutputTokens: n("reasoningOutputTokens"),
  };
}

export class Costs {
  private warned = new Set<string>();
  constructor(private store: Store) {}

  // Every price ever set for a model, newest first. One document per price
  // change, so the list is small enough to hold while a turn is priced.
  pricesFor(modelName: string) {
    return this.store.pricing
      .find({ modelName })
      .sort({ effectiveFrom: -1 })
      .toArray();
  }

  // The model name billed for a session: the chat's override, else the
  // agent's model profile. Looked up directly so that disabling a profile or
  // agent later does not stop its past usage from being priced.
  private async modelNameFor(s: Session): Promise<string | null> {
    if (s.settings?.model) return s.settings.model;
    const agent = await this.store.agents.findOne({
      _id: { $in: idCandidates(s.agentId) },
    });
    if (!agent) return null;
    const profile = await this.store.profiles.findOne({
      _id: { $in: idCandidates(agent.modelProfileId) },
    });
    return profile?.modelName ?? null;
  }

  // Puts the turn's cost on its trace before the turn is stored. Mongo errors
  // propagate so the record is not acknowledged and is delivered again;
  // nothing else here throws.
  async stamp(s: Session, event: DomainEvent): Promise<DomainEvent> {
    const trace = (event.data as any)?.trace as TurnTrace | undefined;
    if (event.type !== "turn.completed" || !trace?.turnId) return event;
    const modelName = await this.modelNameFor(s);
    const prices = modelName ? await this.pricesFor(modelName) : [];
    const stamped = stampEvent(event, modelName, prices);
    const cost = (stamped.data as any)?.trace?.cost as TraceCost | undefined;
    if (!cost) return stamped;
    log("info", "turn cost recorded", {
      op: "cost",
      sessionId: s._id,
      turnId: trace.turnId,
      calls: cost.requests,
      unpricedCalls: cost.unpricedRequests,
      truncated: trace.callsTruncated === true,
    });
    const key = modelName ?? "(unknown model)";
    if (cost.unpricedRequests && !this.warned.has(key)) {
      this.warned.add(key);
      log("warn", "model has no usable price; usage recorded unpriced", {
        op: "cost",
        modelName: key,
      });
    }
    return stamped;
  }

  // What this session's turns were stored with, newest first, by turn id.
  private async storedCosts(sessionId: string): Promise<StoredCosts> {
    const rows = await this.store.traces
      .find(
        { sessionId, cost: { $exists: true } },
        { projection: { turnId: 1, cost: 1 } },
      )
      .sort({ startedAt: -1 })
      .limit(TURN_LIMIT)
      .toArray();
    return new Map(rows.map((r) => [r.turnId, r.cost as TraceCost]));
  }

  // For one open live stream, or one load of a conversation: prices what the
  // runtime sends without waiting on the database, so a turn's cost reaches
  // the browser in the same event as its tokens, and a reload shows the same
  // cost as before. The model, its prices and the costs already stored are
  // loaded now and again when a turn starts (a chat can switch model, prices
  // can change). If they cannot be loaded the event is sent without a cost;
  // the stored trace still has one.
  async livePricer(s: Session) {
    let loaded: {
      modelName: string | null;
      prices: PriceDocument[];
      stored: StoredCosts;
    } | null = null;
    const load = async () => {
      try {
        const modelName = await this.modelNameFor(s);
        loaded = {
          modelName,
          prices: modelName ? await this.pricesFor(modelName) : [],
          stored: await this.storedCosts(s._id),
        };
      } catch (error) {
        loaded = null;
        log("warn", "live pricing unavailable", {
          op: "cost",
          sessionId: s._id,
          error: String((error as Error)?.message ?? error),
        });
      }
    };
    await load();
    const stamp = <
      E extends Pick<DomainEvent, "type" | "data"> & { at?: unknown },
    >(
      event: E,
    ): E =>
      loaded
        ? stampEvent(event, loaded.modelName, loaded.prices, loaded.stored)
        : event;
    return {
      refresh: load,
      stamp,
      // For PublicEventStream: every raw event of the stream passes through
      // here before it is made public.
      prepare: (raw: any) => {
        // A new turn may use another model or newer prices.
        if (raw?.type === "turn.started") void load();
        return stamp(raw);
      },
    };
  }

  // A runtime snapshot with each turn's cost set, for a client that loads the
  // conversation. Never throws: without prices the snapshot comes back as it was.
  async pricedSnapshot<T>(s: Session, snapshot: T): Promise<T> {
    const pricer = await this.livePricer(s);
    const event = pricer.stamp({ type: "snapshot", data: snapshot } as any);
    return (event as any).data as T;
  }

  // The conversation's total and each turn's cost, for the receipt and the
  // activity panel. The total is the session's stored running total, or summed
  // from its traces for a conversation that has none yet.
  async sessionCost(sessionId: string): Promise<SessionCost> {
    const session = await this.store.sessions.findOne(
      { _id: sessionId },
      { projection: { usage: 1 } },
    );
    const stored = session?.usage as SessionUsage | undefined;
    const rows = await this.store.traces
      .find(
        { sessionId, cost: { $exists: true } },
        { projection: { turnId: 1, startedAt: 1, cost: 1 } },
      )
      .sort({ startedAt: -1 })
      .limit(TURN_LIMIT)
      .toArray();
    let total: UsageSummary;
    if (stored) total = summary(stored);
    else {
      const [row] = await this.store.traces
        .aggregate([
          { $match: { sessionId, cost: { $exists: true } } },
          { $group: { _id: null, ...sums } },
        ])
        .toArray();
      total = row ? summary(row) : empty();
    }
    return {
      sessionId,
      total,
      turns: rows.map((r): TurnCost => ({
        turnId: r.turnId,
        costMicros: r.cost?.costMicros ?? 0,
        requests: r.cost?.requests ?? 0,
        unpricedRequests: r.cost?.unpricedRequests ?? 0,
      })),
    };
  }

  // One user's own usage in a range, with a per-model and per-day split.
  async userUsage(userId: string, range: { from: string; to: string }) {
    const match = {
      userId,
      cost: { $exists: true },
      startedAt: { $gte: range.from, $lt: range.to },
    };
    const [facets] = await this.store.traces
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $group: { _id: null, ...sums } }],
            byModel: [
              {
                $group: {
                  _id: { $ifNull: ["$cost.modelName", "(unknown)"] },
                  ...sums,
                },
              },
              { $sort: { costMicros: -1 } },
            ],
            byDay: [
              {
                $group: {
                  _id: { $substrBytes: ["$startedAt", 0, 10] },
                  ...sums,
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ])
      .toArray();
    return {
      userId,
      ...range,
      total: facets?.total?.[0] ? summary(facets.total[0]) : empty(),
      byModel: (facets?.byModel ?? []).map((r: any) => ({
        model: r._id,
        ...summary(r),
      })),
      byDay: (facets?.byDay ?? []).map((r: any) => ({
        day: r._id,
        ...summary(r),
      })),
    };
  }

  // Admin view: every user of the current tenant, highest spend first.
  async allUsersUsage(range: { from: string; to: string }) {
    const match = {
      cost: { $exists: true },
      startedAt: { $gte: range.from, $lt: range.to },
    };
    const [facets] = await this.store.traces
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $group: { _id: null, ...sums } }],
            users: [
              {
                $group: { _id: { $ifNull: ["$userId", "(unknown)"] }, ...sums },
              },
              { $sort: { costMicros: -1 } },
              { $limit: ADMIN_USER_LIMIT },
            ],
          },
        },
      ])
      .toArray();
    return {
      ...range,
      total: facets?.total?.[0] ? summary(facets.total[0]) : empty(),
      users: (facets?.users ?? []).map((r: any) => ({
        userId: r._id,
        ...summary(r),
      })),
    };
  }
}

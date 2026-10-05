// Cost of model requests: priced from truex_model_pricing, one document per
// request in usage_requests (the source of truth), totals aggregated on read.
// Money is integer micro-USD; rates are decimal strings and are never held as
// floats. An unknown price is "unpriced", never zero.
import type {
  DomainEvent,
  Session,
  SessionCost,
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
export interface RateSnapshot {
  input: string;
  cachedInput: string;
  cacheWrite: string;
  output: string;
}
export type CostStatus = "priced" | "unpriced";
export interface UsageRequestDocument {
  _id: string;
  userId: string | null;
  sessionId: string;
  turnId: string;
  agentId: string;
  source: UsageCall["source"];
  modelName: string | null;
  at: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  pricingId: string | null;
  rates: RateSnapshot | null;
  costMicros: number | null;
  costStatus: CostStatus;
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

// A bulk insert that failed only on duplicate keys is a replay, not an error.
function onlyDuplicates(error: any) {
  if (error?.code !== 11000) return false;
  const errors = error.writeErrors;
  if (!errors) return true;
  return ([] as any[])
    .concat(errors)
    .every((e) => (e?.code ?? e?.err?.code) === 11000);
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

const sums = {
  costMicros: { $sum: "$costMicros" },
  requests: { $sum: 1 },
  unpricedRequests: {
    $sum: { $cond: [{ $eq: ["$costStatus", "unpriced"] }, 1, 0] },
  },
  inputTokens: { $sum: "$inputTokens" },
  cachedInputTokens: { $sum: "$cachedInputTokens" },
  cacheWriteInputTokens: { $sum: "$cacheWriteInputTokens" },
  outputTokens: { $sum: "$outputTokens" },
  reasoningOutputTokens: { $sum: "$reasoningOutputTokens" },
};
const empty = (): UsageSummary => summary({});
function summary(row: Record<string, any>): UsageSummary {
  const n = (k: string) => (typeof row[k] === "number" ? row[k] : 0);
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

  // The price in force for a model at a moment, or null.
  priceAt(modelName: string, at: string) {
    return this.store.pricing.findOne(
      {
        modelName,
        effectiveFrom: { $lte: at },
        $or: [
          { effectiveTo: null },
          { effectiveTo: { $exists: false } },
          { effectiveTo: { $gt: at } },
        ],
      },
      { sort: { effectiveFrom: -1 } },
    );
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

  // Records one document per model request of a finished turn. Replaying the
  // same event inserts nothing new. Mongo errors propagate so the record is
  // not acknowledged and is delivered again; nothing else here throws.
  async record(s: Session, event: DomainEvent) {
    if (event.type !== "turn.completed") return;
    const trace = event.data?.trace as TurnTrace | undefined;
    const calls = trace?.calls;
    if (!trace?.turnId || !Array.isArray(calls) || !calls.length) return;
    const modelName = await this.modelNameFor(s);
    const docs: UsageRequestDocument[] = [];
    for (const c of calls) {
      if (!c || !Number.isInteger(c.seq) || c.seq < 0) continue;
      const at = isoOf(c.at) ?? isoOf(event.at) ?? new Date().toISOString();
      const price = modelName ? await this.priceAt(modelName, at) : null;
      const rates = price ? resolveRates(price) : null;
      docs.push({
        _id: `${s._id}:${trace.turnId}:${c.seq}`,
        userId: s.userId ?? null,
        sessionId: s._id,
        turnId: trace.turnId,
        agentId: s.agentId,
        source: c.source === "helper" ? "helper" : "main",
        modelName,
        at,
        inputTokens: Number(count(c.inputTokens)),
        cachedInputTokens: Number(count(c.cachedInputTokens)),
        cacheWriteInputTokens: Number(count(c.cacheWriteInputTokens)),
        outputTokens: Number(count(c.outputTokens)),
        reasoningOutputTokens: Number(count(c.reasoningOutputTokens)),
        pricingId: price && rates ? price._id : null,
        rates: rates?.snapshot ?? null,
        costMicros: rates ? costMicros(c, rates) : null,
        costStatus: rates ? "priced" : "unpriced",
      });
    }
    if (!docs.length) return;
    try {
      await this.store.usageRequests.insertMany(docs, { ordered: false });
    } catch (error) {
      if (!onlyDuplicates(error)) throw error;
    }
    const unpriced = docs.filter((d) => d.costStatus === "unpriced").length;
    log("info", "turn cost recorded", {
      op: "cost",
      sessionId: s._id,
      turnId: trace.turnId,
      calls: docs.length,
      unpricedCalls: unpriced,
      truncated: trace.callsTruncated === true,
    });
    const key = modelName ?? "(unknown model)";
    if (unpriced && !this.warned.has(key)) {
      this.warned.add(key);
      log("warn", "model has no usable price; usage recorded unpriced", {
        op: "cost",
        modelName: key,
      });
    }
  }

  // The conversation's total and each turn's cost, for the receipt and the
  // activity panel. A turn's cost is the sum of its requests, main and helper.
  async sessionCost(sessionId: string): Promise<SessionCost> {
    const [facets] = await this.store.usageRequests
      .aggregate([
        { $match: { sessionId } },
        {
          $facet: {
            total: [{ $group: { _id: null, ...sums } }],
            turns: [
              { $group: { _id: "$turnId", at: { $min: "$at" }, ...sums } },
              { $sort: { at: -1 } },
              { $limit: TURN_LIMIT },
            ],
          },
        },
      ])
      .toArray();
    return {
      sessionId,
      total: facets?.total?.[0] ? summary(facets.total[0]) : empty(),
      turns: (facets?.turns ?? []).map((r: any) => ({
        turnId: r._id,
        costMicros: r.costMicros ?? 0,
        requests: r.requests ?? 0,
        unpricedRequests: r.unpricedRequests ?? 0,
      })),
    };
  }

  // One user's own usage in a range, with a per-model and per-day split.
  async userUsage(userId: string, range: { from: string; to: string }) {
    const match = { userId, at: { $gte: range.from, $lt: range.to } };
    const [facets] = await this.store.usageRequests
      .aggregate([
        { $match: match },
        {
          $facet: {
            total: [{ $group: { _id: null, ...sums } }],
            byModel: [
              {
                $group: {
                  _id: { $ifNull: ["$modelName", "(unknown)"] },
                  ...sums,
                },
              },
              { $sort: { costMicros: -1 } },
            ],
            byDay: [
              { $group: { _id: { $substrBytes: ["$at", 0, 10] }, ...sums } },
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
    const match = { at: { $gte: range.from, $lt: range.to } };
    const [facets] = await this.store.usageRequests
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

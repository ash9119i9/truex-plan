// A reply's parts in the spec's fixed slot order (DESIGN-SPEC 11.7): helpers,
// then the work (tool rows and the narration between them), then asks (steers,
// requests), then the answer. Parts keep their stream order inside a slot.
export type Slot = "helpers" | "tools" | "asks" | "body";

const RANK: Record<Slot, number> = { helpers: 0, tools: 1, asks: 2, body: 3 };

export function orderTurn<T>(
  parts: readonly T[],
  slot: (part: T) => Slot,
): T[] {
  return parts
    .map((part, index) => ({ part, index, rank: RANK[slot(part)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ part }) => part);
}

// The work fold's summary line (spec 12.2 tool group): live while anything runs.
export function workLabel(steps: number, running: number): string {
  if (running > 0) return "Using tools";
  return `Used ${steps} ${steps === 1 ? "tool" : "tools"}`;
}

// A step's duration (DESIGN-SPEC 12): "6.3s" under 10 s, "12s" under a
// minute, "1m 5s" after that; "" when unknown.
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// The work fold's flag: only the outcomes that happened.
export function workFlag(counts: {
  failed: number;
  declined: number;
  stopped: number;
}): string {
  return [
    counts.failed && `${counts.failed} failed`,
    counts.declined && `${counts.declined} not allowed`,
    counts.stopped && `${counts.stopped} stopped`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The working indicator's label (DESIGN-SPEC 12.2): what the turn waits on.
export function workingLabel(state: {
  /** A request is waiting for the member. */
  waiting: boolean;
  /** Helpers still running. */
  helpers: number;
  /** The step running now, as "‹Connector› · ‹Tool›". */
  tool: string | null;
  /** Nothing has shown for a while. */
  slow: boolean;
}): string {
  if (state.waiting) return "Waiting for you";
  if (state.helpers > 0)
    return `Waiting on ${state.helpers} ${state.helpers === 1 ? "helper" : "helpers"}`;
  if (state.tool) return `Running ${state.tool}`;
  return state.slow ? "Still working…" : "Working";
}

// A failed run as the spec's TurnError (DESIGN-SPEC 12.5): title, reference
// code and the one action. The platform's message is the body.
export type TurnErrorView = {
  title: string;
  code: string;
  action: "retry" | "new";
};
export function turnErrorOf(
  error: { code: string; message?: string; retryable: boolean } | null,
): TurnErrorView {
  const action = !error || error.retryable ? "retry" : "new";
  switch (error?.code) {
    case "RATE_LIMITED":
      return {
        title: "Too many requests right now",
        code: "rate_limited",
        action,
      };
    case "MODEL_TIMEOUT":
    case "PROVIDER_ERROR":
      return {
        title: "The model service is unavailable",
        code: "provider_unavailable",
        action,
      };
    case "CONTEXT_FULL":
      return {
        title: "This conversation is too long",
        code: "context_length_exceeded",
        action,
      };
    default:
      return { title: "Something went wrong", code: "internal_error", action };
  }
}

// A count for the receipt (DESIGN-SPEC 12.8): "18.4k" from a thousand, no ".0".
export function compactCount(n: number): string {
  const short = (value: number, unit: string) =>
    `${(Math.round(value * 10) / 10).toString()}${unit}`;
  if (n >= 1_000_000) return short(n / 1_000_000, "M");
  if (n >= 1_000) return short(n / 1_000, "k");
  return String(n);
}

// A catalogue model name for display: the "Claude " prefix is dropped (D7).
export const modelLabel = (name: string | null | undefined) =>
  (name ?? "").replace(/^Claude\s+/, "");

type Timings = {
  acceptedAt: string;
  dispatchedAt?: string;
  firstTextAt?: string;
  completedAt?: string;
};

// The trace card's timing rows, from the timestamps the platform records;
// a row whose two ends aren't both known is left out.
export function traceTimings(run: {
  timings: Timings;
}): Array<[string, string]> {
  const t = run.timings;
  const at = (iso?: string) => (iso ? Date.parse(iso) : NaN);
  const rows: Array<[string, number, number]> = [
    ["Accept", at(t.acceptedAt), at(t.dispatchedAt)],
    ["First token", at(t.acceptedAt), at(t.firstTextAt)],
    ["Stream", at(t.firstTextAt), at(t.completedAt)],
    ["Total", at(t.acceptedAt), at(t.completedAt)],
  ];
  return rows.flatMap(([label, from, to]) =>
    Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? [[label, duration(to - from)] as [string, string]]
      : [],
  );
}

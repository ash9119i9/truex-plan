import { log } from "../../shared/logging";

// Long-lived connections (live conversation streams) are authorized when they
// open, but a person can be signed out, removed or demoted, or a workspace
// disabled, while one is open. The guard re-checks on a timer and ends the
// stream, so a revoked person stops receiving content within one interval
// (kept well inside the thirty-second bound). It checks without extending the
// session: a stream's own traffic never keeps a login alive.

export const MAX_REVALIDATE_MS = 25_000;
export function revalidateMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.STREAM_REVALIDATE_MS);
  if (!Number.isFinite(value) || value <= 0) return 10_000;
  return Math.min(Math.max(Math.floor(value), 100), MAX_REVALIDATE_MS);
}

export type GuardVerdict =
  /** Access is unchanged. */
  | { ok: true }
  /** Access was withdrawn (signed out, removed, demoted, hidden, disabled). */
  | { ok: false; reason: "revoked" }
  /** Access could not be confirmed (the authority store failed). */
  | { ok: false; reason: "unavailable" };

/**
 * Calls check every intervalMs, one at a time, until stop() or a verdict that
 * is not ok; then calls onEnd once. A check that throws counts as
 * unavailable: a stream never outlives its authority store.
 */
export function watchAccess(options: {
  intervalMs: number;
  check: () => Promise<GuardVerdict>;
  onEnd: (verdict: Exclude<GuardVerdict, { ok: true }>) => void;
}) {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    options
      .check()
      .catch((): GuardVerdict => ({ ok: false, reason: "unavailable" }))
      .then((verdict) => {
        running = false;
        if (stopped || verdict.ok) return;
        stopped = true;
        clearInterval(timer);
        options.onEnd(verdict);
      });
  }, options.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Caps concurrent live streams per person on this process. It bounds memory
 * and sockets; across several instances each keeps its own count, so the
 * effective ceiling is this number times the instances.
 */
export class StreamLimiter {
  private open = new Map<string, number>();
  constructor(readonly max: number) {}
  /** A release function, or undefined when the person is at the cap. */
  acquire(userId: string): (() => void) | undefined {
    const count = this.open.get(userId) ?? 0;
    if (count >= this.max) return undefined;
    this.open.set(userId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(userId) ?? 1) - 1;
      if (left > 0) this.open.set(userId, left);
      else this.open.delete(userId);
    };
  }
  get size() {
    return this.open.size;
  }
}
export function streamLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.STREAMS_PER_USER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 10;
}

export function logStreamEnd(
  fields: Record<string, string | number | undefined>,
) {
  log("info", "live stream access ended", fields);
}

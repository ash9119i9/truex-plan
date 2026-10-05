export interface BatchScheduler {
  requestFrame?: (run: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer: (run: () => void, delay: number) => unknown;
  clearTimer: (id: unknown) => void;
}

// T3 publishes ordered stream chunks together. SSE delivers individual frames;
// gather those frames until the next paint, retaining every event and its order.
// A timer also progresses background tabs where animation frames are suspended.
export function createOrderedBatch<T>(
  publish: (items: T[]) => void,
  scheduler: BatchScheduler = {
    requestFrame:
      typeof requestAnimationFrame === "function"
        ? (run) => requestAnimationFrame(run)
        : undefined,
    cancelFrame:
      typeof cancelAnimationFrame === "function"
        ? (id) => cancelAnimationFrame(id)
        : undefined,
    setTimer: (run, delay) => setTimeout(run, delay),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  },
) {
  let pending: T[] = [];
  let frame: number | undefined;
  let timer: unknown;
  const cancelSchedule = () => {
    if (frame !== undefined) scheduler.cancelFrame?.(frame);
    if (timer !== undefined) scheduler.clearTimer(timer);
    frame = undefined;
    timer = undefined;
  };
  const flush = () => {
    cancelSchedule();
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    publish(items);
  };
  return {
    push(item: T) {
      pending.push(item);
      // Bound queued event count even if the browser cannot schedule a paint.
      if (pending.length >= 2048) return flush();
      if (timer !== undefined) return;
      timer = scheduler.setTimer(flush, 50);
      frame = scheduler.requestFrame?.(flush);
    },
    flush,
    discard() {
      cancelSchedule();
      pending = [];
    },
  };
}

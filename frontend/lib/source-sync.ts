import type { DomainEvent, Snapshot } from "../../shared/contracts";
import { applyChatEvent, type Entry } from "./chat.ts";
import { coalesceChatEvents } from "./chat-batch.ts";

// This pair covers the bounded public source projection only. Durable user,
// command and paged display entries never participate in its cursor authority.
export interface SourcePair {
  protocol: 1;
  // Trusted public session scope stamped by its URL-bound subscription. The
  // server intentionally omits the private runtime thread identifier.
  threadId: string;
  cursor: string;
  entries: Entry[];
}
export interface SourceSync {
  phase: "cold" | "handoff" | "warm" | "ready" | "legacy";
  fromCursor: string | null;
  pair: SourcePair | null;
  snapshotCursor: string | null;
}
export interface SyncMarker {
  protocol: 1;
  mode: "snapshot" | "replay";
  fromCursor: string | null;
  highWaterCursor: string;
  snapshot: Snapshot;
}

export function sourceCursor(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /^([A-Za-z0-9_-]{1,64}):(0|[1-9]\d{0,15})$/.exec(value);
  if (!match) return null;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence)
    ? { generation: match[1], sequence }
    : null;
}

function sourceSnapshot(value: any): value is Snapshot {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !!value.state &&
    ["idle", "starting", "running", "interrupting"].includes(
      value.state.kind,
    ) &&
    (!["running", "interrupting"].includes(value.state.kind) ||
      typeof value.state.turnId === "string") &&
    Array.isArray(value.pending) &&
    value.pending.every(
      (request: any) =>
        !!request &&
        typeof request.requestId === "string" &&
        typeof request.method === "string" &&
        !!request.detail &&
        typeof request.detail === "object" &&
        !Array.isArray(request.detail),
    ) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (message: any) =>
        !!message &&
        typeof message.id === "string" &&
        typeof message.text === "string",
    ) &&
    (value.thinking === undefined ||
      (Array.isArray(value.thinking) &&
        value.thinking.every(
          (part: any) =>
            !!part &&
            typeof part.id === "string" &&
            (part.raw === undefined || typeof part.raw === "string") &&
            (part.summary === undefined || typeof part.summary === "string"),
        ))) &&
    ["timings", "traces", "subAgents"].every(
      (key) => value[key] === undefined || Array.isArray(value[key]),
    ) &&
    (value.plan === undefined ||
      value.plan === null ||
      Array.isArray(value.plan))
  );
}

export function readSyncMarker(event: DomainEvent): SyncMarker | null {
  const data = event.data;
  if (
    event.type !== "sync.completed" ||
    data.protocol !== 1 ||
    !["snapshot", "replay"].includes(data.mode) ||
    (data.fromCursor !== null && !sourceCursor(data.fromCursor)) ||
    !sourceCursor(data.highWaterCursor) ||
    event.cursor !== data.highWaterCursor ||
    event.seq !== sourceCursor(event.cursor)?.sequence ||
    !sourceSnapshot(data.snapshot) ||
    data.snapshot.cursor !== event.cursor ||
    data.snapshot.messages.length ||
    (data.snapshot.thinking?.length ?? 0)
  )
    return null;
  return data as SyncMarker;
}

export function beginSourceSync(
  pair: SourcePair | null,
  recovered = false,
): SourceSync {
  return {
    phase: pair ? "warm" : recovered ? "handoff" : "cold",
    fromCursor: pair?.cursor ?? null,
    pair,
    snapshotCursor: null,
  };
}

const onlySourceText = (entries: Entry[]) =>
  entries.filter(
    (entry) =>
      entry.kind === "thinking" ||
      (entry.kind === "message" && entry.role === "assistant"),
  );

// Pure preparation: callers commit this returned state only after every other
// UI projection succeeds. Transport then checkpoints that same accepted batch.
export function advanceSourceSync(
  current: SourceSync,
  incoming: readonly DomainEvent[],
) {
  let state = current;
  const accepted: DomainEvent[] = [];
  let operational: Snapshot | null = null;
  const fail = (failure: string) => ({
    state: { ...current, pair: null },
    accepted: [],
    operational: null,
    failure,
  });
  if (state.phase === "cold" || state.phase === "legacy")
    return { state, accepted: [...incoming], operational, failure: null };
  for (const event of incoming) {
    if (event.type === "resync.required") return fail("resync");
    const cursor = sourceCursor(event.cursor);
    const previous = sourceCursor(state.pair?.cursor);
    if (
      !cursor ||
      typeof event.threadId !== "string" ||
      !event.threadId ||
      event.seq !== cursor.sequence
    )
      return fail("invalid_cursor");
    if (state.pair && event.threadId !== state.pair.threadId)
      return fail("thread_changed");
    if (previous && previous.generation !== cursor.generation)
      return fail("generation_changed");
    if (event.type === "sync.completed") {
      const marker = readSyncMarker(event);
      if (
        !marker ||
        !state.pair ||
        marker.highWaterCursor !== event.cursor ||
        marker.fromCursor !== state.fromCursor ||
        (state.phase === "warm" && marker.mode !== "replay") ||
        (state.phase === "handoff" &&
          (marker.mode !== "snapshot" ||
            state.snapshotCursor !== event.cursor)) ||
        (previous && cursor.sequence < previous.sequence)
      )
        return fail("invalid_marker");
      state = {
        ...state,
        phase: "ready",
        pair: { ...state.pair, cursor: event.cursor },
      };
      operational = marker.snapshot;
      accepted.push(event);
      continue;
    }
    if (event.type === "snapshot") {
      if (
        state.phase !== "handoff" ||
        !sourceSnapshot(event.data) ||
        event.data.cursor !== event.cursor
      )
        return fail("unexpected_snapshot");
      state = {
        ...state,
        snapshotCursor: event.cursor,
        pair: {
          protocol: 1,
          threadId: event.threadId,
          cursor: event.cursor,
          entries: onlySourceText(applyChatEvent([], event)),
        },
      };
      accepted.push(event);
      continue;
    }
    if (!state.pair) return fail("missing_source_snapshot");
    if (previous && cursor.sequence <= previous.sequence) continue;
    state = { ...state, pair: { ...state.pair, cursor: event.cursor } };
    accepted.push(event);
  }
  if (state.pair) {
    // A source snapshot already built its entries from empty. Apply only frames
    // after that snapshot, preserving the existing coalescing/reducer oracle.
    const lastSnapshot = accepted.findLastIndex(
      (event) => event.type === "snapshot",
    );
    const updates = accepted
      .slice(lastSnapshot + 1)
      .filter((event) => event.type !== "sync.completed");
    state = {
      ...state,
      pair: {
        ...state.pair,
        entries: onlySourceText(
          coalesceChatEvents(updates).reduce(
            applyChatEvent,
            state.pair!.entries,
          ),
        ),
      },
    };
    const pair = state.pair!;
    const bytes = pair.entries.reduce(
      (sum, entry) =>
        sum +
        (entry.kind === "message"
          ? entry.text.length
          : entry.kind === "thinking"
            ? entry.text.length +
              (entry.raw?.length ?? 0) +
              (entry.summary?.length ?? 0)
            : 0) *
          2 +
        256,
      0,
    );
    if (pair.entries.length > 2000 || bytes > 8 * 1024 * 1024)
      return fail("projection_limit");
  }
  return { state, accepted, operational, failure: null };
}

// Replay starts from the source pair even if the durable read omits an unfinished
// response. This overlay is display-only and cannot contaminate the source pair.
export function overlaySourceEntries(
  display: Entry[],
  source: Entry[],
): Entry[] {
  const messages = source.flatMap((entry) =>
    entry.kind === "message"
      ? [
          {
            id: entry.itemId,
            turnId: entry.turnId,
            text: entry.text,
            final: entry.final === true,
            messageIndex: entry.messageIndex,
          },
        ]
      : [],
  );
  // Preserve reducer-generated fallback IDs when a reasoning frame has no
  // itemId. Reconstructing a snapshot ID from its display ID would duplicate
  // that row on the next delta.
  let next = display;
  for (const entry of source) {
    if (entry.kind !== "thinking") continue;
    const existing = next.findIndex((old) => old.id === entry.id);
    next = [...next];
    if (existing >= 0) next[existing] = entry;
    else {
      const answer = next.findIndex(
        (old) =>
          old.turnId === entry.turnId &&
          old.kind === "message" &&
          old.role === "assistant",
      );
      next.splice(answer < 0 ? next.length : answer, 0, entry);
    }
  }
  return applyChatEvent(next, {
    type: "snapshot",
    seq: 0,
    cursor: "",
    threadId: "",
    at: "",
    data: {
      messages,
      state: { kind: "running" },
      subAgents: [],
    },
  });
}

// Page-owned readiness wait. Stale markers cannot enable a newer navigation.
// An injected scheduler makes timeout/cancellation regressions deterministic.
export class SynchronizationWaiter {
  private readonly schedule: (run: () => void, ms: number) => () => void;
  private pending: {
    id: string;
    token: number;
    resolve: (ready: boolean) => void;
    cancel: () => void;
  } | null = null;
  constructor(
    schedule = (run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  ) {
    this.schedule = schedule;
  }
  wait(id: string, token: number, timeout = 5000): Promise<boolean> {
    this.cancel();
    const promise = new Promise<boolean>((resolve) => {
      this.pending = { id, token, resolve, cancel: () => {} };
    });
    this.pending!.cancel = this.schedule(() => this.settle(false), timeout);
    return promise;
  }
  complete(id: string, token: number): void {
    if (this.pending?.id === id && this.pending.token === token)
      this.settle(true);
  }
  cancel(): void {
    this.settle(false);
  }
  private settle(ready: boolean): void {
    const pending = this.pending;
    this.pending = null;
    pending?.cancel();
    pending?.resolve(ready);
  }
}

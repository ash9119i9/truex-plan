import type { Snapshot, RateLimitView } from "../../../shared/contracts";
import type { RuntimeReadOptions } from "../../../shared/runtime-read-options";
import type { Thread, Child } from "./state";
import { activeTurn } from "./state";
import { goalView } from "./turn-tracker";

export function snapshot(
  t: Thread,
  options: RuntimeReadOptions,
  operational: () => Snapshot,
): Snapshot {
  let messages = t.messages,
    thinking = t.thinking,
    timings = t.timings,
    traces = t.traces;
  if (options.window) {
    // Choose identities from raw records before mapping or JSON encoding any
    // historical bodies. Keep whole selected turns, never truncate their text.
    const turns = new Set<string>();
    for (let i = messages.length - 1; i >= 0 && turns.size < 10; i--) {
      const turnId = messages[i].turnId;
      if (typeof turnId === "string") turns.add(turnId);
    }
    const active = activeTurn(t);
    if (active) turns.add(active);
    for (const p of t.pending.values())
      if (typeof p.detail.turnId === "string") turns.add(p.detail.turnId);
    for (const message of messages)
      if (!message.final && typeof message.turnId === "string")
        turns.add(message.turnId);
    for (const entry of thinking)
      if (!entry.done && typeof entry.turnId === "string")
        turns.add(entry.turnId);
    // Legacy finalized records lack a group identity. Keep a bounded recent
    // tail; identity-less unfinished records must remain authoritative.
    const legacy = new Set<Snapshot["messages"][number]>();
    for (let i = messages.length - 1; i >= 0 && legacy.size < 20; i--)
      if (messages[i].turnId === undefined) legacy.add(messages[i]);
    messages = messages.filter(
      (m) =>
        !m.final ||
        legacy.has(m) ||
        (m.turnId !== undefined && turns.has(m.turnId)),
    );
    thinking = thinking.filter(
      (r) => !r.done || (r.turnId !== undefined && turns.has(r.turnId)),
    );
    timings = timings.filter((timing) => turns.has(timing.turnId));
    traces = traces.filter((trace) => turns.has(trace.turnId));
  }
  return {
    ...operational(),
    messages,
    thinking,
    timings,
    traces,
    diff: options.window ? "" : t.diff,
  };
}

// A synchronization boundary restores operational authority even when no
// event was missed, without reading or encoding the retained transcript.
export function operationalSnapshot(
  t: Thread,
  generation: string,
  rateLimits: RateLimitView | null,
  agents: () => Child[],
): Snapshot {
  return {
    cursor: `${generation}:${t.seq}`,
    state: t.state,
    pending: [...t.pending.values()]
      .filter((p) => !p.hidden)
      .map(({ timer, rawId, hidden, reviews, ...p }) => p),
    messages: [],
    thinking: [],
    plan: t.plan,
    goal: goalView(t),
    diff: "",
    timings: t.timings.slice(-10),
    traces: t.traces.slice(-10),
    rateLimits: rateLimits,
    subAgents: agents().map((c) => ({ ...c.agent })),
  };
}

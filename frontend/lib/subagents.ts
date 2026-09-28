import type {
  DomainEvent,
  SubAgent,
  SubAgentStatus,
} from "../../shared/contracts";

// Helper agents for one session, keyed by thread ID, plus a bounded live
// preview of what each one is writing.
export interface SubAgentState {
  agents: SubAgent[];
  previews: Record<string, string>;
  // Server clock minus browser clock, learned from event times.
  skewMs?: number;
}
export const emptySubAgents: SubAgentState = { agents: [], previews: {} };
// Keep the tail of a helper's output so a chatty helper can't grow unbounded.
export const PREVIEW_LIMIT = 4000;

const terminal: SubAgentStatus[] = [
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];
export const isRunning = (a: SubAgent) =>
  a.status === "running" || a.status === "pendingInit";
export const isTerminal = (status: SubAgentStatus) => terminal.includes(status);

export function agentName(a: Pick<SubAgent, "nickname" | "role" | "path">) {
  return a.nickname || a.role || a.path || "Helper";
}
export const statusLabels: Record<SubAgentStatus, string> = {
  pendingInit: "Starting",
  running: "Running",
  interrupted: "Stopped",
  completed: "Finished",
  errored: "Failed",
  shutdown: "Closed",
  notFound: "Unavailable",
};

// Merge an update into the list. Events can arrive out of order after a
// reconnect, so a finished helper never reverts to running.
export function upsertAgent(list: SubAgent[], next: SubAgent): SubAgent[] {
  const index = list.findIndex((a) => a.threadId === next.threadId);
  if (index < 0)
    return [
      ...list,
      isTerminal(next.status) && !next.endedAt
        ? { ...next, endedAt: next.startedAt }
        : next,
    ];
  const prev = list[index];
  // A finished helper never reverts to running, and closing a helper that
  // already finished, failed or stopped keeps that outcome.
  const keepEnded =
    isTerminal(prev.status) &&
    (!isTerminal(next.status) ||
      (next.status === "shutdown" && prev.status !== "notFound"));
  const status = keepEnded ? prev.status : next.status;
  const merged: SubAgent = {
    ...prev,
    ...next,
    status,
    path: next.path ?? prev.path,
    nickname: next.nickname ?? prev.nickname,
    role: next.role ?? prev.role,
    task: next.task ?? prev.task,
    lastMessage: next.lastMessage ?? prev.lastMessage,
    startedAt: prev.startedAt || next.startedAt,
    endedAt: isTerminal(status)
      ? prev.endedAt || next.endedAt || new Date().toISOString()
      : undefined,
  };
  return list.map((a, i) => (i === index ? merged : a));
}

const appendPreview = (previous: string, text: string) =>
  (previous + text).slice(-PREVIEW_LIMIT);

// Samples further off than this are treated as replayed history.
const SKEW_LIMIT = 10 * 60_000;
// Network delay only makes events look older, so the largest sample is the
// closest estimate of the server clock's offset.
export function learnSkew(
  skewMs: number | undefined,
  at: string | undefined,
  now = Date.now(),
): number | undefined {
  const sample = at ? Date.parse(at) - now : NaN;
  if (!Number.isFinite(sample) || Math.abs(sample) > SKEW_LIMIT) return skewMs;
  return skewMs === undefined ? sample : Math.max(skewMs, sample);
}

export function applySubAgentEvent(
  state: SubAgentState,
  event: Pick<DomainEvent, "type" | "data"> & { at?: string },
  now = Date.now(),
): SubAgentState {
  const skewMs = learnSkew(state.skewMs, event.at, now);
  return reduceSubAgentEvent(
    skewMs === state.skewMs ? state : { ...state, skewMs },
    event,
  );
}

function reduceSubAgentEvent(
  state: SubAgentState,
  event: Pick<DomainEvent, "type" | "data"> & { at?: string },
): SubAgentState {
  const d = event.data || {};
  switch (event.type) {
    case "snapshot":
      // Older servers send no subAgents; keep what the stream told us.
      return Array.isArray(d.subAgents) ? rehydrate(state, d.subAgents) : state;
    case "subagent.spawned":
    case "subagent.status":
    case "subagent.completed":
      return d.agent?.threadId
        ? { ...state, agents: upsertAgent(state.agents, d.agent) }
        : state;
    case "subagent.event": {
      const id = d.agentThreadId;
      if (!id) return state;
      let agents = state.agents;
      // A helper's output can arrive before its spawn event.
      if (!agents.some((a) => a.threadId === id))
        agents = upsertAgent(agents, {
          threadId: id,
          path: d.agentPath ?? null,
          nickname: d.nickname ?? null,
          role: d.role ?? null,
          depth: typeof d.depth === "number" ? d.depth : 1,
          status: "running",
          // Server time keeps this helper's timer on the same clock.
          startedAt: event.at || new Date().toISOString(),
        });
      const previous = state.previews[id] || "";
      if (d.kind === "message.delta" && typeof d.delta === "string")
        return {
          ...state,
          agents,
          previews: {
            ...state.previews,
            [id]: appendPreview(previous, d.delta),
          },
        };
      if (d.kind === "message.final" && typeof d.text === "string")
        return {
          ...state,
          agents: agents.map((a) =>
            a.threadId === id ? { ...a, lastMessage: d.text } : a,
          ),
          // A final message replaces its own streamed deltas.
          previews: {
            ...state.previews,
            [id]: appendPreview("", d.text),
          },
        };
      if (d.kind === "turn.started")
        return { ...state, agents, previews: { ...state.previews, [id]: "" } };
      return agents === state.agents ? state : { ...state, agents };
    }
  }
  return state;
}

// A snapshot is authoritative for membership; previews survive for helpers
// that are still listed.
export function rehydrate(
  state: SubAgentState,
  agents: SubAgent[],
): SubAgentState {
  const list = agents
    .filter((a) => a && typeof a.threadId === "string")
    .reduce<SubAgent[]>((next, a) => {
      const known = state.agents.find((o) => o.threadId === a.threadId);
      return upsertAgent(next, known ? upsertAgent([known], a)[0] : a);
    }, []);
  const previews: Record<string, string> = {};
  for (const a of list)
    if (state.previews[a.threadId])
      previews[a.threadId] = state.previews[a.threadId];
  return {
    agents: list,
    previews,
    ...(state.skewMs !== undefined ? { skewMs: state.skewMs } : {}),
  };
}

// Spawn order across the session, for numbered fallback names.
export function spawnOrder(agents: SubAgent[]): SubAgent[] {
  return [...agents].sort(
    (a, b) =>
      (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0) ||
      (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
  );
}
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
// Codex's nickname, then a meaningful role, then "Helper N" by spawn order.
// The runtime's placeholder role "default" says nothing, so it is skipped.
export function helperName(
  agent: Pick<SubAgent, "threadId" | "nickname" | "role">,
  all: SubAgent[],
): string {
  if (agent.nickname?.trim()) return agent.nickname.trim();
  const role = agent.role?.trim();
  if (role && role.toLowerCase() !== "default") return capitalize(role);
  const index = spawnOrder(all).findIndex((a) => a.threadId === agent.threadId);
  return `Helper ${index < 0 ? all.length + 1 : index + 1}`;
}

// Cuts at the last word boundary before `max` and marks the cut.
function clipWords(text: string, max: number) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—(]+$/, "") + "…";
}
export const TITLE_LIMIT = 48;
// A short title from the first sentence of the helper's task.
export function taskTitle(task: string | undefined | null): string {
  const text = (task || "").replace(/\s+/g, " ").trim();
  if (!text) return "Working on a task";
  const first = text.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "");
  return clipWords(first || text, TITLE_LIMIT);
}

// Milliseconds a helper has run. Uses server time so the browser clock's
// offset does not show up; never negative.
export function elapsedMs(
  agent: Pick<SubAgent, "startedAt" | "endedAt">,
  nowMs = Date.now(),
  skewMs = 0,
): number {
  const start = Date.parse(agent.startedAt);
  if (!Number.isFinite(start)) return 0;
  const current = nowMs + (Number.isFinite(skewMs) ? skewMs : 0);
  const ended = agent.endedAt ? Date.parse(agent.endedAt) : NaN;
  const end = Number.isFinite(ended) ? ended : current;
  const ms = end - start;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}
// Time a set of helpers has been active: earliest start to latest end, or
// to now while any is still running.
export function groupElapsedMs(
  agents: SubAgent[],
  nowMs = Date.now(),
  skewMs = 0,
): number {
  const starts = agents
    .map((a) => Date.parse(a.startedAt))
    .filter(Number.isFinite);
  if (!starts.length) return 0;
  const startedAt = new Date(Math.min(...starts)).toISOString();
  if (agents.some(isRunning)) return elapsedMs({ startedAt }, nowMs, skewMs);
  const ends = agents
    .map((a) => (a.endedAt ? Date.parse(a.endedAt) : NaN))
    .filter(Number.isFinite);
  return ends.length
    ? elapsedMs(
        { startedAt, endedAt: new Date(Math.max(...ends)).toISOString() },
        nowMs,
        skewMs,
      )
    : 0;
}
// "0:38", "1:12", "1:02:03".
// Whole hours, minutes and seconds of a duration, for rolling timers.
export function durationParts(ms: number) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

export function formatDuration(ms: number): string {
  const { h, m, s } = durationParts(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// The end of a helper's output, cut at a word boundary: at most `maxChars`
// characters and `maxLines` lines.
// The preview is rendered as markdown, so it keeps whole lines where it can
// and never leaves a marker whose partner was cut off.
export function previewTail(text: string, maxChars = 240, maxLines = 4) {
  const lines = (text || "").trim().split("\n");
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (kept.length >= maxLines) break;
    if (kept.length && size + line.length + 1 > maxChars) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  let tail = kept.join("\n").trim();
  let cut = kept.length < lines.length;
  if (tail.length > maxChars) {
    // One long line: cut it, then drop the partial word the cut landed in.
    const start = tail.length - maxChars;
    let piece = tail.slice(start);
    if (!/\s/.test(tail[start - 1] || "")) {
      const space = piece.search(/\s/);
      piece = space < 0 ? piece : piece.slice(space);
    }
    tail = piece.trim();
    cut = true;
  }
  tail = balanceMarkdown(tail);
  if (!cut || !tail) return tail;
  // A list, heading or quote must start its own line to render as one.
  return /^(#{1,6}|[-*+>]|\d+[.)])\s/.test(tail) ? "…\n\n" + tail : "…" + tail;
}
// Removes the first of an unpaired marker: the cut took its partner.
function balanceMarkdown(text: string) {
  const dropFirst = (s: string, marker: RegExp) => {
    const count = (s.match(new RegExp(marker, "g")) || []).length;
    return count % 2 ? s.replace(marker, "") : s;
  };
  let out = dropFirst(text, /```/);
  out = dropFirst(out, /\*\*/);
  out = dropFirst(out, /(?<!`)`(?!`)/);
  return out;
}
export const runningCount = (agents: SubAgent[]) =>
  agents.filter(isRunning).length;

export function elapsedSeconds(a: SubAgent, now = Date.now()) {
  const start = Date.parse(a.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = a.endedAt ? Date.parse(a.endedAt) : now;
  return Math.max(
    0,
    Math.round(((Number.isFinite(end) ? end : now) - start) / 1000),
  );
}
export function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Delegation preferences for new chats. They live in this browser only.
export type DelegationMode = "explicitRequestOnly" | "proactive";
export interface DelegationPrefs {
  mode: DelegationMode;
  maxConcurrent: number;
}
export const defaultDelegation: DelegationPrefs = {
  mode: "explicitRequestOnly",
  maxConcurrent: 3,
};
const prefsKey = "truex.delegation";
export function normalizeDelegation(value: unknown): DelegationPrefs {
  const v = (value || {}) as Partial<DelegationPrefs>;
  const max = Math.round(Number(v.maxConcurrent));
  return {
    mode: v.mode === "proactive" ? "proactive" : "explicitRequestOnly",
    maxConcurrent:
      Number.isFinite(max) && max >= 1
        ? Math.min(5, max)
        : defaultDelegation.maxConcurrent,
  };
}
export function loadDelegation(): DelegationPrefs {
  try {
    return normalizeDelegation(
      JSON.parse(localStorage.getItem(prefsKey) || "null"),
    );
  } catch {
    return defaultDelegation;
  }
}
export function saveDelegation(prefs: DelegationPrefs) {
  try {
    localStorage.setItem(prefsKey, JSON.stringify(normalizeDelegation(prefs)));
  } catch {
    // Storage may be blocked; the preference then lasts for this page only.
  }
}

// View models for the scoped session panel (wireframe r2, section 4).
// Rule: group every panel event by turn id first, then build the This turn
// (a slice) and Session (a sum or a history) scopes on top of that grouping.
// Nothing replaces anything: plan versions, helpers, files and errors keep
// the turn that produced them. Pure functions only; components render these.
import type {
  DomainEvent,
  SubAgent,
  TurnTiming,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";
import type { Entry } from "./chat.ts";
import { formatTokens } from "./goal.ts";
import { errorReasons, turnFailure } from "./goal-errors.ts";
import { formatDuration, turnTokens } from "./observability.ts";
import { stepStatus, type PlanStatus, type PlanStep } from "./plan.ts";
import { elapsedMs, helperName, spawnOrder } from "./subagents.ts";

export { formatTokens, formatDuration };

// ---- Scope -----------------------------------------------------------------

export type Scope = "turn" | "session";
export type PanelTab = "activity" | "goal" | "agents" | "plan" | "insights";

// Goal never slices: a goal spans turns (Board D, note 5).
export const scopeLocked = (tab: PanelTab) => tab === "goal";

// "What each scope shows": Activity follows the live turn (This turn while a
// turn runs, Session when idle); Agents opens on This turn; Plan and Insights
// open on Session; Goal is locked to Session.
export function defaultScope(tab: PanelTab, running: boolean): Scope {
  if (tab === "agents") return "turn";
  if (tab === "activity") return running ? "turn" : "session";
  return "session";
}

// The user's choice is remembered per tab (panel.scope[tab]).
export function effectiveScope(
  tab: PanelTab,
  picked: Partial<Record<PanelTab, Scope>>,
  running: boolean,
): Scope {
  if (scopeLocked(tab)) return "session";
  return picked[tab] ?? defaultScope(tab, running);
}

// The picked turn wins; else the live turn; else the last turn.
export function selectedTurnId(
  turns: { id: string }[],
  pickedId: string | null,
  liveId: string | null,
): string | null {
  if (pickedId && turns.some((t) => t.id === pickedId)) return pickedId;
  if (liveId && turns.some((t) => t.id === liveId)) return liveId;
  return turns.at(-1)?.id ?? null;
}

// "Back to live" shows when a past turn is picked while another one runs.
export function showBackToLive(pickedId: string | null, liveId: string | null) {
  return !!pickedId && !!liveId && pickedId !== liveId;
}

// ---- Formatting --------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
// "10:02" in local time; "" when unknown.
export function clockLabel(at?: string | number | null, seconds = false) {
  const t = at === undefined || at === null ? NaN : new Date(at).getTime();
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
}
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const first = (text: string) => text.replace(/\s+/g, " ").trim();

// ---- Diff parsing (changes view, from diff.updated) --------------------------

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  // Hunk lines for the changes view, "+", "-" or " " prefixed.
  lines: string[];
}
const MAX_DIFF_LINES = 400;

// Parses a unified diff (git style) into one entry per file.
export function parseDiff(text: unknown): FileDiff[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunk = false;
  const start = (path: string): FileDiff => {
    const file: FileDiff = { path, added: 0, removed: 0, created: false, lines: [] };
    files.push(file);
    inHunk = false;
    return file;
  };
  for (const line of text.split("\n")) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      cur = start(git[2]);
      continue;
    }
    if (line.startsWith("--- ") && !inHunk) {
      cur ??= start("");
      if (line.slice(4).trim() === "/dev/null") cur.created = true;
      continue;
    }
    if (line.startsWith("+++ ") && !inHunk) {
      const path = line.slice(4).trim().replace(/^b\//, "");
      if (!cur) cur = start(path);
      else if (path !== "/dev/null" && !cur.path) cur.path = path;
      continue;
    }
    if (!cur) continue;
    const file: FileDiff = cur;
    if (line.startsWith("new file mode")) file.created = true;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) file.added++;
    else if (line.startsWith("-")) file.removed++;
    else if (!line.startsWith(" ")) continue;
    if (file.lines.length < MAX_DIFF_LINES) file.lines.push(line);
  }
  return files.filter((f) => f.path);
}

// ---- Plan versions (history, not a slot) -------------------------------------

export interface PlanStepVM {
  step: string;
  status: PlanStatus;
  // Turns where the step changed status, oldest first.
  history: { status: PlanStatus; turnId?: string }[];
}
export interface PlanVersion {
  version: number;
  createdTurnId?: string;
  supersededTurnId?: string;
  steps: PlanStepVM[];
}

const titles = (plan: PlanStep[]) => plan.map((p) => first(p.step));
const sameTitles = (a: string[], b: string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

// A plan.updated with a different step list starts a new version; one that
// only changes statuses advances the current version.
export function planVersions(
  events: DomainEvent[],
  current: PlanStep[] = [],
): PlanVersion[] {
  const versions: PlanVersion[] = [];
  const apply = (plan: PlanStep[], turnId?: string) => {
    const last = versions.at(-1);
    if (!plan.length) return;
    if (
      !last ||
      !sameTitles(
        last.steps.map((s) => s.step),
        titles(plan),
      )
    ) {
      if (last) last.supersededTurnId = turnId;
      versions.push({
        version: versions.length + 1,
        createdTurnId: turnId,
        steps: plan.map((p) => {
          const status = stepStatus(p.status);
          return {
            step: first(p.step),
            status,
            history: status === "pending" ? [] : [{ status, turnId }],
          };
        }),
      });
      return;
    }
    plan.forEach((p, i) => {
      const status = stepStatus(p.status);
      const step = last.steps[i];
      if (step.status === status) return;
      step.status = status;
      step.history.push({ status, turnId });
    });
  };
  for (const e of events)
    if (e.type === "plan.updated" && Array.isArray(e.data?.plan))
      apply(e.data.plan as PlanStep[], e.turnId);
  // A snapshot restores the latest plan without its history, so changes it
  // brings are not credited to any turn.
  if (current.length) apply(current, undefined);
  return versions;
}

// The version that was active while a turn ran: the newest created at or
// before it. Turn order comes from the caller.
export function versionForTurn(
  versions: PlanVersion[],
  turnOrder: string[],
  turnId: string,
): PlanVersion | undefined {
  const at = turnOrder.indexOf(turnId);
  let found: PlanVersion | undefined;
  for (const v of versions) {
    const created = v.createdTurnId ? turnOrder.indexOf(v.createdTurnId) : -1;
    if (created <= at) found = v;
  }
  return found;
}

// Steps whose status changed during the turn.
export function advancedIn(step: PlanStepVM, turnId: string) {
  return step.history.some((h) => h.turnId === turnId);
}
// The turn a step finished in, or where it is running now.
export function stepTurn(step: PlanStepVM) {
  return step.history.at(-1)?.turnId;
}

export interface PlanDiff {
  kept: string[];
  removed: string[];
  added: string[];
  lines: { kind: "keep" | "del" | "add"; text: string }[];
  label: string;
}
// Step level diff between consecutive versions, matched by step title.
export function planDiff(prev: { step: string }[], next: { step: string }[]): PlanDiff {
  const a = prev.map((s) => first(s.step));
  const b = next.map((s) => first(s.step));
  const kept = a.filter((t) => b.includes(t));
  const removed = a.filter((t) => !b.includes(t));
  const added = b.filter((t) => !a.includes(t));
  return {
    kept,
    removed,
    added,
    lines: [
      ...kept.map((text) => ({ kind: "keep" as const, text: `  ${text}` })),
      ...removed.map((text) => ({ kind: "del" as const, text: `- ${text}` })),
      ...added.map((text) => ({ kind: "add" as const, text: `+ ${text}` })),
    ],
    label: `${kept.length} kept, ${removed.length} removed, ${added.length} added`,
  };
}

export function versionProgress(v: PlanVersion) {
  const done = v.steps.filter((s) => s.status === "completed").length;
  const current = v.steps.findIndex((s) => s.status === "inProgress");
  return { done, total: v.steps.length, current };
}

// ---- Turns: every panel event grouped by turn id -------------------------------

export type LogKind = "think" | "tool" | "agent" | "plan" | "file" | "err";
export type LogIcon = "brain" | "term" | "users" | "list" | "file" | "alert";
export interface LogRow {
  id: string;
  kind: LogKind;
  icon: LogIcon;
  title: string;
  sub?: string;
  // Error reference id, kept with its turn.
  ref?: string;
  // Right-hand column: a clock time, a count or "+8 -31".
  t: string;
  live?: boolean;
  // Helper thread ids nested under the row.
  helpers?: string[];
}

export type TurnStatus = "live" | "done" | "failed" | "stopped";
export interface TurnVM {
  id: string;
  label: string; // "T1"
  index: number;
  startedAt?: string;
  clock: string; // "10:02"
  status: TurnStatus;
  prompt: string;
  steer: boolean;
  durationMs: number | null;
  tokens: number | null;
  helperTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: number;
  failedTools: number;
  errors: number;
  warnings: number;
  helperIds: string[];
  files: FileDiff[];
  rows: LogRow[];
  // Plan version created in this turn, if any.
  planCreated?: number;
}

export interface PanelInput {
  events: DomainEvent[];
  entries?: Entry[];
  traces?: TurnTrace[];
  timings?: TurnTiming[];
  plan?: PlanStep[];
  agents?: SubAgent[];
  // Usage of the running turn, before its trace lands.
  liveUsage?: TurnUsage | null;
  liveTurnId?: string | null;
  now?: number;
}

const FINISHED = /finished|created|could not|stopped|received/i;
const HELPER = /helper/i;
const TOOL_STEPS = new Set(["command", "tool", "fileChange", "webSearch", "other"]);

function errorRow(e: DomainEvent, i: number): LogRow {
  const failure = turnFailure(e.data?.error ?? e.data);
  const reason = failure && failure.reason !== "other" ? errorReasons[failure.reason].label : "";
  return {
    id: `err:${e.seq ?? i}`,
    kind: "err",
    icon: "alert",
    title: reason ? `Request failed: ${reason}` : "Request failed",
    sub: failure?.message,
    ref: e.data?.code ?? e.data?.error?.code,
    t: clockLabel(e.at),
  };
}

// The live turn: turn.started after the last turn.completed.
export function liveTurn(events: DomainEvent[]): string | null {
  let live: string | null = null;
  for (const e of events) {
    if (e.type === "turn.started") live = e.turnId ?? null;
    if (e.type === "turn.completed" && (!live || e.turnId === live)) live = null;
  }
  return live;
}

// Which turn started each helper: the chat's helper block, else the spawn event.
export function helperTurns(
  entries: Entry[] = [],
  events: DomainEvent[] = [],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of events)
    if (e.type === "subagent.spawned" && e.turnId && e.data?.agent?.threadId)
      map[e.data.agent.threadId] ??= e.turnId;
  for (const e of entries)
    if (e.kind === "agents" && e.turnId)
      for (const id of e.threadIds) map[id] ??= e.turnId;
  return map;
}

export function buildTurns(input: PanelInput): TurnVM[] {
  const { events, entries = [], traces = [], timings = [], agents = [] } = input;
  const now = input.now ?? Date.now();
  const live = input.liveTurnId ?? liveTurn(events);

  // 1. Turn order: the chat's order first, then any others by start time.
  const order: string[] = [];
  const seen = (id?: string) => {
    if (id && !order.includes(id)) order.push(id);
  };
  for (const e of entries) seen(e.turnId);
  const extra = [
    ...traces.map((t) => ({ id: t.turnId, at: t.startedAt })),
    ...events
      .filter((e) => e.turnId)
      .map((e) => ({ id: e.turnId as string, at: e.at })),
  ]
    .filter((x) => !order.includes(x.id))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  for (const x of extra) seen(x.id);

  // 2. Group everything by turn id.
  const byTurn = new Map<string, DomainEvent[]>(order.map((id) => [id, []]));
  for (const e of events) if (e.turnId) byTurn.get(e.turnId)?.push(e);
  const helpersOf = helperTurns(entries, events);
  const versions = planVersions(events);
  const diffs = new Map<string, FileDiff[]>();
  for (const e of events)
    if (e.type === "diff.updated" && e.turnId) diffs.set(e.turnId, parseDiff(e.data?.diff));

  // 3. Build each turn's slice.
  return order.map((id, index) => {
    const list = byTurn.get(id) || [];
    const trace = traces.find((t) => t.turnId === id);
    const timing = timings.find((t) => t.turnId === id);
    const started = list.find((e) => e.type === "turn.started");
    const completed = list.findLast((e) => e.type === "turn.completed");
    const startedAt = trace?.startedAt ?? started?.at ?? list[0]?.at;
    const isLive = id === live;
    const turnStatus = completed?.data?.turn?.status ?? trace?.status;
    const status: TurnStatus = isLive
      ? "live"
      : turnStatus === "failed"
        ? "failed"
        : turnStatus === "interrupted"
          ? "stopped"
          : "done";
    const user = entries.find(
      (e): e is Extract<Entry, { kind: "message" }> =>
        e.kind === "message" && e.role === "user" && e.turnId === id,
    );
    const start = Date.parse(startedAt ?? "");
    const durationMs =
      trace?.totalMs ??
      (timing && Number.isFinite(timing.totalMs) ? timing.totalMs : null) ??
      (Number.isFinite(start)
        ? isLive
          ? Math.max(0, now - start)
          : completed
            ? Math.max(0, Date.parse(completed.at) - start)
            : null
        : null);
    const liveTokens = isLive ? (input.liveUsage?.totalTokens ?? null) : null;
    const tokens = trace ? turnTokens(trace) || null : liveTokens;
    const helperIds = Object.entries(helpersOf)
      .filter(([, turn]) => turn === id)
      .map(([thread]) => thread);
    const files = diffs.get(id) || [];

    const rows: LogRow[] = [];
    // Thinking from the chat entries (reasoning is not a panel event).
    for (const e of entries)
      if (e.kind === "thinking" && e.turnId === id) {
        const text = first(e.summary || e.text || "");
        rows.push({
          id: e.id,
          kind: "think",
          icon: "brain",
          title: e.done ? "Thought" : "Thinking",
          sub: text ? text.slice(0, 120) : undefined,
          t: "",
          live: isLive && !e.done,
        });
      }
    let toolCalls = 0;
    let errors = 0;
    let warnings = 0;
    list.forEach((e, i) => {
      if (e.type === "activity.updated" && e.data?.label) {
        const label = String(e.data.label);
        const helper = HELPER.test(label);
        if (!helper && !FINISHED.test(label)) toolCalls++;
        rows.push({
          id: `act:${e.seq ?? i}`,
          kind: helper ? "agent" : "tool",
          icon: helper ? "users" : "term",
          title: label,
          t: clockLabel(e.at),
        });
      } else if (e.type === "error") {
        if (e.data?.willRetry === true) warnings++;
        else {
          errors++;
          rows.push(errorRow(e, i));
        }
      } else if (
        e.type === "turn.completed" &&
        e.data?.turn?.status === "failed" &&
        !errors // the error event already reported this failure
      ) {
        errors++;
        rows.push(errorRow({ ...e, data: e.data.turn }, i));
      }
    });
    // Plan versions and step changes made in this turn.
    let planCreated: number | undefined;
    for (const v of versions) {
      if (v.createdTurnId === id) {
        planCreated = v.version;
        const prev = versions[v.version - 2];
        rows.push({
          id: `plan:${v.version}`,
          kind: "plan",
          icon: "list",
          title: `Plan v${v.version} created`,
          sub: prev
            ? `${plural(v.steps.length, "step")}, supersedes v${prev.version}`
            : plural(v.steps.length, "step"),
          t: "",
        });
      }
      v.steps.forEach((s, i) => {
        const change = s.history.findLast((h) => h.turnId === id);
        if (!change || (v.createdTurnId === id && s.history[0] === change)) return;
        rows.push({
          id: `step:${v.version}:${i}`,
          kind: "plan",
          icon: "list",
          title: `Step ${i + 1} ${change.status === "completed" ? "done" : "started"}`,
          sub: s.step,
          t: "",
        });
      });
    }
    if (helperIds.length)
      rows.push({
        id: `helpers:${id}`,
        kind: "agent",
        icon: "users",
        title: plural(helperIds.length, "helper"),
        sub: helperIds
          .map((t) => {
            const a = agents.find((x) => x.threadId === t);
            return a ? helperName(a, agents) : "";
          })
          .filter(Boolean)
          .join(", "),
        t: trace?.helperUsage ? formatTokens(trace.helperUsage.totalTokens) : "",
        helpers: helperIds,
      });
    for (const f of files)
      rows.push({
        id: `file:${id}:${f.path}`,
        kind: "file",
        icon: "file",
        title: `${isLive ? "Writing" : f.created ? "Created" : "Edited"} ${f.path}`,
        t: isLive ? "now" : lineDelta(f.added, f.removed),
        live: isLive,
      });
    // Once the turn finishes, its trace is authoritative for tool calls.
    const traceTools = trace
      ? (trace.steps || []).filter((s) => TOOL_STEPS.has(s.kind))
      : [];
    return {
      id,
      label: `T${index + 1}`,
      index,
      startedAt,
      clock: clockLabel(startedAt),
      status,
      prompt: user ? first(user.text) : "",
      steer: !!user?.steer,
      durationMs,
      tokens,
      helperTokens: trace?.helperUsage?.totalTokens ?? null,
      inputTokens: trace?.usage?.inputTokens ?? null,
      outputTokens: trace?.usage?.outputTokens ?? null,
      toolCalls: trace ? traceTools.length : toolCalls,
      failedTools: traceTools.filter((s) => s.status === "failed").length,
      errors,
      warnings,
      helperIds,
      files,
      rows,
      planCreated,
    };
  });
}

export function lineDelta(added: number, removed: number) {
  return [added ? `+${added}` : "", removed ? `-${removed}` : ""]
    .filter(Boolean)
    .join(" ") || "0";
}

// ---- Session scope: sums and histories ----------------------------------------

export interface SessionFile {
  path: string;
  added: number;
  removed: number;
  writing: boolean;
  // One entry per turn that touched it, oldest first.
  edits: { turnId: string; label: string; created: boolean; diff: FileDiff }[];
}

export function sessionFiles(turns: TurnVM[]): SessionFile[] {
  const map = new Map<string, SessionFile>();
  for (const t of turns)
    for (const f of t.files) {
      const row = map.get(f.path) ?? {
        path: f.path,
        added: 0,
        removed: 0,
        writing: false,
        edits: [],
      };
      row.added += f.added;
      row.removed += f.removed;
      row.writing = t.status === "live";
      row.edits.push({ turnId: t.id, label: t.label, created: f.created, diff: f });
      map.set(f.path, row);
    }
  return [...map.values()];
}

export interface SessionTotals {
  turns: number;
  tokens: number;
  workingMs: number;
  files: number;
  errors: number;
  helperTokens: number;
  since: string;
}
export function sessionTotals(turns: TurnVM[]): SessionTotals {
  const sum = (f: (t: TurnVM) => number | null) =>
    turns.reduce((n, t) => n + (f(t) ?? 0), 0);
  return {
    turns: turns.length,
    tokens: sum((t) => t.tokens),
    workingMs: sum((t) => t.durationMs),
    files: sessionFiles(turns).length,
    errors: sum((t) => t.errors),
    helperTokens: sum((t) => t.helperTokens),
    since: turns[0]?.clock ?? "",
  };
}

// ---- Helper roster ---------------------------------------------------------------

export interface RosterRun {
  threadId: string;
  turnId?: string;
  turnLabel?: string;
  agent: SubAgent;
  elapsedMs: number;
}
export interface RosterRow {
  name: string;
  role: string;
  tone: number;
  runs: RosterRun[];
  elapsedMs: number;
  warning?: string;
}

// One row per helper: runs of the same helper (same name) merge.
export function helperRoster(
  agents: SubAgent[],
  turns: TurnVM[],
  turnOf: Record<string, string>,
  now = Date.now(),
  skewMs = 0,
): RosterRow[] {
  const rows: RosterRow[] = [];
  spawnOrder(agents).forEach((agent, index) => {
    const name = helperName(agent, agents);
    const turnId = turnOf[agent.threadId];
    const run: RosterRun = {
      threadId: agent.threadId,
      turnId,
      turnLabel: turns.find((t) => t.id === turnId)?.label,
      agent,
      elapsedMs: elapsedMs(agent, now, skewMs),
    };
    let row = rows.find((r) => r.name === name);
    if (!row) {
      row = {
        name,
        role: agent.nickname && agent.role && agent.role !== "default" ? agent.role : "",
        // Same tone as the helper's first run everywhere else.
        tone: index % 3,
        runs: [],
        elapsedMs: 0,
      };
      rows.push(row);
    }
    row.runs.push(run);
    row.elapsedMs += run.elapsedMs;
    if (agent.status === "errored" || agent.status === "notFound")
      row.warning = agent.status === "errored" ? "Failed" : "Unavailable";
  });
  return rows;
}

// "4 helpers (Atlas twice) · 2 plans · 31k tokens from helpers"
export function sessionSubLine(
  roster: RosterRow[],
  versions: PlanVersion[],
  helperTokens: number,
) {
  const twice = roster
    .filter((r) => r.runs.length > 1)
    .map((r) => `${r.name} ${r.runs.length === 2 ? "twice" : `${r.runs.length} times`}`);
  return [
    roster.length &&
      `${plural(roster.length, "helper")}${twice.length ? ` (${twice.join(", ")})` : ""}`,
    versions.length && plural(versions.length, "plan"),
    helperTokens && `${formatTokens(helperTokens)} tokens from helpers`,
  ]
    .filter(Boolean)
    .join(" · ");
}

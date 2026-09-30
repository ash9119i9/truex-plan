// View models for the conversation stream (convo-v2-wireframe-r2.html §1).
// Pure: maps Entry, CommandRecord, ApprovalRecord, SubAgent and TurnTrace into
// what the stream components render. Components never read contracts directly.
import type {
  ApprovalRecord,
  CommandRecord,
  SubAgent,
  TurnTrace,
  TurnUsage,
} from "../../shared/contracts";
import type { Entry } from "./chat.ts";
import type { ErrorRef } from "./api.ts";
import { errorReasons, type TurnFailure } from "./goal-errors.ts";
import { formatDuration, formatTokens, turnTokens } from "./observability.ts";
import {
  formatDuration as clockDuration,
  groupElapsedMs,
  helperName,
  isRunning,
  taskTitle,
  type SubAgentState,
} from "./subagents.ts";

const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";

// "10:02". Empty when the time is missing or invalid.
export function clockTime(at?: string | number | null): string {
  if (at === undefined || at === null || at === "") return "";
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Step durations as the log shows them: 0.3s, 1.2s, 12s, 1m 5s.
export function stepTime(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return formatDuration(ms);
}

// ---- User side -------------------------------------------------------------

export type DeliveryState = "pending" | "accepted" | "failed" | "unknown";
export interface DeliveryView {
  state: DeliveryState;
  // .st-meta modifier and bubble modifier from the wireframe.
  meta: "" | "pend" | "fail" | "unk";
  bubble: "" | "st-pend" | "st-fail";
  icon: "check" | "alert" | "clock" | null;
  spinner: boolean;
  label: string;
  retry: boolean;
}

export function deliveryView(
  delivery: string | undefined,
  at?: string | number | null,
): DeliveryView {
  if (delivery === "pending")
    return {
      state: "pending",
      meta: "pend",
      bubble: "st-pend",
      icon: null,
      spinner: true,
      label: "Sending",
      retry: false,
    };
  if (delivery === "failed")
    return {
      state: "failed",
      meta: "fail",
      bubble: "st-fail",
      icon: "alert",
      spinner: false,
      label: "Not sent",
      retry: true,
    };
  if (delivery === "unknown")
    return {
      state: "unknown",
      meta: "unk",
      bubble: "",
      icon: "clock",
      spinner: false,
      label: "Not confirmed",
      retry: true,
    };
  return {
    state: "accepted",
    meta: "",
    bubble: "",
    icon: "check",
    spinner: false,
    label: clockTime(at),
    retry: false,
  };
}

// "/goal One-page plan" → { name: "goal", arg: "One-page plan" }.
export function parseCommandText(
  value: string,
  method?: string,
): { name: string; arg: string } {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec((value || "").trim());
  if (match) return { name: match[1], arg: match[2].trim() };
  const fallback = (method || "").split("/").filter(Boolean)[1] || "command";
  return { name: fallback, arg: (value || "").trim() };
}

// Section label for a command method; also the result card's aria label.
export function commandLabel(method: string) {
  if (method === "help") return "Chat commands";
  if (method.startsWith("thread/goal/")) return "Goal";
  return (
    (
      {
        "thread/fork": "Conversation branch",
        "thread/compact/start": "Context",
        "thread/settings/update": "Settings",
        "thread/archive": "Archive",
        "thread/unarchive": "Restore",
      } as Record<string, string>
    )[method] || "Command"
  );
}

export interface CommandView {
  name: string;
  arg: string;
  title: string;
  tone: "ok" | "bad";
  tile: "target" | "alert" | "list" | "layers" | "check" | "clock";
  pill: {
    tone: "ok" | "bad" | "warn" | "accent";
    label: string;
    icon: "check" | null;
    spinner: boolean;
  };
  body: string;
  // Failed: the command echoed in mono plus a hint. Goal set: pinned note.
  foot: { mono?: string; text: string; icon?: "eye" } | null;
}

function successTitle(command: CommandRecord) {
  const m = command.method;
  if (m === "thread/goal/set") {
    if (command.params?.status === "paused") return "Goal paused";
    if (command.params?.status === "active") return "Goal resumed";
    return "Goal set";
  }
  return (
    (
      {
        "thread/goal/clear": "Goal cleared",
        "thread/goal/get": "Goal",
        help: "Chat commands",
        "thread/fork": "Branch created",
        "thread/compact/start": "Compaction requested",
        "thread/settings/update": "Settings updated",
        "thread/archive": "Conversation archived",
        "thread/unarchive": "Conversation restored",
      } as Record<string, string>
    )[m] || commandLabel(m)
  );
}

function successBody(command: CommandRecord, objective?: string | null) {
  const m = command.method;
  if (command.result?.help) return command.result.help;
  if (m === "thread/goal/clear") return "Goal cleared.";
  if (m.startsWith("thread/goal/")) return objective || "No goal is set.";
  if (m === "thread/fork") return "Your new conversation branch is ready.";
  if (m === "thread/compact/start")
    return "Context compaction requested. Completion will appear in the conversation activity.";
  if (m === "thread/archive") return "Conversation archived.";
  if (m === "thread/unarchive") return "Conversation restored.";
  return "Conversation settings updated.";
}

export function commandView(
  userText: string,
  command: CommandRecord,
  // The goal the card shows, live or as recorded.
  objective?: string | null,
  // True when this card's goal is the conversation's current goal.
  live = false,
): CommandView {
  const { name, arg } = parseCommandText(userText, command.method);
  const isGoal = command.method.startsWith("thread/goal/");
  const failed = command.state === "failed";
  const tile: CommandView["tile"] = failed
    ? "alert"
    : isGoal
      ? "target"
      : command.method === "help"
        ? "list"
        : command.method === "thread/fork"
          ? "layers"
          : command.state === "succeeded"
            ? "check"
            : "clock";
  const pill: CommandView["pill"] =
    command.state === "succeeded"
      ? { tone: "ok", label: "Done", icon: "check", spinner: false }
      : failed
        ? { tone: "bad", label: "Failed", icon: null, spinner: false }
        : command.state === "running"
          ? { tone: "accent", label: "Running", icon: null, spinner: true }
          : { tone: "warn", label: "Not confirmed", icon: null, spinner: false };
  const title = failed
    ? `${name.charAt(0).toUpperCase()}${name.slice(1)} failed`
    : command.state === "succeeded"
      ? successTitle(command)
      : commandLabel(command.method);
  const body = failed
    ? command.error || "The command could not run."
    : command.state === "running"
      ? "Waiting for the command result."
      : command.state === "unknown"
        ? "The result was not confirmed."
        : successBody(command, objective);
  const foot: CommandView["foot"] = failed
    ? {
        mono: `/${name}${arg ? ` ${arg}` : ""}`,
        text: "edit the command and send again",
      }
    : command.state === "succeeded" &&
        live &&
        command.method === "thread/goal/set" &&
        !command.params?.status
      ? { icon: "eye", text: "Pinned to the topbar until you clear it" }
      : null;
  return {
    name,
    arg,
    title,
    tone: failed ? "bad" : "ok",
    tile,
    pill,
    body,
    foot,
  };
}

// ---- Turns ------------------------------------------------------------------

// Turn numbers in the order turns first appear in the conversation.
export function turnNumbers(entries: Entry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries)
    if (e.turnId && !map.has(e.turnId)) map.set(e.turnId, map.size + 1);
  return map;
}

// ---- Work group: approvals ---------------------------------------------------

export interface AuditRow {
  tone: "ok" | "auto" | "no" | "exp" | "st-s";
  icon: "check" | "spark" | "x" | "clock" | "lock";
  label: string;
  detail: string;
  // Secret answers never render; the row shows a fixed mask instead.
  masked?: boolean;
}

const toolDecisions: Record<
  string,
  Pick<AuditRow, "tone" | "icon" | "label">
> = {
  allowedOnce: { tone: "ok", icon: "check", label: "Allowed once" },
  allowedSession: { tone: "ok", icon: "check", label: "Allowed for session" },
  allowedChat: { tone: "ok", icon: "check", label: "Allowed for this chat" },
  allowedAlways: { tone: "ok", icon: "check", label: "Always allowed" },
  declined: { tone: "no", icon: "x", label: "Declined" },
  expired: { tone: "exp", icon: "clock", label: "Expired" },
  interrupted: { tone: "exp", icon: "clock", label: "Stopped" },
};

export function auditRows(record: ApprovalRecord): AuditRow[] {
  const auto = record.outcome === "auto" && !!record.autoMode;
  return (record.items || []).map((item): AuditRow => {
    if (item.kind === "toolApproval") {
      const d = toolDecisions[item.decision] || toolDecisions.declined;
      const detail = item.action || "Connected business service";
      return auto && d.tone === "ok"
        ? { tone: "auto", icon: "spark", label: "Auto mode", detail }
        : { ...d, detail };
    }
    const question = item.question || "Question";
    if (item.secret && (item.answer || record.outcome === "answered"))
      return {
        tone: "st-s",
        icon: "lock",
        label: "Answered",
        detail: question,
        masked: true,
      };
    if (item.answer)
      return record.outcome === "auto"
        ? {
            tone: "auto",
            icon: "spark",
            label: "Auto mode",
            detail: `${question} · ${item.answer}`,
          }
        : {
            tone: "ok",
            icon: "check",
            label: "Answered",
            detail: `${question} · ${item.answer}`,
          };
    return record.outcome === "interrupted"
      ? { tone: "exp", icon: "clock", label: "Stopped", detail: question }
      : { tone: "exp", icon: "clock", label: "Expired", detail: question };
  });
}

// ---- Work group: log rows ------------------------------------------------------

export type StepIcon =
  | "brain"
  | "term"
  | "file"
  | "plug"
  | "globe"
  | "layers"
  | "shield"
  | "users";
// .node modifier: k-think, k-tool, k-file, k-agent, k-err, k-live, st-k-appr.
export type NodeKind =
  | "k-think"
  | "k-tool"
  | "k-file"
  | "k-agent"
  | "k-err"
  | "k-live"
  | "st-k-appr"
  | "";

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}
export interface FileDiff {
  path: string;
  lines: DiffLine[];
}
export interface LogRow {
  id: string;
  node: NodeKind;
  icon: StepIcon;
  title: string;
  // "Other · <mono>" for unknown item types.
  mono?: string;
  sub?: string;
  // .st-q (mono query) instead of .st-sub.
  query?: boolean;
  t: string;
  running: boolean;
  // Shimmer text for the live row.
  live?: boolean;
  thinking?: { summary: string; raw: string };
  code?: {
    command: string;
    output: string;
    lines: number;
    exitCode: number | null;
  };
  files?: FileDiff[];
  adds?: number;
  dels?: number;
  audit?: AuditRow[];
}

export const OUTPUT_LINES = 12;

// Unified diff (or whole-file content for adds and deletes) as coloured lines.
export function diffLines(
  diff: string,
  kind?: string,
): { lines: DiffLine[]; adds: number; dels: number } {
  const raw = (diff || "").replace(/\n$/, "");
  if (!raw) return { lines: [], adds: 0, dels: 0 };
  const lines: DiffLine[] = [];
  let adds = 0,
    dels = 0;
  const unified = /^(@@|\+\+\+|---|[+-])/m.test(raw) && kind !== "add";
  for (const line of raw.split("\n")) {
    if (!unified) {
      const k = kind === "delete" ? "del" : "add";
      lines.push({ kind: k, text: `${k === "add" ? "+" : "-"} ${line}` });
      if (k === "add") adds++;
      else dels++;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      adds++;
      lines.push({ kind: "add", text: `+ ${line.slice(1)}` });
    } else if (line.startsWith("-")) {
      dels++;
      lines.push({ kind: "del", text: `- ${line.slice(1)}` });
    } else lines.push({ kind: "ctx", text: `  ${line.replace(/^ /, "")}` });
  }
  return { lines, adds, dels };
}

const otherLabels: Record<string, string> = {
  plan: "Made a plan",
  imageView: "Looked at an image",
  imageGeneration: "Made an image",
  contextCompaction: "Compacted the conversation",
  enteredReviewMode: "Started a review",
  exitedReviewMode: "Finished a review",
  sleep: "Waited",
};
const collabLabels: Record<string, string> = {
  sendInput: "Sent a helper a message",
  resumeAgent: "Resumed a helper",
  wait: "Waited for helpers",
  closeAgent: "Closed a helper",
};

function commandTitle(item: any): string {
  const actions: any[] = Array.isArray(item.commandActions)
    ? item.commandActions
    : [];
  if (actions.length && actions.every((a) => a?.type === "read"))
    return `Read ${plural(actions.length, "workspace document")}`;
  if (actions.length && actions.every((a) => a?.type === "listFiles"))
    return "Listed workspace files";
  if (actions.length && actions.every((a) => a?.type === "search"))
    return "Searched the workspace";
  return "Ran a command";
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    const t = text((c as any)?.text);
    if (t) return t.split("\n")[0];
  }
  return "";
}

// One log row for a runtime item, or null when the item is not shown there.
export function itemRow(id: string, item: any): LogRow | null {
  if (!item || typeof item !== "object") return null;
  const status = text(item.status);
  const running = status === "inProgress";
  const failed = status === "failed" || status === "declined";
  const t = stepTime(item.durationMs);
  switch (item.type) {
    case "agentMessage":
    case "userMessage":
    case "reasoning":
    case "hookPrompt":
      return null;
    case "commandExecution": {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const output = (text(item.aggregatedOutput) || "").replace(/\s+$/, "");
      const lines = output ? output.split("\n").length : 0;
      return {
        id,
        node: failed || (exitCode !== null && exitCode !== 0) ? "k-err" : "k-tool",
        icon: "term",
        title: commandTitle(item),
        sub: status === "declined" ? "Declined" : undefined,
        t,
        running,
        code: {
          command: text(item.command),
          output: output.split("\n").slice(0, OUTPUT_LINES).join("\n"),
          lines,
          exitCode,
        },
      };
    }
    case "fileChange": {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      let adds = 0,
        dels = 0;
      const files = changes.map((c): FileDiff => {
        const d = diffLines(text(c?.diff) ? c.diff : "", c?.kind?.type);
        adds += d.adds;
        dels += d.dels;
        return { path: text(c?.path) || "file", lines: d.lines };
      });
      const one = changes.length === 1 ? changes[0] : null;
      const verb =
        one?.kind?.type === "add"
          ? "Created"
          : one?.kind?.type === "delete"
            ? "Deleted"
            : "Edited";
      return {
        id,
        node: failed ? "k-err" : "k-file",
        icon: "file",
        title: one
          ? `${verb} ${files[0].path}`
          : `Edited ${plural(changes.length, "file")}`,
        sub: status === "declined" ? "Declined" : failed ? "Failed" : undefined,
        t,
        running,
        files,
        adds,
        dels,
      };
    }
    case "mcpToolCall": {
      const server = text(item.server),
        tool = text(item.tool);
      const sub =
        text(item.error?.message) ||
        clip(firstText(item.result?.content), 80) ||
        (running ? "Running" : failed ? "Failed" : "");
      return {
        id,
        node: failed ? "k-err" : "k-tool",
        icon: "plug",
        title: [server, tool].filter(Boolean).join(" · ") || "Tool",
        sub: sub || undefined,
        t,
        running,
      };
    }
    case "dynamicToolCall": {
      const bad = failed || item.success === false;
      return {
        id,
        node: bad ? "k-err" : "k-tool",
        icon: "plug",
        title:
          [text(item.namespace), text(item.tool)].filter(Boolean).join(" · ") ||
          "Tool",
        sub: bad ? "Failed" : clip(firstText(item.contentItems), 80) || undefined,
        t,
        running,
      };
    }
    case "webSearch": {
      const q =
        text(item.query) ||
        text(item.action?.query) ||
        text(item.action?.queries?.[0]) ||
        text(item.action?.url);
      const results = Array.isArray(item.results) ? item.results.length : null;
      const sub = [q && `"${clip(q, 120)}"`, results !== null && plural(results, "result")]
        .filter(Boolean)
        .join(" · ");
      return {
        id,
        node: "k-tool",
        icon: "globe",
        title: "Searched the web",
        sub: sub || undefined,
        query: !!q,
        t,
        running,
      };
    }
    case "collabAgentToolCall":
      // Spawns show as the turn's "Started N helpers" row.
      if (item.tool === "spawnAgent") return null;
      return {
        id,
        node: failed ? "k-err" : "k-agent",
        icon: "users",
        title: collabLabels[item.tool] || "Worked with helpers",
        t,
        running,
      };
    default: {
      const type = text(item.type) || "item";
      const known = otherLabels[type];
      return known
        ? { id, node: "", icon: "layers", title: known, t, running }
        : {
            id,
            node: "",
            icon: "layers",
            title: "Other",
            mono: type,
            sub: status && status !== "completed" ? status : undefined,
            t,
            running,
          };
    }
  }
}

// "Thought for 4s", from the matching trace step when one was recorded.
export function thoughtTitle(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "Thought";
  if (ms < 60_000) return `Thought for ${Math.max(1, Math.round(ms / 1000))}s`;
  return `Thought for ${formatDuration(ms)}`;
}

// The bold heading a reasoning summary opens with, for the live row.
export function thinkingHeading(summary: string | undefined): string {
  const m = /^\s*\*\*([^*\n]+)\*\*/.exec(summary || "");
  return m ? `${m[1].trim().replace(/[.…]+$/, "")}…` : "Thinking…";
}

// ---- Work group ----------------------------------------------------------------

export interface WorkContext {
  // This group is the live end of the running turn.
  active: boolean;
  // The answer has started streaming.
  answering: boolean;
  trace?: TurnTrace | null;
  liveUsage?: TurnUsage | null;
  subAgents?: SubAgentState;
  // When the stream first saw this turn running (ms since epoch).
  startedAt?: number;
  now?: number;
  // Pending requests shown as hold rows; they replace the synthetic live row.
  waiting?: number;
}

export interface WorkView {
  rows: LogRow[];
  running: boolean;
  title: string;
  shimmer: boolean;
  small: string;
  types: StepIcon[];
  defaultOpen: boolean;
  helpers: number;
}

export function helperAgents(
  threadIds: string[],
  state?: SubAgentState,
): SubAgent[] {
  const list = state?.agents || [];
  return threadIds
    .map((t) => list.find((a) => a.threadId === t))
    .filter((a): a is SubAgent => !!a);
}

export function workView(entries: Entry[], ctx: WorkContext): WorkView | null {
  const steps = new Map((ctx.trace?.steps || []).map((s) => [s.id, s]));
  const rows: LogRow[] = [];
  const approvals: Extract<Entry, { kind: "approval" }>[] = [];
  let approvalAt = -1;
  let helpers = 0;
  for (const e of entries) {
    if (e.kind === "thinking") {
      const summary = text(e.summary) || (e.raw ? "" : text(e.text));
      const raw = text(e.raw);
      const streaming = ctx.active && !e.done;
      if (!summary && !raw && !streaming) continue;
      rows.push({
        id: e.id,
        node: streaming ? "k-live" : "k-think",
        icon: "brain",
        title: streaming
          ? thinkingHeading(summary)
          : thoughtTitle(e.itemId ? steps.get(e.itemId)?.durationMs : null),
        t: "",
        running: streaming,
        live: streaming,
        thinking: {
          summary: summary.replace(/\*\*/g, ""),
          raw: raw && raw !== summary ? raw : "",
        },
      });
    } else if (e.kind === "item") {
      const row = itemRow(e.id, e.item);
      if (!row) continue;
      if (row.running && !ctx.active) row.running = false;
      rows.push(row);
    } else if (e.kind === "approval") {
      if (approvalAt < 0) approvalAt = rows.length;
      approvals.push(e);
    } else if (e.kind === "agents") {
      const agents = helperAgents(e.threadIds, ctx.subAgents);
      helpers += e.threadIds.length;
      const names = agents.map((a) => helperName(a, ctx.subAgents!.agents));
      rows.push({
        id: e.id,
        node: "k-agent",
        icon: "users",
        title: `Started ${plural(e.threadIds.length, "helper")}`,
        sub: names.length ? names.join(", ") : undefined,
        t: agents.length
          ? clockDuration(
              groupElapsedMs(agents, ctx.now ?? Date.now(), ctx.subAgents?.skewMs),
            )
          : "",
        running: ctx.active && agents.some(isRunning),
      });
    }
  }
  if (approvals.length) {
    const audit = approvals.flatMap((a) => auditRows(a.record));
    const questions = audit.length > 0 && approvals.every((a) =>
      a.record.items.every((i) => i.kind === "question"),
    );
    rows.splice(approvalAt, 0, {
      id: approvals[0].id,
      node: "st-k-appr",
      icon: "shield",
      title: questions
        ? `Questions · ${plural(audit.length, "answer")}`
        : `Approvals · ${plural(audit.length, "decision")}`,
      t: "",
      running: false,
      audit,
    });
  }
  const working = ctx.active && !ctx.answering;
  // While working, the last row always moves: add one when nothing is live.
  const waiting = ctx.active ? ctx.waiting || 0 : 0;
  if (working && !waiting && !rows.some((r) => r.running))
    rows.push({
      id: "live",
      node: "k-live",
      icon: "layers",
      title: "Working…",
      t: "",
      running: true,
      live: true,
    });
  if (!rows.length && !waiting) return null;
  const real = rows.filter((r) => r.id !== "live");
  const running = rows.filter((r) => r.running).length + waiting;
  const done = rows.length + waiting - running;
  const types = [...new Set(real.map((r) => r.icon))];
  const files = real.reduce((n, r) => n + (r.files?.length || 0), 0);
  const helperText = helpers ? plural(helpers, "helper") : "";
  if (ctx.active && !ctx.answering)
    return {
      rows,
      running: true,
      title: `Working · ${done} done${running ? `, ${running} running` : ""}`,
      shimmer: false,
      small: [
        ctx.startedAt ? `Started ${clockTime(ctx.startedAt)}` : "",
        helperText,
      ]
        .filter(Boolean)
        .join(" · "),
      types,
      defaultOpen: true,
      helpers,
    };
  if (ctx.active) {
    const current = [...rows].reverse().find((r) => r.running);
    const tokens = ctx.liveUsage
      ? turnTokens({ usage: ctx.liveUsage, helperUsage: null } as TurnTrace)
      : 0;
    return {
      rows,
      running: true,
      title: current ? current.title : "Writing the answer",
      shimmer: true,
      small: [
        plural(real.length, "step"),
        tokens ? `${formatTokens(tokens)} tokens so far` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      types,
      // A pending request's hold row lives in this group; keep it visible.
      defaultOpen: waiting > 0,
      helpers,
    };
  }
  const total = ctx.trace?.totalMs;
  return {
    rows,
    running: false,
    title:
      typeof total === "number" ? `Worked for ${formatDuration(total)}` : "Worked",
    shimmer: false,
    small: [
      plural(real.length, "step"),
      helperText,
      files ? `${plural(files, "file")} edited` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    types,
    defaultOpen: false,
    helpers,
  };
}

// ---- Helpers ----------------------------------------------------------------------

export interface HelperRowView {
  threadId: string;
  tone: number;
  initial: string;
  name: string;
  role: string;
  task: string;
  running: boolean;
  pill: {
    tone: "" | "accent" | "ok" | "bad" | "warn";
    label: string;
    icon: "check" | "alert" | null;
    spinner: boolean;
  };
}

const helperPills: Record<string, HelperRowView["pill"]> = {
  pendingInit: { tone: "", label: "Starting", icon: null, spinner: true },
  running: { tone: "accent", label: "Running", icon: null, spinner: true },
  completed: { tone: "ok", label: "Done", icon: "check", spinner: false },
  errored: { tone: "bad", label: "Error", icon: "alert", spinner: false },
  notFound: { tone: "bad", label: "Error", icon: "alert", spinner: false },
  interrupted: { tone: "warn", label: "Stopped", icon: null, spinner: false },
  shutdown: { tone: "", label: "Shut down", icon: null, spinner: false },
};

export function helperRows(agents: SubAgent[], all: SubAgent[]): HelperRowView[] {
  return agents.map((a, i) => {
    const name = helperName(a, all);
    const role = text(a.role);
    const running = isRunning(a);
    return {
      threadId: a.threadId,
      tone: i % 3,
      initial: name.slice(0, 1).toUpperCase(),
      name,
      role:
        role && role.toLowerCase() !== "default" && role.toLowerCase() !== name.toLowerCase()
          ? role.charAt(0).toUpperCase() + role.slice(1)
          : "",
      task: running || !text(a.lastMessage) ? taskTitle(a.task) : taskTitle(a.lastMessage),
      running,
      pill: helperPills[a.status] || helperPills.shutdown,
    };
  });
}

// "1 running · 1 done · 1 stopped", in legend order.
export function helperTally(rows: HelperRowView[]): string {
  const order = ["Starting", "Running", "Done", "Error", "Stopped", "Shut down"];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.pill.label, (counts.get(r.pill.label) || 0) + 1);
  return order
    .filter((l) => counts.has(l))
    .map((l) => `${counts.get(l)} ${l.toLowerCase()}`)
    .join(" · ");
}

// ---- Inline error --------------------------------------------------------------------

export interface StreamError {
  turnId?: string;
  message: string;
  // One line on what was kept or what to do next.
  hint?: string;
  ref?: ErrorRef | null;
}

// The failed turn's card, from what page.tsx already tracks.
export function streamError(
  message: string,
  ref?: ErrorRef | null,
  failure?: TurnFailure | null,
): StreamError | null {
  const msg = text(message) || text(failure?.message);
  if (!msg) return null;
  const hint = failure ? errorReasons[failure.reason]?.hint || "" : "";
  return {
    ...(ref?.turnId ? { turnId: ref.turnId } : {}),
    message: msg,
    ...(hint ? { hint } : {}),
    ...(ref ? { ref } : {}),
  };
}

// The text the ref chip shows and copies.
export function refText(ref?: ErrorRef | null): string {
  if (!ref) return "";
  return [ref.code, ref.requestId ?? ref.turnId].filter(Boolean).join(" · ");
}

// View models for the docked live-request card, its stream placeholder and
// audit row, and the composer controls (wireframe r2 §2). Pure functions over
// the existing contracts so the components never read raw request shapes.
import type {
  ApprovalRecord,
  PendingRequest,
} from "../../shared/contracts";
import {
  isDecline,
  optionLabel,
  type InputQuestion,
} from "./request-input.ts";
import { PLAN_APPROVAL_ID, type PlanStep } from "./plan.ts";
import { decisionLabel, recordSummary } from "./approval-mode.ts";

export type RequestKind = "tool" | "question" | "secret" | "plan";
export type TileTone = "warn" | "acc" | "ink" | "ok";
export type TileIcon = "term" | "users" | "key" | "list";

export interface DecisionView {
  /** The value submitted (Codex matches on the original option label). */
  value: string;
  text: string;
  variant: "primary" | "default" | "ghost";
  /** Keyboard hint: "1", "2", "3" or "Esc". */
  kbd: string;
}
export interface OptionView {
  value: string;
  text: string;
  description?: string;
  recommended: boolean;
  kbd?: string;
}
export interface QuestionView {
  id: string;
  header?: string;
  question: string;
  secret: boolean;
  allowsOther: boolean;
  options: OptionView[];
  /** The option preselected so Enter accepts it. */
  preselected: string | null;
}
export type FieldType = "text" | "number" | "date" | "select" | "boolean";
export interface FieldView {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Faint type hint on the right, e.g. "date" or "text, optional". */
  hint: string;
  choices: string[];
  placeholder?: string;
}
export interface PlanStepView {
  n: number;
  text: string;
  isNew: boolean;
}
export interface ToolView {
  command: string;
  cwd?: string;
  effects: { text: string; safe: boolean }[];
}
export interface RequestView {
  id: string;
  kind: RequestKind;
  /** Uppercase label above the title. */
  kindLabel: string;
  tile: TileTone;
  icon: TileIcon;
  title: string;
  subtitle?: string;
  /** Secrets and plan approvals ignore the approval mode. */
  alwaysAsks: boolean;
  /** Countdown caption, e.g. "then declines". */
  then: string;
  ringTone: "warn" | "acc";
  tool: ToolView | null;
  decisions: DecisionView[];
  questions: QuestionView[];
  fields: FieldView[];
  plan: PlanStepView[];
  planTitle: string;
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

function questionsOf(request: PendingRequest): InputQuestion[] {
  const list = request.detail?.questions;
  return Array.isArray(list) ? (list as InputQuestion[]) : [];
}
function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function kindOf(request: PendingRequest): RequestKind {
  const qs = questionsOf(request);
  if (qs.some((q) => q.id === PLAN_APPROVAL_ID)) return "plan";
  if (qs.some((q) => q.kind === "toolApproval")) return "tool";
  if (qs.length && qs.every((q) => q.isSecret === true)) return "secret";
  return "question";
}

// Tool decisions keep the Codex label as their value; the order and copy
// follow the card: Allow once (1), Allow for this chat (2), Always allow (3),
// then Decline (Esc) at the end.
export function toolDecisions(q: InputQuestion): DecisionView[] {
  const options = q.options || [];
  const allow = options.filter((o) => !isDecline(q, o));
  const decline = options.filter((o) => isDecline(q, o));
  return [
    ...allow.map(
      (o, i): DecisionView => ({
        value: o.label,
        text: optionLabel(q, o),
        variant: i === 0 ? "primary" : "default",
        kbd: String(i + 1),
      }),
    ),
    ...decline.map(
      (o): DecisionView => ({
        value: o.label,
        text: "Decline",
        variant: "ghost",
        kbd: "Esc",
      }),
    ),
  ];
}

// The recommended option is the one labelled "(Recommended)" (the same rule
// the runtime uses when a question times out); only one carries the badge.
export function questionView(q: InputQuestion, numbered: boolean): QuestionView {
  const raw = q.options || [];
  const rec = raw.findIndex(
    (o) =>
      RECOMMENDED.test(o.label) ||
      (o as { recommended?: unknown }).recommended === true,
  );
  const options = raw.map(
    (o, i): OptionView => ({
      value: o.label,
      text: o.label.replace(RECOMMENDED, ""),
      description: o.description,
      recommended: i === rec,
      kbd: numbered && i < 9 ? String(i + 1) : undefined,
    }),
  );
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    secret: q.isSecret === true,
    allowsOther: q.isOther === true,
    options,
    preselected: rec >= 0 ? raw[rec].label : null,
  };
}

// Extra inputs from a JSON-schema string: text, number, date, select, boolean.
export function schemaFields(schema: string | null | undefined): FieldView[] {
  if (!schema) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(schema);
  } catch {
    return [];
  }
  const props = parsed?.properties;
  if (!props || typeof props !== "object") return [];
  const required: string[] = Array.isArray(parsed.required)
    ? parsed.required.filter((r: unknown) => typeof r === "string")
    : [];
  return Object.entries(props as Record<string, any>).map(([key, p]) => {
    const choices: string[] = Array.isArray(p?.enum)
      ? p.enum.map((v: unknown) => String(v))
      : [];
    const type: FieldType = choices.length
      ? "select"
      : p?.type === "boolean"
        ? "boolean"
        : p?.type === "number" || p?.type === "integer"
          ? "number"
          : p?.format === "date" || p?.format === "date-time"
            ? "date"
            : "text";
    const isRequired = required.includes(key);
    return {
      key,
      label: str(p?.title) || key,
      type,
      required: isRequired,
      hint: isRequired ? type : `${type}, optional`,
      choices,
      placeholder: str(p?.description),
    };
  });
}

// Required fields hold Send until filled.
export function missingFields(
  fields: FieldView[],
  values: Record<string, string>,
): string[] {
  return fields
    .filter((f) => f.required && f.type !== "boolean")
    .filter((f) => !(values[f.key] || "").trim())
    .map((f) => f.key);
}

// Typed values for the schema fields: numbers and booleans are coerced,
// blank optional fields are left out.
export function fieldValues(
  fields: FieldView[],
  values: Record<string, string>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    const raw = (values[f.key] ?? "").trim();
    if (f.type === "boolean") out[f.key] = raw === "true";
    else if (!raw) continue;
    else if (f.type === "number" && Number.isFinite(Number(raw)))
      out[f.key] = Number(raw);
    else out[f.key] = raw;
  }
  return out;
}

// Steps from the current plan; ones missing from the previous version are new.
export function planSteps(
  plan: PlanStep[],
  previous: PlanStep[] | null = null,
): PlanStepView[] {
  const before = new Set((previous || []).map((s) => s.step.trim()));
  return plan.map((s, i) => ({
    n: i + 1,
    text: s.step,
    isNew: !!previous && !before.has(s.step.trim()),
  }));
}

function toolOf(request: PendingRequest): ToolView | null {
  const tool = (request.detail?.tool || {}) as Record<string, unknown>;
  // Only an explicit command gets the mono block; an action label is a title.
  const command = str(tool.command);
  if (!command) return null;
  const effects = Array.isArray(tool.effects)
    ? (tool.effects as unknown[]).flatMap((e) => {
        if (typeof e === "string") return [{ text: e, safe: false }];
        const text = str((e as any)?.text ?? (e as any)?.label);
        return text ? [{ text, safe: (e as any)?.safe === true }] : [];
      })
    : [];
  return { command, cwd: str(tool.cwd), effects };
}

export function requestView(
  request: PendingRequest,
  plan: PlanStep[] = [],
  options: { planVersion?: number; previousPlan?: PlanStep[] | null } = {},
): RequestView {
  const qs = questionsOf(request);
  const kind = kindOf(request);
  const first = qs[0];
  const base = {
    id: request.requestId,
    kind,
    tool: null,
    decisions: [],
    questions: [],
    fields: schemaFields(request.responseSchema),
    plan: [],
    planTitle: "",
    subtitle: undefined,
  } as Omit<
    RequestView,
    "kindLabel" | "tile" | "icon" | "title" | "alwaysAsks" | "then" | "ringTone"
  >;
  if (kind === "tool") {
    const q = qs.find((x) => x.kind === "toolApproval")!;
    const tool = toolOf(request);
    return {
      ...base,
      kindLabel: "Tool approval",
      tile: "warn",
      icon: "term",
      title: q.action || (tool ? `Run ${tool.command}` : "Use a connected tool"),
      subtitle: q.question || undefined,
      alwaysAsks: false,
      then: "then declines",
      ringTone: "warn",
      tool,
      decisions: toolDecisions(q),
    };
  }
  if (kind === "plan") {
    const steps = planSteps(plan, options.previousPlan ?? null);
    const v = options.planVersion;
    return {
      ...base,
      kindLabel: "Plan approval",
      tile: "ok",
      icon: "list",
      title: `${first?.header || "Plan"}${v ? ` v${v}` : ""}${steps.length ? ` · ${steps.length} step${steps.length === 1 ? "" : "s"}` : ""}`,
      subtitle: steps.length ? undefined : first?.question,
      alwaysAsks: true,
      then: "then approves",
      ringTone: "acc",
      plan: steps,
      planTitle: first?.question || "",
    };
  }
  const numbered = qs.length === 1;
  const questions = qs.map((q) => questionView(q, numbered));
  if (kind === "secret")
    return {
      ...base,
      kindLabel: "Question · Secret",
      tile: "ink",
      icon: "key",
      title: first?.question || "A secret value is needed",
      alwaysAsks: true,
      then: "then declines",
      ringTone: "warn",
      questions,
    };
  const withOptions = questions.some((q) => q.options.length);
  return {
    ...base,
    kindLabel: "Question",
    tile: "acc",
    icon: "users",
    title:
      qs.length === 1
        ? first.question
        : first?.header || "Your input is needed",
    subtitle: qs.length === 1 ? first.header : `${qs.length} questions`,
    alwaysAsks: false,
    // A timed-out question takes its recommended (else first) option.
    then: withOptions ? "then uses recommended" : "then skips",
    ringTone: "acc",
    questions,
  };
}

function lowerFirst(text: string) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

// "m:ss" for the countdown ring.
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
// Ring fill drains from 100 at startedAt to 0 at expiresAt. Null when the
// request has no usable expiry, so the card shows no ring.
export function countdown(
  expiresAt: string | undefined,
  startedAt: number,
  now: number,
): { label: string; percent: number; left: number } | null {
  const end = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(end)) return null;
  const left = Math.max(0, end - now);
  const span = end - startedAt;
  const percent =
    span > 0 ? Math.round(Math.min(100, Math.max(0, (left / span) * 100))) : 0;
  return { label: clockLabel(left), percent, left };
}

// Oldest first. Requests carry no creation time in the contract, so an
// optional detail.createdAt orders them, else arrival order is kept.
export function sortRequests(pending: PendingRequest[]): PendingRequest[] {
  const at = (r: PendingRequest) => {
    const t = Date.parse(String(r.detail?.createdAt ?? ""));
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return pending
    .map((r, i) => ({ r, i }))
    .sort((a, b) => at(a.r) - at(b.r) || a.i - b.i)
    .map((x) => x.r);
}

// The dashed stream row left where the request was raised.
export function holdView(request: PendingRequest): {
  text: string;
  code?: string;
} {
  const kind = kindOf(request);
  if (kind === "tool") {
    const q = questionsOf(request).find((x) => x.kind === "toolApproval");
    const tool = toolOf(request);
    if (tool)
      return { text: "Waiting for approval to run", code: tool.command };
    return q?.action
      ? { text: `Waiting for approval to ${lowerFirst(q.action)}` }
      : { text: "Waiting for approval to use a connected tool" };
  }
  if (kind === "plan") return { text: "Waiting for plan approval" };
  if (kind === "secret") return { text: "Waiting for a secret value" };
  return { text: "Waiting for your answer" };
}

// The one-line audit row a resolved request collapses into.
export function auditView(
  record: ApprovalRecord,
  formatTime: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): { ok: boolean; lead: string; detail: string; meta: string } {
  const by =
    record.outcome === "answered"
      ? "by you"
      : record.outcome === "auto"
        ? "automatically"
        : "";
  const meta = [by, record.at ? formatTime(record.at) : ""]
    .filter(Boolean)
    .join(" · ");
  const item = record.items[0];
  if (item?.kind === "toolApproval") {
    const d = decisionLabel(record, item.decision);
    const expired = item.decision === "expired";
    return {
      ok: d.tone === "allowed",
      lead: expired ? "Expired, declined" : d.text,
      detail: item.action ? lowerFirst(item.action) : "",
      meta,
    };
  }
  if (item?.kind === "question") {
    if (item.secret)
      return { ok: true, lead: "Key provided", detail: "", meta };
    if (record.outcome === "expired" || record.outcome === "interrupted")
      return { ok: false, lead: "No answer", detail: item.question, meta };
    return {
      ok: true,
      lead: recordSummary(record),
      detail: item.answer || "",
      meta,
    };
  }
  return { ok: false, lead: recordSummary(record), detail: "", meta };
}

// Which trailing controls the composer bar shows (Steer / Stop / Stopping /
// Send), from the turn state.
export type TurnPhase = "idle" | "running" | "stopping";
export function composerActions(
  phase: TurnPhase,
  canSend: boolean,
  held: boolean,
): {
  send: "send" | "steer" | "steer-off" | null;
  sendEnabled: boolean;
  stop: "stop" | "stopping" | null;
} {
  if (phase === "stopping")
    return { send: "steer-off", sendEnabled: false, stop: "stopping" };
  if (phase === "running")
    return {
      send: "steer",
      sendEnabled: canSend && !held,
      stop: "stop",
    };
  return { send: "send", sendEnabled: canSend && !held, stop: null };
}

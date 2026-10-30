// What the Activity Panel reports for one turn (DESIGN-SPEC 14), built only
// from what the platform sends: the turn's saved messages and run, or its live
// reply. Nothing here decides anything; the panel only reports.
import { mask } from "./mask.ts";
import type { ChatRun, Exchange, HelperAgent, LiveReply } from "./tenant-chat";
import {
  connectorName,
  toolStepName,
  type ConnectorRef,
} from "./tenant-connectors.ts";
import { activityLabel, type Activity } from "./tenant-coding.ts";
import type { ChatFile } from "./tenant-files";

export type StepStatus = "done" | "run" | "wait" | "fail" | "decl" | "stop";
export type TurnState =
  "live" | "needs" | "done" | "issue" | "declined" | "stopped";

export interface Step {
  id: string;
  /** Plain-language title in the tense of its status. */
  title: string;
  /** The system it used: a connector, "Workspace", or "Skill". */
  system: string;
  status: StepStatus;
  durationMs: number | null;
  /** The raw tool name, for the Technical view. */
  tool: string;
  /** Files it touched (file changes only). */
  touched: string[];
}

export interface TurnView {
  runId: string;
  ask: { text: string; at: string } | null;
  state: TurnState;
  steps: Step[];
  helpers: HelperAgent[];
  /** Notes the member added to the turn while it ran. */
  steers: string[];
  /** Files this turn made (new files only). */
  made: ChatFile[];
  /** Existing files this turn changed. */
  edited: string[];
  run: ChatRun | null;
}

function toolStep(
  id: string,
  connector: string,
  name: string,
  status: "inProgress" | "completed" | "failed",
  errorCode: string | null,
  durationMs: number | null,
  ctx: { ended: boolean; waiting: boolean; declined: boolean },
): Step {
  const system = mask(connector);
  const what = toolStepName(connector, name);
  const step: StepStatus =
    status === "inProgress"
      ? ctx.ended
        ? "stop"
        : ctx.waiting
          ? "wait"
          : "run"
      : status === "completed"
        ? "done"
        : ctx.declined || errorCode === "REFUSED"
          ? "decl"
          : "fail";
  const title =
    step === "run" || step === "wait"
      ? `Using ${what}`
      : step === "done"
        ? `Used ${what}`
        : step === "decl"
          ? `You declined ${what}`
          : step === "stop"
            ? `Stopped while using ${what}`
            : `${what} didn’t work`;
  return {
    id,
    title,
    system,
    status: step,
    durationMs,
    tool: name,
    touched: [],
  };
}

function activityStep(
  activity: Activity,
  ctx: { ended: boolean; waiting: boolean },
): Step {
  const status: StepStatus =
    activity.status === "inProgress"
      ? ctx.ended
        ? "stop"
        : ctx.waiting
          ? "wait"
          : "run"
      : activity.status === "completed"
        ? "done"
        : activity.status === "declined"
          ? "decl"
          : "fail";
  return {
    id: activity.itemId,
    title: mask(activityLabel(activity)),
    system: "Workspace",
    status,
    durationMs: activity.type === "command" ? activity.durationMs : null,
    tool: activity.type,
    touched:
      activity.type === "file_change"
        ? activity.files.map((f) => mask(f.path))
        : [],
  };
}

export function turnView(
  exchange: Exchange,
  live: LiveReply | null,
  files: readonly ChatFile[],
  connectors: ConnectorRef[],
): TurnView {
  const user = exchange.messages.find((m) => m.role === "user");
  const run = exchange.run;
  const steps: Step[] = [];
  const changes: Activity[] = [];
  let helpers: HelperAgent[] = [];
  const steers: string[] = [];
  const name = (slug: string) => connectorName(slug, connectors);

  if (live) {
    const ended = live.phase === "settled";
    const pending = new Set(
      Object.values(live.approvals)
        .filter((a) => a.status === "pending")
        .map((a) => a.itemId),
    );
    const denied = new Set(
      Object.values(live.approvals)
        .filter((a) => a.status === "deny")
        .map((a) => a.itemId),
    );
    for (const item of live.items) {
      const ctx = {
        ended,
        waiting: "itemId" in item && pending.has(item.itemId),
        declined: "itemId" in item && denied.has(item.itemId),
      };
      if (item.type === "tool")
        steps.push(
          toolStep(
            item.itemId,
            name(item.connector),
            item.tool,
            item.status,
            item.errorCode,
            item.durationMs,
            ctx,
          ),
        );
      else if (item.type === "command" || item.type === "file_change") {
        steps.push(activityStep(item, ctx));
        if (item.type === "file_change") changes.push(item);
      } else if (item.type === "input" && item.text) steers.push(item.text);
    }
    helpers = live.helpers;
  } else {
    const ended = true;
    for (const message of exchange.messages) {
      if (message.agent) helpers.push(message.agent);
      else if (message.role === "tool" && message.tool)
        steps.push(
          toolStep(
            message.id,
            name(message.tool.connector),
            message.tool.name,
            message.tool.status,
            message.tool.errorCode,
            message.tool.durationMs,
            {
              ended,
              waiting: false,
              declined: message.tool.approval === "deny",
            },
          ),
        );
      else if (message.role === "tool" && message.activity) {
        steps.push(activityStep(message.activity, { ended, waiting: false }));
        if (message.activity.type === "file_change")
          changes.push(message.activity);
      }
    }
  }

  const made = files.filter((f) => f.runId === exchange.runId && !f.upload);
  const madePaths = new Set(made.map((f) => f.path));
  const edited = [
    ...new Set(
      changes.flatMap((change) =>
        change.type === "file_change"
          ? change.files
              .filter((f) => f.kind !== "add" && !madePaths.has(f.path))
              .map((f) => mask(f.path))
          : [],
      ),
    ),
  ];

  const status = live ? (live.outcome?.status ?? null) : (run?.status ?? null);
  const state: TurnState =
    live && live.phase !== "settled"
      ? steps.some((s) => s.status === "wait")
        ? "needs"
        : "live"
      : status === "stopped"
        ? "stopped"
        : status === "failed" || steps.some((s) => s.status === "fail")
          ? "issue"
          : steps.some((s) => s.status === "decl")
            ? "declined"
            : "done";

  return {
    runId: exchange.runId,
    ask: user ? { text: user.text, at: user.createdAt } : null,
    state,
    steps,
    helpers,
    steers,
    made,
    edited,
    run,
  };
}

export type Pill = {
  tone: string;
  glyph: "hand" | "check" | "alert" | "stop" | null;
  word: string;
};

// The turn's status pill (14.4): a tone, a glyph and a word. `failed` counts
// failed steps; an issue with none is a run that didn't finish. Declined and
// stopped are the person's choices, never a fault colour.
export function statePill(state: TurnState, failed = 1): Pill {
  switch (state) {
    case "live":
      return { tone: "tx-pill-live", glyph: null, word: "Working" };
    case "needs":
      return {
        tone: "tx-pill-warn",
        glyph: "hand",
        word: "Needs your approval",
      };
    case "issue":
      return {
        tone: "tx-pill-warn",
        glyph: "alert",
        word: failed
          ? `Done, ${failed} ${failed === 1 ? "step" : "steps"} failed`
          : "Didn’t finish",
      };
    case "stopped":
      return { tone: "tx-pill-line", glyph: "stop", word: "Stopped by you" };
    default:
      return { tone: "tx-pill-ok", glyph: "check", word: "Done" };
  }
}

import { businessCapabilities } from "../../shared/business-capabilities";
import { BusinessRuntime } from "./business-runtime";
import { StopStore, bounded, type StopIntent } from "./stop";
import { Redactor } from "./redact";
import { TraceBuilder, rateLimitView } from "./trace";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Response } from "express";
import type { Runtime } from "./client";
import type {
  DomainEvent,
  DomainType,
  CollabTool,
  PendingRequest,
  RateLimitView,
  Snapshot,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
  TurnContext,
  TurnState,
  TurnTiming,
  TurnTrace,
} from "../../shared/contracts";
import {
  ALLOW_FOR_CHAT,
  AUTO_MODE_REASON,
  type ApprovalMode,
} from "../../shared/contracts";
import {
  approvalMode as parseMode,
  AUTO_MODE_NOTE,
  GRANT,
  findTool,
  grantKey,
  indexTools,
  isToolQuestion,
  parseToolQuestion,
  withChatGrant,
  type ToolIndex,
  type ToolRef,
} from "./approval-modes";
import { HttpError, rpcText } from "./errors";
import { skillSet, tenantId as parseTenant } from "./tenancy";
import { errorFields, log } from "../../shared/logging";
import { inventory, validateRequest } from "./schema";
import {
  autoAnswer,
  defaults,
  recommendedOption,
  responseSchema,
  validateResponse,
  ServerMethod,
} from "./requests";
interface Pending extends PendingRequest {
  rawId: string | number;
  timer: NodeJS.Timeout;
  // Approval modes: not yet shown while its mode decides, and the latest
  // decision run, so an older one cannot settle it.
  hidden?: boolean;
  reviews?: number;
}
// Alpha approval mode of a root conversation. Threads without one keep
// today's behaviour: every request waits for the user.
interface ModeState {
  mode: ApprovalMode;
  // Treat unannotated tools named like reads (get_, list_, ...) as read-only.
  heuristic: boolean;
  // Tools the user allowed for this chat ("Allow for this chat").
  grants: Set<string>;
  // server -> tool -> read-only, from mcpServerStatus/list.
  tools?: Promise<ToolIndex>;
}
interface Clock {
  start: number;
  accept: number | null;
  first: number | null;
  last: number | null;
  count: number;
  gap: number;
  handler: number;
  turnId?: string;
}
interface Thread {
  id: string;
  state: TurnState;
  seq: number;
  events: DomainEvent[];
  subscribers: Set<Response>;
  pending: Map<string, Pending>;
  messages: Snapshot["messages"];
  thinking: NonNullable<Snapshot["thinking"]>;
  // Latest plan; kept across turns until a newer turn replaces it.
  plan: unknown;
  // Turn that produced the stored plan, so an older turn's update is ignored.
  planTurnId: string | null;
  // Turns seen on this thread, oldest first, to order plan updates.
  turnOrder: string[];
  // Latest goal reported by the runtime; one goal per conversation.
  goal: unknown;
  // Tokens seen for the current goal. The runtime only charges usage that
  // arrives while a goal is still active, so a goal finished within one model
  // call reports none; this tally counts every call of the goal's turns.
  goalTokens: GoalTokens;
  diff: string;
  timings: TurnTiming[];
  clock?: Clock;
  // Observability of the running turn, and of recent finished ones.
  trace?: TraceBuilder;
  traces: TurnTrace[];
  // Masked reconstructions of recent turns; live only, never persisted.
  contexts: Map<string, TurnContext>;
  // Text sent with turn/start, for the trace of the turn it starts.
  input?: string;
  loaded: boolean;
  // MCP fingerprint the runtime thread was loaded with, from the platform.
  mcpFingerprint?: string;
  // A newer MCP configuration that arrived during a turn; applied before the
  // next turn starts, because the runtime ignores config on a running thread.
  pendingResume?: { params: any; mcpFingerprint: string };
  // Owning tenant; also kept in the runtime's thread record for restarts.
  tenantId?: string;
  threadStartMs: number;
  // Inactivity watchdog of the running turn; paused while a request waits.
  stall?: NodeJS.Timeout;
  // Stop remains authoritative until root, helpers and local work settle.
  stop?: StopIntent;
  stopCompletion?: { turn: any; at: number };
  stoppedTurns: Set<string>;
  localWork: Set<Promise<unknown>>;
}
// A helper agent spawned under a root conversation. Its runtime thread is
// never exposed as a session; its events reach clients on the root stream.
interface Child {
  rootId: string;
  parentId: string;
  agent: SubAgent;
  turnId?: string;
  transcript: SubAgentTranscript["messages"];
  // Name lookups started for this helper; Codex may name it a moment late.
  nameTries?: number;
  stop?: StopIntent;
  stoppedTurns?: Set<string>;
}
const agentStatuses: SubAgentStatus[] = [
  "pendingInit",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "notFound",
];
const terminal: SubAgentStatus[] = [
  "completed",
  "errored",
  "interrupted",
  "shutdown",
  "notFound",
];
const transcriptLimit = 200;
const earlyThreadLimit = 20;
const earlyEventLimit = 500;
const droppedLimit = 1000;
const traceLimit = 100;
const contextTurnLimit = 20;
const clip = (value: unknown, limit = 2000) =>
  typeof value === "string" && value
    ? value.length > limit
      ? value.slice(0, limit) + "…"
      : value
    : undefined;
// Timing and trace that close a turn, merged into its turn.completed event.
type TurnEnd = { timing?: TurnTiming; trace?: TurnTrace };
const defaultStallMs = 15 * 60_000;
const stalledMessage =
  "The assistant stopped responding, so this response was ended. Check the conversation for a partial answer and send your message again.";
const helperQuestionAnswer =
  "Helper agents cannot ask the user. The main agent handles clarifications; proceed with reasonable assumptions and list open questions in your result.";
const helperToolFailure =
  "Helper agents cannot use conversation documents or workspace files. Return your findings to the main agent, which handles documents and workspace files.";
interface GoalTokens {
  key: string | null;
  observed: number;
  turns: string[];
}
// Codex edits an objective in place and keeps the goal's usage, so a goal is
// identified by its creation time. Clearing a goal always resets the tally.
const goalKey = (goal: any) =>
  goal && typeof goal.objective === "string"
    ? String(goal.createdAt ?? "")
    : null;
// Mirrors the runtime's goal accounting: fresh input plus output tokens.
export function goalTokenDelta(usage: any) {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return (
    Math.max(0, n(usage?.inputTokens) - n(usage?.cachedInputTokens)) +
    Math.max(0, n(usage?.outputTokens))
  );
}
// write() returns false once the socket buffer passes its high-water mark,
// which a single large frame (an MCP tool result, a long replay) does on a
// healthy client. Only a subscriber whose unsent data keeps growing is dropped.
const maxBufferedBytes = 8 * 1024 * 1024;
// The platform's hash of a thread's MCP configuration; opaque here.
function parseFingerprint(value: unknown) {
  if (
    value !== undefined &&
    (typeof value !== "string" || !/^[\w:.-]{1,200}$/.test(value))
  )
    throw new HttpError(400, "Invalid MCP fingerprint");
}
function send(res: Response, chunk: string) {
  res.write(chunk);
  return res.writableLength <= maxBufferedBytes;
}
const mappings: Record<string, DomainType> = {
  "thread/started": "thread.started",
  "turn/started": "turn.started",
  "turn/completed": "turn.completed",
  "item/agentMessage/delta": "message.delta",
  "item/reasoning/summaryTextDelta": "reasoning.delta",
  "item/reasoning/textDelta": "reasoning.delta",
  "item/started": "item.started",
  "item/completed": "item.completed",
  "mcpServer/startupStatus/updated": "mcp.status",
  "turn/plan/updated": "plan.updated",
  "turn/diff/updated": "diff.updated",
  "thread/goal/updated": "goal.updated",
  "thread/goal/cleared": "goal.cleared",
  error: "error",
};
export class ThreadManager {
  generation = randomUUID();
  readonly redactor = new Redactor();
  readonly threads = new Map<string, Thread>();
  // Helper agent thread id -> its record under the root conversation.
  private children = new Map<string, Child>();
  // Events from threads not yet identified as helpers, replayed on spawn.
  private early = new Map<string, { method: string; p: any }[]>();
  // Helpers of deleted or archived conversations. Codex reports each one
  // closing after the root call returns; those notices are ignored.
  private dropped = new Set<string>();
  // Conversations started, resumed or forked through this manager.
  private roots = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  // Last goal written as a durable record, per thread.
  private goalRecords = new Map<string, string>();
  private reservations = 0;
  // Approval modes per root conversation; see ModeState.
  private modes = new Map<string, ModeState>();
  // Latest account rate limits, merged from sparse updates.
  rateLimits: RateLimitView | null = null;
  unknownMethods = 0;
  draining = false;
  private stops: StopStore;
  private stopAttempts = new Map<string, Promise<any>>();
  private helperStops = new Map<string, StopStore>();
  private helperStopAttempts = new Map<string, Promise<any>>();
  constructor(
    readonly runtime: Runtime,
    readonly home: string,
    readonly capacity = 20,
    readonly replayLimit = 500,
    readonly requestTimeoutMs = 120_000,
    readonly stallMs = Number(process.env.TURN_STALL_MS) || defaultStallMs,
    readonly stopTimeoutMs = 10_000,
    readonly stopCheckMs = 5_000,
  ) {
    this.stops = new StopStore(home);
    mkdirSync(join(home, "adapter-records"), { recursive: true });
    runtime.on("notification", (msg) =>
      this.notification(msg.method, msg.params || {}),
    );
    runtime.on("serverRequest", (msg) => this.serverRequest(msg));
    runtime.on("adapterError", (e) => this.adapterError(e));
    runtime.on("exit", () => {
      const now = performance.now();
      // Turns cut off by the exit are closed as failed so traces and timings end.
      const cut = new Map<Thread, { turnId?: string; done: TurnEnd }>();
      for (const t of this.threads.values()) {
        if (t.state.kind === "idle") continue;
        const turnId =
          t.state.kind === "starting" ? t.clock?.turnId : t.state.turnId;
        cut.set(t, {
          turnId,
          done: turnId ? this.finishTurn(t, turnId, "failed", now) : {},
        });
      }
      this.generation = randomUUID();
      this.helperStopAttempts.clear();
      this.early.clear();
      for (const t of this.threads.values()) {
        t.seq = 0;
        t.events = [];
        for (const p of [...t.pending.values()])
          this.settle(t, p, undefined, "runtime-exit", false);
        t.loaded = false;
        t.state = t.stop
          ? {
              kind: "interrupting",
              turnId: t.stop.turnId,
              stopStatus: "unconfirmed",
            }
          : { kind: "idle" };
        t.clock = undefined;
        // A new runtime may report different tools.
        const mode = this.modes.get(t.id);
        if (mode) mode.tools = undefined;
        t.trace = undefined;
        for (const c of this.agentsOf(t.id)) {
          c.turnId = undefined;
          if (c.stop) this.helperStopStatus(c, "unconfirmed");
        }
        this.unwatch(t);
        const turn = cut.get(t);
        if (t.stop) {
          this.stopUpdate(t);
          continue;
        }
        if (!turn) continue;
        this.failed(
          t,
          turn.turnId,
          {
            message: "Runtime exited; session can be resumed",
            code: "RUNTIME_UNAVAILABLE",
          },
          turn.done,
        );
      }
    });
  }
  // Reports a failed turn the way the runtime does: error, then completion.
  private failed(
    t: Thread,
    turnId: string | undefined,
    error: { message: string; code: string },
    done: TurnEnd = {},
  ) {
    this.emit(
      t,
      "error",
      { ...error, willRetry: false, ...(turnId ? { turnId } : {}) },
      turnId,
    );
    if (!turnId) return;
    this.emit(
      t,
      "turn.completed",
      {
        method: "turn/completed",
        threadId: t.id,
        turn: { id: turnId, status: "failed", code: error.code, error },
        ...done,
      },
      turnId,
    );
  }
  private adapterError(e: {
    threadId?: string;
    turnId?: string;
    method?: string;
  }) {
    if (!e?.threadId) return;
    const child = this.children.get(e.threadId);
    const t = this.threads.get(child ? child.rootId : e.threadId);
    if (!t) return;
    const turnId = child ? undefined : e.turnId;
    this.emit(
      t,
      "error",
      {
        message:
          "The assistant service could not process a runtime update. Check the conversation before continuing; contact support if this continues.",
        code: "ADAPTER_INTERNAL",
        willRetry: false,
        ...(turnId ? { turnId } : {}),
      },
      turnId,
    );
  }
  // (Re)arms the running turn's inactivity watchdog. A turn waiting on the
  // user is not stalled, so the watchdog is off while a request is pending.
  private watch(t: Thread) {
    this.unwatch(t);
    if (t.state.kind !== "running" || t.pending.size) return;
    const turnId = t.state.turnId;
    t.stall = setTimeout(() => this.stalled(t, turnId), this.stallMs);
    t.stall.unref?.();
  }
  private unwatch(t: Thread) {
    clearTimeout(t.stall);
    t.stall = undefined;
  }
  private stalled(t: Thread, turnId: string) {
    t.stall = undefined;
    if (
      t.state.kind !== "running" ||
      t.state.turnId !== turnId ||
      t.pending.size
    )
      return;
    log("warn", "turn stalled; interrupting", {
      threadId: t.id,
      turnId,
      stallMs: this.stallMs,
    });
    void this.interrupt(t.id, "stalled").catch((e) =>
      log("warn", "watchdog stop unconfirmed", {
        threadId: t.id,
        ...errorFields(e),
      }),
    );
  }
  private thread(id: string): Thread {
    if (!/^[\w-]+$/.test(id))
      throw new HttpError(400, "Invalid thread identifier");
    let t = this.threads.get(id);
    if (!t) {
      t = {
        id,
        state: { kind: "idle" },
        seq: 0,
        events: [],
        subscribers: new Set(),
        pending: new Map(),
        messages: [],
        thinking: [],
        plan: null,
        planTurnId: null,
        turnOrder: [],
        goal: null,
        goalTokens: { key: null, observed: 0, turns: [] },
        diff: "",
        timings: [],
        traces: [],
        contexts: new Map(),
        loaded: false,
        threadStartMs: 0,
        stoppedTurns: new Set(),
        localWork: new Set(),
      };
      t.stop = this.stops.read(id);
      if (t.stop)
        t.state = {
          kind: "interrupting",
          turnId: t.stop.turnId,
          stopStatus: "unconfirmed",
        };
      this.restoreHelperStops(t);
      this.threads.set(id, t);
    }
    return t;
  }
  async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) || Promise.resolve();
    const next = prior.catch(() => {}).then(action);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  private reserve() {
    if (this.draining)
      throw new HttpError(503, "Agent core is draining", "DRAINING");
    if (
      [...this.threads.values()].filter((t) => t.loaded).length +
        this.reservations >=
      this.capacity
    )
      throw new HttpError(503, "Thread capacity reached", "CAPACITY");
    this.reservations++;
  }
  async create(params: any = {}) {
    // Truex's helper and persona settings are not runtime parameters; the
    // business runtime turns them into enforced config and instructions.
    const {
      subAgents,
      persona,
      scope,
      approvalMode,
      approvalNameHeuristic,
      tenantId,
      skills,
      mcpFingerprint,
      ...start
    } = params || {};
    if (approvalMode !== undefined) parseMode(approvalMode);
    parseFingerprint(mcpFingerprint);
    const tenant = parseTenant(tenantId);
    skillSet(skills);
    validateRequest("thread/start", start);
    this.redactor.remember(start);
    this.reserve();
    const started = performance.now();
    try {
      const result = await this.runtime.request("thread/start", {
        ...start,
        ...(subAgents === undefined ? {} : { subAgents }),
        ...(persona === undefined ? {} : { persona }),
        ...(scope === undefined ? {} : { scope }),
        ...(tenantId === undefined ? {} : { tenantId: tenant }),
        ...(skills === undefined ? {} : { skills }),
      });
      const t = this.thread(result.thread.id);
      t.tenantId = tenant;
      this.roots.add(t.id);
      this.setMode(t.id, approvalMode, approvalNameHeuristic);
      t.loaded = true;
      t.mcpFingerprint = mcpFingerprint;
      t.threadStartMs = performance.now() - started;
      return { threadId: t.id, threadStartMs: t.threadStartMs };
    } finally {
      this.reservations--;
    }
  }
  async resume(id: string, input: any = {}) {
    // Approval mode fields are Truex settings, not runtime parameters.
    const { approvalMode, approvalNameHeuristic, mcpFingerprint, ...params } =
      input || {};
    if (approvalMode !== undefined) parseMode(approvalMode);
    parseFingerprint(mcpFingerprint);
    if (params.tenantId !== undefined) parseTenant(params.tenantId);
    if (params.skills !== undefined) skillSet(params.skills);
    return this.serial(id, async () => {
      const t = this.thread(id);
      this.ownedBy(t, params.tenantId);
      // Recovery must not resume a persisted active goal or reevaluate grants.
      if (t.stop) {
        try {
          await this.stopTurn(t, t.stop.reason);
        } catch {
          return this.snapshot(id);
        }
      }
      for (const c of this.agentsOf(id))
        if (c.stop)
          void this.interruptAgent(id, c.agent.threadId).catch((e) =>
            log("warn", "helper stop recovery unconfirmed", {
              threadId: id,
              helperThreadId: c.agent.threadId,
              ...errorFields(e),
            }),
          );
      const moded = this.modes.has(id) || approvalMode !== undefined;
      this.setMode(id, approvalMode, approvalNameHeuristic);
      if (moded) this.reevaluate(t);
      if (t.loaded) {
        // No fingerprint, or the same one: the loaded config is current.
        if (mcpFingerprint === undefined) return this.snapshot(id);
        if (mcpFingerprint === t.mcpFingerprint) {
          t.pendingResume = undefined;
          return this.snapshot(id);
        }
        // The runtime ignores config for a running thread; apply it before
        // the next turn instead. A draining pod starts no new turns, so it
        // keeps serving the loaded thread.
        if (t.state.kind !== "idle" || this.draining) {
          t.pendingResume = { params, mcpFingerprint };
          return this.snapshot(id);
        }
        await this.unload(t);
      }
      return this.load(t, params, mcpFingerprint);
    });
  }
  // Releases agent-core's subscription to a loaded runtime thread. With no
  // subscribers left, the next thread/resume shuts the idle thread down and
  // loads it again from its history with the new config.
  private async unload(t: Thread) {
    await this.runtime.request("thread/unsubscribe", { threadId: t.id });
    t.loaded = false;
    this.unwatch(t);
    // The new configuration may offer different tools.
    const mode = this.modes.get(t.id);
    if (mode) mode.tools = undefined;
  }
  // Applies a configuration that arrived while a turn was running. Runs
  // inside serial(), before the next turn starts.
  private async applyPending(t: Thread) {
    const pending = t.pendingResume;
    if (!pending || !t.loaded || t.state.kind !== "idle") return;
    // load() clears the pending change once it succeeds.
    await this.unload(t);
    await this.load(t, pending.params, pending.mcpFingerprint);
  }
  // Cold thread/resume. Runs inside serial().
  private async load(t: Thread, params: any, mcpFingerprint?: string) {
    const id = t.id;
    this.reserve();
    try {
      this.redactor.remember(params);
      const result = await this.runtime.request("thread/resume", {
        ...params,
        threadId: id,
      });
      t.loaded = true;
      t.mcpFingerprint = mcpFingerprint;
      t.pendingResume = undefined;
      this.roots.add(id);
      // Rebuild helper agents from the restored history.
      for (const turn of result.thread?.turns ?? []) {
        if (typeof turn?.id === "string") this.seeTurn(t, turn.id);
        for (const item of turn?.items ?? []) this.collab(id, item);
      }
      const active = result.thread?.turns?.find(
        (turn: any) => turn.status === "inProgress",
      );
      t.state = t.stop
        ? { kind: "interrupting", turnId: t.stop.turnId, stopStatus: "pending" }
        : active
          ? { kind: "running", turnId: active.id }
          : { kind: "idle" };
      this.watch(t);
      // Recover the goal after an agent-core restart; goals are optional.
      try {
        this.setGoal(
          t,
          (await this.runtime.request("thread/goal/get", { threadId: id }))
            ?.goal ?? null,
        );
      } catch (e) {
        log("debug", "goal recovery failed", {
          threadId: id,
          ...errorFields(e),
        });
        this.setGoal(t, null);
      }
      return this.snapshot(id);
    } catch (e) {
      if (
        /thread.*(not found|does not exist)|no rollout found|unable to find.*thread/i.test(
          rpcText(e),
        )
      )
        throw new HttpError(
          410,
          "Thread history is missing from this pod",
          "THREAD_LOST",
        );
      throw e;
    } finally {
      this.reservations--;
    }
  }
  // A conversation is visible only to its own tenant; another tenant's id
  // reads as missing. Callers that send no tenant keep today's behaviour.
  private ownedBy(t: Thread, tenant: unknown) {
    if (tenant === undefined) return;
    if (t.tenantId === undefined && this.runtime instanceof BusinessRuntime)
      t.tenantId = this.runtime.tenant(t.id);
    if ((t.tenantId ?? "default") !== parseTenant(tenant))
      throw new HttpError(404, "Conversation not found", "THREAD_NOT_FOUND");
  }
  async message(
    id: string,
    text: string,
    clientId?: string,
    explicitSteer = false,
  ) {
    if (!text?.trim()) throw new HttpError(400, "Message is empty");
    const t = this.thread(id);
    if (t.stop)
      throw new HttpError(409, "Conversation is stopping", "INTERRUPTING");
    if (!t.loaded)
      throw new HttpError(
        409,
        "Resume the thread before sending",
        "THREAD_UNLOADED",
      );
    return this.serial(id, async () => {
      if (this.draining && t.state.kind === "idle")
        throw new HttpError(503, "Agent core is draining", "DRAINING");
      if (t.state.kind === "interrupting")
        throw new HttpError(
          409,
          "Turn is interrupting; send again after completion",
          "INTERRUPTING",
        );
      const input = [{ type: "text", text, text_elements: [] }];
      if (t.state.kind === "running") {
        const turnId = t.state.turnId;
        await this.runtime.request("turn/steer", {
          threadId: id,
          input,
          expectedTurnId: turnId,
          clientUserMessageId: clientId,
        });
        return { turnId, steer: true };
      }
      if (explicitSteer) throw new HttpError(409, "No running turn to steer");
      await this.applyPending(t);
      if (t.stop)
        throw new HttpError(409, "Conversation is stopping", "INTERRUPTING");
      t.state = { kind: "starting" };
      t.diff = "";
      t.clock = {
        start: performance.now(),
        accept: null,
        first: null,
        last: null,
        count: 0,
        gap: 0,
        handler: 0,
      };
      t.input = text;
      try {
        const generation = this.generation;
        const result = await this.runtime.request("turn/start", {
          threadId: id,
          input,
          clientUserMessageId: clientId,
        });
        if (generation !== this.generation)
          throw new HttpError(
            503,
            "Runtime changed during startup",
            "RUNTIME_UNAVAILABLE",
          );
        this.attachStopTurn(t, result.turn.id);
        if (t.clock) {
          t.clock.accept = performance.now() - t.clock.start;
          t.clock.turnId = result.turn.id;
        }
        this.seeTurn(t, result.turn.id);
        // A complete notification can arrive before the response; do not revive that turn.
        if (t.state.kind === "starting") {
          t.state = { kind: "running", turnId: result.turn.id };
          this.watch(t);
        }
        return { turnId: result.turn.id, steer: false };
      } catch (e) {
        if (e instanceof HttpError && e.code === "RPC_TIMEOUT") {
          t.loaded = false;
        }
        if (t.state.kind === "starting") t.state = { kind: "idle" };
        t.input = undefined;
        throw e;
      }
    });
  }
  async interrupt(id: string, reason: StopIntent["reason"] = "user") {
    const ongoing = this.stopAttempts.get(id);
    if (ongoing) return this.waitForStop(this.thread(id), ongoing);
    if (this.draining)
      throw new HttpError(503, "Runtime is draining", "STOP_UNCONFIRMED");
    const t = this.thread(id);
    // Fence admission even while turn/start still holds the lifecycle lock.
    if (
      t.state.kind !== "idle" ||
      t.stop ||
      this.locks.has(id) ||
      this.hasActiveHelpers(t)
    ) {
      this.prepareStop(t, t.stop?.reason ?? reason);
    }
    const attempt = this.serial(id, async () => {
      if (t.state.kind === "idle" && !t.stop && !this.hasActiveHelpers(t))
        return { ok: true, state: t.state };
      if (
        t.state.kind !== "running" &&
        t.state.kind !== "interrupting" &&
        t.state.kind !== "starting"
      )
        throw new HttpError(409, "No running turn");
      return this.stopTurn(t, t.stop?.reason ?? reason);
    }).finally(() => {
      if (this.stopAttempts.get(id) === attempt) this.stopAttempts.delete(id);
    });
    this.stopAttempts.set(id, attempt);
    return this.waitForStop(t, attempt);
  }
  private waitForStop(t: Thread, attempt: Promise<any>) {
    return bounded(attempt, this.stopTimeoutMs + this.stopCheckMs).catch(
      (e) => {
        if (t.stop) {
          t.state = {
            kind: "interrupting",
            turnId: t.stop.turnId,
            stopStatus: "unconfirmed",
          };
          if (!this.draining) this.stopUpdate(t);
        }
        if (e instanceof HttpError) throw e;
        throw new HttpError(
          503,
          "Stop could not be confirmed. Retry Stop.",
          "STOP_UNCONFIRMED",
        );
      },
    );
  }
  private stopUpdate(t: Thread) {
    this.emit(
      t,
      "turn.stop.updated",
      { state: t.state, turnId: t.stop?.turnId },
      t.stop?.turnId,
    );
  }
  private discoverStop(t: Thread) {
    const intent = t.stop!;
    const targets = [...intent.targets];
    let changed = false;
    for (const c of this.agentsOf(t.id)) {
      if (c.stop)
        for (const target of c.stop.targets) {
          if (!targets.some((x) => x.threadId === target.threadId)) {
            targets.push({ ...target });
            changed = true;
          }
        }
      if (!c.stop && !c.turnId && terminal.includes(c.agent.status)) continue;
      if (!targets.some((target) => target.threadId === c.agent.threadId)) {
        targets.push({
          threadId: c.agent.threadId,
          turnId: c.turnId ?? "",
        });
        changed = true;
      }
    }
    if (changed) {
      this.stops.write({ ...intent, targets });
      intent.targets = targets;
    }
    return changed;
  }
  private hasActiveHelpers(t: Thread) {
    return this.agentsOf(t.id).some(
      (c) => c.stop || c.turnId || !terminal.includes(c.agent.status),
    );
  }
  private prepareStop(t: Thread, reason: StopIntent["reason"]) {
    if (!t.stop) {
      if (
        t.state.kind === "idle" &&
        !this.locks.has(t.id) &&
        !this.hasActiveHelpers(t)
      )
        throw new HttpError(409, "No running turn");
      const turnId =
        t.state.kind === "starting" || t.state.kind === "idle"
          ? t.clock?.turnId
          : t.state.turnId;
      t.stop = {
        version: 1,
        threadId: t.id,
        turnId: turnId ?? `stop_${randomUUID()}`,
        turnIds: turnId ? [turnId] : [],
        reason,
        targets: [{ threadId: t.id, turnId: turnId ?? "" }],
      };
      t.stopCompletion = undefined;
      if (!t.stop.turnIds!.length) t.stop.turnIds = [t.stop.turnId];
    }
    t.state = {
      kind: "interrupting",
      turnId: t.stop.turnId,
      stopStatus: "pending",
    };
    this.unwatch(t);
    try {
      this.discoverStop(t);
      this.stops.write(t.stop);
      this.stopUpdate(t);
      for (const request of [...t.pending.values()])
        this.settle(
          t,
          request,
          defaults[request.method as ServerMethod],
          "turn-completed",
        );
    } catch (e) {
      t.state = {
        kind: "interrupting",
        turnId: t.stop.turnId,
        stopStatus: "unconfirmed",
      };
      this.stopUpdate(t);
      throw e;
    }
  }
  private attachStopTurn(t: Thread, turnId: string) {
    if (!t.stop) return;
    const root = t.stop.targets.find((target) => target.threadId === t.id);
    if (!root || root.turnId === turnId) return;
    const current = t.turnOrder.indexOf(t.stop.turnId);
    const candidate = t.turnOrder.indexOf(turnId);
    if (current >= 0 && candidate >= 0 && candidate < current) return;
    t.stop.turnId = turnId;
    if (!t.stop.turnIds?.includes(turnId))
      t.stop.turnIds = [...(t.stop.turnIds ?? []), turnId];
    root.turnId = turnId;
    t.stopCompletion = undefined;
    t.state = {
      kind: "interrupting",
      turnId,
      stopStatus:
        t.state.kind === "interrupting" ? t.state.stopStatus : "pending",
    };
    try {
      this.stops.write(t.stop);
    } catch (e) {
      t.state = { kind: "interrupting", turnId, stopStatus: "unconfirmed" };
      log("error", "startup stop intent write failed", {
        threadId: t.id,
        ...errorFields(e),
      });
      throw e;
    } finally {
      this.stopUpdate(t);
    }
  }
  private async stopTurn(t: Thread, reason: StopIntent["reason"]) {
    if (this.draining)
      throw new HttpError(503, "Runtime is draining", "STOP_UNCONFIRMED");
    this.prepareStop(t, reason);
    const intent = t.stop!;
    const generation = this.generation;
    const startedAt = performance.now();
    t.state = {
      kind: "interrupting",
      turnId: intent.turnId,
      stopStatus: "pending",
    };
    this.unwatch(t);
    try {
      const valid = () =>
        !this.draining && generation === this.generation && t.stop === intent;
      let interruptDeadline = performance.now() + this.stopTimeoutMs;
      const interruptRemaining = () =>
        Math.max(1, interruptDeadline - performance.now());
      const goal = (
        await bounded(
          this.runtime.request("thread/goal/get", { threadId: t.id }),
          interruptRemaining(),
        )
      )?.goal;
      if (
        goal !== null &&
        ![
          "active",
          "paused",
          "complete",
          "blocked",
          "budgetLimited",
          "usageLimited",
        ].includes(goal?.status)
      )
        throw new Error("Goal state unavailable");
      if (!valid()) throw new Error("Runtime changed");
      if (goal?.status === "active") {
        const paused = await bounded(
          this.runtime.request("thread/goal/set", {
            threadId: t.id,
            status: "paused",
          }),
          interruptRemaining(),
        );
        if (paused?.goal?.status !== "paused")
          throw new Error("Goal pause unconfirmed");
        this.setGoal(t, paused.goal);
      } else this.setGoal(t, goal ?? null);
      if (!valid()) throw new Error("Runtime changed");
      // Persisted helper IDs are only used after the root's ownership was checked.
      if (this.runtime instanceof BusinessRuntime)
        for (const target of intent.targets)
          if (target.threadId !== t.id)
            this.runtime.helpers.add(target.threadId);
      const interrupted = new Set<string>();
      const archived = new Set<string>();
      const targetKey = (target: StopIntent["targets"][number]) =>
        `${target.threadId}:${target.turnId}`;
      const targetVersion = () => intent.targets.map(targetKey).join("|");
      const dispatch = async () => {
        this.discoverStop(t);
        const targets = intent.targets
          .filter((target) => !interrupted.has(targetKey(target)))
          .map((target) => ({ ...target }));
        await Promise.all(
          targets.map(async (target) => {
            interrupted.add(targetKey(target));
            try {
              await bounded(
                this.runtime.request("turn/interrupt", target),
                interruptRemaining(),
              );
            } catch {
              /* Metadata, not ACK, proves settlement. */
            }
            if (target.threadId !== t.id && valid()) {
              try {
                await bounded(
                  this.runtime.request("thread/archive", {
                    threadId: target.threadId,
                  }),
                  interruptRemaining(),
                );
                archived.add(target.threadId);
              } catch {
                /* Initializing helpers must also confirm shutdown. */
              }
            }
          }),
        );
      };
      await dispatch();
      const deadline = performance.now() + this.stopCheckMs;
      interruptDeadline = deadline;
      // Detached document/script work can keep mutating the workspace after
      // native interruption. Wait once instead of polling metadata while it runs.
      if (t.localWork.size)
        await bounded(Promise.allSettled([...t.localWork]), this.stopCheckMs);
      while (valid()) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        this.discoverStop(t);
        if (
          intent.targets.some((target) => !interrupted.has(targetKey(target)))
        ) {
          // A helper identified during interruption belongs to this same Stop.
          await bounded(dispatch(), remaining);
        }
        const version = targetVersion();
        const targets = intent.targets.map((target) => ({ ...target }));
        const states = await bounded(
          Promise.all(
            targets.map(async (target) => {
              try {
                const result = await this.runtime.request("thread/read", {
                  threadId: target.threadId,
                  includeTurns: false,
                });
                return ["idle", "notLoaded"].includes(
                  result?.thread?.status?.type,
                );
              } catch {
                return false;
              }
            }),
          ),
          Math.max(1, deadline - performance.now()),
        );
        if (valid() && version !== targetVersion()) continue;
        if (
          valid() &&
          !this.discoverStop(t) &&
          version === targetVersion() &&
          states.every(Boolean) &&
          targets.every(
            (target) =>
              target.threadId === t.id || archived.has(target.threadId),
          ) &&
          !t.localWork.size
        ) {
          for (const c of this.agentsOf(t.id))
            if (
              c.stop &&
              c.stop.targets.every((target) =>
                intent.targets.some((x) => x.threadId === target.threadId),
              )
            )
              this.finishHelperStop(c);
          this.stops.clear(t.id);
          t.stop = undefined;
          t.state = { kind: "idle" };
          const stopped = new Set(intent.turnIds ?? [intent.turnId]);
          for (const turnId of stopped) t.stoppedTurns.add(turnId);
          if (t.stoppedTurns.size > this.replayLimit)
            t.stoppedTurns.delete(t.stoppedTurns.values().next().value!);
          for (const c of this.agentsOf(t.id)) {
            if (
              !intent.targets.some(
                (target) => target.threadId === c.agent.threadId,
              )
            )
              continue;
            c.turnId = undefined;
            if (!terminal.includes(c.agent.status))
              this.update(c, { status: "interrupted" });
          }
          for (const r of t.thinking)
            if (r.turnId && stopped.has(r.turnId)) r.done = true;
          for (const message of t.messages) {
            if (
              !message.turnId ||
              !stopped.has(message.turnId) ||
              message.final
            )
              continue;
            message.final = true;
            this.emit(
              t,
              "message.final",
              { text: message.text, messageIndex: message.messageIndex },
              message.turnId,
              message.id,
            );
          }
          for (const request of [...t.pending.values()])
            this.settle(
              t,
              request,
              defaults[request.method as ServerMethod],
              "turn-completed",
            );
          const native = t.stopCompletion;
          const status =
            intent.reason === "stalled"
              ? "failed"
              : (native?.turn?.status ?? "interrupted");
          const done = this.finishTurn(
            t,
            intent.turnId,
            status,
            native?.at ?? performance.now(),
          );
          if (intent.reason === "stalled")
            this.failed(
              t,
              intent.turnId,
              { message: stalledMessage, code: "TURN_STALLED" },
              done,
            );
          else
            this.emit(
              t,
              "turn.completed",
              {
                method: "turn/completed",
                turn: { ...native?.turn, id: intent.turnId, status },
                ...done,
              },
              intent.turnId,
            );
          this.emit(
            t,
            "turn.stop.updated",
            { state: t.state, turnId: intent.turnId },
            intent.turnId,
          );
          log("info", "stop confirmed", {
            threadId: t.id,
            reason: intent.reason,
            targets: intent.targets.length,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          return { ok: true, state: t.state, turnId: intent.turnId };
        }
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(50, Math.max(1, deadline - performance.now())),
          ),
        );
      }
      throw new Error("Stop not confirmed");
    } catch (e) {
      if (t.stop === intent) {
        t.state = {
          kind: "interrupting",
          turnId: intent.turnId,
          stopStatus: "unconfirmed",
        };
        if (!this.draining) this.stopUpdate(t);
      }
      log("warn", "stop unconfirmed", { threadId: t.id, ...errorFields(e) });
      if (e instanceof HttpError && e.code === "STOP_STORAGE_INVALID") throw e;
      throw new HttpError(
        503,
        "Stop could not be confirmed. Retry Stop; already-started connector actions may finish.",
        "STOP_UNCONFIRMED",
      );
    }
  }
  snapshot(id: string): Snapshot {
    const t = this.thread(id);
    return {
      cursor: `${this.generation}:${t.seq}`,
      state: t.state,
      pending: [...t.pending.values()]
        .filter((p) => !p.hidden)
        .map(({ timer, rawId, hidden, reviews, ...p }) => p),
      messages: t.messages,
      thinking: t.thinking,
      plan: t.plan,
      goal: this.goalView(t),
      diff: t.diff,
      timings: t.timings,
      traces: t.traces,
      rateLimits: this.rateLimits,
      subAgents: this.agentsOf(id).map((c) => ({ ...c.agent })),
    };
  }
  agents(id: string): SubAgent[] {
    this.thread(id);
    return this.agentsOf(id).map((c) => ({ ...c.agent }));
  }
  agent(id: string, agentId: string): SubAgentTranscript {
    const c = this.owned(id, agentId);
    return {
      agent: { ...c.agent },
      messages: c.transcript.map((m) => ({ ...m })),
    };
  }
  private helperStopStore(rootId: string) {
    let store = this.helperStops.get(rootId);
    if (!store) {
      store = new StopStore(this.home, join("helper-stop-intents", rootId));
      this.helperStops.set(rootId, store);
    }
    return store;
  }
  private restoreHelperStops(root: Thread) {
    const store = this.helperStopStore(root.id);
    const intents = store.ids().map((id) => store.read(id)!);
    for (const intent of intents)
      for (const target of intent.targets) {
        const known = this.children.get(target.threadId);
        if (target.threadId === root.id || (known && known.rootId !== root.id))
          throw new HttpError(
            503,
            "Invalid helper stop ownership",
            "STOP_STORAGE_INVALID",
          );
      }
    for (const intent of intents) {
      const id = intent.threadId;
      for (const target of intent.targets) {
        if (target.threadId === root.id)
          throw new HttpError(
            503,
            "Invalid helper stop recovery",
            "STOP_STORAGE_INVALID",
          );
        if (!this.children.has(target.threadId))
          this.children.set(target.threadId, {
            rootId: root.id,
            parentId: target.threadId === id ? root.id : id,
            transcript: [],
            agent: {
              threadId: target.threadId,
              path: null,
              nickname: null,
              role: null,
              depth: target.threadId === id ? 1 : 2,
              status: "pendingInit",
              startedAt: new Date().toISOString(),
            },
          });
      }
      const c = this.children.get(id)!;
      if (c.rootId !== root.id)
        throw new HttpError(
          503,
          "Invalid helper stop ownership",
          "STOP_STORAGE_INVALID",
        );
      c.stop = intent;
      c.agent.stopStatus = "unconfirmed";
    }
  }
  private helperStopStatus(c: Child, status?: "pending" | "unconfirmed") {
    if (status) c.agent.stopStatus = status;
    else delete c.agent.stopStatus;
    const root = this.threads.get(c.rootId);
    if (root)
      this.emit(
        root,
        "subagent.status",
        { agent: { ...c.agent } },
        this.activeTurn(root),
      );
  }
  // Archiving a native helper also shuts down its descendants. Verify the
  // whole known subtree, while leaving ancestors and siblings alone.
  private discoverHelperStop(c: Child, force = false) {
    const intent = c.stop!;
    const ids = new Set([
      c.agent.threadId,
      ...intent.targets.map((x) => x.threadId),
    ]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of this.agentsOf(c.rootId))
        if (ids.has(child.parentId) && !ids.has(child.agent.threadId)) {
          ids.add(child.agent.threadId);
          changed = true;
        }
    }
    const targets = [...ids].map((id) => {
      const child = this.children.get(id);
      return {
        threadId: id,
        turnId:
          child?.turnId ??
          intent.targets.find((x) => x.threadId === id)?.turnId ??
          "",
      };
    });
    const own = targets.find((x) => x.threadId === c.agent.threadId)!;
    const turnId = own.turnId || intent.turnId;
    const next = {
      ...intent,
      targets,
      turnId,
      turnIds: [...new Set([...(intent.turnIds ?? []), turnId])],
    };
    if (!force && JSON.stringify(next) === JSON.stringify(intent)) return;
    // Write before publishing any new target so a failed write is retried.
    this.helperStopStore(c.rootId).write(next);
    Object.assign(intent, next);
  }
  private finishHelperStop(c: Child) {
    const intent = c.stop;
    if (!intent) return;
    this.helperStopStore(c.rootId).clear(c.agent.threadId);
    c.stop = undefined;
    for (const target of intent.targets) {
      const child = this.children.get(target.threadId);
      if (!child || child.rootId !== c.rootId) continue;
      child.stoppedTurns ??= new Set();
      for (const turnId of target.threadId === c.agent.threadId
        ? (intent.turnIds ?? [intent.turnId])
        : [target.turnId])
        if (turnId) child.stoppedTurns.add(turnId);
      while (child.stoppedTurns.size > this.replayLimit)
        child.stoppedTurns.delete(child.stoppedTurns.values().next().value!);
      child.turnId = undefined;
      if (!["completed", "errored", "interrupted"].includes(child.agent.status))
        this.update(child, { status: "interrupted" });
      for (const m of child.transcript) m.final = true;
    }
    for (const child of this.agentsOf(c.rootId))
      if (
        child.stop &&
        child.stop.targets.every((target) =>
          intent.targets.some((x) => x.threadId === target.threadId),
        )
      )
        this.finishHelperStop(child);
    this.helperStopStatus(c);
  }
  async interruptAgent(id: string, agentId: string) {
    const c = this.owned(id, agentId);
    if (this.draining)
      throw new HttpError(503, "Runtime is draining", "STOP_UNCONFIRMED");
    const ongoing = this.helperStopAttempts.get(agentId);
    if (ongoing) return ongoing;
    if (!c.stop && !c.turnId && terminal.includes(c.agent.status))
      return { ok: true, agent: { ...c.agent } };
    if (!c.stop) {
      const turnId = c.turnId ?? `stop_${randomUUID()}`;
      c.stop = {
        version: 1,
        threadId: agentId,
        turnId,
        turnIds: [turnId],
        reason: "user",
        targets: [{ threadId: agentId, turnId: c.turnId ?? "" }],
      };
    }
    this.helperStopStatus(c, "pending");
    const attempt = this.stopHelper(c).finally(() => {
      if (this.helperStopAttempts.get(agentId) === attempt)
        this.helperStopAttempts.delete(agentId);
    });
    this.helperStopAttempts.set(agentId, attempt);
    return attempt;
  }
  private async stopHelper(c: Child) {
    const intent = c.stop!;
    const generation = this.generation;
    const started = performance.now();
    const valid = () =>
      !this.draining &&
      this.generation === generation &&
      c.stop === intent &&
      this.children.get(c.agent.threadId) === c;
    const confirmed = () => !c.stop && terminal.includes(c.agent.status);
    try {
      this.discoverHelperStop(c, true);
      const interrupted = new Set<string>();
      let archived = false;
      let deadline = performance.now() + this.stopTimeoutMs;
      const remaining = () => Math.max(1, deadline - performance.now());
      const version = () => JSON.stringify(intent.targets);
      const dispatch = async () => {
        if (this.runtime instanceof BusinessRuntime)
          for (const target of intent.targets)
            this.runtime.helpers.add(target.threadId);
        await Promise.all(
          intent.targets.map(async (target) => {
            const key = `${target.threadId}:${target.turnId}`;
            if (interrupted.has(key)) return;
            interrupted.add(key);
            try {
              await bounded(
                this.runtime.request("turn/interrupt", { ...target }),
                remaining(),
              );
            } catch {
              /* Inactive metadata can confirm a lost interrupt ACK. */
            }
          }),
        );
        if (!valid()) return;
        await bounded(
          this.runtime.request("thread/archive", {
            threadId: c.agent.threadId,
          }),
          remaining(),
        );
        archived = true;
      };
      await dispatch();
      deadline = performance.now() + this.stopCheckMs;
      while (valid() && performance.now() < deadline) {
        const before = version();
        this.discoverHelperStop(c);
        if (
          before !== version() ||
          intent.targets.some(
            (target) => !interrupted.has(`${target.threadId}:${target.turnId}`),
          )
        ) {
          archived = false;
          await dispatch();
        }
        const checked = version();
        const states = await bounded(
          Promise.all(
            intent.targets.map(async (target) => {
              try {
                const result = await this.runtime.request("thread/read", {
                  threadId: target.threadId,
                  includeTurns: false,
                });
                return ["idle", "notLoaded"].includes(
                  result?.thread?.status?.type,
                );
              } catch {
                return false;
              }
            }),
          ),
          remaining(),
        );
        if (!valid()) break;
        this.discoverHelperStop(c);
        if (checked === version() && archived && states.every(Boolean)) {
          this.finishHelperStop(c);
          log("info", "helper stop confirmed", {
            threadId: c.rootId,
            helperThreadId: c.agent.threadId,
            targets: intent.targets.length,
            elapsedMs: Math.round(performance.now() - started),
          });
          return { ok: true, agent: { ...c.agent } };
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, remaining())),
        );
      }
      if (confirmed()) return { ok: true, agent: { ...c.agent } };
      throw new Error("Helper stop unconfirmed");
    } catch (e) {
      if (confirmed()) return { ok: true, agent: { ...c.agent } };
      if (c.stop === intent && generation === this.generation)
        this.helperStopStatus(c, "unconfirmed");
      log("warn", "helper stop unconfirmed", {
        threadId: c.rootId,
        helperThreadId: c.agent.threadId,
        ...errorFields(e),
      });
      if (e instanceof HttpError && e.code === "STOP_STORAGE_INVALID") throw e;
      throw new HttpError(
        503,
        "Helper Stop could not be confirmed. Retry Stop; already-started connector actions may finish.",
        "STOP_UNCONFIRMED",
      );
    }
  }
  private owned(id: string, agentId: string) {
    this.thread(id);
    const c = /^[\w-]+$/.test(agentId) ? this.children.get(agentId) : undefined;
    if (!c || c.rootId !== id)
      throw new HttpError(404, "Helper agent not found", "AGENT_NOT_FOUND");
    return c;
  }
  private agentsOf(rootId: string) {
    return [...this.children.values()].filter((c) => c.rootId === rootId);
  }
  private activeTurn(t: Thread) {
    return t.state.kind === "running" || t.state.kind === "interrupting"
      ? t.state.turnId
      : undefined;
  }
  private spawnSource(p: any) {
    const source = p.thread?.source?.subagent?.thread_spawn;
    return typeof source?.parent_thread_id === "string" ? source : null;
  }
  // Registers a helper under its root conversation the first time it is seen.
  private child(
    childId: string,
    parentId: string,
    patch: Partial<SubAgent> = {},
    extra: { tool?: CollabTool; callStatus?: string } = {},
  ) {
    const known = this.children.get(childId);
    if (known) {
      this.update(known, patch, extra);
      return known;
    }
    if (!/^[\w-]+$/.test(childId)) return null;
    const rootId = this.children.get(parentId)?.rootId ?? parentId;
    const root = this.threads.get(rootId);
    if (!root || rootId === childId) return null;
    // An early helper event may have created a record no client observes.
    const stray = this.threads.get(childId);
    if (stray && stray.subscribers.size === 0) this.threads.delete(childId);
    const parent = this.children.get(parentId);
    const c: Child = {
      rootId,
      parentId,
      turnId: stray ? this.activeTurn(stray) : undefined,
      // Keep what the helper said before it was identified.
      transcript: (stray?.messages ?? [])
        .slice(-transcriptLimit)
        .map((m) => ({ id: m.id, text: m.text, final: m.final })),
      agent: {
        threadId: childId,
        path: null,
        nickname: null,
        role: null,
        depth: parent ? parent.agent.depth + 1 : 1,
        status: "pendingInit",
        startedAt: new Date().toISOString(),
      },
    };
    this.apply(c.agent, patch);
    if (terminal.includes(c.agent.status)) c.agent.endedAt = c.agent.startedAt;
    this.children.set(childId, c);
    if (this.runtime instanceof BusinessRuntime)
      this.runtime.helpers.add(childId);
    if (root.stop) {
      try {
        this.discoverStop(root);
      } catch (e) {
        root.state = {
          kind: "interrupting",
          turnId: root.stop.turnId,
          stopStatus: "unconfirmed",
        };
        this.stopUpdate(root);
        log("error", "helper stop intent write failed", {
          threadId: root.id,
          ...errorFields(e),
        });
      }
    }
    this.emit(
      root,
      "subagent.spawned",
      { agent: { ...c.agent }, ...extra },
      this.activeTurn(root),
    );
    const held = this.early.get(childId);
    this.early.delete(childId);
    for (const e of held ?? []) this.childNotification(c, e.method, e.p);
    this.lookupName(c);
    return c;
  }
  // Codex keeps a helper's nickname on its own thread; collab items and
  // spawn notifications often arrive without it.
  private lookupName(c: Child) {
    if (c.agent.nickname || (c.nameTries ?? 0) >= 2) return;
    c.nameTries = (c.nameTries ?? 0) + 1;
    const id = c.agent.threadId;
    Promise.resolve()
      .then(() =>
        this.runtime.request("thread/read", {
          threadId: id,
          includeTurns: false,
        }),
      )
      .then((result: any) => {
        if (this.children.get(id) !== c) return;
        this.update(c, {
          nickname: clip(result?.thread?.agentNickname, 80),
          role: clip(result?.thread?.agentRole, 80),
        });
      })
      .catch((e) =>
        log("debug", "helper name lookup failed", {
          helperThreadId: id,
          ...errorFields(e),
        }),
      );
  }
  private apply(agent: SubAgent, patch: Partial<SubAgent>) {
    let changed = false;
    for (const key of [
      "path",
      "nickname",
      "role",
      "depth",
      "status",
      "task",
      "lastMessage",
    ] as const) {
      const value = patch[key];
      if (value === undefined || value === null || agent[key] === value)
        continue;
      if (key === "status" && !agentStatuses.includes(value as SubAgentStatus))
        continue;
      // Closing or shutting down an ended helper keeps how it ended
      // (finished, failed or stopped) instead of "closed" or "not found".
      if (
        key === "status" &&
        terminal.includes(agent.status) &&
        (value === "shutdown" || value === "notFound")
      )
        continue;
      if (key === "depth" && !(Number.isInteger(value) && Number(value) > 0))
        continue;
      (agent as any)[key] = value;
      changed = true;
    }
    return changed;
  }
  private update(
    c: Child,
    patch: Partial<SubAgent>,
    extra: { tool?: CollabTool; callStatus?: string } = {},
  ) {
    const before = c.agent.status;
    if (!this.apply(c.agent, patch)) return;
    const done = terminal.includes(c.agent.status),
      finished = done && !terminal.includes(before);
    if (finished) c.agent.endedAt = new Date().toISOString();
    if (!done) delete c.agent.endedAt;
    const root = this.threads.get(c.rootId);
    if (root)
      this.emit(
        root,
        finished ? "subagent.completed" : "subagent.status",
        { agent: { ...c.agent }, ...extra },
        this.activeTurn(root),
      );
  }
  // Collab items name helpers before, or instead of, their thread/started.
  private collab(parentId: string, item: any) {
    if (item?.type === "collabAgentToolCall") {
      const extra = { tool: item.tool, callStatus: item.status };
      const sender =
        typeof item.senderThreadId === "string" &&
        (this.threads.has(item.senderThreadId) ||
          this.children.has(item.senderThreadId))
          ? item.senderThreadId
          : parentId;
      for (const id of Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : []) {
        if (typeof id !== "string") continue;
        const state = item.agentsStates?.[id];
        this.child(
          id,
          sender,
          {
            ...(item.tool === "spawnAgent"
              ? { task: clip(item.prompt, 500) }
              : {}),
            status: state?.status,
            lastMessage: clip(state?.message),
          },
          extra,
        );
      }
    }
    if (
      item?.type === "subAgentActivity" &&
      typeof item.agentThreadId === "string"
    )
      this.child(item.agentThreadId, parentId, {
        path: clip(item.agentPath, 200),
        status: item.kind === "interrupted" ? "interrupted" : "running",
      });
  }
  // Only a helper's lifecycle, messages and reasoning summaries are published;
  // its tool calls and arguments stay internal.
  private childNotification(c: Child, method: string, p: any) {
    const root = this.threads.get(c.rootId);
    if (!root) return;
    const nativeTurn = p.turnId || p.turn?.id;
    if (nativeTurn && c.stoppedTurns?.has(nativeTurn)) return;
    // A helper working for the running turn keeps that turn alive.
    this.watch(root);
    const a = c.agent,
      turnId = p.turnId || p.turn?.id,
      itemId = p.itemId || p.item?.id;
    const event = (kind: string, data: Record<string, unknown> = {}) =>
      this.emit(
        root,
        "subagent.event",
        {
          agentThreadId: a.threadId,
          agentPath: a.path,
          nickname: a.nickname,
          role: a.role,
          depth: a.depth,
          kind,
          ...data,
        },
        this.activeTurn(root),
      );
    const message = () => {
      let m = c.transcript.find((x) => x.id === itemId);
      if (!m) {
        m = { id: itemId, text: "", final: false };
        c.transcript.push(m);
        if (c.transcript.length > transcriptLimit) c.transcript.shift();
      }
      return m;
    };
    const trace = () => this.builder(root, this.activeTurn(root));
    switch (method) {
      case "thread/started": {
        const s = this.spawnSource(p);
        this.update(c, {
          path: s?.agent_path,
          nickname: s?.agent_nickname ?? p.thread?.agentNickname,
          role: s?.agent_role ?? p.thread?.agentRole,
          depth: s?.depth,
        });
        return;
      }
      case "turn/started":
        c.turnId = turnId;
        this.update(c, { status: "running" });
        event("turn.started");
        this.lookupName(c);
        return;
      case "turn/completed": {
        if (c.turnId && c.turnId !== turnId) return;
        if (c.turnId === turnId) c.turnId = undefined;
        const status = p.turn?.status;
        this.update(c, {
          status:
            status === "interrupted"
              ? "interrupted"
              : status === "failed"
                ? "errored"
                : "completed",
        });
        event("turn.completed", { status });
        return;
      }
      case "item/agentMessage/delta":
        if (typeof p.delta !== "string") return;
        message().text += p.delta;
        event("message.delta", { delta: p.delta, itemId });
        return;
      case "item/reasoning/summaryTextDelta":
        if (typeof p.delta === "string")
          event("reasoning.delta", { delta: p.delta, itemId });
        return;
      case "thread/tokenUsage/updated":
        trace()?.onHelperUsage(p.tokenUsage?.last);
        return;
      case "item/started":
      case "item/completed":
        trace()?.onItem(
          method === "item/started" ? "started" : "completed",
          p.item,
          method === "item/started" ? p.startedAtMs : p.completedAtMs,
          {
            agent: a.nickname ?? a.role ?? "helper",
            agentThreadId: a.threadId,
          },
        );
        if (
          method === "item/completed" &&
          p.item?.type === "agentMessage" &&
          typeof p.item.text === "string"
        ) {
          const m = message();
          m.text = p.item.text;
          m.final = true;
          event("message.final", { text: p.item.text, itemId });
          this.update(c, { lastMessage: clip(p.item.text) });
        } else this.collab(a.threadId, p.item);
        return;
      case "thread/closed":
      case "thread/archived":
      case "thread/deleted":
        c.turnId = undefined;
        this.update(c, { status: "shutdown" });
        return;
    }
  }
  // Buffers events for an unknown thread while a root turn is running, since
  // only a running turn can spawn a helper. Bounded per thread and overall.
  private holdEarly(id: string, method: string, p: any) {
    if (this.threads.has(id) || this.roots.has(id)) return false;
    const spawning = [...this.roots].some((r) =>
      ["running", "interrupting"].includes(
        this.threads.get(r)?.state.kind ?? "",
      ),
    );
    if (!spawning || !/^[\w-]+$/.test(id)) return false;
    let held = this.early.get(id);
    if (!held) {
      if (this.early.size >= earlyThreadLimit) {
        const oldest = this.early.keys().next().value;
        if (oldest !== undefined) this.early.delete(oldest);
      }
      held = [];
      this.early.set(id, held);
    }
    if (held.length < earlyEventLimit) held.push({ method, p });
    return true;
  }
  private dropAgents(rootId: string) {
    for (const c of this.agentsOf(rootId)) {
      this.children.delete(c.agent.threadId);
      this.dropped.add(c.agent.threadId);
      if (this.dropped.size > droppedLimit)
        this.dropped.delete(this.dropped.values().next().value!);
      if (this.runtime instanceof BusinessRuntime)
        this.runtime.helpers.delete(c.agent.threadId);
    }
  }
  subscribe(id: string, res: Response, cursor?: string) {
    const t = this.thread(id);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    if (cursor) {
      const [generation, seqText] = cursor.split(":");
      const seq = Number(seqText);
      const oldest = t.events[0]?.seq ?? t.seq + 1;
      if (
        generation !== this.generation ||
        !Number.isSafeInteger(seq) ||
        seq < oldest - 1 ||
        seq > t.seq
      ) {
        res.write(
          `data: ${JSON.stringify({ type: "resync.required", data: { reason: "Cursor no longer retained" }, threadId: id })}\n\n`,
        );
      } else
        for (const e of t.events.filter((e) => e.seq > seq)) {
          if (!send(res, this.frame(e))) {
            res.destroy();
            return;
          }
        }
    }
    const snapshot = {
      type: "snapshot",
      threadId: id,
      cursor: this.snapshot(id).cursor,
      data: this.snapshot(id),
    };
    if (
      !send(
        res,
        `id: ${snapshot.cursor}\ndata: ${JSON.stringify(snapshot)}\n\n`,
      )
    ) {
      res.destroy();
      return;
    }
    t.subscribers.add(res);
    const timer = setInterval(() => {
      if (!send(res, ": heartbeat\n\n")) res.destroy();
    }, 15_000);
    res.on("close", () => {
      clearInterval(timer);
      t.subscribers.delete(res);
    });
  }
  private frame(event: DomainEvent) {
    return `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  // The running turn's trace; created lazily for a turn resumed mid-way.
  private builder(t: Thread, turnId?: string) {
    if (!turnId) return undefined;
    if (t.trace?.turnId === turnId) return t.trace;
    if (this.activeTurn(t) !== turnId) return undefined;
    t.trace = new TraceBuilder(
      turnId,
      t.id,
      Date.now(),
      this.rateLimits,
      t.input ?? "",
    );
    t.input = undefined;
    return t.trace;
  }
  turnContext(id: string, turnId: string): TurnContext {
    const t = this.thread(id);
    const context = /^[\w-]+$/.test(turnId)
      ? (t.contexts.get(turnId) ??
        (t.trace?.turnId === turnId ? t.trace.context() : undefined))
      : undefined;
    if (!context)
      throw new HttpError(
        404,
        "Turn context is not available",
        "CONTEXT_NOT_FOUND",
      );
    return context;
  }
  private finishTurn(
    t: Thread,
    turnId: string,
    status: string | undefined,
    at: number,
  ): TurnEnd {
    const end: TurnEnd = {};
    if (t.clock && t.clock.turnId === turnId) {
      const c = t.clock,
        total = at - c.start,
        stream = c.first !== null && c.last !== null ? c.last - c.first : 0;
      const timing: TurnTiming = {
        turnId,
        acceptMs: c.accept,
        ttftMs: c.first === null ? null : c.first - c.start,
        streamMs: stream,
        adapterStreamMs: Math.min(stream, c.handler),
        idleStreamMs: Math.max(0, stream - c.handler),
        maxGapMs: c.gap,
        deltaRate: stream > 0 ? c.count / (stream / 1000) : 0,
        finalizeMs: c.last === null ? total : at - c.last,
        totalMs: total,
        deltaCount: c.count,
        nonStreaming: c.count === 0,
        status: status as string,
      };
      t.timings.push(timing);
      if (t.timings.length > 100) t.timings.shift();
      end.timing = timing;
      t.clock = undefined;
    }
    const b = t.trace;
    if (b && b.turnId === turnId) {
      t.trace = undefined;
      const trace = b.finish(
        status ?? "completed",
        end.timing?.totalMs ?? null,
      );
      t.traces.push(trace);
      if (t.traces.length > traceLimit) t.traces.shift();
      t.contexts.set(turnId, b.context());
      if (t.contexts.size > contextTurnLimit)
        t.contexts.delete(t.contexts.keys().next().value!);
      end.trace = trace;
    }
    return end;
  }
  private seeTurn(t: Thread, turnId: string) {
    if (t.turnOrder.includes(turnId)) return;
    t.turnOrder.push(turnId);
    if (t.turnOrder.length > 500) t.turnOrder.shift();
  }
  // True when turnId is older than the turn that produced the stored plan.
  // An unknown turn counts as older once the stored plan's turn is known.
  private stalePlan(t: Thread, turnId: string) {
    if (!t.planTurnId || t.planTurnId === turnId) return false;
    const stored = t.turnOrder.indexOf(t.planTurnId);
    if (stored < 0) return false;
    return t.turnOrder.indexOf(turnId) < stored;
  }
  // A different goal starts a fresh tally.
  private setGoal(t: Thread, goal: any) {
    const key = goalKey(goal);
    if (key !== t.goalTokens.key)
      t.goalTokens = { key, observed: 0, turns: [] };
    t.goal = goal;
  }
  // Turns that ran while the goal was active count toward it, including usage
  // reported after the goal was marked complete within the same turn.
  private trackGoalTurn(t: Thread, turnId: string) {
    const goal = t.goal as any;
    if (goal?.status !== "active" || t.goalTokens.turns.includes(turnId))
      return;
    t.goalTokens.turns.push(turnId);
    if (t.goalTokens.turns.length > 200) t.goalTokens.turns.shift();
  }
  private goalView(t: Thread) {
    const goal = t.goal as any;
    return goal ? { ...goal, tokensObserved: t.goalTokens.observed } : null;
  }
  private emit(
    t: Thread,
    type: DomainType,
    data: any,
    turnId?: string,
    itemId?: string,
  ) {
    data = this.redactor.clean(data);
    const event: DomainEvent = {
      type,
      threadId: t.id,
      seq: ++t.seq,
      cursor: `${this.generation}:${t.seq}`,
      at: new Date().toISOString(),
      data,
      turnId,
      itemId,
    };
    let durable = [
      "message.final",
      "turn.completed",
      "approval.resolved",
      "goal.cleared",
      // Lets platform keep the plan when no browser is subscribed.
      "plan.updated",
    ].includes(type);
    if (type === "goal.cleared") this.goalRecords.set(t.id, "cleared");
    // Goal changes are durable; token-only updates are not.
    if (type === "goal.updated") {
      const g = data?.goal;
      const key = JSON.stringify(
        g
          ? [g.createdAt ?? null, g.objective, g.status, g.tokenBudget ?? null]
          : null,
      );
      durable = this.goalRecords.get(t.id) !== key;
      this.goalRecords.set(t.id, key);
    }
    let lost = false;
    if (durable) {
      const dir = join(this.home, "adapter-records", t.id);
      const file = join(
        dir,
        `${this.generation}-${String(event.seq).padStart(12, "0")}.json`,
      );
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file + ".tmp", JSON.stringify(event));
        renameSync(file + ".tmp", file);
      } catch (e) {
        lost = true;
        this.draining = true;
        log("error", "durable record write failed; stopping admission", {
          threadId: t.id,
          turnId,
          eventType: type,
          seq: event.seq,
          ...errorFields(e),
        });
      }
    }
    t.events.push(event);
    if (t.events.length > this.replayLimit) t.events.shift();
    for (const sub of t.subscribers)
      if (!send(sub, this.frame(event))) sub.destroy();
    if (lost) {
      // Subscribers learn why the stream ends before it is closed.
      this.emit(
        t,
        "error",
        {
          message:
            "Conversation storage is unavailable, so this update may not be saved. Refresh the conversation later to check its state.",
          code: "STORAGE_UNAVAILABLE",
          willRetry: false,
          ...(turnId ? { turnId } : {}),
        },
        turnId,
      );
      for (const sub of t.subscribers) sub.destroy();
    }
    return event;
  }
  private notification(method: string, p: any) {
    const begin = performance.now();
    p = this.redactor.clean(p);
    if (!inventory.notifications.some((n) => n.method === method)) {
      this.unknownMethods++;
      log("warn", "unknown runtime notification", { method });
    }
    const id = p.threadId || p.thread?.id;
    if (!id) {
      const limits =
        method === "account/rateLimits/updated" && p.rateLimits
          ? (this.rateLimits = rateLimitView(p.rateLimits, this.rateLimits))
          : null;
      for (const t of this.threads.values())
        if (t.loaded) {
          this.emit(t, mappings[method] || "runtime.event", { method, ...p });
          if (!limits) continue;
          const turnId = this.activeTurn(t);
          this.builder(t, turnId)?.onRateLimits(limits);
          this.emit(t, "limits.updated", { rateLimits: limits }, turnId);
        }
      return;
    }
    if (typeof id === "string") {
      const helper = this.children.get(id);
      if (helper) return this.childNotification(helper, method, p);
      if (this.dropped.has(id)) return;
      const spawn =
        method === "thread/started" ? this.spawnSource(p) : undefined;
      if (
        spawn &&
        this.child(id, spawn.parent_thread_id, {
          path: spawn.agent_path,
          nickname: spawn.agent_nickname ?? p.thread?.agentNickname,
          role: spawn.agent_role ?? p.thread?.agentRole,
          depth: spawn.depth,
        })
      )
        return;
      // A helper can speak before the root's spawn call names it. Hold its
      // events instead of creating a thread record no client observes.
      if (!spawn && this.holdEarly(id, method, p)) return;
    }
    const t = this.thread(id),
      turnId = p.turnId || p.turn?.id,
      itemId = p.itemId || p.item?.id;
    if (turnId && t.stoppedTurns.has(turnId)) return;
    if (method === "thread/started") t.loaded = true;
    if (method === "turn/started") {
      if (t.stop) {
        if (typeof turnId === "string") this.attachStopTurn(t, turnId);
        if (t.clock) t.clock.turnId = turnId;
        if (turnId) this.seeTurn(t, turnId);
        this.builder(t, turnId);
        this.stopUpdate(t);
        return;
      }
      if (t.state.kind === "idle" || t.state.kind === "starting")
        t.state = { kind: "running", turnId };
      if (t.clock) t.clock.turnId = turnId;
      if (turnId) this.seeTurn(t, turnId);
      this.builder(t, turnId);
    }
    // Any activity on the thread shows the running turn is alive.
    this.watch(t);
    if (
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta" ||
      (method === "item/completed" && p.item?.type === "reasoning")
    ) {
      let thinking = t.thinking.find(
        (r) => r.id === itemId && r.turnId === turnId,
      );
      if (!thinking) {
        thinking = { id: itemId, turnId, summary: "", raw: "", done: false };
        t.thinking.push(thinking);
      }
      if (method === "item/reasoning/summaryTextDelta")
        thinking.summary += p.delta;
      if (method === "item/reasoning/textDelta") thinking.raw += p.delta;
      if (method === "item/completed") {
        thinking.summary =
          (p.item.summary || []).join("\n") || thinking.summary;
        thinking.done = true;
      }
      if (t.thinking.length > 100) t.thinking.shift();
    }
    if (method === "item/agentMessage/delta") {
      let message = t.messages.find((x) => x.id === itemId);
      if (!message) {
        message = {
          id: itemId,
          turnId,
          text: "",
          final: false,
          messageIndex:
            Math.max(
              -1,
              ...t.messages
                .filter((x) => x.turnId === turnId)
                .map((x) => x.messageIndex ?? -1),
            ) + 1,
        };
        t.messages.push(message);
      }
      message.text += p.delta;
      p = { ...p, messageIndex: message.messageIndex };
      if (t.clock && t.clock.turnId === turnId) {
        const c = t.clock;
        if (c.first === null) c.first = begin;
        if (c.last !== null) c.gap = Math.max(c.gap, begin - c.last);
        c.last = begin;
        c.count++;
      }
    }
    if (method === "item/completed" && p.item?.type === "agentMessage") {
      const previous = t.messages.find((x) => x.id === itemId);
      const message = {
        id: itemId,
        turnId,
        text: p.item.text,
        final: true,
        messageIndex:
          previous?.messageIndex ??
          Math.max(
            -1,
            ...t.messages
              .filter((x) => x.turnId === turnId)
              .map((x) => x.messageIndex ?? -1),
          ) + 1,
      };
      const index = t.messages.findIndex((x) => x.id === itemId);
      if (index < 0) t.messages.push(message);
      else t.messages[index] = message;
      if (t.clock && t.clock.turnId === turnId && t.clock.first === null) {
        t.clock.first = begin;
        t.clock.last = begin;
      }
      const messageIndex = message.messageIndex;
      this.emit(
        t,
        "message.final",
        { text: p.item.text, messageIndex },
        turnId,
        itemId,
      );
      if (t.messages.length > 1000)
        t.messages.splice(0, t.messages.length - 1000);
    }
    if (method === "turn/plan/updated") {
      // A replayed or late update from an older turn must not replace a newer plan.
      if (turnId && this.stalePlan(t, turnId)) return;
      t.plan = p.plan;
      t.planTurnId = turnId ?? t.planTurnId;
    }
    if (method === "turn/started" && turnId) this.trackGoalTurn(t, turnId);
    if (method === "thread/goal/updated") {
      this.setGoal(t, p.goal ?? null);
      if (turnId) this.trackGoalTurn(t, turnId);
      p = { ...p, goal: this.goalView(t) };
    }
    if (method === "thread/goal/cleared") {
      // Names the cleared goal, so a replayed clear can't remove a newer one.
      p = { ...p, goalCreatedAt: (t.goal as any)?.createdAt ?? null };
      this.setGoal(t, null);
    }
    if (method === "thread/tokenUsage/updated") {
      if (turnId && t.goalTokens.turns.includes(turnId)) {
        const delta = goalTokenDelta(p.tokenUsage?.last);
        if (delta > 0) {
          t.goalTokens.observed += delta;
          this.emit(t, "goal.updated", { goal: this.goalView(t) }, turnId);
        }
      }
      // Published as the turn's summed usage, never as the raw notification.
      const usage = this.builder(t, turnId)?.onUsage(p.tokenUsage);
      if (usage) this.emit(t, "usage.updated", { usage }, turnId);
      return;
    }
    if (method === "turn/diff/updated") t.diff = p.diff;
    if (method === "serverRequest/resolved") {
      const request = [...t.pending.values()].find(
        (x) => String(x.rawId) === String(p.requestId),
      );
      if (request)
        this.settle(t, request, undefined, "runtime-resolved", false);
    }
    if (method === "item/started" || method === "item/completed") {
      this.collab(t.id, p.item);
      this.builder(t, turnId)?.onItem(
        method === "item/started" ? "started" : "completed",
        p.item,
        method === "item/started" ? p.startedAtMs : p.completedAtMs,
        { agent: "main", agentThreadId: t.id },
      );
    }
    let data = { method, ...p };
    if (method === "turn/completed") {
      // A root terminal event alone cannot unlock helpers or detached work.
      if (t.stop) {
        if (turnId === t.stop.turnId)
          t.stopCompletion = { turn: p.turn, at: begin };
        return;
      }
      for (const r of t.thinking) if (r.turnId === turnId) r.done = true;
      data = { ...data, ...this.finishTurn(t, turnId, p.turn?.status, begin) };
      if (
        (t.state.kind === "running" || t.state.kind === "interrupting") &&
        t.state.turnId === turnId
      ) {
        t.state = { kind: "idle" };
        this.unwatch(t);
        for (const request of [...t.pending.values()])
          this.settle(
            t,
            request,
            defaults[request.method as ServerMethod],
            "turn-completed",
          );
      }
    }
    if (
      ["thread/deleted", "thread/archived", "thread/closed"].includes(method)
    ) {
      t.loaded = false;
      this.unwatch(t);
    }
    this.emit(t, mappings[method] || "runtime.event", data, turnId, itemId);
    if (t.clock?.first !== null && t.clock)
      t.clock.handler += performance.now() - begin;
  }
  private serverRequest(msg: {
    id: string | number;
    method: string;
    params: any;
  }) {
    const method = msg.method as ServerMethod;
    if (method === "currentTime/read") {
      this.runtime.respond(msg.id, {
        currentTimeAt: Math.floor(Date.now() / 1000),
      });
      return;
    }
    // Helpers never wait on the user; the main agent handles clarifications
    // and documents, so their requests are declined at once.
    const origin = msg.params?.threadId || msg.params?.conversationId;
    if (typeof origin === "string" && this.threads.get(origin)?.stop) {
      if (method === "item/tool/call")
        this.runtime.respond(msg.id, {
          contentItems: [
            { type: "inputText", text: "Conversation is stopping" },
          ],
          success: false,
        });
      else if (Object.hasOwn(defaults, method) && defaults[method] !== null)
        this.runtime.respond(msg.id, defaults[method]);
      else
        this.runtime.respond(msg.id, undefined, {
          code: -32601,
          message: "Conversation is stopping",
        });
      return;
    }
    // A thread that was never started, resumed or forked here is a helper
    // that has not been identified yet.
    if (
      typeof origin === "string" &&
      (this.children.has(origin) || !this.roots.has(origin))
    ) {
      if (method === "item/tool/requestUserInput")
        this.runtime.respond(msg.id, {
          answers: Object.fromEntries(
            (Array.isArray(msg.params.questions) ? msg.params.questions : [])
              .filter((q: any) => typeof q?.id === "string")
              .map((q: any) => [q.id, { answers: [helperQuestionAnswer] }]),
          ),
        });
      else if (method === "item/tool/call")
        this.runtime.respond(msg.id, {
          contentItems: [{ type: "inputText", text: helperToolFailure }],
          success: false,
        });
      else if (Object.hasOwn(defaults, method) && defaults[method] !== null)
        this.runtime.respond(msg.id, defaults[method]);
      else
        this.runtime.respond(msg.id, undefined, {
          code: -32601,
          message: "Helper agents cannot use this capability",
        });
      return;
    }
    if (
      this.runtime instanceof BusinessRuntime &&
      method === "item/tool/call"
    ) {
      const generation = this.generation;
      const t =
        typeof origin === "string" ? this.threads.get(origin) : undefined;
      const turnId = msg.params?.turnId ?? (t ? this.activeTurn(t) : undefined);
      const work = this.runtime
        .executeTool(msg.params)
        .then((result) => {
          if (
            generation === this.generation &&
            !t?.stop &&
            !t?.stoppedTurns.has(turnId)
          ) {
            try {
              this.runtime.respond(msg.id, result);
            } catch (e) {
              log("debug", "tool result not delivered; runtime disconnected", {
                threadId: msg.params?.threadId,
                tool: msg.params?.tool,
                ...errorFields(e),
              });
            }
          }
        })
        .catch((e) =>
          log("error", "tool call failed", {
            threadId: msg.params?.threadId,
            tool: msg.params?.tool,
            ...errorFields(e),
          }),
        );
      t?.localWork.add(work);
      void work.finally(() => t?.localWork.delete(work));
      return;
    }
    if (!Object.hasOwn(defaults, method) || defaults[method] === null) {
      this.runtime.respond(msg.id, undefined, {
        code: -32601,
        message: "Host capability unavailable in profile-based API-key mode",
      });
      return;
    }
    if (
      this.runtime instanceof BusinessRuntime &&
      method !== "item/tool/requestUserInput"
    ) {
      this.runtime.respond(msg.id, defaults[method]);
      return;
    }
    const threadId = msg.params.threadId || msg.params.conversationId;
    if (!threadId) {
      this.runtime.respond(msg.id, undefined, {
        code: -32602,
        message: "Cannot attribute request to a thread",
      });
      return;
    }
    const t = this.thread(threadId),
      requestId = `${this.generation}-${typeof msg.id}-${msg.id}`;
    const pending: Pending = {
      requestId,
      rawId: msg.id,
      method,
      detail: this.redactor.clean(msg.params),
      expiresAt: new Date(Date.now() + this.requestTimeoutMs).toISOString(),
      responseSchema: responseSchema(method),
      timer: setTimeout(() => {
        // An unanswered question proceeds with its recommended option.
        const auto =
          method === "item/tool/requestUserInput"
            ? autoAnswer(pending.detail)
            : null;
        if (auto) this.settle(t, pending, auto, "auto-recommended");
        else this.settle(t, pending, defaults[method], "expired");
      }, this.requestTimeoutMs),
    };
    t.pending.set(requestId, pending);
    this.watch(t);
    // A chat with an approval mode may answer before anyone is asked.
    if (method === "item/tool/requestUserInput" && this.modes.has(t.id)) {
      pending.detail = withChatGrant(pending.detail);
      pending.hidden = true;
      void this.review(t, pending);
      return;
    }
    const { timer, rawId, ...publicRequest } = pending;
    this.emit(
      t,
      "approval.requested",
      publicRequest,
      msg.params.turnId,
      msg.params.itemId,
    );
  }
  // Sets a root conversation's approval mode; absent leaves it unchanged.
  private setMode(id: string, mode: unknown, heuristic: unknown) {
    if (mode === undefined) return;
    const next = parseMode(mode);
    const state = this.modes.get(id);
    if (!state) {
      this.modes.set(id, {
        mode: next,
        heuristic: heuristic === true,
        grants: new Set(),
      });
      return;
    }
    state.mode = next;
    if (heuristic !== undefined && (heuristic === true) !== state.heuristic) {
      state.heuristic = heuristic === true;
      state.tools = undefined;
    }
  }
  setApprovalMode(id: string, mode: unknown) {
    const t = this.thread(id);
    if (this.children.has(id))
      throw new HttpError(409, "Helper agents follow their conversation");
    const next = parseMode(mode);
    const state = this.modes.get(id);
    if (state) state.mode = next;
    else
      this.modes.set(id, { mode: next, heuristic: false, grants: new Set() });
    this.reevaluate(t);
    return { mode: next };
  }
  // Runs the chat's mode again over its waiting questions.
  private reevaluate(t: Thread) {
    if (t.stop) return;
    if (!this.modes.has(t.id)) return;
    for (const p of [...t.pending.values()])
      if (p.method === "item/tool/requestUserInput") void this.review(t, p);
  }
  // Answers a request under the chat's mode, or shows it to the user.
  private async review(t: Thread, p: Pending) {
    const generation = this.generation;
    const run = (p.reviews = (p.reviews ?? 0) + 1);
    let decision: { result: any; reason: string } | null = null;
    try {
      decision = await this.decide(t.id, p.detail);
      if (decision) validateResponse(p.method, decision.result);
    } catch (e) {
      // A failed lookup or an invalid answer never allows anything.
      log("debug", "approval mode decision failed; asking the user", {
        threadId: t.id,
        requestId: p.requestId,
        ...errorFields(e),
      });
      decision = null;
    }
    if (
      t.stop ||
      generation !== this.generation ||
      !t.pending.has(p.requestId) ||
      p.reviews !== run
    )
      return;
    if (decision) this.settle(t, p, decision.result, decision.reason);
    else if (p.hidden) {
      p.hidden = false;
      const { timer, rawId, hidden, reviews, ...publicRequest } = p;
      this.emit(
        t,
        "approval.requested",
        publicRequest,
        typeof p.detail?.turnId === "string" ? p.detail.turnId : undefined,
        typeof p.detail?.itemId === "string" ? p.detail.itemId : undefined,
      );
    }
  }
  // The mode's answer for every question in a request, or null to ask.
  // Plan approval and secret questions always ask; a chat grant allows its
  // tool in any mode. Tools are only ever sent "Allow".
  private async decide(id: string, detail: any) {
    const state = this.modes.get(id);
    if (!state) return null;
    const mode = state.mode;
    const questions: any[] = Array.isArray(detail?.questions)
      ? detail.questions
      : [];
    if (!questions.length) return null;
    const answers: Record<string, { answers: string[] }> = {};
    let granted = true;
    for (const q of questions) {
      if (typeof q?.id !== "string" || q.isSecret === true) return null;
      if (q.id === "plan_approval") return null;
      if (isToolQuestion(q)) {
        const ref = parseToolQuestion(q.question);
        const offered =
          Array.isArray(q.options) &&
          q.options.some((o: any) => o?.label === "Allow");
        if (!ref || !offered) return null;
        answers[q.id] = { answers: ["Allow"] };
        if (state.grants.has(grantKey(ref))) continue;
        granted = false;
        if (mode === "auto") continue;
        if (mode === "readOnly" && (await this.readOnly(id, state, ref)))
          continue;
        return null;
      }
      granted = false;
      const pick = mode === "auto" ? recommendedOption(q) : null;
      if (!pick) return null;
      answers[q.id] = { answers: [pick, AUTO_MODE_NOTE] };
    }
    return {
      result: { answers },
      reason: AUTO_MODE_REASON + (granted ? GRANT : mode),
    };
  }
  // Only readOnlyHint === true (or the opt-in name heuristic) counts; an
  // unknown tool refreshes the inventory once, then asks.
  private async readOnly(id: string, state: ModeState, ref: ToolRef) {
    const hit =
      findTool(await this.toolIndex(id, state, false), ref) ??
      findTool(await this.toolIndex(id, state, true), ref);
    return hit?.readOnly === true;
  }
  private toolIndex(id: string, state: ModeState, refresh: boolean) {
    if (refresh || !state.tools) {
      const load = this.listTools(id, state.heuristic);
      state.tools = load;
      // A failed lookup is retried by the next request.
      load.catch(() => {
        if (state.tools === load) state.tools = undefined;
      });
    }
    return state.tools!;
  }
  private async listTools(id: string, heuristic: boolean) {
    const statuses: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = await this.runtime.request("mcpServerStatus/list", {
        threadId: id,
        detail: "toolsAndAuthOnly",
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result?.data))
        throw new Error("Invalid MCP server status");
      statuses.push(...result.data);
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) break;
    }
    return indexTools(statuses, heuristic);
  }
  // "Allow for this chat": remembers the tool and returns what Codex gets
  // instead ("Allow"), or undefined when the answer grants nothing.
  private grant(t: Thread, p: Pending, result: any) {
    const state = this.modes.get(t.id);
    if (!state || p.method !== "item/tool/requestUserInput") return undefined;
    let wire: any;
    for (const q of Array.isArray(p.detail?.questions)
      ? p.detail.questions
      : []) {
      const values = result?.answers?.[q?.id]?.answers;
      if (!isToolQuestion(q) || !Array.isArray(values)) continue;
      if (!values.includes(ALLOW_FOR_CHAT)) continue;
      const ref = parseToolQuestion(q.question);
      if (!ref) continue;
      state.grants.add(grantKey(ref));
      wire ??= structuredClone(result);
      wire.answers[q.id] = {
        answers: values.map((v: unknown) =>
          v === ALLOW_FOR_CHAT ? "Allow" : v,
        ),
      };
    }
    return wire;
  }
  answer(id: string, requestId: string, result: unknown) {
    if (this.thread(id).stop)
      throw new HttpError(409, "Conversation is stopping", "INTERRUPTING");
    const t = this.thread(id),
      pending = t.pending.get(requestId);
    if (!pending)
      throw new HttpError(
        409,
        "Request is already resolved or belongs to a previous runtime",
        "STALE_REQUEST",
      );
    validateResponse(pending.method, result);
    const wire = this.grant(t, pending, result);
    this.settle(t, pending, result, "user", true, wire);
    // A new grant may cover requests that are still waiting.
    if (wire !== undefined) this.reevaluate(t);
    return { ok: true };
  }
  private settle(
    t: Thread,
    p: Pending,
    result: any,
    reason: string,
    reply = true,
    // Sent to the runtime instead of result, which stays the recorded answer.
    wire?: unknown,
  ) {
    if (!t.pending.has(p.requestId)) return;
    if (reply) {
      try {
        this.runtime.respond(p.rawId, wire === undefined ? result : wire);
      } catch {
        reason = "runtime-unavailable";
      }
    }
    clearTimeout(p.timer);
    t.pending.delete(p.requestId);
    this.watch(t);
    // The question travels with its answer so the decision can be audited.
    this.emit(
      t,
      "approval.resolved",
      {
        requestId: p.requestId,
        method: p.method,
        detail: p.detail,
        result,
        reason,
      },
      typeof p.detail?.turnId === "string" ? p.detail.turnId : undefined,
      typeof p.detail?.itemId === "string" ? p.detail.itemId : undefined,
    );
  }
  records(id: string) {
    this.thread(id);
    const dir = join(this.home, "adapter-records", id);
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .slice(0, 100)
        .map((f) => ({
          key: f,
          event: JSON.parse(readFileSync(join(dir, f), "utf8")),
        }));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
  ack(id: string, keys: string[]) {
    this.thread(id);
    for (const key of keys) {
      if (!/^[\w-]+\.json$/.test(key))
        throw new HttpError(400, "Invalid record key");
      try {
        unlinkSync(join(this.home, "adapter-records", id, key));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  async capability(id: string, method: string, params: any) {
    if (this.thread(id).stop && method !== "thread/goal/get")
      throw new HttpError(409, "Conversation is stopping", "INTERRUPTING");
    if (
      this.runtime instanceof BusinessRuntime &&
      method !== "thread/delete" &&
      !Object.hasOwn(businessCapabilities, method)
    )
      throw new HttpError(
        403,
        "Runtime controls are unavailable",
        "CAPABILITY_DENIED",
      );
    if (
      [
        "initialize",
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
      ].includes(method)
    )
      throw new HttpError(409, "Use the dedicated lifecycle endpoint");
    const entry = inventory.requests.find((x) => x.method === method);
    if (!entry) throw new HttpError(400, "Unknown capability");
    const payload =
      entry.params === "undefined"
        ? undefined
        : method.startsWith("thread/") || method.startsWith("turn/")
          ? { ...params, threadId: id }
          : params;
    validateRequest(method, payload);
    this.redactor.remember(payload);
    return this.serial(id, async () => {
      const t = this.thread(id);
      if (t.stop && method !== "thread/goal/get")
        throw new HttpError(
          409,
          "Stop must be confirmed before continuing",
          "INTERRUPTING",
        );
      if (
        ["thread/delete", "thread/archive", "thread/fork"].includes(method) &&
        t.state.kind !== "idle"
      )
        throw new HttpError(409, "Finish the current turn first");
      if (
        ["thread/archive", "thread/delete"].includes(method) &&
        this.agentsOf(id).some((c) => c.stop)
      )
        throw new HttpError(
          409,
          "Confirm helper Stop before archiving or deleting this conversation",
          "STOP_UNCONFIRMED",
        );
      if (method === "thread/fork") this.reserve();
      let result: any;
      try {
        result = await this.runtime.request(entry.method, payload);
      } finally {
        if (method === "thread/fork") this.reservations--;
      }
      if (method === "thread/fork") {
        const fork = this.thread(result.thread.id);
        this.roots.add(fork.id);
        fork.loaded = true;
        // A fork is built from its source's loaded profile.
        fork.mcpFingerprint = t.mcpFingerprint;
      }
      // Keep snapshots current even if the runtime sends no notification.
      if (method === "thread/goal/get" || method === "thread/goal/set") {
        this.setGoal(t, result?.goal ?? null);
        // Setting an active goal on an idle thread starts a turn; a running
        // turn now works toward the goal.
        if (t.state.kind === "running") this.trackGoalTurn(t, t.state.turnId);
        if (result?.goal) result = { ...result, goal: this.goalView(t) };
      }
      // Lets the platform link the goal change to the running turn.
      if (method.startsWith("thread/goal/") && t.state.kind === "running")
        result = { ...result, turnId: t.state.turnId };
      if (method === "thread/goal/clear") this.setGoal(t, null);
      if (method === "thread/delete" || method === "thread/archive") {
        this.dropAgents(id);
        t.contexts.clear();
      }
      if (method === "thread/delete") this.modes.delete(id);
      if (
        ["thread/archive", "thread/delete", "thread/unsubscribe"].includes(
          method,
        )
      ) {
        t.loaded = false;
        this.unwatch(t);
      }
      return this.redactor.clean(result);
    });
  }
  close() {
    this.draining = true;
    for (const t of this.threads.values()) {
      this.unwatch(t);
      for (const p of t.pending.values()) clearTimeout(p.timer);
      for (const res of t.subscribers) res.end();
    }
  }
}

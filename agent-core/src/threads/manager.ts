import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Response } from "express";
import { businessCapabilities } from "../../../shared/business-capabilities";
import type {
  DomainType,
  RateLimitView,
  Snapshot,
  SubAgent,
  SubAgentTranscript,
  TurnContext,
} from "../../../shared/contracts";
import { errorFields, log } from "../../../shared/logging";
import type { RuntimeReadOptions } from "../../../shared/runtime-read-options";
import {
  runtimeResumeResponse,
  type RuntimeResumeOptions,
} from "../../../shared/runtime-resume-options";
import { BusinessRuntime } from "../runtime/business-runtime";
import type { Runtime } from "../runtime/client";
import { skillSet, tenantId as parseTenant } from "../runtime/tenancy";
import { inventory, validateRequest } from "../protocol/schema";
import { defaults, type ServerMethod } from "../protocol/requests";
import { Redactor } from "../telemetry/redact";
import { rateLimitView } from "../telemetry/trace";
import { HttpError, rpcText } from "../errors";
import { approvalMode as parseMode } from "./approval-policy";
import { ApprovalCoordinator } from "./approvals";
import { HelperRegistry } from "./helpers";
import { ThreadEvents } from "./events";
import { ThreadStream } from "./stream";
import { records, ack } from "./records";
import type { Thread, ModeState, TurnEnd } from "./state";
import { createThread, activeTurn } from "./state";
import { snapshot, operationalSnapshot } from "./snapshots";
import { projectMessages } from "./messages";
import {
  builder,
  finishTurn,
  seeTurn,
  stalePlan,
  setGoal,
  trackGoalTurn,
  goalView,
  goalTokenDelta,
  watch,
  unwatch,
} from "./turn-tracker";
const defaultStallMs = 15 * 60_000;
const notificationDebugFile = join(
  tmpdir(),
  "truex-notification-debug.jsonl",
);
const stalledMessage =
  "The assistant stopped responding, so this response was ended. Check the conversation for a partial answer and send your message again.";
const helperQuestionAnswer =
  "Helper agents cannot ask the user. The main agent handles clarifications; proceed with reasonable assumptions and list open questions in your result.";
const helperToolFailure =
  "Helper agents cannot use conversation documents or workspace files. Return your findings to the main agent, which handles documents and workspace files.";
// The platform's hash of a thread's MCP configuration; opaque here.
function parseFingerprint(value: unknown) {
  if (
    value !== undefined &&
    (typeof value !== "string" || !/^[\w:.-]{1,200}$/.test(value))
  )
    throw new HttpError(400, "Invalid MCP fingerprint");
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
  private readonly events: ThreadEvents;
  private readonly helpers: HelperRegistry;
  private readonly approvals: ApprovalCoordinator;
  private readonly stream: ThreadStream;
  generation = randomUUID();
  readonly redactor = new Redactor();
  readonly threads = new Map<string, Thread>();
  // Conversations started, resumed or forked through this manager.
  private roots = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();
  private reservations = 0;
  // Approval modes per root conversation; see ModeState.
  private readonly modes: Map<string, ModeState>;
  // Latest account rate limits, merged from sparse updates.
  rateLimits: RateLimitView | null = null;
  unknownMethods = 0;
  draining = false;
  constructor(
    readonly runtime: Runtime,
    readonly home: string,
    readonly capacity = 20,
    readonly replayLimit = 500,
    readonly requestTimeoutMs = 120_000,
    readonly stallMs = Number(process.env.TURN_STALL_MS) || defaultStallMs,
  ) {
    mkdirSync(join(home, "adapter-records"), { recursive: true });
    this.events = new ThreadEvents(home, replayLimit, {
      generation: () => this.generation,
      redactor: this.redactor,
      storageFailed: () => {
        this.draining = true;
      },
    });
    this.stream = new ThreadStream({
      generation: () => this.generation,
      snapshot: (id, options) => this.snapshot(id, options),
      operationalSnapshot: (t) => this.operationalSnapshot(t),
    });
    this.helpers = new HelperRegistry({
      runtime,
      threads: this.threads,
      roots: this.roots,
      thread: (id) => this.thread(id),
      emit: (t, type, data, turnId, itemId) =>
        this.emit(t, type, data, turnId, itemId),
      builder: (t, turnId) => this.builder(t, turnId),
      watch: (t) => this.watch(t),
    });
    this.approvals = new ApprovalCoordinator(
      {
        runtime,
        redactor: this.redactor,
        generation: () => this.generation,
        thread: (id) => this.thread(id),
        isHelper: (id) => this.helpers.has(id),
        watch: (t) => this.watch(t),
        emit: (t, type, data, turnId, itemId) =>
          this.emit(t, type, data, turnId, itemId),
      },
      requestTimeoutMs,
    );
    this.modes = this.approvals.modes;
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
          done: turnId ? finishTurn(t, turnId, "failed", now) : {},
        });
      }
      this.generation = randomUUID();
      this.helpers.resetEarly();
      for (const t of this.threads.values()) {
        t.seq = 0;
        t.events = [];
        t.replayBytes = 0;
        for (const p of [...t.pending.values()])
          this.approvals.settle(t, p, undefined, "runtime-exit", false);
        t.loaded = false;
        t.state = { kind: "idle" };
        t.clock = undefined;
        // A new runtime may report different tools.
        const mode = this.modes.get(t.id);
        if (mode) mode.tools = undefined;
        t.trace = undefined;
        for (const c of this.helpers.agentsOf(t.id)) c.turnId = undefined;
        this.unwatch(t);
        const turn = cut.get(t);
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
    const child = this.helpers.get(e.threadId);
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
  private watch(t: Thread) {
    watch(t, this.stallMs, (thread, turnId) => this.stalled(thread, turnId));
  }
  private unwatch(t: Thread) {
    unwatch(t);
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
    this.runtime
      .request("turn/interrupt", { threadId: t.id, turnId })
      .catch((e) =>
        log("debug", "stalled turn interrupt failed", {
          threadId: t.id,
          turnId,
          ...errorFields(e),
        }),
      );
    const done = finishTurn(t, turnId, "failed", performance.now());
    t.state = { kind: "idle" };
    t.stalledTurn = turnId;
    for (const r of t.thinking) if (r.turnId === turnId) r.done = true;
    this.failed(
      t,
      turnId,
      { message: stalledMessage, code: "TURN_STALLED" },
      done,
    );
  }
  private thread(id: string): Thread {
    if (!/^[\w-]+$/.test(id))
      throw new HttpError(400, "Invalid thread identifier");
    let t = this.threads.get(id);
    if (!t) {
      t = createThread(id);
      this.threads.set(id, t);
    }
    return t;
  }
  async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) || Promise.resolve();
    const next = prior.catch(() => { }).then(action);
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
      this.approvals.setMode(t.id, approvalMode, approvalNameHeuristic);
      t.loaded = true;
      t.sourceCovered = true;
      t.mcpFingerprint = mcpFingerprint;
      t.threadStartMs = performance.now() - started;
      return {
        threadId: t.id,
        threadStartMs: t.threadStartMs,
        ...(approvalMode === undefined
          ? {}
          : { approvalMode: parseMode(approvalMode) }),
      };
    } finally {
      this.reservations--;
    }
  }
  async resume(id: string, input: any = {}) {
    // Approval mode fields are Truex settings, not runtime parameters.
    const {
      approvalMode,
      approvalNameHeuristic,
      mcpFingerprint,
      response: requestedResponse,
      ...params
    } = input || {};
    let response: RuntimeResumeOptions["response"];
    try {
      response = runtimeResumeResponse(requestedResponse);
    } catch {
      throw new HttpError(400, "Invalid runtime resume response");
    }
    if (approvalMode !== undefined) parseMode(approvalMode);
    parseFingerprint(mcpFingerprint);
    if (params.tenantId !== undefined) parseTenant(params.tenantId);
    if (params.skills !== undefined) skillSet(params.skills);
    return this.serial(id, async () => {
      const t = this.thread(id);
      this.ownedBy(t, params.tenantId);
      const moded = this.modes.has(id) || approvalMode !== undefined;
      this.approvals.setMode(id, approvalMode, approvalNameHeuristic);
      const confirmed = (snapshot: Snapshot) => ({
        ...snapshot,
        ...(approvalMode === undefined
          ? {}
          : { approvalMode: parseMode(approvalMode) }),
      });
      const snapshot = () =>
        response === "operational"
          ? this.operationalSnapshot(t)
          : this.snapshot(id);
      if (moded) this.approvals.reevaluate(t);
      if (t.loaded) {
        // No fingerprint, or the same one: the loaded config is current.
        if (mcpFingerprint === undefined) return confirmed(snapshot());
        if (mcpFingerprint === t.mcpFingerprint) {
          t.pendingResume = undefined;
          return confirmed(snapshot());
        }
        // The runtime ignores config for a running thread; apply it before
        // the next turn instead. A draining pod starts no new turns, so it
        // keeps serving the loaded thread.
        if (t.state.kind !== "idle" || this.draining) {
          t.pendingResume = { params, mcpFingerprint };
          return confirmed(snapshot());
        }
        await this.unload(t);
      }
      return confirmed(await this.load(t, params, mcpFingerprint, response));
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
  private async load(
    t: Thread,
    params: any,
    mcpFingerprint?: string,
    response?: RuntimeResumeOptions["response"],
  ) {
    const id = t.id;
    // The asynchronous resume response can overlap live notifications. Do not
    // guess how its restored bodies line up with our previously tracked deltas.
    t.sourceCovered = false;
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
        if (typeof turn?.id === "string") seeTurn(t, turn.id);
        for (const item of turn?.items ?? []) this.helpers.collab(id, item);
      }
      const active = result.thread?.turns?.find(
        (turn: any) => turn.status === "inProgress",
      );
      t.state = active
        ? { kind: "running", turnId: active.id }
        : { kind: "idle" };
      this.watch(t);
      // Recover the goal after an agent-core restart; goals are optional.
      try {
        setGoal(
          t,
          (await this.runtime.request("thread/goal/get", { threadId: id }))
            ?.goal ?? null,
        );
      } catch (e) {
        log("debug", "goal recovery failed", {
          threadId: id,
          ...errorFields(e),
        });
        setGoal(t, null);
      }
      return response === "operational"
        ? this.operationalSnapshot(t)
        : this.snapshot(id);
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
        const result = await this.runtime.request("turn/start", {
          threadId: id,
          input,
          clientUserMessageId: clientId,
        });
        if (t.clock) {
          t.clock.accept = performance.now() - t.clock.start;
          t.clock.turnId = result.turn.id;
        }
        seeTurn(t, result.turn.id);
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
  async interrupt(id: string) {
    return this.serial(id, async () => {
      const t = this.thread(id);
      if (t.state.kind === "interrupting") return { ok: true };
      if (t.state.kind !== "running")
        throw new HttpError(409, "No running turn");
      const turnId = t.state.turnId;
      t.state = { kind: "interrupting", turnId };
      this.unwatch(t);
      try {
        await this.runtime.request("turn/interrupt", { threadId: id, turnId });
      } catch (e) {
        if (t.state.kind === "interrupting") {
          t.state = { kind: "running", turnId };
          this.watch(t);
        }
        throw e;
      }
      // Stopping the conversation stops its helpers too.
      await Promise.allSettled(
        this.helpers
          .agentsOf(id)
          .filter((c) => c.turnId)
          .map((c) =>
            this.runtime.request("turn/interrupt", {
              threadId: c.agent.threadId,
              turnId: c.turnId,
            }),
          ),
      );
      return { ok: true };
    });
  }
  snapshot(id: string, options: RuntimeReadOptions = {}): Snapshot {
    const t = this.thread(id);
    return snapshot(t, options, () => this.operationalSnapshot(t));
  }
  private operationalSnapshot(t: Thread): Snapshot {
    return operationalSnapshot(t, this.generation, this.rateLimits, () =>
      this.helpers.agentsOf(t.id),
    );
  }
  agents(id: string): SubAgent[] {
    return this.helpers.agents(id);
  }

  agent(id: string, agentId: string): SubAgentTranscript {
    return this.helpers.agent(id, agentId);
  }

  async interruptAgent(id: string, agentId: string) {
    return this.helpers.interruptAgent(id, agentId);
  }

  subscribe(
    id: string,
    res: Response,
    cursor?: string,
    options: RuntimeReadOptions = {},
  ) {
    console.log("Subscribing the Thread Events:: ", id,cursor,options);
    return this.stream.subscribe(this.thread(id), res, cursor, options);
  }

  private builder(t: Thread, turnId?: string) {
    return builder(t, turnId, this.rateLimits);
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
  private emit(
    t: Thread,
    type: DomainType,
    data: any,
    turnId?: string,
    itemId?: string,
  ) {
    return this.events.emit(t, type, data, turnId, itemId);
  }

  /**
   * Applies a one-way Codex notification received through CodexClient.dispatch().
   * @param method Native event name, e.g. item/agentMessage/delta or turn/completed.
   * @param p Native notification params: thread/turn/item IDs plus event data
   * such as delta text, a completed item, token usage, plan or goal state.
   * @returns No response payload. Updates manager-owned state and emits domain
   * events; ThreadEvents handles replay retention, selected durable records and
   * writes to registered SSE subscribers. No browser connection is required to
   * receive Codex output or update the thread's message projection.
   *
   * Account-wide events and helper events take separate paths below. Root events
   * update the matching thread before publication, so a later snapshot sees the
   * generated text even if it arrived before the first SSE subscription.
   * Debug with method + threadId + turnId + itemId. Check early-return branches
   * when an event is received here but does not reach the root SSE publisher.
   */
  private notification(method: string, p: any) {
    // Measure local handling time and redact the payload used by state/events.
    const begin = performance.now();
    p = this.redactor.clean(p);
    try {
      const entry = JSON.stringify({
        ts: new Date().toISOString(),
        method,
        params: p,
      });
      appendFileSync(
        notificationDebugFile,
        `${entry}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      log("warn", "notification debug file write failed", errorFields(error));
    }
    // A connector's URL path or query can carry a secret, so it is not logged.
    if (method === "mcpServer/startupStatus/updated" && p.status === "failed")
      log("warn", "mcp server failed to start", {
        threadId: p.threadId,
        server: p.name,
        reason: p.failureReason,
        error:
          typeof p.error === "string"
            ? p.error.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 500)
            : undefined,
      });
    // Protocol drift is counted and logged; unknown methods still continue
    // through routing and can be published as the generic runtime.event type.
    if (!inventory.notifications.some((n) => n.method === method)) {
      this.unknownMethods++;
      log("warn", "unknown runtime notification", { method });
    }
    // Codex supplies thread identity either directly or inside a thread object.
    const id = p.threadId || p.thread?.id;
    if (!id) {
      // No thread ID: broadcast to loaded roots. Account rate-limit updates also
      // refresh shared limits, active traces and the derived limits.updated event.
      const limits =
        method === "account/rateLimits/updated" && p.rateLimits
          ? (this.rateLimits = rateLimitView(p.rateLimits, this.rateLimits))
          : null;
      for (const t of this.threads.values())
        if (t.loaded) {
          this.emit(t, mappings[method] || "runtime.event", { method, ...p });
          if (!limits) continue;
          const turnId = activeTurn(t);
          this.builder(t, turnId)?.onRateLimits(limits);
          this.emit(t, "limits.updated", { rateLimits: limits }, turnId);
        }
      return;
    }
    // Helper notifications belong to their root's helper projection, not a new
    // public conversation. Dropped helpers and buffered early events exit here.
    if (typeof id === "string") {
      const helper = this.helpers.get(id);
      if (helper) return this.helpers.childNotification(helper, method, p);
      if (this.helpers.isDropped(id)) return;
      const spawn =
        method === "thread/started" ? this.helpers.spawnSource(p) : undefined;
      console.log("SPAWN SOURCE:: ", spawn);
      if (
        spawn &&
        this.helpers.child(id, spawn.parent_thread_id, {
          path: spawn.agent_path,
          nickname: spawn.agent_nickname ?? p.thread?.agentNickname,
          role: spawn.agent_role ?? p.thread?.agentRole,
          depth: spawn.depth,
        })
      )
        return;
      // A helper can speak before the root's spawn call names it. Hold its
      // events instead of creating a thread record no client observes.
      if (!spawn && this.helpers.holdEarly(id, method, p)) return;
    }
    // Root path: retrieve the shared Thread object also used by subscribe().
    // Resolve IDs from either direct fields or their nested native objects.
    const t = this.thread(id),
      turnId = p.turnId || p.turn?.id,
      itemId = p.itemId || p.item?.id;
    // A start notification can race the RPC acknowledgment. Only move an idle
    // or starting thread into running; also initialize turn ordering and tracing.
    if (method === "thread/started") t.loaded = true;
    if (method === "turn/started") {
      if (t.state.kind === "idle" || t.state.kind === "starting")
        t.state = { kind: "running", turnId };
      if (t.clock) t.clock.turnId = turnId;
      if (turnId) seeTurn(t, turnId);
      this.builder(t, turnId);
    }
    // Any activity on the thread shows the running turn is alive.
    this.watch(t);
    // The watchdog already reported this turn as failed; ignore its late finish
    // rather than publishing a second completion for the same stalled turn.
    if (method === "turn/completed" && turnId && t.stalledTurn === turnId) {
      t.stalledTurn = undefined;
      return;
    }
    // Assistant deltas append to t.messages; completed items replace their text
    // with the final answer and emit message.final. Reasoning is projected too.
    // This runs before the generic event publication at the end of this method.
    p = projectMessages(t, method, p, turnId, itemId, begin, this.events);
    if (method === "turn/plan/updated") {
      // A replayed or late update from an older turn must not replace a newer plan.
      if (turnId && stalePlan(t, turnId)) return;
      t.plan = p.plan;
      t.planTurnId = turnId ?? t.planTurnId;
    }
    // Track which turns contribute to a goal and preserve its observed usage
    // separately from the runtime's reported goal object.
    if (method === "turn/started" && turnId) trackGoalTurn(t, turnId);
    if (method === "thread/goal/updated") {
      setGoal(t, p.goal ?? null);
      if (turnId) trackGoalTurn(t, turnId);
      p = { ...p, goal: goalView(t) };
    }
    if (method === "thread/goal/cleared") {
      // Names the cleared goal, so a replayed clear can't remove a newer one.
      p = { ...p, goalCreatedAt: (t.goal as any)?.createdAt ?? null };
      setGoal(t, null);
    }
    // Usage has its own derived events. Return after processing it so the raw
    // token notification is not also published by the generic event path.
    if (method === "thread/tokenUsage/updated") {
      if (turnId && t.goalTokens.turns.includes(turnId)) {
        const delta = goalTokenDelta(p.tokenUsage?.last);
        if (delta > 0) {
          t.goalTokens.observed += delta;
          this.emit(t, "goal.updated", { goal: goalView(t) }, turnId);
        }
      }
      // Published as the turn's summed usage, never as the raw notification.
      const usage = this.builder(t, turnId)?.onUsage(p.tokenUsage);
      if (usage) this.emit(t, "usage.updated", { usage }, turnId);
      return;
    }
    // Retain the latest diff for snapshots. A runtime-resolved approval is
    // removed locally without sending a second response back to Codex.
    if (method === "turn/diff/updated") t.diff = p.diff;
    if (method === "serverRequest/resolved") {
      const request = [...t.pending.values()].find(
        (x) => String(x.rawId) === String(p.requestId),
      );
      if (request)
        this.approvals.settle(t, request, undefined, "runtime-resolved", false);
    }
    // Tool/item lifecycle contributes helper relationships and trace steps;
    // assistant message text was already handled by projectMessages() above.
    if (method === "item/started" || method === "item/completed") {
      this.helpers.collab(t.id, p.item);
      this.builder(t, turnId)?.onItem(
        method === "item/started" ? "started" : "completed",
        p.item,
        method === "item/started" ? p.startedAtMs : p.completedAtMs,
        { agent: "main", agentThreadId: t.id },
      );
    }
    // Complete reasoning, timings and traces. Only the currently matching turn
    // may make the thread idle, stop its watchdog and settle pending requests.
    let data = { method, ...p };
    if (method === "turn/completed") {
      for (const r of t.thinking) if (r.turnId === turnId) r.done = true;
      data = { ...data, ...finishTurn(t, turnId, p.turn?.status, begin) };
      if (
        (t.state.kind === "running" || t.state.kind === "interrupting") &&
        t.state.turnId === turnId
      ) {
        t.state = { kind: "idle" };
        this.unwatch(t);
        for (const request of [...t.pending.values()])
          this.approvals.settle(
            t,
            request,
            defaults[request.method as ServerMethod],
            "turn-completed",
          );
      }
    }
    // An archived/deleted/closed thread is no longer loaded for execution.
    if (
      ["thread/deleted", "thread/archived", "thread/closed"].includes(method)
    ) {
      t.loaded = false;
      this.unwatch(t);
    }
    // Publish after projecting state: e.g. native item/agentMessage/delta maps
    // to message.delta. ThreadEvents.emit() writes the frame to t.subscribers.
    this.emit(t, mappings[method] || "runtime.event", data, turnId, itemId);
    // Attribute this handler's elapsed time to the live turn's stream metrics.
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
    // A thread that was never started, resumed or forked here is a helper
    // that has not been identified yet.
    if (
      typeof origin === "string" &&
      (this.helpers.has(origin) || !this.roots.has(origin))
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
      void this.runtime
        .executeTool(msg.params)
        .then((result) => {
          if (generation === this.generation) {
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
    this.approvals.request(msg);
  }
  setApprovalMode(id: string, mode: unknown) {
    return this.approvals.setApprovalMode(id, mode);
  }

  answer(id: string, requestId: string, result: unknown) {
    return this.approvals.answer(id, requestId, result);
  }

  records(id: string) {
    this.thread(id);
    return records(this.home, id);
  }

  ack(id: string, keys: string[]) {
    this.thread(id);
    ack(this.home, id, keys);
  }

  async capability(id: string, method: string, params: any) {
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
      if (
        ["thread/delete", "thread/archive", "thread/fork"].includes(method) &&
        t.state.kind !== "idle"
      )
        throw new HttpError(409, "Finish the current turn first");
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
        setGoal(t, result?.goal ?? null);
        // Setting an active goal on an idle thread starts a turn; a running
        // turn now works toward the goal.
        if (t.state.kind === "running") trackGoalTurn(t, t.state.turnId);
        if (result?.goal) result = { ...result, goal: goalView(t) };
      }
      // Lets the platform link the goal change to the running turn.
      if (method.startsWith("thread/goal/") && t.state.kind === "running")
        result = { ...result, turnId: t.state.turnId };
      if (method === "thread/goal/clear") setGoal(t, null);
      if (method === "thread/delete" || method === "thread/archive") {
        this.helpers.dropAgents(id);
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

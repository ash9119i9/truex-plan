import { businessCapabilities } from "../../shared/business-capabilities";
import { BusinessRuntime } from "./business-runtime";
import { Redactor } from "./redact";
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
  Snapshot,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
  TurnState,
  TurnTiming,
} from "../../shared/contracts";
import { HttpError } from "./errors";
import { inventory, validateRequest } from "./schema";
import {
  defaults,
  responseSchema,
  validateResponse,
  ServerMethod,
} from "./requests";
interface Pending extends PendingRequest {
  rawId: string | number;
  timer: NodeJS.Timeout;
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
  plan: unknown;
  // Latest goal reported by the runtime; one goal per conversation.
  goal: unknown;
  // Tokens seen for the current goal. The runtime only charges usage that
  // arrives while a goal is still active, so a goal finished within one model
  // call reports none; this tally counts every call of the goal's turns.
  goalTokens: GoalTokens;
  diff: string;
  timings: TurnTiming[];
  clock?: Clock;
  loaded: boolean;
  threadStartMs: number;
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
const clip = (value: unknown, limit = 2000) =>
  typeof value === "string" && value
    ? value.length > limit
      ? value.slice(0, limit) + "…"
      : value
    : undefined;
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
  unknownMethods = 0;
  draining = false;
  constructor(
    readonly runtime: Runtime,
    readonly home: string,
    readonly capacity = 20,
    readonly replayLimit = 500,
    readonly requestTimeoutMs = 120_000,
  ) {
    mkdirSync(join(home, "adapter-records"), { recursive: true });
    runtime.on("notification", (msg) =>
      this.notification(msg.method, msg.params || {}),
    );
    runtime.on("serverRequest", (msg) => this.serverRequest(msg));
    runtime.on("exit", () => {
      this.generation = randomUUID();
      this.early.clear();
      for (const t of this.threads.values()) {
        t.seq = 0;
        t.events = [];
        for (const p of [...t.pending.values()])
          this.settle(t, p, undefined, "runtime-exit", false);
        t.loaded = false;
        t.state = { kind: "idle" };
        t.clock = undefined;
        for (const c of this.agentsOf(t.id)) c.turnId = undefined;
        this.emit(t, "error", {
          message: "Runtime exited; session can be resumed",
          code: "RUNTIME_UNAVAILABLE",
        });
      }
    });
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
        goal: null,
        goalTokens: { key: null, observed: 0, turns: [] },
        diff: "",
        timings: [],
        loaded: false,
        threadStartMs: 0,
      };
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
    // Truex's helper settings are not a runtime parameter; the business
    // runtime turns them into enforced config.
    const { subAgents, ...start } = params || {};
    validateRequest("thread/start", start);
    this.redactor.remember(start);
    this.reserve();
    const started = performance.now();
    try {
      const result = await this.runtime.request(
        "thread/start",
        subAgents === undefined ? start : { ...start, subAgents },
      );
      const t = this.thread(result.thread.id);
      this.roots.add(t.id);
      t.loaded = true;
      t.threadStartMs = performance.now() - started;
      return { threadId: t.id, threadStartMs: t.threadStartMs };
    } finally {
      this.reservations--;
    }
  }
  async resume(id: string, params: any = {}) {
    return this.serial(id, async () => {
      const t = this.thread(id);
      if (t.loaded) return this.snapshot(id);
      this.reserve();
      try {
        this.redactor.remember(params);
        const result = await this.runtime.request("thread/resume", {
          ...params,
          threadId: id,
        });
        t.loaded = true;
        this.roots.add(id);
        // Rebuild helper agents from the restored history.
        for (const turn of result.thread?.turns ?? [])
          for (const item of turn?.items ?? []) this.collab(id, item);
        const active = result.thread.turns?.find(
          (turn: any) => turn.status === "inProgress",
        );
        t.state = active
          ? { kind: "running", turnId: active.id }
          : { kind: "idle" };
        // Recover the goal after an agent-core restart; goals are optional.
        try {
          this.setGoal(
            t,
            (await this.runtime.request("thread/goal/get", { threadId: id }))
              ?.goal ?? null,
          );
        } catch {
          this.setGoal(t, null);
        }
        return this.snapshot(id);
      } catch (e) {
        if (
          e instanceof Error &&
          /thread.*(not found|does not exist)|no rollout found|unable to find.*thread/i.test(
            e.message,
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
    });
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
      t.state = { kind: "starting" };
      t.diff = "";
      t.plan = null;
      t.clock = {
        start: performance.now(),
        accept: null,
        first: null,
        last: null,
        count: 0,
        gap: 0,
        handler: 0,
      };
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
        // A complete notification can arrive before the response; do not revive that turn.
        if (t.state.kind === "starting")
          t.state = { kind: "running", turnId: result.turn.id };
        return { turnId: result.turn.id, steer: false };
      } catch (e) {
        if (e instanceof HttpError && e.code === "RPC_TIMEOUT") {
          t.loaded = false;
        }
        if (t.state.kind === "starting") t.state = { kind: "idle" };
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
      try {
        await this.runtime.request("turn/interrupt", { threadId: id, turnId });
      } catch (e) {
        if (t.state.kind === "interrupting")
          t.state = { kind: "running", turnId };
        throw e;
      }
      // Stopping the conversation stops its helpers too.
      await Promise.allSettled(
        this.agentsOf(id)
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
  snapshot(id: string): Snapshot {
    const t = this.thread(id);
    return {
      cursor: `${this.generation}:${t.seq}`,
      state: t.state,
      pending: [...t.pending.values()].map(({ timer, rawId, ...p }) => p),
      messages: t.messages,
      thinking: t.thinking,
      plan: t.plan,
      goal: this.goalView(t),
      diff: t.diff,
      timings: t.timings,
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
  async interruptAgent(id: string, agentId: string) {
    const c = this.owned(id, agentId);
    if (!c.turnId)
      throw new HttpError(409, "Helper agent is not running", "AGENT_IDLE");
    await this.runtime.request("turn/interrupt", {
      threadId: c.agent.threadId,
      turnId: c.turnId,
    });
    // Codex treats an interrupted helper as resumable, so the main agent's
    // wait would keep waiting on it. Shutting it down gives wait a final
    // status and the main agent carries on without it.
    await this.runtime
      .request("thread/archive", { threadId: c.agent.threadId })
      .catch((e) =>
        process.stderr.write(
          `Helper shutdown after stop failed: ${(e as Error).message}\n`,
        ),
      );
    return { ok: true };
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
        this.runtime.request("thread/read", { threadId: id, includeTurns: false }),
      )
      .then((result: any) => {
        if (this.children.get(id) !== c) return;
        this.update(c, {
          nickname: clip(result?.thread?.agentNickname, 80),
          role: clip(result?.thread?.agentRole, 80),
        });
      })
      .catch(() => {});
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
      case "item/started":
      case "item/completed":
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
    const spawning = [...this.roots].some(
      (r) => this.threads.get(r)?.state.kind === "running",
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
    if (durable) {
      const dir = join(this.home, "adapter-records", t.id);
      mkdirSync(dir, { recursive: true });
      const file = join(
        dir,
        `${this.generation}-${String(event.seq).padStart(12, "0")}.json`,
      );
      try {
        writeFileSync(file + ".tmp", JSON.stringify(event));
        renameSync(file + ".tmp", file);
      } catch {
        this.draining = true;
        process.stderr.write(
          "Durable record write failed; stopping admission\n",
        );
        for (const sub of t.subscribers) sub.destroy();
      }
    }
    t.events.push(event);
    if (t.events.length > this.replayLimit) t.events.shift();
    for (const sub of t.subscribers)
      if (!send(sub, this.frame(event))) sub.destroy();
    return event;
  }
  private notification(method: string, p: any) {
    const begin = performance.now();
    p = this.redactor.clean(p);
    if (!inventory.notifications.some((n) => n.method === method)) {
      this.unknownMethods++;
      process.stderr.write(`Unknown runtime notification: ${method}\n`);
    }
    const id = p.threadId || p.thread?.id;
    if (!id) {
      for (const t of this.threads.values())
        if (t.loaded)
          this.emit(t, mappings[method] || "runtime.event", { method, ...p });
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
    if (method === "thread/started") t.loaded = true;
    if (method === "turn/started") {
      if (t.state.kind === "idle" || t.state.kind === "starting")
        t.state = { kind: "running", turnId };
      if (t.clock) t.clock.turnId = turnId;
    }
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
    if (method === "turn/plan/updated") t.plan = p.plan;
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
      // Raw usage is internal; only the goal tally is published.
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
    if (method === "item/started" || method === "item/completed")
      this.collab(t.id, p.item);
    let data = { method, ...p };
    if (method === "turn/completed") {
      for (const r of t.thinking) if (r.turnId === turnId) r.done = true;
      if (t.clock && t.clock.turnId === turnId) {
        const c = t.clock,
          total = begin - c.start,
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
          finalizeMs: c.last === null ? total : begin - c.last,
          totalMs: total,
          deltaCount: c.count,
          nonStreaming: c.count === 0,
          status: p.turn.status,
        };
        t.timings.push(timing);
        if (t.timings.length > 100) t.timings.shift();
        data = { ...data, timing };
        t.clock = undefined;
      }
      if (
        (t.state.kind === "running" || t.state.kind === "interrupting") &&
        t.state.turnId === turnId
      ) {
        t.state = { kind: "idle" };
        for (const request of [...t.pending.values()])
          this.settle(
            t,
            request,
            defaults[request.method as ServerMethod],
            "turn-completed",
          );
      }
    }
    if (["thread/deleted", "thread/archived", "thread/closed"].includes(method))
      t.loaded = false;
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
      void this.runtime.executeTool(msg.params).then((result) => {
        if (generation === this.generation) {
          try {
            this.runtime.respond(msg.id, result);
          } catch {
            /* Runtime disconnected. */
          }
        }
      });
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
      timer: setTimeout(
        () => this.settle(t, pending, defaults[method], "expired"),
        this.requestTimeoutMs,
      ),
    };
    t.pending.set(requestId, pending);
    const { timer, rawId, ...publicRequest } = pending;
    this.emit(
      t,
      "approval.requested",
      publicRequest,
      msg.params.turnId,
      msg.params.itemId,
    );
  }
  answer(id: string, requestId: string, result: unknown) {
    const t = this.thread(id),
      pending = t.pending.get(requestId);
    if (!pending)
      throw new HttpError(
        409,
        "Request is already resolved or belongs to a previous runtime",
        "STALE_REQUEST",
      );
    validateResponse(pending.method, result);
    this.settle(t, pending, result, "user");
    return { ok: true };
  }
  private settle(
    t: Thread,
    p: Pending,
    result: any,
    reason: string,
    reply = true,
  ) {
    if (!t.pending.has(p.requestId)) return;
    if (reply) {
      try {
        this.runtime.respond(p.rawId, result);
      } catch {
        reason = "runtime-unavailable";
      }
    }
    clearTimeout(p.timer);
    t.pending.delete(p.requestId);
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
      if (method === "thread/delete" || method === "thread/archive")
        this.dropAgents(id);
      if (
        ["thread/archive", "thread/delete", "thread/unsubscribe"].includes(
          method,
        )
      )
        t.loaded = false;
      return this.redactor.clean(result);
    });
  }
  close() {
    this.draining = true;
    for (const t of this.threads.values()) {
      for (const p of t.pending.values()) clearTimeout(p.timer);
      for (const res of t.subscribers) res.end();
    }
  }
}

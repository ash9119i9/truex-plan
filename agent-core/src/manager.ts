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
  PendingRequest,
  Snapshot,
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
  diff: string;
  timings: TurnTiming[];
  clock?: Clock;
  loaded: boolean;
  threadStartMs: number;
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
  error: "error",
};
export class ThreadManager {
  generation = randomUUID();
  readonly redactor = new Redactor();
  readonly threads = new Map<string, Thread>();
  private locks = new Map<string, Promise<unknown>>();
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
      for (const t of this.threads.values()) {
        t.seq = 0;
        t.events = [];
        for (const p of [...t.pending.values()])
          this.settle(t, p, undefined, "runtime-exit", false);
        t.loaded = false;
        t.state = { kind: "idle" };
        t.clock = undefined;
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
  async create(params: any) {
    validateRequest("thread/start", params);
    this.redactor.remember(params);
    this.reserve();
    const started = performance.now();
    try {
      const result = await this.runtime.request("thread/start", params);
      const t = this.thread(result.thread.id);
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
        const active = result.thread.turns?.find(
          (turn: any) => turn.status === "inProgress",
        );
        t.state = active
          ? { kind: "running", turnId: active.id }
          : { kind: "idle" };
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
      diff: t.diff,
      timings: t.timings,
    };
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
          if (!res.write(this.frame(e))) {
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
      !res.write(
        `id: ${snapshot.cursor}\ndata: ${JSON.stringify(snapshot)}\n\n`,
      )
    ) {
      res.destroy();
      return;
    }
    t.subscribers.add(res);
    const timer = setInterval(() => {
      if (!res.write(": heartbeat\n\n")) res.destroy();
    }, 15_000);
    res.on("close", () => {
      clearInterval(timer);
      t.subscribers.delete(res);
    });
  }
  private frame(event: DomainEvent) {
    return `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`;
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
    if (
      ["message.final", "turn.completed", "approval.resolved"].includes(type)
    ) {
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
      if (!sub.write(this.frame(event))) sub.destroy();
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
    if (method === "turn/diff/updated") t.diff = p.diff;
    if (method === "serverRequest/resolved") {
      const request = [...t.pending.values()].find(
        (x) => String(x.rawId) === String(p.requestId),
      );
      if (request)
        this.settle(t, request, undefined, "runtime-resolved", false);
    }
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
    this.emit(t, "approval.resolved", {
      requestId: p.requestId,
      method: p.method,
      result,
      reason,
    });
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
        fork.loaded = true;
      }
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

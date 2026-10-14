import { BusinessRuntime } from "../runtime/business-runtime";
import type { Runtime } from "../runtime/client";
import { HttpError } from "../errors";
import type { TraceBuilder } from "../telemetry/trace";
import { errorFields, log } from "../../../shared/logging";
import type {
  DomainType,
  DomainEvent,
  SubAgent,
  SubAgentStatus,
  SubAgentTranscript,
  CollabTool,
} from "../../../shared/contracts";
import type { Thread, Child } from "./state";
import { activeTurn } from "./state";
interface HelperContext {
  runtime: Runtime;
  threads: Map<string, Thread>;
  roots: Set<string>;
  thread(id: string): Thread;
  emit(
    t: Thread,
    type: DomainType,
    data: any,
    turnId?: string,
    itemId?: string,
  ): DomainEvent;
  builder(t: Thread, turnId?: string): TraceBuilder | undefined;
  watch(t: Thread): void;
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
export class HelperRegistry {
  // Helper agent thread id -> its record under the root conversation.
  private children = new Map<string, Child>();
  // Events from threads not yet identified as helpers, replayed on spawn.
  private early = new Map<string, { method: string; p: any }[]>();
  // Helpers of deleted or archived conversations; ignore their late notices.
  private dropped = new Set<string>();
  constructor(private readonly context: HelperContext) {}
  get(id: string) {
    return this.children.get(id);
  }
  has(id: string) {
    return this.children.has(id);
  }
  isDropped(id: string) {
    return this.dropped.has(id);
  }
  resetEarly() {
    this.early.clear();
  }

  agents(id: string): SubAgent[] {
    this.context.thread(id);
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
    await this.context.runtime.request("turn/interrupt", {
      threadId: c.agent.threadId,
      turnId: c.turnId,
    });
    // Codex treats an interrupted helper as resumable, so the main agent's
    // wait would keep waiting on it. Shutting it down gives wait a final
    // status and the main agent carries on without it.
    await this.context.runtime
      .request("thread/archive", { threadId: c.agent.threadId })
      .catch((e) =>
        log("warn", "helper shutdown after stop failed", {
          threadId: id,
          helperThreadId: c.agent.threadId,
          ...errorFields(e),
        }),
      );
    return { ok: true };
  }

  private owned(id: string, agentId: string) {
    this.context.thread(id);
    const c = /^[\w-]+$/.test(agentId) ? this.children.get(agentId) : undefined;
    if (!c || c.rootId !== id)
      throw new HttpError(404, "Helper agent not found", "AGENT_NOT_FOUND");
    return c;
  }

  agentsOf(rootId: string) {
    return [...this.children.values()].filter((c) => c.rootId === rootId);
  }

  spawnSource(p: any) {
    const source = p.thread?.source?.subagent?.thread_spawn;
    return typeof source?.parent_thread_id === "string" ? source : null;
  }

  // Registers a helper under its root conversation the first time it is seen.
  child(
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
    const root = this.context.threads.get(rootId);
    if (!root || rootId === childId) return null;
    // An early helper event may have created a record no client observes.
    const stray = this.context.threads.get(childId);
    if (stray && stray.subscribers.size === 0)
      this.context.threads.delete(childId);
    const parent = this.children.get(parentId);
    const c: Child = {
      rootId,
      parentId,
      turnId: stray ? activeTurn(stray) : undefined,
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
    if (this.context.runtime instanceof BusinessRuntime)
      this.context.runtime.helpers.add(childId);
    this.context.emit(
      root,
      "subagent.spawned",
      { agent: { ...c.agent }, ...extra },
      activeTurn(root),
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
        this.context.runtime.request("thread/read", {
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
    const root = this.context.threads.get(c.rootId);
    if (root)
      this.context.emit(
        root,
        finished ? "subagent.completed" : "subagent.status",
        { agent: { ...c.agent }, ...extra },
        activeTurn(root),
      );
  }

  // Collab items name helpers before, or instead of, their thread/started.
  collab(parentId: string, item: any) {
    if (item?.type === "collabAgentToolCall") {
      const extra = { tool: item.tool, callStatus: item.status };
      const sender =
        typeof item.senderThreadId === "string" &&
        (this.context.threads.has(item.senderThreadId) ||
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
  childNotification(c: Child, method: string, p: any) {
    const root = this.context.threads.get(c.rootId);
    if (!root) return;
    // A helper working for the running turn keeps that turn alive.
    this.context.watch(root);
    const a = c.agent,
      turnId = p.turnId || p.turn?.id,
      itemId = p.itemId || p.item?.id;
    const event = (kind: string, data: Record<string, unknown> = {}) =>
      this.context.emit(
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
        activeTurn(root),
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
    const trace = () => this.context.builder(root, activeTurn(root));
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
  holdEarly(id: string, method: string, p: any) {
    if (this.context.threads.has(id) || this.context.roots.has(id))
      return false;
    const spawning = [...this.context.roots].some(
      (r) => this.context.threads.get(r)?.state.kind === "running",
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

  dropAgents(rootId: string) {
    for (const c of this.agentsOf(rootId)) {
      this.children.delete(c.agent.threadId);
      this.dropped.add(c.agent.threadId);
      if (this.dropped.size > droppedLimit)
        this.dropped.delete(this.dropped.values().next().value!);
      if (this.context.runtime instanceof BusinessRuntime)
        this.context.runtime.helpers.delete(c.agent.threadId);
    }
  }
}

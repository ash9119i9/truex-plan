import type { RunError } from "../errors";
import { blockKey, type NetworkBlock } from "../codex/network";
import {
  MAX_COMMAND_OUTPUT,
  type FileChange,
  type PreviewUpdate,
} from "../codex/activity";

// One run = one user message and the turn that answers it. The run keeps a
// bounded buffer of numbered events plus the full text of each item, so a
// reconnecting caller either replays from its cursor or receives a snapshot.
// Memory per run is bounded by the answer's size, not its token count.

export type RunStatus =
  "starting" | "running" | "stopping" | "completed" | "stopped" | "failed";

// Whether Codex received the turn: "none" means nothing ran and resending is
// safe; "unknown" means a request went out and its answer was lost.
export type Delivery = "none" | "accepted" | "unknown";

export interface RunEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface Subscriber {
  readonly send: (event: RunEvent) => void;
  readonly end: () => void;
}

// An ordered entry of what Codex produced during the turn. A reply holds one
// assistant message; an input marks where a steer entered the turn; a tool is
// one MCP tool call. The run's own first input is not recorded, so the list is
// the steered conversation.
export type RunItem =
  | { type: "reply"; itemId: string; text: string; completed: boolean }
  | { type: "input"; clientMessageId: string }
  | {
      type: "tool";
      itemId: string;
      connector: string;
      tool: string;
      status: "inProgress" | "completed" | "failed";
      durationMs?: number;
      errorCode?: ToolErrorCode;
      approval?: ApprovalDecision;
    }
  | CommandItem
  | FileChangeItem
  | { type: "skill"; slug: string }
  | NetworkItem;

// A sandbox request the network proxy refused (codex/network.ts
// `classifyBlock`): one per site and method in a run. The member's answer
// goes to the platform and applies from the next reply.
export type NetworkItem = { type: "network" } & NetworkBlock;

// A helper agent the lead started. Kept apart from `items` on purpose: the
// platform reads an unknown item with `itemId` and `text` as a reply, and a
// helper's result is never the lead's reply.
export interface AgentState {
  readonly agentId: string;
  readonly path: string;
  status: "running" | "completed" | "failed" | "stopped";
  preview?: string;
  result?: string;
  usage?: Record<string, number>;
}

// Live previews per helper; its result and status always get through.
const MAX_AGENT_ACTIVITY = 50;

// A command Codex ran (or was asked to) in the chat's sandbox. `command` is
// what the approval card showed; `output` is capped (Codex keeps the rest).
export interface CommandItem {
  type: "command";
  itemId: string;
  command: string;
  status: ActivityStatus;
  exitCode?: number;
  durationMs?: number;
  output: string;
  outputTruncated: boolean;
  approval?: ApprovalDecision;
}

// One apply_patch: the files it touches, relative to the workspace.
export interface FileChangeItem {
  type: "file_change";
  itemId: string;
  files: FileChange[];
  status: ActivityStatus;
  approval?: ApprovalDecision;
}

// declined: the member denied it (or its approval expired or was cancelled),
// so it never ran.
export type ActivityStatus = "inProgress" | "completed" | "failed" | "declined";

// Why a tool call ended `failed`. Never carries provider error text. DENIED:
// its approval was denied, expired or cancelled, so the server was never
// called.
export type ToolErrorCode =
  "REFUSED" | "DENIED" | "TOOL_ERROR" | "TIMEOUT" | "UNKNOWN";

// How a tool approval ended. `allow`, `allow_for_chat` and `deny` are the
// member's answers (or, with `auto`, a standing allow for this chat);
// `expired` and `cancelled` decline it without one.
export type ApprovalDecision =
  "allow" | "allow_for_chat" | "deny" | "expired" | "cancelled";

// One argument as shown on the approval card. Model-written, so untrusted:
// bounded here and rendered as plain text.
export interface ApprovalParam {
  readonly name: string;
  readonly value: string;
}

// mcp: a connector tool call. command / file_change: the coding profile's
// sandboxed command or apply_patch; their connector is "workspace" and tool
// "command", "push" or "file_change".
export type ApprovalKind = "mcp" | "command" | "file_change";

export interface PendingApproval {
  readonly approvalId: string;
  readonly itemId: string;
  readonly kind: ApprovalKind;
  readonly connector: string;
  readonly tool: string;
  readonly params: readonly ApprovalParam[];
  // False when the card must not offer Allow for this chat (push).
  readonly allowForChat: boolean;
  // What Allow for this chat stores, when it is not the connector and tool:
  // a command's hash (that same command only) or "file_change" (every edit).
  readonly scope?: string;
  // file_change only: the changes as a diff, cut at a bound.
  readonly diff?: string;
  readonly diffTruncated?: boolean;
  readonly expiresAt: number;
}

interface ToolState {
  connector: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  durationMs?: number;
  errorCode?: ToolErrorCode;
  approval?: ApprovalDecision;
  // Index in `order`, assigned when the call starts.
  placedAt: number;
}

interface ReplyState {
  text: string;
  completed: boolean;
  // Index in `order`, or undefined until the reply has its first text and is
  // placed. Empty replies are never placed, so they never appear.
  placedAt: number | undefined;
}

export interface Timings {
  receivedAt: number;
  dispatchedAt?: number;
  firstTextAt?: number;
  completedAt?: number;
}

export function isFinished(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

export class Run {
  status: RunStatus = "starting";
  delivery: Delivery = "none";
  threadId: string | null = null;
  turnId: string | null = null;
  resumed = false;
  stopRequested = false;
  finishedAt: number | undefined;
  readonly timings: Timings = { receivedAt: Date.now() };

  private seq = 0;
  private readonly events: RunEvent[] = [];
  private readonly replies = new Map<string, ReplyState>();
  // MCP tool calls by item id, so a started call can be updated on completion
  // in place (snapshots show an unfinished call as `inProgress`).
  private readonly tools = new Map<string, ToolState>();
  // Commands and file changes by item id, updated in place like tool calls.
  private readonly activities = new Map<string, CommandItem | FileChangeItem>();
  // Replies and inputs in the order Codex produced them. Replies appear only
  // once they have text (empty ones never do); every steer input appears.
  private readonly order: RunItem[] = [];
  // Steer inputs already recorded, so a repeated userMessage/completed for one
  // is placed once.
  private readonly recordedInputs = new Set<string>();
  // Skills the model has opened this run, each recorded once.
  private readonly usedSkills = new Set<string>();
  // blockKey of each network.blocked already recorded.
  private readonly blocked = new Set<string>();
  // Blocks seen before the command they belong to ended. The proxy's log
  // line can arrive before Codex reports the command started, so a block is
  // placed after the next command that ends (or when the run ends), never
  // above the command that caused it.
  private readonly heldBlocks: NetworkItem[] = [];
  // Approvals waiting for the member, by approvalId, in request order.
  private readonly pending = new Map<string, PendingApproval>();
  // Helper agents by id, in start order, and their preview counts.
  private readonly agents = new Map<string, AgentState>();
  private readonly agentPreviews = new Map<string, number>();
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    readonly runId: string,
    readonly tenantId: string,
    readonly chatId: string,
    readonly requestHash: string,
    private readonly bufferLimit: number,
    // The run's own first input; its userMessage item is never listed.
    readonly inputClientMessageId: string | null = null,
  ) {}

  get lastSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  emit(type: string, data: Record<string, unknown>): void {
    if (this.finishedAt !== undefined) return;
    const event = { seq: ++this.seq, type, data };
    this.events.push(event);
    if (this.events.length > this.bufferLimit) this.events.shift();
    for (const subscriber of this.subscribers) subscriber.send(event);
  }

  appendText(itemId: string, delta: string): void {
    const reply = this.reply(itemId);
    if (reply.completed) return;
    reply.text += delta;
    this.place(itemId, reply);
    this.timings.firstTextAt ??= Date.now();
    this.emit("text.delta", { itemId, delta });
  }

  completeItem(itemId: string, text: string): void {
    const reply = this.reply(itemId);
    if (reply.completed) return;
    reply.text = text;
    reply.completed = true;
    this.place(itemId, reply);
    this.timings.firstTextAt ??= Date.now();
    this.emit("item.completed", { itemId, text });
  }

  // A steer entered the turn: Codex's userMessage item for it completed. The
  // run's own input is never listed; every steer is recorded once, in stream
  // order, and emits `input.accepted`. A reply still streaming at this point
  // was cut off by the steer and never gets `item.completed`.
  recordInput(clientMessageId: string): void {
    if (
      clientMessageId === this.inputClientMessageId ||
      this.recordedInputs.has(clientMessageId)
    )
      return;
    this.recordedInputs.add(clientMessageId);
    this.order.push({ type: "input", clientMessageId });
    this.emit("input.accepted", { clientMessageId });
  }

  // The model opened one of the chat's skills (`skills.read`). Recorded once
  // per run, in stream order. The slug is one the platform sent, never text
  // the model wrote.
  useSkill(slug: string): void {
    if (this.finishedAt !== undefined || this.usedSkills.has(slug)) return;
    this.usedSkills.add(slug);
    this.order.push({ type: "skill", slug });
    this.emit("skill.used", { slug });
  }

  // A helper started. Its path is the lead's task name, e.g. "/root/deals".
  startAgent(agentId: string, path: string): void {
    if (this.finishedAt !== undefined || this.agents.has(agentId)) return;
    this.agents.set(agentId, { agentId, path, status: "running" });
    this.emit("agent.started", { agentId, path });
  }

  // A helper is working: running again after a follow-up, or a new preview.
  // Repeats are dropped and previews are capped per helper.
  agentActivity(agentId: string, preview?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || this.finishedAt !== undefined) return;
    const resumed = agent.status !== "running";
    const fresh = preview !== undefined && preview !== agent.preview;
    if (!resumed && !fresh) return;
    const shown = this.agentPreviews.get(agentId) ?? 0;
    if (!resumed && shown >= MAX_AGENT_ACTIVITY) return;
    agent.status = "running";
    if (fresh) {
      agent.preview = preview;
      this.agentPreviews.set(agentId, shown + 1);
    }
    this.emit("agent.activity", {
      agentId,
      status: "running",
      ...(fresh ? { preview } : {}),
    });
  }

  // A helper's turn ended. Sent again if a follow-up runs it once more.
  completeAgent(
    agentId: string,
    status: "completed" | "failed" | "stopped",
    result: string | undefined,
    usage: Record<string, number> | null,
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent || this.finishedAt !== undefined) return;
    agent.status = status;
    if (result !== undefined) agent.result = result;
    if (usage) agent.usage = { ...usage };
    this.emit("agent.completed", {
      agentId,
      status,
      ...(agent.result !== undefined ? { result: agent.result } : {}),
      ...(agent.usage ? { usage: { ...agent.usage } } : {}),
    });
  }

  agentList(): AgentState[] {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  // Present only when a helper ran, so runs without helpers are unchanged.
  private agentField(): { agents?: AgentState[] } {
    return this.agents.size > 0 ? { agents: this.agentList() } : {};
  }

  // A sandbox request was refused. Recorded once per site and method (a
  // command often retries); returns false for a repeat.
  networkBlocked(block: NetworkBlock): boolean {
    if (this.finishedAt !== undefined) return false;
    const key = blockKey(block);
    if (this.blocked.has(key)) return false;
    this.blocked.add(key);
    this.heldBlocks.push({ type: "network", ...block });
    return true;
  }

  private placeBlocks(): void {
    for (const item of this.heldBlocks.splice(0)) {
      this.order.push(item);
      const { type: _type, ...block } = item;
      this.emit("network.blocked", block);
    }
  }

  // An MCP tool call started. Placed in stream order so snapshots carry it with
  // status `inProgress` until it completes. A repeated start for the same id
  // (Codex can re-emit `item/started`) is ignored. Arguments are never kept.
  startTool(itemId: string, connector: string, tool: string): void {
    if (this.tools.has(itemId)) return;
    const state: ToolState = {
      connector,
      tool,
      status: "inProgress",
      placedAt: this.order.length,
    };
    this.tools.set(itemId, state);
    this.order.push({
      type: "tool",
      itemId,
      connector,
      tool,
      status: "inProgress",
    });
    this.emit("tool.started", { itemId, connector, tool });
  }

  // An MCP tool call finished. Completes the started entry in place, or, if the
  // start was missed, records it now so the call is never dropped. The result
  // text is never kept or emitted.
  completeTool(
    itemId: string,
    connector: string,
    tool: string,
    status: "completed" | "failed",
    durationMs: number,
    errorCode?: ToolErrorCode,
  ): void {
    let state = this.tools.get(itemId);
    if (!state) {
      state = {
        connector,
        tool,
        status: "inProgress",
        placedAt: this.order.length,
      };
      this.tools.set(itemId, state);
      this.order.push({
        type: "tool",
        itemId,
        connector,
        tool,
        status: "inProgress",
      });
    } else if (state.status !== "inProgress") {
      return; // already completed
    }
    state.status = status;
    state.durationMs = durationMs;
    state.errorCode = errorCode;
    this.emit("tool.completed", {
      itemId,
      connector,
      tool,
      status,
      durationMs,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  // A tool call is waiting for the member's approval. The card shows the
  // connector, tool and the call's displayed arguments.
  requestApproval(approval: PendingApproval): void {
    this.pending.set(approval.approvalId, approval);
    this.emit("approval.requested", { ...approval });
  }

  // An approval ended. `auto` marks one answered by a standing allow for
  // this chat (no card was shown). Recorded on the tool call it belongs to.
  resolveApproval(
    approval: Omit<PendingApproval, "expiresAt" | "diff" | "diffTruncated">,
    decision: ApprovalDecision,
    auto: boolean,
  ): void {
    this.pending.delete(approval.approvalId);
    const state =
      approval.kind === "mcp"
        ? this.tools.get(approval.itemId)
        : this.activities.get(approval.itemId);
    if (state) state.approval = decision;
    this.emit("approval.resolved", {
      approvalId: approval.approvalId,
      itemId: approval.itemId,
      kind: approval.kind,
      connector: approval.connector,
      tool: approval.tool,
      params: approval.params,
      ...(approval.scope ? { scope: approval.scope } : {}),
      decision,
      auto,
    });
  }

  get pendingApprovals(): PendingApproval[] {
    return [...this.pending.values()];
  }

  // Number of tool calls still in flight. The chat's watchdog uses this to
  // decide when to restore the ordinary silence timer.
  get inFlightToolCount(): number {
    let count = 0;
    for (const state of this.tools.values())
      if (state.status === "inProgress") count++;
    return count;
  }

  // A sandboxed command started. Placed in stream order like a tool call; a
  // repeated start is ignored.
  startCommand(itemId: string, command: string): void {
    if (this.activities.has(itemId)) return;
    const item: CommandItem = {
      type: "command",
      itemId,
      command,
      status: "inProgress",
      output: "",
      outputTruncated: false,
    };
    this.activities.set(itemId, item);
    this.order.push(item);
    this.emit("command.started", { itemId, command });
  }

  // Live command output, kept and forwarded up to MAX_COMMAND_OUTPUT.
  appendOutput(itemId: string, delta: string): void {
    const item = this.activities.get(itemId);
    if (item?.type !== "command" || item.outputTruncated || !delta) return;
    const room = MAX_COMMAND_OUTPUT - item.output.length;
    const chunk = delta.length > room ? delta.slice(0, room) : delta;
    item.output += chunk;
    if (delta.length > room) item.outputTruncated = true;
    this.emit("command.output", {
      itemId,
      delta: chunk,
      ...(item.outputTruncated ? { truncated: true } : {}),
    });
  }

  completeCommand(
    itemId: string,
    command: string,
    status: Exclude<ActivityStatus, "inProgress">,
    exitCode: number | undefined,
    durationMs: number | undefined,
    output: string | undefined,
  ): void {
    if (!this.activities.has(itemId)) this.startCommand(itemId, command);
    const item = this.activities.get(itemId)!;
    if (item.type !== "command" || item.status !== "inProgress") return;
    item.status = status;
    if (exitCode !== undefined) item.exitCode = exitCode;
    if (durationMs !== undefined) item.durationMs = durationMs;
    // The final aggregate replaces the streamed text when nothing streamed.
    if (output && !item.output) {
      item.output = output.slice(0, MAX_COMMAND_OUTPUT);
      item.outputTruncated = output.length > MAX_COMMAND_OUTPUT;
    }
    this.emit("command.completed", {
      itemId,
      command: item.command,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(item.approval ? { approval: item.approval } : {}),
    });
    this.placeBlocks();
  }

  // A file change the model is still writing (apply_patch streaming). Not an
  // ordered item: it is never listed in snapshots or the completed run, and
  // it stops once Codex starts the file change itself (or `ended` when the
  // call never became one).
  fileChangeProgress(
    itemId: string,
    progress:
      { files: FileChange[]; lines: number; preview?: PreviewUpdate } | "ended",
  ): void {
    if (this.activities.has(itemId)) return;
    this.emit(
      "file_change.progress",
      progress === "ended" ? { itemId, ended: true } : { itemId, ...progress },
    );
  }

  startFileChange(itemId: string, files: FileChange[]): void {
    if (this.activities.has(itemId)) return;
    const item: FileChangeItem = {
      type: "file_change",
      itemId,
      files,
      status: "inProgress",
    };
    this.activities.set(itemId, item);
    this.order.push(item);
    this.emit("file_change.started", { itemId, files });
  }

  completeFileChange(
    itemId: string,
    files: FileChange[],
    status: Exclude<ActivityStatus, "inProgress">,
  ): void {
    if (!this.activities.has(itemId)) this.startFileChange(itemId, files);
    const item = this.activities.get(itemId)!;
    if (item.type !== "file_change" || item.status !== "inProgress") return;
    item.status = status;
    item.files = files;
    this.emit("file_change.completed", {
      itemId,
      files,
      status,
      ...(item.approval ? { approval: item.approval } : {}),
    });
  }

  // Commands still running, for the watchdog.
  get inFlightCommandCount(): number {
    let count = 0;
    for (const item of this.activities.values())
      if (item.type === "command" && item.status === "inProgress") count++;
    return count;
  }

  // A connector's startup status changed (not an ordered item, just an event).
  connectorStatus(
    connector: string,
    status: "starting" | "ready" | "failed",
    reason?: "auth" | "unreachable" | "unknown",
  ): void {
    this.emit("connector.status", {
      connector,
      status,
      ...(reason ? { reason } : {}),
    });
  }

  itemList(): RunItem[] {
    return this.order.map((item) => {
      if (item.type === "reply")
        return {
          type: "reply" as const,
          itemId: item.itemId,
          text: this.replies.get(item.itemId)!.text,
          completed: this.replies.get(item.itemId)!.completed,
        };
      if (item.type === "tool") {
        const state = this.tools.get(item.itemId)!;
        return {
          type: "tool" as const,
          itemId: item.itemId,
          connector: state.connector,
          tool: state.tool,
          status: state.status,
          ...(state.durationMs !== undefined
            ? { durationMs: state.durationMs }
            : {}),
          ...(state.errorCode ? { errorCode: state.errorCode } : {}),
          ...(state.approval ? { approval: state.approval } : {}),
        };
      }
      if (item.type === "command" || item.type === "file_change")
        return structuredClone(this.activities.get(item.itemId)!);
      return item;
    });
  }

  // The terminal event. Everything a caller needs to save the outcome is in
  // it, including partial text, which Codex does not keep after a stop.
  finish(
    status: "completed" | "stopped" | "failed",
    error: RunError | null,
    usage: Record<string, unknown> | null,
  ): void {
    if (this.finishedAt !== undefined) return;
    this.placeBlocks();
    this.status = status;
    this.timings.completedAt = Date.now();
    this.emit("run.completed", {
      status,
      error,
      delivery: this.delivery,
      threadId: this.threadId,
      turnId: this.turnId,
      items: this.itemList(),
      ...this.agentField(),
      usage,
      timings: this.timings,
    });
    this.finishedAt = Date.now();
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
  }

  // Replays everything after `after` and registers for live events in the
  // same synchronous step, so no event can fall between them.
  subscribe(after: number, subscriber: Subscriber): () => void {
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (after < oldest - 1) {
      subscriber.send({
        seq: this.seq,
        type: "run.snapshot",
        data: {
          status: this.status,
          threadId: this.threadId,
          turnId: this.turnId,
          items: this.itemList(),
          ...this.agentField(),
          approvals: this.pendingApprovals,
        },
      });
      after = this.seq;
      // A finished run's last event is run.completed; resend it after the
      // snapshot so the caller always ends on the outcome.
      const last = this.events.at(-1);
      if (this.finishedAt !== undefined && last) subscriber.send(last);
    } else {
      for (const event of this.events)
        if (event.seq > after) subscriber.send(event);
    }
    if (this.finishedAt !== undefined) {
      subscriber.end();
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private reply(itemId: string): ReplyState {
    let reply = this.replies.get(itemId);
    if (!reply) {
      reply = { text: "", completed: false, placedAt: undefined };
      this.replies.set(itemId, reply);
    }
    return reply;
  }

  // Puts a reply into the ordered list the first time it has any text, so an
  // empty reply (started then cut off) never appears.
  private place(itemId: string, reply: ReplyState): void {
    if (reply.placedAt !== undefined || reply.text.length === 0) return;
    reply.placedAt = this.order.length;
    this.order.push({ type: "reply", itemId, text: "", completed: false });
  }
}

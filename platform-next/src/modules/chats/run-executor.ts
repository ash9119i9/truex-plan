import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Optional,
} from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { detached } from "../../common/http/server-timing";
import { parseWireId, toWireId } from "../../database/object-id";
import {
  APPROVAL_DECISIONS,
  type ApprovalAnswer,
  MAX_ACTIVITY_COMMAND,
  MAX_ACTIVITY_FILES,
  MAX_ACTIVITY_PATH,
  type ApprovalDecision,
  type FollowUpsAssignment,
  type RunErrorInfo,
  type RunUsage,
  type MessageAttachment,
} from "./chat";
import { parseFollowUps, type ParsedFollowUps } from "./followups";
import {
  ChatFilesService,
  type CaptureResult,
  type CaptureTarget,
  type ChatFileView,
} from "./chat-files";
import {
  ChatStore,
  LEASE_RENEW_MS,
  networkKey,
  type CommandSettleItem,
  type FileChangeSettleItem,
  type NetworkSettleItem,
  type SettleItem,
  type SettleResult,
  type Settlement,
  type SkillSettleItem,
  type ToolSettleItem,
  type AgentSettleItem,
} from "./chat-store";
import { ConnectorsService } from "../connectors/connectors.service";
import { networkBlockOf, reconcileBlock } from "../network/network-grants";
import type { RunNetworkPolicy } from "../network/network-policy";
import type { ChatSkill } from "../skills/skill";
import { SkillsService } from "../skills/skills.service";
import {
  AdapterRefusal,
  AdapterUnreachable,
  RuntimeClient,
  goalUpdate,
  type AdapterEvent,
  type ChatRef,
  type GoalUpdate,
  type HistoryTurn,
  type StartRunBody,
} from "./runtime-client";

export const RUNTIME_CLIENT = Symbol("RUNTIME_CLIENT");

// What a run tells the connectors module: a connector's server refused the
// chat owner's token, so the next run refreshes it or asks to reconnect.
export interface ConnectorFeedback {
  tokenRejected(dbName: string, userId: ObjectId, slug: string): Promise<void>;
}

// Everything needed to run (or recover) one turn. Built by ChatsService from
// the saved chat; holds a gateway token, so it never leaves the server.
export type Dispatch = DispatchBase &
  (
    | {
        readonly body: StartRunBody;
        // start: post the run. recover: reattach first; post only when the
        // runtime has no trace of the message.
        readonly mode: "start" | "recover";
      }
    | {
        // A turn Codex started for the chat's goal: never posted, read from
        // its first event, and found in history by its turn.
        readonly mode: "attach";
        readonly threadId: string;
        readonly turnId: string;
      }
  );

interface DispatchBase {
  readonly dbName: string;
  readonly chatId: ObjectId;
  readonly runId: ObjectId;
  // The chat's owner: a stream proves its caller against this, not MongoDB.
  readonly ownerId: ObjectId;
  // The seq of the reply's first message: the one after the member's, or
  // for a goal run the chat's next seq when it was claimed.
  readonly replySeq: number;
  readonly ref: ChatRef;
  // A recovered run whose lease is still held waits until it expires.
  readonly notBefore?: Date;
  // The member's attached files, copied into the workspace before a start
  // posts the run.
  readonly attachments?: readonly MessageAttachment[];
  // The chat's skills (also named in body.skills), pushed to the runtime
  // before the thread's first run and whenever it reports them missing.
  readonly skills?: readonly ChatSkill[];
  // The chat's Allow-once network grants body.network includes (their card
  // messages); removed from the chat when the run ends.
  readonly networkOnce?: readonly ObjectId[];
  // Decided at chat creation. Absent (an older chat) is off. Rows are stored
  // only for a completed run of an "on" chat; stripping happens for every
  // run whatever this says.
  readonly followUps?: FollowUpsAssignment;
}

export type Phase =
  | "waiting"
  | "streaming"
  | "retrying"
  | "stopping"
  | "reconnecting"
  | "settled";

// What a browser subscriber receives. Deltas are batched per run.
export type LiveEvent =
  | { type: "snapshot"; data: Snapshot }
  | { type: "status"; data: { phase: Phase } }
  | { type: "delta"; data: { itemId: string; text: string } }
  | { type: "item"; data: { itemId: string; text: string } }
  | { type: "input"; data: { clientMessageId: string } }
  | { type: "tool"; data: ToolEventData }
  | { type: "connector"; data: ConnectorEventData }
  | { type: "approval"; data: ApprovalEventData }
  | { type: "activity"; data: ActivityItem }
  | { type: "skill"; data: { slug: string; name: string } }
  // A sandbox request the network proxy refused (network-grants.ts). Its
  // card is answered once the reply is saved.
  | { type: "network"; data: Omit<NetworkSettleItem, "type"> }
  | { type: "output"; data: { itemId: string; text: string } }
  | { type: "progress"; data: ProgressEventData }
  // A helper agent started, is working or finished (its whole state).
  | { type: "agent"; data: AgentSettleItem }
  | { type: "usage"; data: RunUsage }
  | { type: "completed"; data: Completed }
  // The file versions the run stored, after completed and before saved, and
  // the files it wrote that couldn't be stored.
  | { type: "files"; data: { files: ChatFileView[]; unsaved: string[] } }
  | { type: "saved"; data: SettleResult }
  | { type: "save_failed"; data: Record<string, never> };

// A connector tool call starting or finishing. Never arguments or results.
export interface ToolEventData {
  itemId: string;
  connector: string;
  tool: string;
  status: ToolSettleItem["status"];
  durationMs?: number;
  errorCode?: string;
  approval?: ApprovalDecision;
}

// A command or file change in the chat's workspace, as it starts and ends.
// Output streams separately (`output` events); the item carries what was
// kept so far.
export type ActivityItem = CommandSettleItem | FileChangeSettleItem;

// A file change the model is still writing, before it becomes an activity:
// its files and the lines written so far, or `ended` when it never will.
// Live only; never saved.
export type ProgressEventData =
  | {
      itemId: string;
      files: FileChangeSettleItem["files"];
      lines: number;
      preview?: FilePreview;
    }
  | { itemId: string; ended: true };

// A new file's text while the model writes it. Live events carry the next
// piece (`offset` is where it starts); a snapshot carries all of it so far
// (`offset` 0). Never saved.
export interface FilePreview {
  path: string;
  offset: number;
  text: string;
  truncated: boolean;
}

// Characters of preview kept per file being written (the runtime's limit).
export const MAX_PREVIEW_CHARS = 256 * 1024;

// A write-tool call waiting for the member (`status: "pending"`, with
// `expiresAt`), or how its approval ended (`auto` when an earlier Allow for
// this chat answered it). `params` are what the card shows: model-written,
// bounded by the adapter and re-bounded here, rendered as plain text.
export interface ApprovalEventData {
  approvalId: string;
  itemId: string;
  // mcp: a connector tool. command / file_change: the coding profile's
  // sandboxed command or edit (connector "@workspace").
  kind: "mcp" | "command" | "file_change";
  connector: string;
  tool: string;
  params: Array<{ name: string; value: string }>;
  status: "pending" | ApprovalDecision;
  // False when the card must not offer Allow for this chat (push).
  allowForChat: boolean;
  // Coding: what Allow for this chat stores (a command's hash, or
  // "file_change").
  scope?: string;
  // file_change cards: the changes as a bounded diff.
  diff?: string;
  diffTruncated?: boolean;
  expiresAt?: string;
  auto?: boolean;
}

// What a member's answer to an approval came to.
export type ApprovalOutcome = "answered" | "resolved" | "not_found";

// A connector's server starting, ready or failed for this run.
export interface ConnectorEventData {
  connector: string;
  status: "starting" | "ready" | "failed";
  reason?: "auth" | "unreachable" | "unknown";
}

// Replies, tool calls and steers in the runtime's order (see SettleItem).
export interface Snapshot {
  runId: string;
  phase: Phase;
  items: SettleItem[];
  usage: RunUsage | null;
  // Approvals still waiting for the member, so a reconnecting browser shows
  // their cards.
  approvals: ApprovalEventData[];
  // File changes still being written (live only, never saved).
  writing: Array<Extract<ProgressEventData, { lines: number }>>;
  // Helper agents, only when some ran.
  agents?: AgentSettleItem[];
}

export interface Completed {
  status: Settlement["status"];
  error: RunErrorInfo | null;
  items: SettleItem[];
  agents?: AgentSettleItem[];
  usage: RunUsage | null;
}

// What became of a steer sent to the runtime.
//   queued: the runtime took it into the running turn
//   unknown: it went out and the answer was lost; settle shows if it was used
//   ended: the turn had ended or was stopping; nothing was delivered
//   not_found: the runtime does not know the run
//   limit / refused: refused; nothing was delivered
export type SteerOutcome =
  "queued" | "unknown" | "ended" | "not_found" | "limit" | "refused";

export interface LiveSubscriber {
  send(event: LiveEvent): void;
  end(): void;
}

// Command output a live run keeps per command (the runtime caps at 16 000).
const MAX_LIVE_OUTPUT = 16_000;

// The first delta of an item goes out at once; later ones every 50 ms.
export const DELTA_FLUSH_MS = 50;
// A settled run stays here this long for late subscribers; after that the
// saved messages are the answer.
const SETTLED_TTL_MS = 60_000;
// Reconnect attempts after the adapter stream drops, and the delays between.
const RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 4_000, 8_000, 15_000];
// How long a steer waits for the runtime to accept a run this process just
// started, so it does not arrive before the run exists there.
const STEER_ACCEPT_WAIT_MS = 20_000;
// Request-level refusals that mean "not started; try again shortly".
const RETRYABLE_START = new Set([
  "RUNTIME_BUSY",
  "DRAINING",
  "RUNTIME_UNAVAILABLE",
  "INTERNAL",
]);

const RUNTIME_FAILED: RunErrorInfo = {
  code: "RUNTIME_ERROR",
  message: "The assistant couldn't run this message. Try again.",
  retryable: true,
};
const NOT_SENT: RunErrorInfo = {
  code: "NOT_SENT",
  message: "This message wasn't sent to the assistant. Try again.",
  retryable: true,
};
// A goal turn the runtime announced but no longer holds or remembers.
const GOAL_TURN_LOST: RunErrorInfo = {
  code: "GOAL_TURN_LOST",
  message: "This step of the goal couldn't be recovered.",
  retryable: false,
};
// Only an adapter older than the Codex-exact change (coding + helpers share a
// workspace) still refuses helpers under coding; a current adapter runs them.
// Kept so that older adapter surfaces a clear message instead of a raw error.
const SUBAGENTS_UNAVAILABLE: RunErrorInfo = {
  code: "SUBAGENTS_DISABLED",
  message: "Helper agents aren't available for this assistant.",
  retryable: false,
};
const BUSY_ELSEWHERE: RunErrorInfo = {
  code: "RUNTIME_BUSY",
  message:
    "The assistant is still finishing an earlier reply. Try again shortly.",
  retryable: true,
};
const ATTACHMENTS_FAILED: RunErrorInfo = {
  code: "ATTACHMENTS_FAILED",
  message:
    "Your attached files couldn't be given to the assistant. Try sending again.",
  retryable: true,
};
const SKILLS_FAILED: RunErrorInfo = {
  code: "SKILLS_FAILED",
  message: "This agent's skills couldn't be loaded. Try again.",
  retryable: true,
};
const UPLOADS_UNAVAILABLE: RunErrorInfo = {
  code: "UPLOADS_DISABLED",
  message: "This assistant can't open attached files here.",
  retryable: false,
};
const THREAD_LOST: RunErrorInfo = {
  code: "THREAD_LOST",
  message:
    "This conversation's history is no longer available, so it can't continue.",
  retryable: false,
};

type OrderEntry =
  | { type: "reply"; itemId: string }
  | { type: "tool"; itemId: string }
  | { type: "activity"; itemId: string }
  | { type: "skill"; slug: string }
  | { type: "network"; key: string }
  | { type: "input"; clientMessageId: string };

// The tool error codes the adapter sends (slice 3 contract); anything else
// is saved as UNKNOWN so no free text reaches a message.
const TOOL_ERROR_CODES = new Set([
  "REFUSED",
  "DENIED",
  "TOOL_ERROR",
  "TIMEOUT",
  "UNKNOWN",
]);

class LiveRun {
  phase: Phase = "waiting";
  // Text already sent to subscribers, per reply.
  readonly items = new Map<string, string>();
  // Replies and steers in the runtime's order. A reply is placed when its
  // first text arrives, so an empty one never appears.
  private readonly order: OrderEntry[] = [];
  private readonly completedItems = new Set<string>();
  private readonly inputs = new Set<string>();
  private readonly pending = new Map<string, string>();
  // Tool calls by item, placed in `order` when first seen.
  private readonly tools = new Map<string, ToolSettleItem>();
  // Commands and file changes by item, placed like tool calls.
  private readonly activities = new Map<string, ActivityItem>();
  // Skills the model opened, by slug, placed in `order` when first seen.
  private readonly skills = new Map<string, SkillSettleItem>();
  // Refused sandbox requests, by networkKey, placed like skills.
  private readonly networks = new Map<string, NetworkSettleItem>();
  // Helper agents by id, in start order.
  private readonly agents = new Map<string, AgentSettleItem>();
  // File changes the model is still writing, until they become activities.
  private readonly writing = new Map<
    string,
    Extract<ProgressEventData, { lines: number }>
  >();
  // Approvals waiting for the member, by approvalId, and the ones that ended
  // (so a replayed request never reopens a card).
  private readonly approvals = new Map<string, ApprovalEventData>();
  private readonly resolvedApprovals = new Set<string>();
  // Connectors already reported as refusing the token, once per run.
  readonly authReported = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  usage: RunUsage | null = null;
  firstTextAt: Date | undefined;
  threadId: string | null = null;
  turnId: string | null = null;
  stopRequested = false;
  accepted = false;
  // The runtime's acceptance being saved. Text keeps streaming meanwhile;
  // the run's later writes wait for it so they land in order.
  acceptedWrite: Promise<void> = Promise.resolve();
  completed: Completed | undefined;
  saved: SettleResult | undefined;
  saveFailed = false;
  files: ChatFileView[] = [];
  unsaved: string[] = [];
  readonly subscribers = new Set<LiveSubscriber>();
  readonly abort = new AbortController();
  done: Promise<void> = Promise.resolve();
  // Resolve when the runtime accepts the run, and when this process stops
  // holding it (settled or released).
  private markAccepted!: () => void;
  readonly acceptedOrClosed = new Promise<void>(
    (resolve) => (this.markAccepted = resolve),
  );
  private markClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.markClosed = resolve));

  constructor(readonly dispatch: Dispatch) {}

  get id(): string {
    return toWireId(this.dispatch.runId);
  }

  snapshot(): Snapshot {
    return {
      runId: this.id,
      phase: this.phase,
      items: this.settleItems(),
      usage: this.usage,
      approvals: [...this.approvals.values()],
      writing: [...this.writing.values()],
      ...this.agentField(),
    };
  }

  // What was sent to subscribers, in order. Call flush() first to include
  // pending text.
  settleItems(): SettleItem[] {
    return this.order.map((entry): SettleItem => {
      if (entry.type === "input") return entry;
      if (entry.type === "tool") return this.tools.get(entry.itemId)!;
      if (entry.type === "activity") return this.activities.get(entry.itemId)!;
      if (entry.type === "skill") return this.skills.get(entry.slug)!;
      if (entry.type === "network") return this.networks.get(entry.key)!;
      return {
        type: "reply",
        itemId: entry.itemId,
        text: this.items.get(entry.itemId) ?? "",
        completed: this.completedItems.has(entry.itemId),
      };
    });
  }

  hasInput(clientMessageId: string): boolean {
    return this.inputs.has(clientMessageId);
  }

  // The last reply, when the runtime never finished it.
  trailingPartial(): SettleItem | null {
    const last = this.settleItems().at(-1);
    return last?.type === "reply" && !last.completed && last.text ? last : null;
  }

  accept(): void {
    this.accepted = true;
    this.markAccepted();
  }

  // A steer entered the turn at this point. Once per steer.
  addInput(clientMessageId: string): void {
    if (this.inputs.has(clientMessageId)) return;
    this.flush();
    this.inputs.add(clientMessageId);
    this.order.push({ type: "input", clientMessageId });
    this.broadcast({ type: "input", data: { clientMessageId } });
  }

  // A tool call started or finished. Placed in stream order when first seen;
  // a finished call never goes back to in progress (a reconnect snapshot
  // can carry an older state).
  setTool(item: ToolSettleItem): void {
    const before = this.tools.get(item.itemId);
    if (before && before.status !== "inProgress") return;
    if (before && item.status === "inProgress") return;
    if (!before) {
      this.flush();
      this.order.push({ type: "tool", itemId: item.itemId });
    }
    // A finished call's event does not repeat its approval; keep it.
    const merged =
      before?.approval && !item.approval
        ? { ...item, approval: before.approval }
        : item;
    this.tools.set(item.itemId, merged);
    const { type: _type, ...data } = merged;
    this.broadcast({ type: "tool", data });
  }

  // The model opened one of the chat's skills. Once per run; a slug the
  // chat doesn't have is ignored.
  useSkill(slug: string): void {
    if (this.skills.has(slug)) return;
    const skill = this.dispatch.skills?.find((entry) => entry.slug === slug);
    if (!skill) return;
    this.flush();
    const item: SkillSettleItem = {
      type: "skill",
      slug,
      name: skill.displayName,
    };
    this.skills.set(slug, item);
    this.order.push({ type: "skill", slug });
    this.broadcast({ type: "skill", data: { slug, name: item.name } });
  }

  // A helper agent's state from the runtime. "start" adds it once; "update"
  // changes a known one; "snapshot" (a reconnect or the outcome) does
  // either. A finished helper keeps its result unless a later turn sends one.
  setAgent(agent: AgentSettleItem, how: "start" | "update" | "snapshot"): void {
    const known = this.agents.get(agent.agentId);
    if (how === "start" && known) return;
    if (how === "update" && !known) return;
    if (!known && this.agents.size >= MAX_RUN_AGENTS) return;
    const next: AgentSettleItem = known
      ? {
          ...known,
          status: agent.status,
          ...(agent.preview !== undefined ? { preview: agent.preview } : {}),
          ...(agent.result !== undefined ? { result: agent.result } : {}),
          ...(agent.usage ? { usage: agent.usage } : {}),
        }
      : agent;
    this.agents.set(agent.agentId, next);
    this.broadcast({ type: "agent", data: { ...next } });
  }

  // Present only when a helper ran, so other runs are unchanged.
  agentField(): { agents?: AgentSettleItem[] } {
    return this.agents.size
      ? { agents: [...this.agents.values()].map((agent) => ({ ...agent })) }
      : {};
  }

  // The network proxy refused a sandbox request. Once per site and method.
  blockNetwork(item: NetworkSettleItem): void {
    const key = networkKey(item);
    if (this.networks.has(key)) return;
    this.flush();
    this.networks.set(key, item);
    this.order.push({ type: "network", key });
    const { type: _type, ...data } = item;
    this.broadcast({ type: "network", data });
  }

  // A command or file change started or finished. A finished one never goes
  // back to in progress; its streamed output and approval are kept when the
  // event does not repeat them.
  setActivity(item: ActivityItem): void {
    const before = this.activities.get(item.itemId);
    if (before && before.status !== "inProgress") return;
    if (before && item.status === "inProgress") return;
    if (!before) {
      this.flush();
      this.order.push({ type: "activity", itemId: item.itemId });
    }
    let merged: ActivityItem = item;
    if (before?.approval && !item.approval)
      merged = { ...merged, approval: before.approval };
    if (
      before?.type === "command" &&
      merged.type === "command" &&
      !merged.output &&
      before.output
    )
      merged = {
        ...merged,
        output: before.output,
        outputTruncated: before.outputTruncated,
      };
    this.activities.set(item.itemId, merged);
    this.writing.delete(item.itemId);
    this.broadcast({ type: "activity", data: merged });
  }

  endWriting(): void {
    for (const itemId of [...this.writing.keys()])
      this.setProgress({ itemId, ended: true });
  }

  // Progress of a file change still being written. Ignored once the change
  // is an activity.
  setProgress(progress: ProgressEventData): void {
    if (this.activities.has(progress.itemId)) return;
    if ("ended" in progress) {
      if (!this.writing.delete(progress.itemId)) return;
      this.broadcast({ type: "progress", data: progress });
      return;
    }
    // The snapshot keeps the whole text so far; subscribers get the piece.
    const kept = this.writing.get(progress.itemId)?.preview;
    let preview = kept;
    let piece = progress.preview;
    if (piece) {
      const sofar = kept && kept.path === piece.path ? kept.text : "";
      if (piece.offset === sofar.length && !kept?.truncated)
        preview = {
          path: piece.path,
          offset: 0,
          text: sofar + piece.text,
          truncated: piece.truncated,
        };
      // Out of order or after the limit: kept text stands, piece dropped.
      else piece = undefined;
    }
    this.writing.set(progress.itemId, {
      itemId: progress.itemId,
      files: progress.files,
      lines: progress.lines,
      ...(preview ? { preview } : {}),
    });
    const { preview: _, ...rest } = progress;
    this.broadcast({
      type: "progress",
      data: piece ? { ...rest, preview: piece } : rest,
    });
  }

  // Live command output, bounded like the runtime's own copy.
  appendOutput(itemId: string, text: string): void {
    const item = this.activities.get(itemId);
    if (item?.type !== "command" || item.outputTruncated || !text) return;
    const room = MAX_LIVE_OUTPUT - item.output.length;
    const chunk = text.slice(0, Math.max(0, room));
    this.activities.set(itemId, {
      ...item,
      output: item.output + chunk,
      outputTruncated: text.length > room,
    });
    if (chunk)
      this.broadcast({ type: "output", data: { itemId, text: chunk } });
  }

  // A write-tool call is waiting for the member. Ignored once it ended.
  requestApproval(approval: ApprovalEventData): void {
    if (this.resolvedApprovals.has(approval.approvalId)) return;
    const before = this.approvals.get(approval.approvalId);
    this.approvals.set(approval.approvalId, approval);
    if (!before) this.broadcast({ type: "approval", data: approval });
  }

  // An approval ended. Returns false when this run already saw it end, so
  // its audit record and chat allow are written once per reader.
  resolveApproval(approval: ApprovalEventData): boolean {
    if (this.resolvedApprovals.has(approval.approvalId)) return false;
    this.resolvedApprovals.add(approval.approvalId);
    this.approvals.delete(approval.approvalId);
    if (approval.status !== "pending") {
      const tool = this.tools.get(approval.itemId);
      if (tool && approval.kind === "mcp")
        this.tools.set(approval.itemId, { ...tool, approval: approval.status });
      const activity = this.activities.get(approval.itemId);
      if (activity && approval.kind !== "mcp")
        this.activities.set(approval.itemId, {
          ...activity,
          approval: approval.status,
        });
    }
    this.broadcast({ type: "approval", data: approval });
    return true;
  }

  // Pending approvals the runtime no longer has (a reconnect snapshot
  // replaced the event stream, so their approval.resolved was missed). Their
  // cards close; the tool's own outcome carries how they ended. No audit
  // record is written for these: who answered is not known here.
  closeApprovalsNotIn(pending: ReadonlySet<string>): void {
    for (const [approvalId, approval] of [...this.approvals]) {
      if (pending.has(approvalId)) continue;
      const { expiresAt: _expiresAt, ...rest } = approval;
      const decision =
        (approval.kind === "mcp"
          ? this.tools.get(approval.itemId)?.approval
          : this.activities.get(approval.itemId)?.approval) ?? "cancelled";
      this.resolveApproval({ ...rest, status: decision });
    }
  }

  private place(itemId: string): void {
    if (!this.items.has(itemId) && !this.pending.has(itemId))
      this.order.push({ type: "reply", itemId });
  }

  broadcast(event: LiveEvent): void {
    if (event.type !== "delta") this.flush();
    for (const subscriber of this.subscribers) subscriber.send(event);
  }

  setPhase(phase: Phase): void {
    if (this.phase === phase || this.phase === "settled") return;
    if (this.phase === "stopping" && phase !== "settled") return;
    this.phase = phase;
    this.broadcast({ type: "status", data: { phase } });
  }

  appendDelta(itemId: string, delta: string): void {
    this.firstTextAt ??= new Date();
    const first = !this.items.has(itemId) && !this.pending.has(itemId);
    this.place(itemId);
    this.pending.set(itemId, (this.pending.get(itemId) ?? "") + delta);
    if (this.phase === "waiting" || this.phase === "retrying")
      this.setPhase("streaming");
    if (first) this.flush();
    else this.flushTimer ??= setTimeout(() => this.flush(), DELTA_FLUSH_MS);
  }

  // Replaces a reply's text when the runtime reports it: whole when
  // completed, or so far (a reconnect snapshot).
  setItem(itemId: string, text: string, completed = true): void {
    if (!text && !this.items.has(itemId) && !this.pending.has(itemId)) return;
    this.place(itemId);
    this.pending.delete(itemId);
    const before = this.items.get(itemId);
    const wasCompleted = this.completedItems.has(itemId);
    if (completed) this.completedItems.add(itemId);
    if (before === text && wasCompleted === completed) return;
    this.items.set(itemId, text);
    // `item` tells a browser the reply is finished; text so far that only
    // extends what it has goes out as a delta.
    if (!completed && before !== undefined && text.startsWith(before)) {
      if (text.length > before.length)
        for (const subscriber of this.subscribers)
          subscriber.send({
            type: "delta",
            data: { itemId, text: text.slice(before.length) },
          });
      return;
    }
    this.broadcast({ type: "item", data: { itemId, text } });
  }

  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.size === 0) return;
    const batch = [...this.pending];
    this.pending.clear();
    for (const [itemId, text] of batch) {
      this.items.set(itemId, (this.items.get(itemId) ?? "") + text);
      for (const subscriber of this.subscribers)
        subscriber.send({ type: "delta", data: { itemId, text } });
    }
  }

  close(): void {
    this.flush();
    for (const subscriber of this.subscribers) subscriber.end();
    this.subscribers.clear();
    this.markAccepted();
    this.markClosed();
  }
}

// The chat a run's goal.updated came from, for the GoalWatcher.
export interface GoalUpdateSource {
  readonly dbName: string;
  readonly tenantId: ObjectId;
  readonly chatId: ObjectId;
  readonly ownerId: ObjectId;
}

export type GoalUpdateListener = (
  at: GoalUpdateSource,
  update: GoalUpdate,
) => void;

// Owns every run this process is streaming. One reader per run consumes the
// adapter's stream whether or not a browser is watching, saves the outcome,
// and fans live text out to any number of browser subscribers.
//
// v1 runs one platform process (tasks/chat-v1-plan.md). A run whose process
// died is recovered once its lease lapses: by the next access to its chat, or
// by the RecoverySweep within a minute.
@Injectable()
export class RunExecutor implements OnApplicationShutdown {
  private readonly logger = new Logger("RunExecutor");
  private readonly live = new Map<string, LiveRun>();
  private goalListener: GoalUpdateListener | undefined;
  // Bounded: a run leaves it when it is read again.
  private readonly abandoned = new Set<string>();
  private draining = false;

  constructor(
    @Inject(ChatStore) private readonly store: ChatStore,
    @Inject(RUNTIME_CLIENT) private readonly client: RuntimeClient | null,
    @Optional()
    @Inject(ConnectorsService)
    private readonly connectors: ConnectorFeedback | null = null,
    @Optional()
    @Inject(ChatFilesService)
    private readonly chatFiles: ChatFilesService | null = null,
    @Optional()
    @Inject(SkillsService)
    private readonly skills: SkillsService | null = null,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  // Called for every goal.updated on a run's stream (a member's run or a
  // goal run), so the GoalWatcher starts for a goal it has not seen. One
  // listener; a later call replaces it.
  onGoalUpdate(listener: GoalUpdateListener): void {
    this.goalListener = listener;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  // This process read the run and gave up on it (save failed, or the
  // runtime stayed unreachable), so no lease needs to lapse before
  // recovering it.
  abandonedHere(runId: ObjectId): boolean {
    return this.abandoned.has(toWireId(runId));
  }

  isLive(runId: ObjectId): boolean {
    const run = this.live.get(toWireId(runId));
    return !!run && run.phase !== "settled";
  }

  // What this process holds for a run it is reading for exactly this tenant
  // database, chat and owner: "running", or the saved outcome. The entry was
  // written by this server from a verified caller and a run's owner never
  // changes, so it answers as the owner-filtered read of the run would.
  // Null otherwise, including a run whose save failed: the caller then reads
  // MongoDB and recovery runs as before.
  liveFor(
    dbName: string,
    chatId: ObjectId,
    runId: ObjectId,
    ownerId: ObjectId,
  ): "running" | SettleResult | null {
    const run = this.live.get(toWireId(runId));
    if (!run) return null;
    const { dispatch } = run;
    if (
      dispatch.dbName !== dbName ||
      !dispatch.chatId.equals(chatId) ||
      !dispatch.ownerId.equals(ownerId)
    )
      return null;
    if (run.saved) return run.saved;
    return run.phase === "settled" ? null : "running";
  }

  // Starts reading a run. Repeating it for a run already live here is a
  // no-op, so recovery and a fresh start can never double-read in one
  // process.
  begin(dispatch: Dispatch): void {
    if (!this.client) throw new Error("chat runtime is not configured");
    const id = toWireId(dispatch.runId);
    const existing = this.live.get(id);
    if (existing && existing.phase !== "settled") return;
    const run = new LiveRun(dispatch);
    this.abandoned.delete(id);
    if (dispatch.mode === "recover") run.phase = "reconnecting";
    this.live.set(id, run);
    const client = this.client;
    // The reader outlives the request that started it.
    run.done = detached(() =>
      this.execute(run, client).catch((error: unknown) => {
        this.logger.error({
          message: "run reader failed",
          runId: id,
          error: error instanceof Error ? error.name : "unknown",
        });
        run.close();
        this.live.delete(id);
      }),
    );
  }

  // Snapshot then live events, registered in one synchronous step so no
  // event falls between them. Returns null when the run is not live here.
  subscribe(runId: ObjectId, subscriber: LiveSubscriber): (() => void) | null {
    const run = this.live.get(toWireId(runId));
    if (!run) return null;
    run.flush();
    subscriber.send({ type: "snapshot", data: run.snapshot() });
    if (run.completed)
      subscriber.send({ type: "completed", data: run.completed });
    if (run.files.length > 0 || run.unsaved.length > 0)
      subscriber.send({
        type: "files",
        data: { files: run.files, unsaved: run.unsaved },
      });
    if (run.saved) subscriber.send({ type: "saved", data: run.saved });
    else if (run.saveFailed) subscriber.send({ type: "save_failed", data: {} });
    if (run.saved || run.saveFailed) {
      subscriber.end();
      return () => undefined;
    }
    run.subscribers.add(subscriber);
    return () => run.subscribers.delete(subscriber);
  }

  // Asks the runtime to stop. Safe to repeat. A stop that arrives before
  // the runtime knows the run is sent again once it does.
  async stop(runId: ObjectId): Promise<void> {
    const run = this.live.get(toWireId(runId));
    if (!run || run.phase === "settled") return;
    run.stopRequested = true;
    run.setPhase("stopping");
    await this.sendStop(run);
  }

  // Sends a steer to the runtime. A run this process started and the
  // runtime has not accepted yet is waited for (bounded) first, so the steer
  // does not arrive before the run exists there. A recovered run already
  // exists there, or never will.
  async steer(
    runId: ObjectId,
    ref: ChatRef,
    input: { text: string; clientMessageId: string },
  ): Promise<SteerOutcome> {
    if (!this.client) throw new Error("chat runtime is not configured");
    const id = toWireId(runId);
    const run = this.live.get(id);
    if (
      run?.dispatch.mode === "start" &&
      !run.accepted &&
      run.phase !== "settled"
    )
      await Promise.race([
        run.acceptedOrClosed,
        sleep(STEER_ACCEPT_WAIT_MS, run.abort.signal),
      ]);
    if (run?.phase === "settled") return "ended";
    try {
      await this.client.steer(id, ref, input);
      return "queued";
    } catch (error) {
      if (error instanceof AdapterUnreachable) return "unknown";
      if (!(error instanceof AdapterRefusal)) throw error;
      switch (error.code) {
        case "STEER_UNKNOWN":
          return "unknown";
        case "RUN_ENDED":
          return "ended";
        case "RUN_NOT_FOUND":
          return "not_found";
        case "STEER_LIMIT":
          return "limit";
        default:
          this.logger.warn({
            message: "runtime refused steer",
            runId: id,
            code: error.code,
          });
          return "refused";
      }
    }
  }

  // Sends the member's answer to a pending approval. The runtime holds the
  // approval, so this works whichever process reads the run. First answer
  // wins: a later one is `resolved`; an unknown, expired or finished one is
  // `not_found`. AdapterUnreachable propagates (the caller may retry).
  async answerApproval(
    runId: ObjectId,
    ref: ChatRef,
    approvalId: string,
    decision: ApprovalAnswer,
  ): Promise<ApprovalOutcome> {
    if (!this.client) throw new Error("chat runtime is not configured");
    try {
      await this.client.answerApproval(
        toWireId(runId),
        approvalId,
        ref,
        decision,
      );
      return "answered";
    } catch (error) {
      if (!(error instanceof AdapterRefusal)) throw error;
      if (error.code === "APPROVAL_RESOLVED") return "resolved";
      if (
        error.code === "APPROVAL_NOT_FOUND" ||
        error.code === "RUN_NOT_FOUND" ||
        error.code === "RUN_ENDED"
      )
        return "not_found";
      this.logger.warn({
        message: "runtime refused approval answer",
        runId: toWireId(runId),
        code: error.code,
      });
      throw error;
    }
  }

  // Resolves once this process stops holding the run (saved, save failed or
  // let go), or after `ms`. At once when the run is not live here.
  async waitClosed(runId: ObjectId, ms: number): Promise<void> {
    const run = this.live.get(toWireId(runId));
    if (!run) return;
    await Promise.race([run.closed, sleep(ms)]);
  }

  private async sendStop(run: LiveRun): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.stop(run.id, run.dispatch.ref);
    } catch (error) {
      // Not yet known to the runtime: resent on its first event.
      if (error instanceof AdapterRefusal && error.code === "RUN_NOT_FOUND")
        return;
      throw error;
    }
  }

  private async execute(run: LiveRun, client: RuntimeClient): Promise<void> {
    const { dispatch } = run;
    let lease: NodeJS.Timeout | undefined;
    try {
      if (dispatch.notBefore) {
        const wait = dispatch.notBefore.getTime() - Date.now();
        if (wait > 0) await sleep(wait, run.abort.signal);
        if (run.abort.signal.aborted) return this.release(run);
        // Its holder may have renewed the lease meanwhile: then it is still
        // reading, and this process lets go.
        if (
          !(await this.store.takeOverLease(
            dispatch.dbName,
            dispatch.chatId,
            dispatch.runId,
            dispatch.notBefore,
          ))
        )
          return this.release(run);
      }
      // Renewed only once the run is this process's to read.
      lease = setInterval(() => {
        this.store
          .renewLease(dispatch.dbName, dispatch.chatId, dispatch.runId)
          .catch(() => undefined);
      }, LEASE_RENEW_MS);
      lease.unref();
      const outcome = await this.read(run, client);
      if (outcome) await this.finish(run, outcome);
      else {
        // Unreachable runtime or shutdown: let go of the run so the next
        // access recovers it once the lease lapses. Browsers reconnect.
        this.release(run);
        if (!this.draining) this.abandoned.add(run.id);
      }
    } finally {
      clearInterval(lease);
      // Shutdown waits for it with the reader.
      await run.acceptedWrite;
    }
  }

  // Stops holding a run without settling it; browsers reconnect.
  private release(run: LiveRun): void {
    run.close();
    if (this.live.get(run.id) === run) this.live.delete(run.id);
  }

  // Reads the run to its outcome, reconnecting through drops. Returns null
  // when the runtime stayed unreachable: the run is left claimed and
  // `uncertain`, and recovery settles it once its lease lapses.
  private async read(
    run: LiveRun,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    const { dispatch } = run;
    const signal = run.abort.signal;
    // Null for an attached run: there is nothing to post, ever.
    const body = dispatch.mode === "attach" ? null : dispatch.body;
    let after = 0;
    let posts = 0;
    let failures = 0;
    let skillsResent = false;
    // A new thread's runtime has never seen the chat's skills: push them
    // before the first post rather than waiting to be told they're missing.
    if (
      dispatch.mode === "start" &&
      dispatch.body.threadId === null &&
      dispatch.skills?.length
    ) {
      const refused = await this.pushSkills(run, client, dispatch.skills);
      if (signal.aborted) return null;
      if (refused) return failed(run, refused);
    }
    if (dispatch.mode === "start" && dispatch.attachments?.length) {
      const refused = await this.copyAttachments(run, client);
      if (signal.aborted) return null;
      if (refused) return failed(run, refused);
    }
    let stream =
      dispatch.mode === "start"
        ? (posts++, client.startRun(dispatch.body, signal))
        : client.events(run.id, dispatch.ref, 0, signal);
    for (;;) {
      try {
        for await (const event of stream) {
          failures = 0;
          after = event.seq;
          const outcome = await this.handle(run, event, client);
          if (outcome) return outcome;
        }
        throw new AdapterUnreachable("stream ended early");
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof AdapterRefusal) {
          if (error.code === "RUN_NOT_FOUND") {
            // undefined: history unreadable right now; retried below.
            const known = await this.fromHistory(run, client).catch(
              () => undefined,
            );
            if (known) return known;
            if (known === null) {
              // A goal turn is the runtime's own; nothing can resend it.
              if (!body) return failed(run, GOAL_TURN_LOST);
              // Recovery may run long after the message was written; never
              // post it then. The member sees "not sent" and can resend.
              if (dispatch.mode === "recover" || posts >= 2)
                return failed(run, NOT_SENT);
              posts++;
              after = 0;
              stream = client.startRun(body, signal);
              continue;
            }
          }
          // Refused before the run started (the runtime's storage was reset,
          // or it is a different runtime): push the missing skills and post
          // again, once.
          if (error.code === "SKILLS_MISSING") {
            if (!body || skillsResent || !dispatch.skills?.length)
              return failed(run, SKILLS_FAILED);
            skillsResent = true;
            const missing = missingOf(error, dispatch.skills);
            const refused = await this.pushSkills(run, client, missing);
            if (signal.aborted) return null;
            if (refused) return failed(run, refused);
            posts++;
            after = 0;
            stream = client.startRun(body, signal);
            continue;
          }
          if (error.code === "THREAD_LOST")
            return failed(run, THREAD_LOST, true);
          if (error.code === "CHAT_BUSY") return failed(run, BUSY_ELSEWHERE);
          if (error.code === "SUBAGENTS_DISABLED")
            return failed(run, SUBAGENTS_UNAVAILABLE);
          if (
            !RETRYABLE_START.has(error.code) &&
            error.code !== "RUN_NOT_FOUND"
          ) {
            this.logger.warn({
              message: "runtime refused run",
              runId: run.id,
              code: error.code,
            });
            return failed(run, RUNTIME_FAILED);
          }
        }
        const delay = RECONNECT_DELAYS_MS[failures++];
        if (delay === undefined) {
          this.logger.warn({ message: "runtime unreachable", runId: run.id });
          await run.acceptedWrite;
          await this.store
            .markUncertain(dispatch.dbName, dispatch.runId)
            .catch(() => undefined);
          return null;
        }
        run.setPhase("reconnecting");
        await sleep(delay, signal);
        if (signal.aborted) return null;
        // A refusal before streaming means nothing started: post again.
        // Anything else may have started: reattach, never repost blindly.
        stream =
          body &&
          error instanceof AdapterRefusal &&
          RETRYABLE_START.has(error.code) &&
          after === 0 &&
          posts > 0
            ? client.startRun(body, signal)
            : client.events(run.id, dispatch.ref, after, signal);
      }
    }
  }

  // Unpacks the given skills in the chat's runtime, in parallel, retrying a
  // busy or unreachable runtime twice. Archives come from SkillsService's
  // cache, so S3 is read once per version per process. Returns the failure
  // to settle the run with, or null once every skill is there.
  private async pushSkills(
    run: LiveRun,
    client: RuntimeClient,
    skills: readonly ChatSkill[],
  ): Promise<RunErrorInfo | null> {
    const { dispatch } = run;
    if (!this.skills) return SKILLS_FAILED;
    const store = this.skills;
    for (let attempt = 0; ; attempt++) {
      try {
        await Promise.all(
          skills.map(async (skill) =>
            client.putSkill(
              dispatch.ref,
              skill.sha256,
              await store.archive(skill),
            ),
          ),
        );
        return null;
      } catch (error) {
        const code =
          error instanceof AdapterRefusal ? error.code : errorNameOf(error);
        this.logger.warn({ message: "skills not pushed", runId: run.id, code });
        const retryable =
          error instanceof AdapterUnreachable ||
          (error instanceof AdapterRefusal && RETRYABLE_START.has(error.code));
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (!retryable || attempt >= 2 || delay === undefined)
          return SKILLS_FAILED;
        await sleep(delay, run.abort.signal);
        if (run.abort.signal.aborted) return null;
      }
    }
  }

  // Puts the message's attached files in the workspace before the run is
  // posted, retrying a busy or unreachable runtime twice. Returns the
  // failure to settle the run with, or null once every file is there.
  private async copyAttachments(
    run: LiveRun,
    client: RuntimeClient,
  ): Promise<RunErrorInfo | null> {
    const { dispatch } = run;
    if (!this.chatFiles) return ATTACHMENTS_FAILED;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.chatFiles.copyAttachments(
          dispatch.dbName,
          dispatch.ref,
          client,
          dispatch.attachments!,
        );
        return null;
      } catch (error) {
        const code =
          error instanceof AdapterRefusal ? error.code : errorNameOf(error);
        this.logger.warn({
          message: "attached files not copied",
          runId: run.id,
          code,
        });
        if (error instanceof AdapterRefusal) {
          if (error.code === "UPLOADS_DISABLED") return UPLOADS_UNAVAILABLE;
          if (error.code === "CHAT_BUSY") return BUSY_ELSEWHERE;
          if (!RETRYABLE_START.has(error.code)) return ATTACHMENTS_FAILED;
        } else if (!(error instanceof AdapterUnreachable))
          return ATTACHMENTS_FAILED;
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (attempt >= 2 || delay === undefined) return ATTACHMENTS_FAILED;
        await sleep(delay, run.abort.signal);
        if (run.abort.signal.aborted) return null;
      }
    }
  }

  private async handle(
    run: LiveRun,
    event: AdapterEvent,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    const d = event.data;
    if (run.phase === "reconnecting")
      run.setPhase(run.items.size ? "streaming" : "waiting");
    switch (event.type) {
      case "run.accepted": {
        const threadId = str(d.threadId);
        const turnId = str(d.turnId);
        run.accept();
        run.threadId = threadId;
        run.turnId = turnId;
        if (threadId && turnId) {
          const { dbName, chatId, runId } = run.dispatch;
          // Not awaited: the reply's first text must not wait for a database
          // round trip. A failure is logged; the run's thread and turn are
          // saved again when it settles.
          run.acceptedWrite = run.acceptedWrite.then(() =>
            this.store
              .markAccepted(dbName, chatId, runId, threadId, turnId)
              .catch((error: unknown) =>
                this.logger.warn({
                  message: "saving run acceptance failed",
                  runId: run.id,
                  error: error instanceof Error ? error.name : "unknown",
                }),
              ),
          );
        }
        if (run.stopRequested) await this.sendStop(run).catch(() => undefined);
        return null;
      }
      case "text.delta": {
        const itemId = str(d.itemId);
        const delta = typeof d.delta === "string" ? d.delta : "";
        if (itemId && delta) run.appendDelta(itemId, delta);
        return null;
      }
      case "item.completed": {
        const itemId = str(d.itemId);
        if (itemId && typeof d.text === "string") run.setItem(itemId, d.text);
        return null;
      }
      case "input.accepted": {
        const clientMessageId = str(d.clientMessageId);
        if (clientMessageId) run.addInput(clientMessageId);
        return null;
      }
      case "tool.started":
      case "tool.completed": {
        const item = toolOf({
          ...d,
          status:
            event.type === "tool.started"
              ? "inProgress"
              : d.status === "completed"
                ? "completed"
                : "failed",
        });
        if (item) run.setTool(item);
        return null;
      }
      case "command.started":
      case "command.completed":
      case "file_change.started":
      case "file_change.completed": {
        const item = activityOf({
          ...d,
          type: event.type.startsWith("command") ? "command" : "file_change",
          ...(event.type.endsWith(".started") ? { status: "inProgress" } : {}),
        });
        if (item) run.setActivity(item);
        return null;
      }
      case "command.output": {
        const itemId = str(d.itemId);
        if (itemId && typeof d.delta === "string")
          run.appendOutput(itemId, d.delta);
        return null;
      }
      case "file_change.progress": {
        const progress = progressOf(d);
        if (progress) run.setProgress(progress);
        return null;
      }
      case "connector.status":
        this.connectorStatus(run, d);
        return null;
      case "agent.started":
      case "agent.activity":
      case "agent.completed": {
        const agent = agentOf(d);
        if (agent)
          run.setAgent(
            agent,
            event.type === "agent.started" ? "start" : "update",
          );
        return null;
      }
      case "skill.used": {
        const slug = str(d.slug);
        if (slug) run.useSkill(slug);
        return null;
      }
      case "network.blocked": {
        const block = networkBlockOf(d);
        if (block)
          run.blockNetwork({
            type: "network",
            ...reconcileBlock(block, networkOf(run.dispatch)),
          });
        return null;
      }
      case "approval.requested": {
        const approval = approvalOf(d, "pending");
        if (approval) run.requestApproval(approval);
        return null;
      }
      case "approval.resolved": {
        const approval = approvalOf(d, "resolved");
        if (approval && run.resolveApproval(approval))
          this.recordApproval(run, approval);
        return null;
      }
      case "run.snapshot": {
        run.flush();
        // Progress events were missed, and snapshots carry none.
        run.endWriting();
        for (const item of itemsOf(d.items))
          if (item.type === "input") run.addInput(item.clientMessageId);
          else if (item.type === "tool") run.setTool(item);
          else if (item.type === "command" || item.type === "file_change")
            run.setActivity(item);
          else if (item.type === "skill") run.useSkill(item.slug);
          else if (item.type === "network")
            run.blockNetwork({
              ...item,
              ...reconcileBlock(item, networkOf(run.dispatch)),
            });
          else run.setItem(item.itemId, item.text, item.completed);
        const pending = new Set<string>();
        if (Array.isArray(d.approvals))
          for (const raw of d.approvals as unknown[]) {
            const approval =
              raw && typeof raw === "object"
                ? approvalOf(raw as Record<string, unknown>, "pending")
                : null;
            if (!approval) continue;
            pending.add(approval.approvalId);
            run.requestApproval(approval);
          }
        run.closeApprovalsNotIn(pending);
        for (const agent of agentsOf(d.agents)) run.setAgent(agent, "snapshot");
        if (str(d.threadId)) run.threadId = str(d.threadId);
        if (str(d.turnId)) {
          // A snapshot with a turn replaces a run.accepted no longer buffered.
          run.turnId = str(d.turnId);
          run.accept();
        }
        return null;
      }
      case "retrying":
        run.setPhase("retrying");
        return null;
      case "usage": {
        const usage = turnUsageOf(d);
        if (usage) {
          run.usage = usage;
          run.broadcast({ type: "usage", data: usage });
        }
        return null;
      }
      case "goal.updated": {
        const update = goalUpdate(d);
        if (update) this.reportGoal(run, update);
        return null;
      }
      case "run.completed":
        return this.outcomeOf(run, d, client);
      default:
        return null;
    }
  }

  // Tells the listener; its failure never changes the run.
  private reportGoal(run: LiveRun, update: GoalUpdate): void {
    const { dbName, chatId, ownerId, ref } = run.dispatch;
    const tenantId = parseWireId(ref.tenantId);
    if (!this.goalListener || !tenantId) return;
    try {
      this.goalListener({ dbName, tenantId, chatId, ownerId }, update);
    } catch (error) {
      this.logger.warn({
        message: "goal update listener failed",
        runId: run.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // The audit record of a resolved approval and, for the member's own Allow
  // for this chat, the chat allow that later runs send as approvedTools. Not
  // awaited: the reply goes on; a failure is logged (params never are).
  private recordApproval(run: LiveRun, approval: ApprovalEventData): void {
    if (approval.status === "pending") return;
    const { dbName, chatId, runId, ownerId } = run.dispatch;
    const decision = approval.status;
    const writes: Promise<void>[] = [
      this.store.recordApproval(dbName, {
        _id: approval.approvalId,
        chatId,
        runId,
        userId: ownerId,
        ...(approval.kind !== "mcp" ? { kind: approval.kind } : {}),
        connector: approval.connector,
        tool: approval.tool,
        decision,
        auto: approval.auto === true,
        params: approval.params,
        at: new Date(),
      }),
    ];
    if (decision === "allow_for_chat" && approval.auto !== true) {
      if (approval.kind === "mcp")
        writes.push(
          this.store.allowToolForChat(
            dbName,
            chatId,
            ownerId,
            approval.connector,
            approval.tool,
          ),
        );
      else if (approval.scope && approval.allowForChat)
        writes.push(
          this.store.allowCodingForChat(dbName, chatId, ownerId, {
            command: approval.scope,
          }),
        );
    }
    this.logger.log({
      message: "tool approval resolved",
      runId: run.id,
      connector: approval.connector,
      tool: approval.tool,
      decision,
      auto: approval.auto === true,
    });
    void Promise.all(writes).catch((error: unknown) =>
      this.logger.warn({
        message: "saving a tool approval failed",
        runId: run.id,
        connector: approval.connector,
        tool: approval.tool,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  // Relays a connector's state to subscribers. A server that refused the
  // owner's token marks the connection so the next run refreshes it or asks
  // the member to reconnect. Not awaited: the reply goes on without it.
  private connectorStatus(run: LiveRun, d: Record<string, unknown>): void {
    const connector = str(d.connector);
    const status =
      d.status === "starting" || d.status === "ready" || d.status === "failed"
        ? d.status
        : null;
    if (!connector || !status) return;
    const reason =
      status !== "failed"
        ? undefined
        : d.reason === "auth" || d.reason === "unreachable"
          ? d.reason
          : "unknown";
    run.broadcast({
      type: "connector",
      data: { connector, status, ...(reason ? { reason } : {}) },
    });
    if (reason !== "auth" || !this.connectors) return;
    if (run.authReported.has(connector)) return;
    run.authReported.add(connector);
    const { dbName, ownerId } = run.dispatch;
    this.connectors
      .tokenRejected(dbName, ownerId, connector)
      .catch((error: unknown) =>
        this.logger.warn({
          message: "marking a rejected connector token failed",
          runId: run.id,
          connector,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
  }

  private async outcomeOf(
    run: LiveRun,
    d: Record<string, unknown>,
    client: RuntimeClient,
  ): Promise<Settlement> {
    const status =
      d.status === "completed" || d.status === "stopped" ? d.status : "failed";
    const error = errorOf(d.error);
    const network = networkOf(run.dispatch);
    const items = namedSkills(itemsOf(d.items), run.dispatch.skills).map(
      (item) =>
        item.type === "network"
          ? { ...item, ...reconcileBlock(item, network) }
          : item,
    );
    const base = {
      items,
      usage:
        turnUsageOf(d.usage as Record<string, unknown> | null) ?? run.usage,
      threadId: str(d.threadId) ?? run.threadId,
      turnId: str(d.turnId) ?? run.turnId,
      firstTextAt: run.firstTextAt,
      ...this.finalAgents(run, d.agents),
    };
    if (status === "failed" && d.delivery === "unknown") {
      // The turn may have run anyway; its saved history decides.
      const known = await this.fromHistory(run, client).catch(() => null);
      if (known && known.status === "completed") return known;
    }
    if (status === "failed" && d.delivery === "none" && !error)
      return {
        ...base,
        status,
        error: run.dispatch.mode === "attach" ? GOAL_TURN_LOST : NOT_SENT,
        threadLost: false,
      };
    return {
      ...base,
      status,
      error: status === "failed" ? (error ?? RUNTIME_FAILED) : null,
      threadLost: error?.code === "THREAD_LOST",
    };
  }

  // The helpers as the runtime's outcome lists them (authoritative), merged
  // into what streamed, so a missed event still reaches the saved rows.
  private finalAgents(
    run: LiveRun,
    value: unknown,
  ): { agents?: AgentSettleItem[] } {
    for (const agent of agentsOf(value)) run.setAgent(agent, "snapshot");
    return run.agentField();
  }

  // The run's turn in the runtime's saved history (a member's run by its
  // message, a goal run by its turn), or null when the runtime has no trace
  // of it (for a member's run: nothing ran; posting is safe).
  private async fromHistory(
    run: LiveRun,
    client: RuntimeClient,
  ): Promise<Settlement | null> {
    const { dispatch } = run;
    let turns;
    try {
      turns = await client.history(dispatch.ref);
    } catch (error) {
      // No thread was ever created: a first message that never started.
      if (error instanceof AdapterRefusal && error.code === "THREAD_LOST")
        return dispatch.mode === "attach" || dispatch.body.threadId
          ? failed(run, THREAD_LOST, true)
          : null;
      throw error;
    }
    // The run's own message, left out of what it saves.
    const own =
      dispatch.mode === "attach" ? null : dispatch.body.input.clientMessageId;
    const turn = turns.find((t) =>
      dispatch.mode === "attach"
        ? t.turnId === dispatch.turnId
        : t.clientMessageId === own,
    );
    if (!turn) return null;
    run.flush();
    const base = {
      usage: run.usage,
      threadId: run.threadId,
      turnId: turn.turnId,
      firstTextAt: run.firstTextAt,
      threadLost: false,
      ...run.agentField(),
    };
    if (turn.status === "completed")
      return {
        ...base,
        status: "completed",
        error: null,
        items: historySettleItems(turn, own),
      };
    const items = unfinishedItems(run, turn, own);
    if (turn.status === "interrupted")
      return { ...base, status: "stopped", error: null, items };
    return { ...base, status: "failed", error: RUNTIME_FAILED, items };
  }

  // Stores files a settled run couldn't store when it ended. Null when file
  // storage or the runtime isn't configured.
  async retryFiles(
    target: CaptureTarget,
    paths: ReadonlySet<string>,
  ): Promise<CaptureResult | null> {
    if (!this.chatFiles?.configured || !this.client) return null;
    return this.chatFiles.capture(target, this.client, { only: paths });
  }

  private async finish(run: LiveRun, outcome: Settlement): Promise<void> {
    // Before anything is shown or saved: the block never reaches a saved
    // message, on the live, reconcile or recovery path (all settle here).
    outcome = withFollowUpRows(outcome, run.dispatch.followUps);
    run.flush();
    run.completed = {
      status: outcome.status,
      error: outcome.error,
      items: [...outcome.items],
      ...(outcome.agents?.length ? { agents: [...outcome.agents] } : {}),
      usage: outcome.usage,
    };
    run.broadcast({ type: "completed", data: run.completed });
    const { dbName, chatId, runId, replySeq } = run.dispatch;
    // The run's files are stored before it is saved, so a member who sees
    // the saved reply can open them. Bounded by CAPTURE_TIMEOUT_MS; a
    // file the run wrote that can't be stored is saved on the run as
    // unsaved, so the member sees it and can retry.
    if (this.chatFiles?.configured && this.client) {
      const { stored, unsaved } = await this.chatFiles.capture(
        {
          dbName,
          tenantId: run.dispatch.ref.tenantId,
          chatId,
          ownerId: run.dispatch.ownerId,
          runId,
          ref: run.dispatch.ref,
        },
        this.client,
        { report: writtenPaths(outcome.items) },
      );
      run.files = stored;
      run.unsaved = unsaved;
      if (stored.length > 0 || unsaved.length > 0)
        run.broadcast({ type: "files", data: { files: stored, unsaved } });
      if (unsaved.length > 0) outcome = { ...outcome, unsavedFiles: unsaved };
    }
    // The chat's thread is recorded before the chat is released, so the
    // next message continues it.
    await run.acceptedWrite;
    const saved = await this.store.settleWithRetry(
      dbName,
      chatId,
      runId,
      replySeq,
      outcome,
    );
    if (saved) {
      run.saved = saved;
      this.afterSettle(run, outcome);
      run.broadcast({ type: "saved", data: saved });
    } else {
      run.saveFailed = true;
      this.abandoned.add(run.id);
      run.broadcast({ type: "save_failed", data: {} });
    }
    run.phase = "settled";
    run.close();
    const timer = setTimeout(() => {
      if (this.live.get(run.id) === run) this.live.delete(run.id);
    }, SETTLED_TTL_MS);
    timer.unref();
  }

  // The run's Allow-once network grants are used up, and each refused
  // request is recorded for the audit (auto: refused by the run's policy, not
  // by the member). Not awaited; a failure is logged.
  private afterSettle(run: LiveRun, outcome: Settlement): void {
    const { dbName, chatId, runId, ownerId, networkOnce } = run.dispatch;
    const writes: Promise<void>[] = [];
    if (networkOnce?.length)
      writes.push(this.store.consumeNetworkGrants(dbName, chatId, networkOnce));
    for (const item of outcome.items) {
      if (item.type !== "network") continue;
      const key = networkKey(item);
      this.logger.log({
        message: "sandbox request blocked",
        runId: run.id,
        host: item.host,
        method: item.method,
        kind: item.kind,
        connector: item.connector?.name,
      });
      writes.push(
        this.store.recordApproval(dbName, {
          _id: `net_block_${run.id}_${key}`,
          chatId,
          runId,
          userId: ownerId,
          kind: "network",
          connector: item.connector?.name ?? "web",
          tool: `${item.method} ${item.host}`,
          decision: "deny",
          auto: true,
          params: [
            { name: "host", value: item.host },
            { name: "method", value: item.method },
            { name: "kind", value: item.kind },
          ],
          at: new Date(),
        }),
      );
    }
    if (writes.length === 0) return;
    void Promise.all(writes).catch((error: unknown) =>
      this.logger.warn({
        message: "saving network records failed",
        runId: run.id,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
  }

  // Lets live runs finish for up to `drainMs`, then detaches from the rest.
  // Their turns keep running in the runtime; the next process recovers
  // them once their leases lapse.
  async drain(drainMs = 30_000): Promise<void> {
    this.draining = true;
    const pending = [...this.live.values()].map((run) => run.done);
    await Promise.race([Promise.allSettled(pending), sleep(drainMs)]);
    for (const run of this.live.values()) {
      run.abort.abort();
      run.close();
    }
    await Promise.allSettled([...this.live.values()].map((run) => run.done));
    this.live.clear();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }
}

// Removes the suggestion block from every reply the run produced and, for a
// completed run in an "on" chat, keeps the rows from its final non-empty
// answer. Runs of holdout, off and pre-v5 chats are stripped all the same.
export function withFollowUpRows(
  outcome: Settlement,
  assignment: FollowUpsAssignment | undefined,
): Settlement {
  const items: SettleItem[] = [];
  let final: ParsedFollowUps | null = null;
  for (const item of outcome.items) {
    if (item.type !== "reply") {
      items.push(item);
      continue;
    }
    const parsed = parseFollowUps(item.text);
    if (parsed.text.trim().length > 0) final = parsed;
    items.push(
      parsed.text === item.text ? item : { ...item, text: parsed.text },
    );
  }
  if (assignment !== "on" || outcome.status !== "completed")
    return { ...outcome, items };
  return {
    ...outcome,
    items,
    followUps: final
      ? final.followUps
      : { status: "missing", shape: "unknown", stage: "unknown", items: [] },
  };
}

// The files a run's completed edits left in the chat, in edit order: added
// or updated paths and move destinations, without those it later deleted or
// moved away.
export function writtenPaths(items: readonly SettleItem[]): Set<string> {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.type !== "file_change" || item.status !== "completed") continue;
    for (const file of item.files) {
      if (file.kind === "delete") paths.delete(file.path);
      else if (file.kind === "move") {
        paths.delete(file.path);
        if (file.movePath) paths.add(file.movePath);
      } else paths.add(file.path);
    }
  }
  return paths;
}

function failed(
  run: LiveRun,
  error: RunErrorInfo,
  threadLost = false,
): Settlement {
  run.flush();
  return {
    status: "failed",
    error,
    items: run.settleItems(),
    usage: run.usage,
    threadId: run.threadId,
    turnId: run.turnId,
    firstTextAt: run.firstTextAt,
    threadLost,
    ...run.agentField(),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

// Helper agents: the adapter bounds these already; they are bounded again
// here because the runtime is a separate trust boundary.
const MAX_RUN_AGENTS = 10;
const MAX_AGENT_PATH = 120;
const MAX_AGENT_PREVIEW = 240;
const MAX_AGENT_RESULT = 4000;
const AGENT_STATUSES = new Set(["running", "completed", "failed", "stopped"]);

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

// A helper from an adapter event or list entry, or null when unreadable.
function agentOf(value: unknown): AgentSettleItem | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const agentId = str(v.agentId);
  if (!agentId) return null;
  const status =
    typeof v.status === "string" && AGENT_STATUSES.has(v.status)
      ? (v.status as AgentSettleItem["status"])
      : "running";
  const preview = boundedText(v.preview, MAX_AGENT_PREVIEW);
  const result = boundedText(v.result, MAX_AGENT_RESULT);
  const usage = usageOf(v.usage);
  return {
    agentId,
    path: boundedText(v.path, MAX_AGENT_PATH) ?? "",
    status,
    ...(preview !== undefined ? { preview } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(usage ? { usage } : {}),
  };
}

function agentsOf(value: unknown): AgentSettleItem[] {
  if (!Array.isArray(value)) return [];
  const agents: AgentSettleItem[] = [];
  for (const entry of value.slice(0, MAX_RUN_AGENTS)) {
    const agent = agentOf(entry);
    if (agent) agents.push(agent);
  }
  return agents;
}

// A tool call from an adapter event or item, or null when unreadable.
function toolOf(value: Record<string, unknown>): ToolSettleItem | null {
  const itemId = str(value.itemId);
  const connector = str(value.connector);
  const tool = str(value.tool);
  const status =
    value.status === "inProgress" ||
    value.status === "completed" ||
    value.status === "failed"
      ? value.status
      : null;
  if (!itemId || !connector || !tool || !status) return null;
  const durationMs =
    typeof value.durationMs === "number" &&
    Number.isSafeInteger(value.durationMs) &&
    value.durationMs >= 0
      ? value.durationMs
      : undefined;
  const errorCode =
    status === "failed"
      ? typeof value.errorCode === "string" &&
        TOOL_ERROR_CODES.has(value.errorCode)
        ? value.errorCode
        : "UNKNOWN"
      : undefined;
  const approval = APPROVAL_DECISIONS.includes(
    value.approval as ApprovalDecision,
  )
    ? (value.approval as ApprovalDecision)
    : undefined;
  return {
    type: "tool",
    itemId,
    connector,
    tool,
    status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(approval ? { approval } : {}),
  };
}

const ACTIVITY_STATUS = new Set([
  "inProgress",
  "completed",
  "failed",
  "declined",
]);
const FILE_KINDS = new Set(["add", "update", "delete", "move"]);

// A command or file change from an adapter event or item, or null when
// unreadable. Text is bounded here so the platform is safe on its own.
function activityOf(value: Record<string, unknown>): ActivityItem | null {
  const itemId = str(value.itemId);
  const status = ACTIVITY_STATUS.has(value.status as string)
    ? (value.status as ActivityItem["status"])
    : null;
  if (!itemId || !status) return null;
  const approval = APPROVAL_DECISIONS.includes(
    value.approval as ApprovalDecision,
  )
    ? { approval: value.approval as ApprovalDecision }
    : {};
  if (value.type === "command") {
    if (typeof value.command !== "string" || !value.command) return null;
    const output = typeof value.output === "string" ? value.output : "";
    const int = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) ? v : undefined;
    const exitCode = int(value.exitCode);
    const durationMs = int(value.durationMs);
    return {
      type: "command",
      itemId,
      command: value.command.slice(0, MAX_ACTIVITY_COMMAND),
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
      output: output.slice(0, MAX_LIVE_OUTPUT),
      outputTruncated:
        value.outputTruncated === true || output.length > MAX_LIVE_OUTPUT,
      ...approval,
    };
  }
  const files: FileChangeSettleItem["files"][number][] = [];
  if (Array.isArray(value.files))
    for (const raw of value.files as Array<Record<string, unknown> | null>) {
      if (files.length >= MAX_ACTIVITY_FILES) break;
      if (
        typeof raw?.path !== "string" ||
        !raw.path ||
        !FILE_KINDS.has(raw.kind as string)
      )
        continue;
      files.push({
        path: raw.path.slice(0, MAX_ACTIVITY_PATH),
        kind: raw.kind as "add" | "update" | "delete" | "move",
        ...(typeof raw.movePath === "string"
          ? { movePath: raw.movePath.slice(0, MAX_ACTIVITY_PATH) }
          : {}),
      });
    }
  return { type: "file_change", itemId, files, status, ...approval };
}

// File-change progress from an adapter event, or null when malformed.
function progressOf(value: Record<string, unknown>): ProgressEventData | null {
  const itemId = str(value.itemId);
  if (!itemId) return null;
  if (value.ended === true) return { itemId, ended: true };
  const lines = value.lines;
  if (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 0)
    return null;
  const item = activityOf({
    ...value,
    type: "file_change",
    status: "inProgress",
  });
  if (item?.type !== "file_change" || item.files.length === 0) return null;
  const preview = previewOf(value.preview);
  return { itemId, files: item.files, lines, ...(preview ? { preview } : {}) };
}

function previewOf(value: unknown): FilePreview | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (
    typeof p.path !== "string" ||
    p.path.length === 0 ||
    p.path.length > MAX_ACTIVITY_PATH ||
    typeof p.text !== "string" ||
    typeof p.offset !== "number" ||
    !Number.isSafeInteger(p.offset) ||
    p.offset < 0 ||
    p.offset + p.text.length > MAX_PREVIEW_CHARS
  )
    return undefined;
  return {
    path: p.path,
    offset: p.offset,
    text: p.text,
    truncated: p.truncated === true,
  };
}

// At most this many card params, each value cut to this length. The adapter
// bounds them already; this keeps the platform safe on its own.
const MAX_APPROVAL_PARAMS = 12;
const MAX_APPROVAL_PARAM_CHARS = 500;
// A command is shown whole on its card (the runtime declines longer ones).
const MAX_APPROVAL_COMMAND_CHARS = 4_000;
const MAX_APPROVAL_DIFF = 16_000;

// An approval from an adapter event (or snapshot entry), or null when
// unreadable. `pending` reads a request; `resolved` needs a known decision.
function approvalOf(
  value: Record<string, unknown>,
  kind: "pending" | "resolved",
): ApprovalEventData | null {
  const approvalId = str(value.approvalId);
  const itemId = str(value.itemId);
  const connector = str(value.connector);
  const tool = str(value.tool);
  if (!approvalId || !itemId || !connector || !tool) return null;
  const params: ApprovalEventData["params"] = [];
  if (Array.isArray(value.params))
    for (const raw of value.params as unknown[]) {
      if (params.length >= MAX_APPROVAL_PARAMS) break;
      const p = raw as { name?: unknown; value?: unknown } | null;
      const name = typeof p?.name === "string" ? p.name.slice(0, 64) : "";
      if (!name || typeof p?.value !== "string") continue;
      params.push({
        name,
        value: p.value.slice(
          0,
          value.kind === "command" && name === "command"
            ? MAX_APPROVAL_COMMAND_CHARS
            : MAX_APPROVAL_PARAM_CHARS,
        ),
      });
    }
  const approvalKind: ApprovalEventData["kind"] =
    value.kind === "command" || value.kind === "file_change"
      ? value.kind
      : "mcp";
  // A command or file change may only come from the workspace; anything
  // else claiming those kinds is not trusted as one.
  if (approvalKind !== "mcp" && connector !== "@workspace") return null;
  const scope =
    typeof value.scope === "string" &&
    /^[0-9a-f]{64}$|^file_change$/.test(value.scope)
      ? { scope: value.scope }
      : {};
  const base = {
    approvalId,
    itemId,
    kind: approvalKind,
    connector,
    tool,
    params,
    allowForChat: value.allowForChat !== false,
    ...scope,
    ...(approvalKind === "file_change" && typeof value.diff === "string"
      ? {
          diff: value.diff.slice(0, MAX_APPROVAL_DIFF),
          diffTruncated:
            value.diffTruncated === true ||
            value.diff.length > MAX_APPROVAL_DIFF,
        }
      : {}),
  };
  if (kind === "pending") {
    const expiresAt =
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? new Date(value.expiresAt).toISOString()
        : undefined;
    return { ...base, status: "pending", ...(expiresAt ? { expiresAt } : {}) };
  }
  if (!APPROVAL_DECISIONS.includes(value.decision as ApprovalDecision))
    return null;
  return {
    ...base,
    status: value.decision as ApprovalDecision,
    auto: value.auto === true,
  };
}

// The adapter's ordered items: replies `{type: "reply", itemId, text,
// completed}`, tool calls `{type: "tool", …}` and steers `{type: "input",
// clientMessageId}`. An entry with no type is a reply, as an adapter that
// predates steering sends it.
function itemsOf(value: unknown): SettleItem[] {
  if (!Array.isArray(value)) return [];
  const items: SettleItem[] = [];
  for (const item of value as Array<Record<string, unknown> | null>) {
    if (!item) continue;
    if (item.type === "tool") {
      const tool = toolOf(item);
      if (tool) items.push(tool);
      continue;
    }
    if (item.type === "command" || item.type === "file_change") {
      const activity = activityOf(item);
      if (activity) items.push(activity);
      continue;
    }
    if (item.type === "input") {
      const clientMessageId = str(item.clientMessageId);
      if (clientMessageId) items.push({ type: "input", clientMessageId });
      continue;
    }
    if (item.type === "network") {
      const block = networkBlockOf(item);
      if (block) items.push({ type: "network", ...block });
      continue;
    }
    if (item.type === "skill") {
      // Named from the chat's snapshot by LiveRun.useSkill.
      const slug = str(item.slug);
      if (slug) items.push({ type: "skill", slug, name: slug });
      continue;
    }
    const itemId = str(item.itemId);
    if (itemId && typeof item.text === "string")
      items.push({
        type: "reply",
        itemId,
        text: item.text,
        completed: item.completed === true,
      });
  }
  return items;
}

// A finished turn's items from the runtime's saved history, without the
// run's own message (null for a goal run). Reply IDs are
// history:<turnId>:<n>.
function historySettleItems(
  turn: HistoryTurn,
  own: string | null,
): SettleItem[] {
  if (!turn.items)
    return [
      {
        type: "reply",
        itemId: `history:${turn.turnId}`,
        text: turn.text,
        completed: true,
      },
    ];
  let replies = 0;
  return turn.items.flatMap((item): SettleItem[] => {
    if (item.type === "reply")
      return [
        {
          type: "reply",
          itemId: `history:${turn.turnId}:${replies++}`,
          text: item.text,
          completed: true,
        },
      ];
    return item.clientMessageId && item.clientMessageId !== own
      ? [{ type: "input", clientMessageId: item.clientMessageId }]
      : [];
  });
}

// A stopped or failed turn. The runtime's history drops partial text, so
// what this process streamed is used when it saw every steer the runtime
// used; otherwise the history, plus the reply being written when it ended.
function unfinishedItems(
  run: LiveRun,
  turn: HistoryTurn,
  own: string | null,
): SettleItem[] {
  const live = run.settleItems();
  if (!turn.items) return live;
  const history = historySettleItems(turn, own);
  const sawAll = history.every(
    (item) => item.type !== "input" || run.hasInput(item.clientMessageId),
  );
  if (sawAll && live.length) return live;
  const partial = run.trailingPartial();
  return partial ? [...history, partial] : history;
}

// The policy a run's network blocks are shown against. A goal run was not
// posted with one, so its blocks offer no grant.
function networkOf(dispatch: Dispatch): RunNetworkPolicy | undefined {
  return dispatch.mode === "attach" ? undefined : dispatch.body.network;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

// The whole turn's usage (every model call summed by the adapter); older
// adapters only report the latest call.
function turnUsageOf(
  usage: Record<string, unknown> | null | undefined,
): RunUsage | null {
  return usageOf(usage?.turn) ?? usageOf(usage?.last);
}

function usageOf(value: unknown): RunUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  return {
    input: count(u.inputTokens),
    cached: count(u.cachedInputTokens),
    cacheWrite: count(u.cacheWriteInputTokens),
    output: count(u.outputTokens),
    reasoning: count(u.reasoningOutputTokens),
  };
}

// What members see for each runtime failure. Messages are the platform's
// own, never text from the adapter or a provider.
const RUN_ERRORS: Record<string, Omit<RunErrorInfo, "code">> = {
  MODEL_TIMEOUT: {
    message: "The model didn't respond in time. Try again.",
    retryable: true,
  },
  CONTEXT_FULL: {
    message: "This conversation is too long for the model. Start a new chat.",
    retryable: false,
  },
  RATE_LIMITED: {
    message: "The model is rate limited right now. Try again shortly.",
    retryable: true,
  },
  PROVIDER_ERROR: {
    message: "The model provider returned an error. Try again.",
    retryable: true,
  },
  RUNTIME_ERROR: {
    message: "The assistant stopped unexpectedly. Try again.",
    retryable: true,
  },
  RUNTIME_SHUTDOWN: {
    message: "The assistant restarted before finishing. Try again.",
    retryable: true,
  },
  THREAD_LOST: { message: THREAD_LOST.message, retryable: false },
  THREAD_MISMATCH: {
    message: "This conversation can't continue here. Start a new chat.",
    retryable: false,
  },
  SUBAGENT_LIMIT: {
    message:
      "This needed more helper agents than one reply allows. Try a narrower request.",
    retryable: false,
  },
};

function errorOf(value: unknown): RunErrorInfo | null {
  if (!value || typeof value !== "object") return null;
  const code = str((value as Record<string, unknown>).code);
  const known = code ? RUN_ERRORS[code] : undefined;
  return code && known ? { code, ...known } : RUNTIME_FAILED;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// The skills a SKILLS_MISSING refusal names, or all of them when it names
// none this chat knows.
function missingOf(
  error: AdapterRefusal,
  skills: readonly ChatSkill[],
): readonly ChatSkill[] {
  const named = error.details?.missing;
  const missing = Array.isArray(named)
    ? skills.filter((skill) => named.includes(skill.sha256))
    : [];
  return missing.length ? missing : skills;
}

// Skill items named as the chat's snapshot names them; a slug the chat
// doesn't have is dropped.
function namedSkills(
  items: readonly SettleItem[],
  skills: readonly ChatSkill[] | undefined,
): SettleItem[] {
  return items.flatMap((item): SettleItem[] => {
    if (item.type !== "skill") return [item];
    const skill = skills?.find((entry) => entry.slug === item.slug);
    return skill ? [{ ...item, name: skill.displayName }] : [];
  });
}

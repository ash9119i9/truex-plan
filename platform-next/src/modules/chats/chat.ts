import { createHash } from "node:crypto";
import type { IndexDescription, ObjectId } from "mongodb";
import { invalid, objectWith } from "../../common/validation";
import { parseWireId } from "../../database/object-id";

// Chats, their messages and runs, in the tenant database. A chat belongs to
// one member and is never visible to anyone else, admins included; every
// query filters by ownerId.
export const CHATS_COLLECTION = "chats";
export const MESSAGES_COLLECTION = "messages";
export const RUNS_COLLECTION = "runs";
// One audit record per resolved write-tool approval.
export const TOOL_APPROVALS_COLLECTION = "tool_approvals";

// Built when the tenant is provisioned (see tenant-indexes.ts), never during
// a request. The unique ones are what make retried sends idempotent.
export const CHAT_INDEXES: Readonly<Record<string, IndexDescription[]>> = {
  [CHATS_COLLECTION]: [
    // A retried first send finds the chat it created.
    {
      key: { ownerId: 1, createdByMessageId: 1 },
      name: "owner_first_message_unique",
      unique: true,
    },
    // The sidebar: newest first, cursor-paginated.
    {
      key: { ownerId: 1, status: 1, lastMessageAt: -1, _id: -1 },
      name: "owner_recent",
    },
    // The recovery sweep: chats whose run's lease lapsed. Only answering
    // chats are in it, so it stays small however many chats there are.
    {
      key: { "activeRun.leaseExpiresAt": 1 },
      name: "active_lease",
      partialFilterExpression: {
        "activeRun.leaseExpiresAt": { $type: "date" },
      },
    },
  ],
  [MESSAGES_COLLECTION]: [
    { key: { chatId: 1, seq: 1 }, name: "chat_seq_unique", unique: true },
    {
      key: { chatId: 1, clientMessageId: 1 },
      name: "chat_client_message_unique",
      unique: true,
      partialFilterExpression: { clientMessageId: { $type: "string" } },
    },
    {
      key: { runId: 1, runtimeItemId: 1 },
      name: "run_item_unique",
      unique: true,
      partialFilterExpression: { runtimeItemId: { $type: "string" } },
    },
  ],
  [RUNS_COLLECTION]: [{ key: { chatId: 1, _id: -1 }, name: "by_chat" }],
  // _id is the adapter's approvalId, so a replayed resolution is one record.
  [TOOL_APPROVALS_COLLECTION]: [
    { key: { chatId: 1, at: -1 }, name: "by_chat" },
    { key: { userId: 1, at: -1 }, name: "by_user" },
  ],
};

export const MAX_MESSAGE_CHARS = 32_000;
export const TITLE_CHARS = 60;
export const MAX_TITLE_CHARS = 120;
export const HISTORY_PAGE = 50;
export const CHAT_LIST_PAGE = 30;
// Sends per member per minute, across their chats. Steers count too.
export const SENDS_PER_MINUTE = 20;
// Messages a member can add to one reply while it is being written.
export const STEERS_PER_RUN = 5;
// The base prompt version every user agent's prompt is built from.
export const PLATFORM_INSTRUCTIONS_VERSION = "v4";

export type AgentSource = "builtin" | "personal" | "tenant";

// Whether the chat's Codex thread can take another turn. History stays
// readable in every state.
//   none:  no thread yet (the first run has not been accepted)
//   ready: the thread exists
//   lost:  the thread's runtime storage is gone; the chat is read-only
export type RuntimeState = "none" | "ready" | "lost";

export interface ActiveRun {
  runId: ObjectId;
  // Pushed forward while a platform process streams the run. A run past its
  // lease that no process holds is recovered on the next access or by the
  // recovery sweep.
  leaseExpiresAt: Date;
}

// A connector the chat snapshotted from its agent at start, pinned by catalog
// ID with the slug kept to build the run's MCP specs and the chat view.
// `access` is absent for read_write (so chats created before write access keep
// their meaning); read_only removes the connector's write tools from the run.
export interface ChatConnector {
  connectorId: ObjectId;
  slug: string;
  access?: "read_only";
}

// One tool a member allowed for the whole chat (Allow for this chat). Sent to
// the adapter as approvedTools so its later calls run without a card. Bounded
// (≤ MAX_CHAT_TOOL_APPROVALS); $addToSet keeps it free of duplicates.
export interface ChatToolApproval {
  connector: string;
  tool: string;
  at: Date;
}

// At most this many per-chat tool approvals; a member cannot grow the set
// without bound by repeatedly allowing distinct tools.
export const MAX_CHAT_TOOL_APPROVALS = 50;

export interface ChatDoc {
  _id: ObjectId;
  ownerId: ObjectId;
  title: string;
  // References only. The thread keeps the prompt it started with, so later
  // agent edits reach new chats only.
  agent: { source: AgentSource; id: ObjectId; revision: number };
  // The chat's own pin: the agent's model may change later.
  model: { id: ObjectId; revision: number };
  // The connectors the resolved agent had at chat start, snapshotted so an
  // agent edit never changes a running chat's tools. Absent on chats created
  // before connectors existed, read as [] everywhere.
  connectors?: ChatConnector[];
  // Tools the member allowed for this whole chat (Allow for this chat), sent
  // to the adapter as approvedTools. Absent on chats with none; grown by
  // $addToSet when an approval resolves allow_for_chat (non-auto).
  toolApprovals?: ChatToolApproval[];
  platformInstructionsVersion: string;
  runtime: { threadId: string | null; state: RuntimeState };
  activeRun: ActiveRun | null;
  // Next message order number, taken inside the transaction that inserts.
  nextSeq: number;
  status: "active" | "archived";
  // The first message's clientMessageId, so a retried first send returns
  // this chat instead of creating another.
  createdByMessageId: string;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageRole = "user" | "assistant" | "tool";
// complete: saved in full; stopped: the user stopped the reply, partial text
// kept; failed: the reply failed, partial text (if any) kept.
// interrupted: a reply cut short by the member's next message (a steer); the
// partial text is kept but the model never saw it.
// not_sent: a message the member added to a reply (a steer) that the
// assistant never read.
export type MessageState =
  "complete" | "stopped" | "failed" | "interrupted" | "not_sent";

// The summary of one directory-connector tool call, saved on a role `tool`
// message. Arguments and results are never stored (data-handling, v1); only
// the connector, tool title, outcome and duration.
export interface MessageTool {
  connector: string;
  name: string;
  status: "completed" | "failed";
  durationMs?: number;
  errorCode?: string;
  // The approval decision for a write-tool call, when one was requested:
  // allow, allow_for_chat, deny, expired or cancelled. Absent for a read-only
  // call that needed no approval.
  approval?: ApprovalDecision;
}

export interface MessageDoc {
  _id: ObjectId;
  chatId: ObjectId;
  ownerId: ObjectId;
  seq: number;
  runId: ObjectId;
  role: MessageRole;
  text: string;
  state: MessageState;
  // User messages: the browser's ID, unique per chat.
  clientMessageId?: string;
  textHash?: string;
  // Assistant and tool messages: the runtime item, unique per run.
  runtimeItemId?: string;
  // Tool messages only: the connector-tool-call summary.
  tool?: MessageTool;
  createdAt: Date;
}

// accepted: saved, not yet acknowledged by the runtime
// running: the runtime accepted the turn
// completed / stopped / failed: settled
// uncertain: a request went out and its answer was lost; reconciled from the
//   runtime's history, never resent automatically
export type RunStatus =
  "accepted" | "running" | "completed" | "stopped" | "failed" | "uncertain";

export interface RunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RunUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface RunTimings {
  acceptedAt: Date;
  dispatchedAt?: Date;
  firstTextAt?: Date;
  completedAt?: Date;
}

// A message the member added to a reply while it was being written. Saved on
// the run before it goes to the runtime; settle turns it into a message, in
// the place the runtime used it, or `not_sent`.
export interface SteerDoc {
  clientMessageId: string;
  text: string;
  textHash: string;
  createdAt: Date;
}

export interface RunDoc {
  _id: ObjectId;
  chatId: ObjectId;
  ownerId: ObjectId;
  userMessageId: ObjectId;
  clientMessageId: string;
  status: RunStatus;
  threadId?: string;
  turnId?: string;
  error?: RunErrorInfo;
  usage?: RunUsage;
  timings: RunTimings;
  stopRequested?: boolean;
  // At most STEERS_PER_RUN, in arrival order.
  steers?: SteerDoc[];
  createdAt: Date;
  updatedAt: Date;
}

// The audit record of one write-tool approval: who, which tool, what the
// card showed and how it ended. `auto` marks one answered by an earlier
// Allow for this chat. Params are the card's bounded name/value list; they
// are never logged.
export interface ToolApprovalDoc {
  _id: string;
  chatId: ObjectId;
  runId: ObjectId;
  userId: ObjectId;
  connector: string;
  tool: string;
  decision: ApprovalDecision;
  auto: boolean;
  params: Array<{ name: string; value: string }>;
  at: Date;
}

// The member's answers to an approval card, and how an approval can end.
export type ApprovalAnswer = "allow" | "allow_for_chat" | "deny";
export type ApprovalDecision = ApprovalAnswer | "expired" | "cancelled";
export const APPROVAL_ANSWERS: readonly ApprovalAnswer[] = [
  "allow",
  "allow_for_chat",
  "deny",
];
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  ...APPROVAL_ANSWERS,
  "expired",
  "cancelled",
];

export function isSettled(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Control characters and the bidi embedding/override/isolate controls, which
// reorder what is shown. Other format characters stay: emoji sequences, many
// scripts (ZWJ/ZWNJ) and right-to-left text (direction marks) need them.
const UNSAFE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;

function clientMessageId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID.test(value))
    invalid('clientMessageId must be 8-64 letters, digits, "_" or "-".');
  return value;
}

// Keeps the text as typed (newlines, tabs, inner spacing) after NFC;
// refuses other control characters and bidi overrides.
function messageText(value: unknown): string {
  if (typeof value !== "string") invalid("text must be a string.");
  const text = value.normalize("NFC");
  if (text.trim().length === 0 || text.length > MAX_MESSAGE_CHARS)
    invalid(`text must be 1-${MAX_MESSAGE_CHARS} characters.`);
  if (UNSAFE.test(text.replace(/[\n\r\t]/g, "")))
    invalid("text contains unsupported control characters.");
  return text;
}

export interface SendInput {
  clientMessageId: string;
  text: string;
}

export interface StartChatInput extends SendInput {
  agentId: ObjectId;
}

export function parseSend(body: unknown): SendInput {
  const raw = objectWith(body, ["clientMessageId", "text"], "Request body");
  return {
    clientMessageId: clientMessageId(raw.clientMessageId),
    text: messageText(raw.text),
  };
}

export function parseStartChat(body: unknown): StartChatInput {
  const raw = objectWith(
    body,
    ["clientMessageId", "text", "agentId"],
    "Request body",
  );
  const agentId = parseWireId(raw.agentId);
  if (!agentId) invalid("agentId must be an agent ID.");
  return {
    agentId,
    clientMessageId: clientMessageId(raw.clientMessageId),
    text: messageText(raw.text),
  };
}

export function parseApprovalAnswer(body: unknown): ApprovalAnswer {
  const raw = objectWith(body, ["decision"], "Request body");
  if (!APPROVAL_ANSWERS.includes(raw.decision as ApprovalAnswer))
    invalid(`decision must be one of: ${APPROVAL_ANSWERS.join(", ")}.`);
  return raw.decision as ApprovalAnswer;
}

// The adapter's approval IDs ("ap_" + a UUID); anything else is unknown.
const APPROVAL_ID = /^ap_[0-9a-f-]{36}$/;

export function isApprovalId(value: string): boolean {
  return APPROVAL_ID.test(value);
}

export function parseRename(body: unknown): string {
  const raw = objectWith(body, ["title"], "Request body");
  if (typeof raw.title !== "string") invalid("title must be a string.");
  const title = raw.title.normalize("NFC").trim();
  if (!title || title.length > MAX_TITLE_CHARS || UNSAFE.test(title))
    invalid(`title must be 1-${MAX_TITLE_CHARS} visible characters.`);
  return title;
}

// The first 60 characters of the first message, on one line.
export function titleOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= TITLE_CHARS
    ? line
    : `${chars
        .slice(0, TITLE_CHARS - 1)
        .join("")
        .trimEnd()}…`;
}

export function textHashOf(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

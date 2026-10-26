import { createHash } from "node:crypto";
import type { IndexDescription, ObjectId } from "mongodb";
import { invalid, objectWith } from "../../common/validation";
import { parseWireId } from "../../database/object-id";
import type {
  ChatNetworkGrant,
  MessageNetwork,
} from "../network/network-grants";
import type { ChatSkill } from "../skills/skill";
import type { FollowUpSet } from "./followups";

// Chats, their messages and runs, in the tenant database. A chat belongs to
// one member and is never visible to anyone else, admins included; every
// query filters by ownerId.
export const CHATS_COLLECTION = "chats";
export const MESSAGES_COLLECTION = "messages";
export const RUNS_COLLECTION = "runs";
// One audit record per resolved write-tool approval.
export const TOOL_APPROVALS_COLLECTION = "tool_approvals";
// One record per stored version of a file a chat's run produced; the bytes
// are in S3 (chat-files.ts).
export const CHAT_FILES_COLLECTION = "chat_files";
// Files members attached, staged before their message is sent
// (chat-uploads.ts).
export const CHAT_UPLOADS_COLLECTION = "chat_uploads";

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
  [RUNS_COLLECTION]: [
    { key: { chatId: 1, _id: -1 }, name: "by_chat" },
    // The Follow Up report: runs that carry a set, newest window first.
    {
      key: { createdAt: 1 },
      name: "followups_created",
      partialFilterExpression: { followUps: { $exists: true } },
    },
  ],
  // _id is the adapter's approvalId, so a replayed resolution is one record.
  [TOOL_APPROVALS_COLLECTION]: [
    { key: { chatId: 1, at: -1 }, name: "by_chat" },
    { key: { userId: 1, at: -1 }, name: "by_user" },
  ],
  [CHAT_FILES_COLLECTION]: [
    // A path's versions, newest first; unique so two captures of one run
    // can't both store the same version.
    {
      key: { chatId: 1, path: 1, version: -1 },
      name: "chat_path_version_unique",
      unique: true,
    },
  ],
  [CHAT_UPLOADS_COLLECTION]: [
    // The per-member cap on staged uploads.
    { key: { ownerId: 1, state: 1 }, name: "owner_state" },
    // Staged uploads never sent go after a day; sent ones have no expiresAt.
    { key: { expiresAt: 1 }, name: "staged_ttl", expireAfterSeconds: 0 },
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
export const PLATFORM_INSTRUCTIONS_VERSION = "v5";

// Whether a chat asks the model for Follow Up rows. Decided once when the
// chat is created: a holdout never flips mid-chat.
export type FollowUpsAssignment = "on" | "holdout" | "off";

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

// What a member allowed for the whole chat on coding cards. `commands` are
// the sha256 scopes the runtime gave (each re-allows that exact command).
// File changes inside the chat never ask. Sent to the runtime as
// codingApprovals. Push is never in it.
export interface ChatCodingApprovals {
  commands?: string[];
}

export const MAX_CHAT_COMMAND_APPROVALS = 50;

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
  // The skill versions the agent's enabled skills had at chat start. Later
  // publishes or disables never change them. Absent on chats without skills.
  skills?: ChatSkill[];
  // Tools the member allowed for this whole chat (Allow for this chat), sent
  // to the adapter as approvedTools. Absent on chats with none; grown by
  // $addToSet when an approval resolves allow_for_chat (non-auto).
  toolApprovals?: ChatToolApproval[];
  // Absent on chats with none.
  codingApprovals?: ChatCodingApprovals;
  // The owner's allows on network cards (network-grants.ts), at most
  // MAX_CHAT_NETWORK_GRANTS. Absent on chats with none.
  networkGrants?: ChatNetworkGrant[];
  // Bytes of every file members attached to the chat's messages, for the
  // per-chat cap. Absent on chats with none.
  uploadBytes?: number;
  platformInstructionsVersion: string;
  // Absent on chats created before v5; read as "off".
  followUps?: FollowUpsAssignment;
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

// A skill the assistant opened during a reply, saved on a role `tool`
// message: shown as "Used skill <name>". Nothing of what it read is kept.
export interface MessageSkill {
  slug: string;
  name: string;
}

// A command or file change the assistant made in the chat's workspace, saved
// on a role `tool` message. The command and file paths are what the member
// approved; output is a bounded preview.
export type MessageActivity =
  | {
      kind: "command";
      command: string;
      status: ActivityStatus;
      exitCode?: number;
      durationMs?: number;
      output: string;
      outputTruncated: boolean;
      approval?: ApprovalDecision;
    }
  | {
      kind: "file_change";
      files: ActivityFile[];
      status: ActivityStatus;
      approval?: ApprovalDecision;
    };

// declined: denied (or expired/cancelled) before it ran.
export type ActivityStatus = "completed" | "failed" | "declined";

export interface ActivityFile {
  path: string;
  kind: "add" | "update" | "delete" | "move";
  movePath?: string;
}

// Bounds on what an activity message keeps.
export const MAX_ACTIVITY_COMMAND = 4_000;
export const MAX_ACTIVITY_OUTPUT = 4_000;
export const MAX_ACTIVITY_FILES = 50;
export const MAX_ACTIVITY_PATH = 512;

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
  // Tool messages only: a command or file change instead of a connector call.
  activity?: MessageActivity;
  // Tool messages only: a skill the reply used.
  skill?: MessageSkill;
  // Tool messages only: a sandbox request the network proxy refused.
  network?: MessageNetwork;
  // User messages only: the files attached to it, in order. Each is a stored
  // chat file (its upload version) the run copies into the workspace first.
  attachments?: MessageAttachment[];
  createdAt: Date;
}

export interface MessageAttachment {
  // The chat_files version holding the bytes.
  fileId: ObjectId;
  name: string;
  // Workspace-relative: "uploads/<name>".
  path: string;
  size: number;
  contentType: string;
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

// The rows a completed reply offered, stripped from its saved text. Only
// written for completed runs in chats whose followUps is "on".
export interface RunFollowUps {
  status: FollowUpSet["status"];
  shape: string;
  stage: string;
  items: FollowUpSet["items"];
}

// A run the member started from a Follow Up row. Analytics only; the report
// verifies it against the suggesting run's stored rows.
export interface RunOrigin {
  source: "suggestion";
  fromRunId: ObjectId;
  slot: number;
}

export interface RunDoc {
  _id: ObjectId;
  chatId: ObjectId;
  ownerId: ObjectId;
  userMessageId: ObjectId;
  clientMessageId: string;
  status: RunStatus;
  followUps?: RunFollowUps;
  origin?: RunOrigin;
  threadId?: string;
  turnId?: string;
  error?: RunErrorInfo;
  usage?: RunUsage;
  timings: RunTimings;
  stopRequested?: boolean;
  // At most STEERS_PER_RUN, in arrival order.
  steers?: SteerDoc[];
  // Files the run wrote that couldn't be stored when it ended (at most
  // MAX_UNSAVED), until a retry stores them. Absent when there are none.
  unsavedFiles?: string[];
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
  // Absent for a connector tool call (records before coding had none).
  // network: the owner's answer to a network card, or (auto) the block.
  kind?: "command" | "file_change" | "network";
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
  // Empty only when the message has attachments.
  text: string;
  // Staged upload IDs, in order; at most MAX_MESSAGE_ATTACHMENTS.
  attachments: ObjectId[];
  // Set when the message started from a Follow Up row. Analytics only: it is
  // stored as given and the report verifies it against the stored rows.
  followUp?: { fromRunId: ObjectId; slot: number };
}

export const MAX_MESSAGE_ATTACHMENTS = 10;

// IDs of staged uploads, unique, in order. Absent means none.
function attachmentIds(value: unknown): ObjectId[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ATTACHMENTS)
    invalid(
      `attachments must be a list of at most ${MAX_MESSAGE_ATTACHMENTS} upload IDs.`,
    );
  const ids: ObjectId[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = parseWireId(item);
    if (!id) invalid("attachments must be upload IDs.");
    if (seen.has(id.toHexString())) invalid("attachments repeats an upload.");
    seen.add(id.toHexString());
    ids.push(id);
  }
  return ids;
}

// Message text, or "" when files are attached and nothing was typed.
function sentText(value: unknown, attachments: readonly ObjectId[]): string {
  if (
    attachments.length > 0 &&
    (value === undefined || (typeof value === "string" && !value.trim()))
  )
    return "";
  return messageText(value);
}

export interface StartChatInput extends SendInput {
  agentId: ObjectId;
}

// A Follow Up claim. The shape is checked; whether the run and slot exist is
// verified later by the report, so the send path adds no database read.
function followUpOf(value: unknown): SendInput["followUp"] {
  if (value === undefined) return undefined;
  const raw = objectWith(value, ["fromRunId", "slot"], "followUp");
  const fromRunId = parseWireId(raw.fromRunId);
  if (!fromRunId) invalid("followUp.fromRunId must be a run ID.");
  const slot = raw.slot;
  if (
    typeof slot !== "number" ||
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > 3
  )
    invalid("followUp.slot must be 1, 2 or 3.");
  return { fromRunId, slot };
}

export function parseSend(body: unknown): SendInput {
  const raw = objectWith(
    body,
    ["clientMessageId", "text", "attachments", "followUp"],
    "Request body",
  );
  const attachments = attachmentIds(raw.attachments);
  const followUp = followUpOf(raw.followUp);
  return {
    clientMessageId: clientMessageId(raw.clientMessageId),
    text: sentText(raw.text, attachments),
    attachments,
    ...(followUp ? { followUp } : {}),
  };
}

export function parseStartChat(body: unknown): StartChatInput {
  const raw = objectWith(
    body,
    ["clientMessageId", "text", "agentId", "attachments"],
    "Request body",
  );
  const agentId = parseWireId(raw.agentId);
  if (!agentId) invalid("agentId must be an agent ID.");
  const attachments = attachmentIds(raw.attachments);
  return {
    agentId,
    clientMessageId: clientMessageId(raw.clientMessageId),
    text: sentText(raw.text, attachments),
    attachments,
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

// A chat started with files and no text is named after them, each name once:
// two "notes.txt" files read as "notes.txt", not "notes.txt, notes.txt".
export function titleOfFiles(names: readonly string[]): string {
  return titleOf([...new Set(names)].join(", "));
}

export function textHashOf(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

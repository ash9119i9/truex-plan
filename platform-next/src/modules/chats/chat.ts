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
};

export const MAX_MESSAGE_CHARS = 32_000;
export const TITLE_CHARS = 60;
export const MAX_TITLE_CHARS = 120;
export const HISTORY_PAGE = 50;
export const CHAT_LIST_PAGE = 30;
// Sends per member per minute, across their chats.
export const SENDS_PER_MINUTE = 20;
// The base prompt version every user agent's prompt is built from.
export const PLATFORM_INSTRUCTIONS_VERSION = "v1";

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
  // lease that no process holds is recovered on the next access.
  leaseExpiresAt: Date;
}

export interface ChatDoc {
  _id: ObjectId;
  ownerId: ObjectId;
  title: string;
  // References only. The thread keeps the prompt it started with, so later
  // agent edits reach new chats only.
  agent: { source: AgentSource; id: ObjectId; revision: number };
  // The chat's own pin: the agent's model may change later.
  model: { id: ObjectId; revision: number };
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

export type MessageRole = "user" | "assistant";
// complete: saved in full; stopped: the user stopped the reply, partial text
// kept; failed: the reply failed, partial text (if any) kept.
export type MessageState = "complete" | "stopped" | "failed";

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
  // Assistant messages: the runtime item, unique per run.
  runtimeItemId?: string;
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
  createdAt: Date;
  updatedAt: Date;
}

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

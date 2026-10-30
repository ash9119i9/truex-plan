// Chats in the tenant workspace (platform-next /api/v1/chats). Wire parsers,
// thin API wrappers and the pure state changes the chat screen applies, so
// the components only render. Every request names this tab's tenant through
// api(); the live reply stream is in tenant-chat-stream.ts.
import { api } from "./api.ts";
import {
  FOLLOW_UP_INTENTS,
  FOLLOW_UPS_MAX_CHARS,
  type FollowUpItem,
} from "./suggestions.ts";
import type {
  AgentSource,
  AgentTint,
  TenantAgent,
  TenantModel,
} from "./tenant-agents.ts";
import {
  parseApprovalEvent,
  parseConnectorEvent,
  parseConnectorRefs,
  parseSavedTool,
  parseToolEvent,
  type ApprovalKind,
  type ApprovalParam,
  type ApprovalStatus,
  type ConnectorFailureReason,
  type ConnectorRef,
  type SavedTool,
  type ToolErrorCode,
  type ToolStatus,
} from "./tenant-connectors.ts";
import {
  parseActivity,
  parseProgress,
  parseSavedActivity,
  withOutput,
  withPreviewPiece,
  type Activity,
} from "./tenant-coding.ts";
import {
  parseFiles,
  parseUnsaved,
  withFiles,
  type ChatFile,
} from "./tenant-files.ts";
import {
  filesReady,
  parseAttachments,
  type DraftFile,
  type MessageAttachment,
} from "./tenant-uploads.ts";
import {
  parseNetworkBlock,
  type NetworkBlock,
  type NetworkDecision,
} from "./tenant-network.ts";

// Kept in step with platform-next/src/modules/chats/chat.ts.
export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_TITLE_CHARS = 120;
// "Still working…" appears when a reply has shown nothing for this long.
export const SLOW_REPLY_MS = 15_000;

export type ReadOnlyReason =
  "THREAD_LOST" | "MODEL_UNAVAILABLE" | "AGENT_UNAVAILABLE";
// "interrupted": an assistant reply cut short by the member's next message
// (its partial text is kept but the model never saw it). "not_sent": a user
// message added to a reply that the assistant never read.
export type MessageState =
  "complete" | "stopped" | "failed" | "interrupted" | "not_sent";
export type RunStatus =
  "accepted" | "running" | "completed" | "stopped" | "failed" | "uncertain";
export type Phase =
  | "waiting"
  | "streaming"
  | "retrying"
  | "stopping"
  | "reconnecting"
  | "settled";

export interface ChatSummary {
  id: string;
  title: string;
  agent: {
    id: string;
    source: AgentSource;
    name: string;
    look: number;
    tint: AgentTint;
  } | null;
  model: TenantModel | null;
  readOnly: ReadOnlyReason | null;
  activeRunId: string | null;
  status: "active" | "archived";
  lastMessageAt: string;
  createdAt: string;
  // The directory connectors this chat's agent attaches (always present,
  // [] when none), so a Connect card can name them.
  connectors: ConnectorRef[];
}

export interface ChatMessage {
  id: string;
  seq: number;
  runId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  state: MessageState;
  // A saved tool message (role "tool", text "") carries its settled call
  // here; absent on user/assistant messages.
  tool?: SavedTool;
  // Or a command / file change in the chat's workspace.
  activity?: Activity;
  // Or a skill the reply used ("Used skill <name>").
  skill?: UsedSkill;
  // Or a sandbox request Truex blocked, with the owner's answer once given.
  network?: NetworkBlock;
  // Or a helper agent the reply used, with its result.
  agent?: HelperAgent;
  // A user message's attached files, in order; absent when none.
  attachments?: MessageAttachment[];
  clientMessageId?: string;
  createdAt: string;
}

export interface RunError {
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

// A message the member added to a running reply (a steer). Present on a run
// only while it is unsettled, so a reload shows the steers it is carrying.
export interface SteerView {
  clientMessageId: string;
  text: string;
  createdAt: string;
}

export interface ChatRun {
  id: string;
  status: RunStatus;
  error: RunError | null;
  usage: RunUsage | null;
  timings: {
    acceptedAt: string;
    dispatchedAt?: string;
    firstTextAt?: string;
    completedAt?: string;
  };
  // The steers queued on this run, in arrival order; absent once settled.
  steers?: SteerView[];
  // Files the reply wrote that couldn't be saved; absent when none.
  unsavedFiles?: string[];
  // The rows a completed reply offered, while Follow Ups are on; absent
  // otherwise.
  followUps?: { items: FollowUpItem[] };
}

// One open chat: its summary and the loaded, contiguous tail of messages.
export interface ChatThread {
  chat: ChatSummary;
  messages: ChatMessage[];
  runs: Record<string, ChatRun>;
  hasMore: boolean;
}

export interface SendReceipt {
  chat: ChatSummary;
  message: ChatMessage;
  run: ChatRun;
}

// The answer to a message sent to a chat that is still replying: the steer
// joined the running turn rather than starting a new one. It has `steer` and
// no `message`, and its run is the one already active.
export interface SteerReceipt {
  chat: ChatSummary;
  run: ChatRun;
  steer: SteerView;
}

// A POST to a busy chat answers with either: a steer joined the active run,
// or a normal send that started a new run (the platform's fallback when the
// reply had just ended).
export type MessageReceipt =
  | { kind: "steer"; receipt: SteerReceipt }
  | { kind: "send"; receipt: SendReceipt };

const WIRE_ID = /^[0-9a-f]{24}$/;
const SOURCES: readonly AgentSource[] = ["builtin", "personal", "tenant"];
const TINTS: readonly AgentTint[] = ["ice", "mint", "butter", "peach", "lilac"];
const READ_ONLY: readonly ReadOnlyReason[] = [
  "THREAD_LOST",
  "MODEL_UNAVAILABLE",
  "AGENT_UNAVAILABLE",
];
const STATES: readonly MessageState[] = [
  "complete",
  "stopped",
  "failed",
  "interrupted",
  "not_sent",
];
const RUN_STATUSES: readonly RunStatus[] = [
  "accepted",
  "running",
  "completed",
  "stopped",
  "failed",
  "uncertain",
];
const PHASES: readonly Phase[] = [
  "waiting",
  "streaming",
  "retrying",
  "stopping",
  "reconnecting",
  "settled",
];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
const id = (value: unknown): string | null =>
  typeof value === "string" && WIRE_ID.test(value) ? value : null;
const str = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null => (allowed.includes(value as T) ? (value as T) : null);

function parseModel(value: unknown): TenantModel | null {
  const m = record(value);
  const modelId = id(m?.id);
  const displayName = str(m?.displayName, 200);
  if (!m || !modelId || !displayName) return null;
  return {
    id: modelId,
    displayName,
    shortLabel: str(m.shortLabel, 100) ?? "",
    family: str(m.family, 50) ?? "other",
  };
}

// A malformed chat from the server is dropped rather than rendered.
export function parseChat(value: unknown): ChatSummary | null {
  const c = record(value);
  const chatId = id(c?.id);
  const title = str(c?.title, 400);
  const lastMessageAt = date(c?.lastMessageAt);
  const createdAt = date(c?.createdAt);
  if (!c || !chatId || title === null || !lastMessageAt || !createdAt)
    return null;
  const a = record(c.agent);
  const agentId = id(a?.id);
  const agentName = str(a?.name, 200);
  const agent =
    a && agentId && agentName
      ? {
          id: agentId,
          source: oneOf(a.source, SOURCES) ?? "builtin",
          name: agentName,
          look:
            typeof a.look === "number" && Number.isInteger(a.look) ? a.look : 0,
          tint: oneOf(a.tint, TINTS) ?? "ice",
        }
      : null;
  return {
    id: chatId,
    title,
    agent,
    model: c.model === null ? null : parseModel(c.model),
    readOnly: oneOf(c.readOnly, READ_ONLY),
    activeRunId: id(c.activeRunId),
    status: c.status === "archived" ? "archived" : "active",
    lastMessageAt,
    createdAt,
    connectors: parseConnectorRefs(c.connectors),
  };
}

// A skill the assistant opened during a reply. The name is the one the chat
// started with.
export interface UsedSkill {
  slug: string;
  name: string;
}

function parseUsedSkill(value: unknown): UsedSkill | null {
  const s = record(value);
  const slug = str(s?.slug, 64);
  const name = str(s?.name, 200);
  return slug && name ? { slug, name } : null;
}

// A helper agent the lead started during a reply. `path` is the task name
// the lead gave it; `result` is the helper's own answer, shown as plain text.
// `preview` (what it is doing now) exists only while the reply is live.
export type HelperStatus = "running" | "completed" | "failed" | "stopped";
const HELPER_STATUSES: readonly HelperStatus[] = [
  "running",
  "completed",
  "failed",
  "stopped",
];

export interface HelperAgent {
  path: string;
  status: HelperStatus;
  result?: string;
  preview?: string;
}

export interface LiveHelper extends HelperAgent {
  agentId: string;
}

// The platform bounds these; they are bounded again here.
const MAX_HELPERS = 10;
const MAX_HELPER_PATH = 120;
const MAX_HELPER_PREVIEW = 240;
const MAX_HELPER_RESULT = 4000;

const bounded = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;

function parseHelper(value: unknown): HelperAgent | null {
  const a = record(value);
  const status = oneOf(a?.status, HELPER_STATUSES);
  if (!a || !status) return null;
  const result = bounded(a.result, MAX_HELPER_RESULT);
  const preview = bounded(a.preview, MAX_HELPER_PREVIEW);
  return {
    path: bounded(a.path, MAX_HELPER_PATH) ?? "",
    status,
    ...(result !== undefined ? { result } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}

function parseLiveHelper(value: unknown): LiveHelper | null {
  const agentId = str(record(value)?.agentId, 200);
  const helper = agentId ? parseHelper(value) : null;
  return helper && agentId ? { agentId, ...helper } : null;
}

// A helper's task name for display: the last part of its path, with
// underscores as spaces ("/root/crm_deals" → "crm deals").
export function helperLabel(path: string): string {
  const name = path.split("/").filter(Boolean).at(-1)?.replace(/_/g, " ");
  return name?.trim() || "Helper";
}

// The line above a reply's helper cards.
export function helpersSummary(helpers: readonly HelperAgent[]): string {
  const total = helpers.length;
  const running = helpers.filter((h) => h.status === "running").length;
  const noun = total === 1 ? "helper" : "helpers";
  return running
    ? `Checking with ${total} ${noun} · ${total - running} done`
    : `Checked with ${total} ${noun}`;
}

// The note on an approval card in a reply that used helpers. Helper results
// are model-written and may steer the lead, so the member checks the request
// against what they asked for.
export function helperApprovalNote(
  helpers: readonly HelperAgent[],
): string | null {
  return helpers.length
    ? "This request came after helper results. Check it matches what you asked for."
    : null;
}

// A saved helper row never carries the live preview.
function parseSavedHelper(value: unknown): HelperAgent | null {
  const helper = parseHelper(value);
  if (!helper || helper.status === "running") return null;
  const { preview: _preview, ...saved } = helper;
  return saved;
}

// Helpers merged by agentId, in start order: a known helper takes the new
// status and keeps its earlier text unless the update brings new text.
function withHelpers(
  current: readonly LiveHelper[],
  updates: readonly LiveHelper[],
): LiveHelper[] {
  const next = [...current];
  for (const update of updates) {
    const at = next.findIndex((h) => h.agentId === update.agentId);
    if (at >= 0) next[at] = { ...next[at]!, ...update };
    else if (next.length < MAX_HELPERS) next.push(update);
  }
  return next;
}

export function parseMessage(value: unknown): ChatMessage | null {
  const m = record(value);
  const messageId = id(m?.id);
  const runId = id(m?.runId);
  const text = str(m?.text, 1_000_000);
  const createdAt = date(m?.createdAt);
  const role =
    m?.role === "user" || m?.role === "assistant" || m?.role === "tool"
      ? m.role
      : null;
  if (!m || !messageId || !runId || text === null || !createdAt || !role)
    return null;
  if (typeof m.seq !== "number" || !Number.isInteger(m.seq)) return null;
  const clientMessageId = str(m.clientMessageId, 64);
  // A tool message that carries no readable tool payload is dropped: it
  // would render as an empty, meaningless row.
  const tool =
    role === "tool" && m.tool !== undefined ? parseSavedTool(m.tool) : null;
  const activity =
    role === "tool" && !tool ? parseSavedActivity(m.activity, messageId) : null;
  const skill =
    role === "tool" && !tool && !activity ? parseUsedSkill(m.skill) : null;
  const network =
    role === "tool" && !tool && !activity && !skill
      ? parseNetworkBlock(m.network)
      : null;
  const agent =
    role === "tool" && !tool && !activity && !skill && !network
      ? parseSavedHelper(m.agent)
      : null;
  if (role === "tool" && !tool && !activity && !skill && !network && !agent)
    return null;
  const attachments = role === "user" ? parseAttachments(m.attachments) : [];
  return {
    id: messageId,
    seq: m.seq,
    runId,
    role,
    text,
    state: oneOf(m.state, STATES) ?? "complete",
    ...(tool ? { tool } : {}),
    ...(activity ? { activity } : {}),
    ...(skill ? { skill } : {}),
    ...(network ? { network } : {}),
    ...(agent ? { agent } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    createdAt,
  };
}

function parseUsage(value: unknown): RunUsage | null {
  const u = record(value);
  if (!u) return null;
  return {
    input: count(u.input),
    cached: count(u.cached),
    cacheWrite: count(u.cacheWrite),
    output: count(u.output),
    reasoning: count(u.reasoning),
  };
}

export function parseRunError(value: unknown): RunError | null {
  const e = record(value);
  const code = str(e?.code, 100);
  const message = str(e?.message, 2000);
  if (!e || !code || !message) return null;
  return { code, message, retryable: e.retryable === true };
}

export function parseSteer(value: unknown): SteerView | null {
  const s = record(value);
  const clientMessageId = str(s?.clientMessageId, 64);
  const text = str(s?.text, 1_000_000);
  const createdAt = date(s?.createdAt);
  if (!s || !clientMessageId || text === null || !createdAt) return null;
  return { clientMessageId, text, createdAt };
}

const FOLLOW_UP_INTENT_VALUES = [...FOLLOW_UP_INTENTS, "ask"] as const;

function parseFollowUpItems(value: unknown): FollowUpItem[] {
  const followUps = record(value);
  return list(followUps?.items, (raw) => {
    const item = record(raw);
    const slot = item?.slot;
    const intent = oneOf(item?.intent, FOLLOW_UP_INTENT_VALUES);
    const text = str(item?.text, FOLLOW_UPS_MAX_CHARS);
    if (
      typeof slot !== "number" ||
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > 3 ||
      !intent ||
      !text
    )
      return null;
    return { slot, intent, text };
  });
}

export function parseRun(value: unknown): ChatRun | null {
  const r = record(value);
  const runId = id(r?.id);
  const status = oneOf(r?.status, RUN_STATUSES);
  const t = record(r?.timings);
  const acceptedAt = date(t?.acceptedAt);
  if (!r || !runId || !status || !t || !acceptedAt) return null;
  const timings: ChatRun["timings"] = { acceptedAt };
  for (const key of ["dispatchedAt", "firstTextAt", "completedAt"] as const) {
    const at = date(t[key]);
    if (at) timings[key] = at;
  }
  // `steers` is present only while the run is unsettled; a missing array (a
  // settled run, an older platform) leaves the field off rather than empty.
  const steers = Array.isArray(r.steers)
    ? r.steers.flatMap((s) => {
        const parsed = parseSteer(s);
        return parsed ? [parsed] : [];
      })
    : null;
  const unsavedFiles = parseUnsaved(r.unsavedFiles);
  const followUps = parseFollowUpItems(r.followUps);
  return {
    id: runId,
    status,
    error: parseRunError(r.error),
    usage: parseUsage(r.usage),
    timings,
    ...(steers ? { steers } : {}),
    ...(unsavedFiles.length ? { unsavedFiles } : {}),
    ...(followUps.length ? { followUps: { items: followUps } } : {}),
  };
}

const list = <T>(value: unknown, parse: (v: unknown) => T | null): T[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const parsed = parse(v);
        return parsed ? [parsed] : [];
      })
    : [];

function runsById(runs: ChatRun[]): Record<string, ChatRun> {
  return Object.fromEntries(runs.map((run) => [run.id, run]));
}

function unreadable(): never {
  throw new Error("The platform returned an unreadable chat.");
}

// A follow-up's receipt may leave the agent out: it has not changed, and
// the chat it was sent in already has it.
function receiptChat(data: Raw | null, sentIn?: ChatSummary): ChatSummary {
  const raw = record(data?.chat);
  const parsed = parseChat(raw);
  const chat =
    parsed && raw && !("agent" in raw) && sentIn?.id === parsed.id
      ? { ...parsed, agent: sentIn.agent }
      : parsed;
  if (!chat) unreadable();
  return chat;
}

function receiptOf(data: unknown, sentIn?: ChatSummary): SendReceipt {
  const d = record(data);
  const chat = receiptChat(d, sentIn);
  const message = parseMessage(d?.message);
  const run = parseRun(d?.run);
  if (!message || !run) unreadable();
  return { chat, message, run };
}

// A message sent to a busy chat: a steer receipt (has `steer`, no `message`)
// or a normal send for a new run. The two are told apart by the shape the
// platform returned, not by status, so a replay (200) is read the same way.
function messageReceiptOf(data: unknown, sentIn?: ChatSummary): MessageReceipt {
  const d = record(data);
  if (d && record(d.steer)) {
    const chat = receiptChat(d, sentIn);
    const run = parseRun(d.run);
    const steer = parseSteer(d.steer);
    if (!run || !steer) unreadable();
    return { kind: "steer", receipt: { chat, run, steer } };
  }
  return { kind: "send", receipt: receiptOf(data, sentIn) };
}

const chatPath = (chatId: string, rest = "") =>
  `/api/v1/chats/${encodeURIComponent(chatId)}${rest}`;

export async function fetchChats(
  cursor?: string | null,
): Promise<{ chats: ChatSummary[]; nextCursor: string | null }> {
  const data = record(
    await api(
      cursor
        ? `/api/v1/chats?cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/chats",
    ),
  );
  return {
    chats: list(data?.chats, parseChat),
    nextCursor: str(data?.nextCursor, 200) || null,
  };
}

export async function fetchChat(chatId: string): Promise<ChatThread> {
  const data = record(await api(chatPath(chatId)));
  const chat = parseChat(data?.chat);
  if (!chat) unreadable();
  return {
    chat,
    messages: sortMessages(list(data?.messages, parseMessage)),
    runs: runsById(list(data?.runs, parseRun)),
    hasMore: data?.hasMore === true,
  };
}

export async function fetchOlderMessages(
  chatId: string,
  beforeSeq: number,
): Promise<{ messages: ChatMessage[]; runs: ChatRun[]; hasMore: boolean }> {
  const data = record(
    await api(chatPath(chatId, `/messages?before=${beforeSeq}`)),
  );
  return {
    messages: list(data?.messages, parseMessage),
    runs: list(data?.runs, parseRun),
    hasMore: data?.hasMore === true,
  };
}

// `attachments` are staged upload IDs; sent only when there are some.
const withUploads = (attachments: readonly string[]) =>
  attachments.length ? { attachments } : {};

export const startChat = async (
  agentId: string,
  text: string,
  clientMessageId: string,
  attachments: readonly string[] = [],
): Promise<SendReceipt> =>
  receiptOf(
    await api("/api/v1/chats", {
      agentId,
      clientMessageId,
      text,
      ...withUploads(attachments),
    }),
  );

// A message to an open chat. The platform decides whether it starts a new
// run or steers the one still replying, so the receipt is one or the other.
// A click on a Follow Up row: the run and slot it came from. Analytics only;
// the platform verifies it against the stored rows when reporting.
export interface FollowUpOrigin {
  fromRunId: string;
  slot: number;
}

export const sendMessage = async (
  chat: ChatSummary,
  text: string,
  clientMessageId: string,
  attachments: readonly string[] = [],
  followUp?: FollowUpOrigin,
): Promise<MessageReceipt> =>
  messageReceiptOf(
    await api(chatPath(chat.id, "/messages"), {
      clientMessageId,
      text,
      ...withUploads(attachments),
      ...(followUp ? { followUp } : {}),
    }),
    chat,
  );

export async function stopRun(chatId: string, runId: string): Promise<void> {
  await api(chatPath(chatId, `/runs/${encodeURIComponent(runId)}/stop`), {});
}

async function chatOf(request: Promise<unknown>): Promise<ChatSummary> {
  const chat = parseChat(record(await request)?.chat);
  if (!chat) unreadable();
  return chat;
}

export const renameChat = (chatId: string, title: string) =>
  chatOf(api(chatPath(chatId), { title }, undefined, "PATCH"));

export const archiveChat = (chatId: string) =>
  chatOf(api(chatPath(chatId, "/archive"), {}));

// ---- Pure state ----

export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort((a, b) => a.seq - b.seq);
}

// Adds or replaces messages by id, keeping seq order.
export function withMessages(
  thread: ChatThread,
  messages: ChatMessage[],
): ChatThread {
  if (!messages.length) return thread;
  const byId = new Map(thread.messages.map((m) => [m.id, m]));
  for (const message of messages) byId.set(message.id, message);
  return { ...thread, messages: sortMessages([...byId.values()]) };
}

export function withRun(thread: ChatThread, run: ChatRun): ChatThread {
  return { ...thread, runs: { ...thread.runs, [run.id]: run } };
}

// The chat list, newest activity first; an updated chat replaces its row.
export function withChat(
  chats: ChatSummary[],
  chat: ChatSummary,
): ChatSummary[] {
  const rest = chats.filter((c) => c.id !== chat.id);
  if (chat.status === "archived") return rest;
  return [...rest, chat].sort(
    (a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt),
  );
}

// A sent message's receipt applied to the open chat.
export function withReceipt(
  thread: ChatThread | null,
  receipt: SendReceipt,
): ChatThread {
  const base: ChatThread =
    thread && thread.chat.id === receipt.chat.id
      ? { ...thread, chat: receipt.chat }
      : { chat: receipt.chat, messages: [], runs: {}, hasMore: false };
  return withRun(withMessages(base, [receipt.message]), receipt.run);
}

// A steer receipt applied to the open chat: the run gains the steer (so a
// reload still shows it), but no message is saved yet — the steer bubble is
// shown from the live reply until the run settles. A steer for a chat not
// open here is ignored.
export function withSteer(
  thread: ChatThread | null,
  receipt: SteerReceipt,
): ChatThread | null {
  if (!thread || thread.chat.id !== receipt.chat.id) return thread;
  return withRun({ ...thread, chat: receipt.chat }, receipt.run);
}

// ---- A message on its way ----

// A message shown the moment it is sent, before the platform answers. The
// saved message has the same clientMessageId and takes its place.
export interface PendingSend {
  // The draft it came from: a chat's ID, or "new" for a first message.
  key: string;
  text: string;
  clientMessageId: string;
  since: number;
  attachments?: MessageAttachment[];
}

// The run a pending message is shown under until the real run is known.
export const pendingRunId = (pending: PendingSend) =>
  `pending:${pending.clientMessageId}`;

// The open chat with the pending message after its last message. A repeat
// of a message already saved adds nothing.
export function withPending(
  thread: ChatThread,
  pending: PendingSend,
): ChatThread {
  if (
    thread.messages.some((m) => m.clientMessageId === pending.clientMessageId)
  )
    return thread;
  const runId = pendingRunId(pending);
  const message: ChatMessage = {
    id: runId,
    seq: (thread.messages.at(-1)?.seq ?? 0) + 1,
    runId,
    role: "user",
    text: pending.text,
    state: "complete",
    ...(pending.attachments?.length
      ? { attachments: pending.attachments }
      : {}),
    clientMessageId: pending.clientMessageId,
    createdAt: new Date(pending.since).toISOString(),
  };
  return { ...thread, messages: [...thread.messages, message] };
}

// What a first message shows while its chat is being created.
export function pendingThread(
  agent: TenantAgent,
  pending: PendingSend,
): ChatThread {
  const at = new Date(pending.since).toISOString();
  const chat: ChatSummary = {
    id: pendingRunId(pending),
    title: "",
    agent: {
      id: agent.id,
      source: agent.source,
      name: agent.name,
      look: agent.look,
      tint: agent.tint,
    },
    model: agent.model,
    readOnly: null,
    activeRunId: null,
    status: "active",
    lastMessageAt: at,
    createdAt: at,
    connectors: agent.connectors,
  };
  return withPending({ chat, messages: [], runs: {}, hasMore: false }, pending);
}

// One ordered entry of a live reply, in the order Codex produced it: a
// reply's text, or a steer the member slipped into the running turn. A
// steer carries the draft text it was sent with so its bubble shows at once
// (optimistic); once the `input` event fixes its place `text` is the same,
// and after a reconnect it is rebuilt from the run's `steers` (`text: null`,
// looked up by clientMessageId when rendered). `placed` is false only for
// the optimistic bubble: Codex has not read that steer yet.
export type LiveReplyItem =
  | { type: "reply"; itemId: string; text: string; completed: boolean }
  | {
      type: "input";
      clientMessageId: string;
      text: string | null;
      placed: boolean;
    }
  | {
      // A connector tool call kiro-cli ran, placed in stream order. The same
      // itemId goes inProgress -> completed/failed; a repeat start after it
      // settled is ignored so a settled card never flips back to running.
      type: "tool";
      itemId: string;
      connector: string;
      tool: string;
      status: ToolStatus;
      durationMs: number | null;
      errorCode: ToolErrorCode | null;
    }
  // A command or file change in the chat's workspace, by itemId like a tool.
  | Activity
  // A skill the model opened, once per reply.
  | ({ type: "skill" } & UsedSkill)
  // A sandbox request Truex blocked, once per site and method; answered on
  // the saved reply.
  | ({ type: "network" } & NetworkBlock);

// Only the reply items of a live reply, in order.
export const replyItems = (
  reply: LiveReply,
): Array<{ itemId: string; text: string; completed: boolean }> =>
  reply.items.flatMap((i) => (i.type === "reply" ? [i] : []));

// The follow-up this tab just sent into the reply, until Codex reads it:
// the transcript scrolls to it as it does to a sent message.
export const sentSteerId = (reply: LiveReply | null): string | null => {
  const sent = reply?.items.findLast((i) => i.type === "input" && !i.placed);
  return sent?.type === "input" ? sent.clientMessageId : null;
};

// A steer's text, read from the run it was queued on. An input item placed
// by the stream (or rebuilt from a snapshot) carries no text of its own, so
// its bubble is filled from the run's `steers`.
export const steerText = (
  run: ChatRun | null,
  clientMessageId: string,
): string | null =>
  run?.steers?.find((s) => s.clientMessageId === clientMessageId)?.text ?? null;

// A write-tool approval shown inline at its tool row during a live reply.
// It opens "pending" (the card) and settles to a decision (an outcome label);
// `auto` marks a decision the platform answered itself (an allow-for-chat
// replay), which shows only the label, never a card.
export interface ApprovalView {
  approvalId: string;
  itemId: string;
  kind: ApprovalKind;
  connector: string;
  tool: string;
  params: ApprovalParam[];
  status: ApprovalStatus;
  expiresAt: string | null;
  auto: boolean;
  allowForChat: boolean;
  // Set when this tab's own answer lost the first-answer race: a 409
  // (someone/something already answered) or a 404 (the request expired or the
  // reply finished). The card shows "Already answered" / "Expired", distinct
  // from a decision outcome. Absent otherwise.
  race?: "resolved" | "not_found";
}

// What the screen shows for one reply while it is not yet saved.
export interface LiveReply {
  runId: string;
  phase: Phase;
  items: LiveReplyItem[];
  usage: RunUsage | null;
  // The outcome is known (completed event) but not yet saved.
  outcome: { status: RunStatus; error: RunError | null } | null;
  saveFailed: boolean;
  // When the reply started, for the "Still working…" note.
  since: number;
  // Connectors (by slug) that failed during this reply, each kept once with
  // the reason it last reported, so a banner shows once per connector per run.
  connectorFailures: Record<string, ConnectorFailureReason>;
  // Write-tool approvals by approvalId: pending ones show a card at their
  // tool row, settled ones an outcome label. A snapshot replaces this with
  // the still-pending set, so a reconnecting caller shows the open cards.
  approvals: Record<string, ApprovalView>;
  // The file versions the reply stored, once it has finished (the `files`
  // event, before `saved`), and the paths it wrote that couldn't be stored.
  files: ChatFile[];
  unsaved: string[];
  // Helper agents the lead started, in start order. Kept apart from items:
  // a helper's result is never one of the lead's replies.
  helpers: LiveHelper[];
}

export function liveReply(runId: string, now = Date.now()): LiveReply {
  return {
    runId,
    phase: "waiting",
    items: [],
    usage: null,
    outcome: null,
    saveFailed: false,
    since: now,
    connectorFailures: {},
    approvals: {},
    files: [],
    unsaved: [],
    helpers: [],
  };
}

// snapshot/completed items are an ordered list of replies and inputs; a
// malformed entry is dropped. An input placed by the stream has no text
// here (it is read from the run's steers when rendered).
function parseItems(value: unknown): LiveReplyItem[] {
  return list(value, (v) => {
    const item = record(v);
    if (!item) return null;
    if (item.type === "input") {
      const clientMessageId = str(item.clientMessageId, 64);
      return clientMessageId
        ? { type: "input", clientMessageId, text: null, placed: true }
        : null;
    }
    if (item.type === "command" || item.type === "file_change")
      return parseActivity(item);
    if (item.type === "skill") {
      const skill = parseUsedSkill(item);
      return skill ? { type: "skill", ...skill } : null;
    }
    if (item.type === "network") {
      const block = parseNetworkBlock(item);
      return block ? { type: "network", ...block } : null;
    }
    if (item.type === "tool") {
      // A snapshot/completed tool item is shaped like a tool event; reuse
      // its parser, then carry the itemId so repeat starts can be ignored.
      const event = parseToolEvent(item);
      return event
        ? {
            type: "tool",
            itemId: event.itemId,
            connector: event.connector,
            tool: event.tool,
            status: event.status,
            durationMs: event.durationMs,
            errorCode: event.errorCode,
          }
        : null;
    }
    const itemId = str(item.itemId, 200);
    const text = str(item.text, 1_000_000);
    if (!itemId || text === null) return null;
    return { type: "reply", itemId, text, completed: item.completed === true };
  });
}

// A snapshot's file changes still being written.
function parseWriting(value: unknown): LiveReplyItem[] {
  return list(value, (v) => {
    const progress = parseProgress(v);
    if (!progress || progress.ended) return null;
    const preview = withPreviewPiece(undefined, progress.piece);
    return preview ? { ...progress.activity, preview } : progress.activity;
  });
}

// A snapshot's pending approvals → an approvals map keyed by approvalId. Each
// entry is shaped like an approval event, so the event parser is reused.
function parseApprovals(value: unknown): Record<string, ApprovalView> {
  const approvals: Record<string, ApprovalView> = {};
  for (const event of list(value, parseApprovalEvent))
    approvals[event.approvalId] = { ...event };
  return approvals;
}

// The pending approval for a tool row (`itemId`), or null. A card is shown
// for exactly this; a settled approval is looked up with `approvalForItem`.
export function pendingApprovalForItem(
  reply: LiveReply | null,
  itemId: string,
): ApprovalView | null {
  if (!reply) return null;
  return (
    Object.values(reply.approvals).find(
      (a) => a.itemId === itemId && a.status === "pending",
    ) ?? null
  );
}

// The most recent approval for a tool row (`itemId`), pending or settled, or
// null. A settled one shows an outcome label on the row.
export function approvalForItem(
  reply: LiveReply | null,
  itemId: string,
): ApprovalView | null {
  if (!reply) return null;
  return (
    Object.values(reply.approvals).findLast((a) => a.itemId === itemId) ?? null
  );
}

// True while any approval on this reply is still waiting for the member, so
// the composer's placeholder points to the card.
export function hasPendingApproval(reply: LiveReply | null): boolean {
  return (
    !!reply &&
    Object.values(reply.approvals).some((a) => a.status === "pending")
  );
}

// Settles one approval on a live reply to the decision the platform recorded,
// without waiting for the stream's resolved event — used when the POST
// succeeds. A no-op when the approval is unknown or already settled, so a
// late stream event cannot reopen it.
export function withApproval(
  reply: LiveReply,
  approvalId: string,
  status: ApprovalStatus,
): LiveReply {
  const current = reply.approvals[approvalId];
  if (!current || current.status !== "pending") return reply;
  return {
    ...reply,
    approvals: {
      ...reply.approvals,
      [approvalId]: { ...current, status },
    },
  };
}

// Marks one approval as having lost the first-answer race (a 409/404 to this
// tab's answer): the card shows "Already answered"/"Expired". A no-op when
// the approval is unknown.
export function withApprovalRace(
  reply: LiveReply,
  approvalId: string,
  race: "resolved" | "not_found",
): LiveReply {
  const current = reply.approvals[approvalId];
  if (!current) return reply;
  return {
    ...reply,
    approvals: {
      ...reply.approvals,
      [approvalId]: { ...current, race },
    },
  };
}

// A steer shown at the bottom of the running reply the moment it is sent,
// before the stream reports where Codex placed it. If the stream already
// has an entry for this clientMessageId (a reconnect) nothing is added.
export function withLiveSteer(
  reply: LiveReply,
  steer: { clientMessageId: string; text: string },
): LiveReply {
  if (
    reply.items.some(
      (i) => i.type === "input" && i.clientMessageId === steer.clientMessageId,
    )
  )
    return reply;
  return {
    ...reply,
    items: [
      ...reply.items,
      {
        type: "input",
        clientMessageId: steer.clientMessageId,
        text: steer.text,
        placed: false,
      },
    ],
  };
}

// Which entries of an exchange are progress narration rather than the answer.
// A reply written before a tool call ("I'll search your repositories…") is
// progress; the reply after the last call is the answer. Codex can mark this
// itself (an agentMessage `phase` of "commentary"), but only when the provider
// sends a phase, and the gateway's providers do not, so the rule is
// structural. A reply followed by another reply is progress too: Codex only
// samples again after a tool call, and some calls (update_plan) have no row
// in the transcript. A user message or steer ends the stretch a later tool
// call or reply can reach back over.
export type ExchangeEntry = "reply" | "tool" | "input";

export function progressFlags(entries: readonly ExchangeEntry[]): boolean[] {
  const flags = new Array<boolean>(entries.length).fill(false);
  let later = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === "input") later = false;
    else if (entry === "tool") later = true;
    else {
      flags[i] = later;
      later = true;
    }
  }
  return flags;
}

// The reply at `index` was cut short by a steer: it never completed and a
// steer Codex read came after it. An optimistic steer cuts nothing yet; it
// may still be refused.
export function isCutShort(reply: LiveReply, index: number): boolean {
  const item = reply.items[index];
  return (
    item?.type === "reply" &&
    !item.completed &&
    item.text.length > 0 &&
    reply.items
      .slice(index + 1)
      .some((later) => later.type === "input" && later.placed)
  );
}

// Removes an optimistic steer from a live reply: used when the steer failed
// to reach the running turn, or the platform turned it into a new run, so
// its bubble does not linger.
export function dropSteer(
  reply: LiveReply,
  clientMessageId: string,
): LiveReply {
  const items = reply.items.filter(
    (i) => !(i.type === "input" && i.clientMessageId === clientMessageId),
  );
  return items.length === reply.items.length ? reply : { ...reply, items };
}

export type StreamEvent =
  | { type: "snapshot"; data: unknown }
  | { type: "status"; data: unknown }
  | { type: "delta"; data: unknown }
  | { type: "item"; data: unknown }
  | { type: "input"; data: unknown }
  | { type: "tool"; data: unknown }
  | { type: "connector"; data: unknown }
  | { type: "approval"; data: unknown }
  | { type: "activity"; data: unknown }
  | { type: "skill"; data: unknown }
  | { type: "network"; data: unknown }
  | { type: "agent"; data: unknown }
  | { type: "output"; data: unknown }
  | { type: "progress"; data: unknown }
  | { type: "usage"; data: unknown }
  | { type: "completed"; data: unknown }
  | { type: "files"; data: unknown }
  | { type: "save_failed"; data: unknown };

// One stream event applied to the live reply. Unknown or malformed events
// leave it unchanged; a snapshot replaces everything seen so far, which is
// what makes reconnecting safe.
export function applyStreamEvent(
  reply: LiveReply,
  event: { type: string; data: unknown },
): LiveReply {
  const data = record(event.data);
  switch (event.type) {
    case "snapshot": {
      if (!data || (data.runId !== undefined && data.runId !== reply.runId))
        return reply;
      return {
        ...reply,
        phase: oneOf(data.phase, PHASES) ?? reply.phase,
        // File changes still being written follow the ordered items.
        items: [...parseItems(data.items), ...parseWriting(data.writing)],
        usage: parseUsage(data.usage) ?? reply.usage,
        // A snapshot carries only the still-pending approvals; it replaces
        // the map so a settled card does not linger after a reconnect, and
        // the open cards are shown again.
        approvals:
          data.approvals === undefined
            ? reply.approvals
            : parseApprovals(data.approvals),
        // Merged, not replaced: a snapshot without helpers keeps what this
        // tab already showed.
        helpers: withHelpers(
          reply.helpers,
          list(data.agents, parseLiveHelper).slice(0, MAX_HELPERS),
        ),
      };
    }
    case "agent": {
      const helper = parseLiveHelper(data);
      return helper
        ? { ...reply, helpers: withHelpers(reply.helpers, [helper]) }
        : reply;
    }
    case "status": {
      const phase = oneOf(data?.phase, PHASES);
      return phase ? { ...reply, phase } : reply;
    }
    case "delta":
    case "item": {
      const itemId = str(data?.itemId, 200);
      const text = str(data?.text, 1_000_000);
      if (!itemId || text === null) return reply;
      const index = reply.items.findIndex(
        (i) => i.type === "reply" && i.itemId === itemId,
      );
      const items = [...reply.items];
      if (index < 0)
        items.push({
          type: "reply",
          itemId,
          text,
          completed: event.type === "item",
        });
      else {
        const current = items[index] as Extract<
          LiveReplyItem,
          { type: "reply" }
        >;
        items[index] = {
          type: "reply",
          itemId,
          text: event.type === "delta" ? current.text + text : text,
          // `item` means that reply completed; a `delta` never un-completes it.
          completed: event.type === "item" || current.completed,
        };
      }
      return {
        ...reply,
        items,
        phase: reply.phase === "waiting" ? "streaming" : reply.phase,
      };
    }
    case "input": {
      // A steer entered the running turn: fix it at this point in the order.
      // An optimistic bubble for it is moved here (keeping its text); a
      // repeat (a reconnect delivering it again) changes nothing.
      const clientMessageId = str(data?.clientMessageId, 64);
      if (!clientMessageId) return reply;
      const existing = reply.items.find(
        (i) => i.type === "input" && i.clientMessageId === clientMessageId,
      ) as Extract<LiveReplyItem, { type: "input" }> | undefined;
      const rest = reply.items.filter(
        (i) => !(i.type === "input" && i.clientMessageId === clientMessageId),
      );
      return {
        ...reply,
        items: [
          ...rest,
          {
            type: "input",
            clientMessageId,
            text: existing?.text ?? null,
            placed: true,
          },
        ],
        phase: reply.phase === "waiting" ? "streaming" : reply.phase,
      };
    }
    case "tool": {
      // A connector tool call: inProgress places a card, completed/failed
      // settles it by itemId. A repeat start after a call settled is
      // ignored, so a finished card never reverts to running.
      const event = parseToolEvent(data);
      if (!event) return reply;
      const index = reply.items.findIndex(
        (i) => i.type === "tool" && i.itemId === event.itemId,
      );
      const next: Extract<LiveReplyItem, { type: "tool" }> = {
        type: "tool",
        itemId: event.itemId,
        connector: event.connector,
        tool: event.tool,
        status: event.status,
        durationMs: event.durationMs,
        errorCode: event.errorCode,
      };
      if (index < 0)
        return {
          ...reply,
          items: [...reply.items, next],
          phase: reply.phase === "waiting" ? "streaming" : reply.phase,
        };
      const current = reply.items[index] as Extract<
        LiveReplyItem,
        { type: "tool" }
      >;
      // A duplicate start for an already-settled call changes nothing.
      if (event.status === "inProgress" && current.status !== "inProgress")
        return reply;
      const items = [...reply.items];
      items[index] = next;
      return { ...reply, items };
    }
    case "skill": {
      // A skill the model opened: placed once, where it happened.
      const skill = parseUsedSkill(data);
      if (
        !skill ||
        reply.items.some((i) => i.type === "skill" && i.slug === skill.slug)
      )
        return reply;
      return {
        ...reply,
        items: [...reply.items, { type: "skill", ...skill }],
        phase: reply.phase === "waiting" ? "streaming" : reply.phase,
      };
    }
    case "network": {
      // A blocked sandbox request: placed once per site and method.
      const block = parseNetworkBlock(data);
      if (!block || reply.items.some((i) => sameBlock(i, block))) return reply;
      return {
        ...reply,
        items: [...reply.items, { type: "network", ...block }],
        phase: reply.phase === "waiting" ? "streaming" : reply.phase,
      };
    }
    case "activity": {
      // A command or file change: placed when first seen, settled by itemId.
      // A finished one never goes back to running; output streamed so far is
      // kept when the event carries none.
      const next = parseActivity(data);
      if (!next) return reply;
      const index = reply.items.findIndex(
        (i) =>
          i.type === next.type && "itemId" in i && i.itemId === next.itemId,
      );
      if (index < 0)
        return {
          ...reply,
          items: [...reply.items, next],
          phase: reply.phase === "waiting" ? "streaming" : reply.phase,
        };
      const current = reply.items[index] as Activity;
      if (current.status !== "inProgress") return reply;
      const merged: Activity =
        next.type === "command" &&
        current.type === "command" &&
        !next.output &&
        current.output
          ? {
              ...next,
              output: current.output,
              outputTruncated: current.outputTruncated,
            }
          : next;
      const items = [...reply.items];
      items[index] = merged;
      return { ...reply, items };
    }
    case "progress": {
      // A file change the model is still writing: shown where the change
      // will be, until its activity replaces it. A progress event for an
      // existing activity changes nothing.
      const progress = parseProgress(data);
      if (!progress) return reply;
      const itemId = progress.ended
        ? progress.itemId
        : progress.activity.itemId;
      const index = reply.items.findIndex(
        (i) => i.type === "file_change" && i.itemId === itemId,
      );
      const current =
        index < 0
          ? null
          : (reply.items[index] as Extract<Activity, { type: "file_change" }>);
      if (current && current.writtenLines === undefined) return reply;
      if (progress.ended)
        return current
          ? { ...reply, items: reply.items.filter((_, i) => i !== index) }
          : reply;
      const preview = withPreviewPiece(current?.preview, progress.piece);
      const next = preview
        ? { ...progress.activity, preview }
        : progress.activity;
      if (!current)
        return {
          ...reply,
          items: [...reply.items, next],
          phase: reply.phase === "waiting" ? "streaming" : reply.phase,
        };
      const items = [...reply.items];
      items[index] = next;
      return { ...reply, items };
    }
    case "output": {
      const itemId = str(data?.itemId, 200);
      const text = str(data?.text, 100_000);
      if (!itemId || !text) return reply;
      const index = reply.items.findIndex(
        (i) => i.type === "command" && i.itemId === itemId,
      );
      if (index < 0) return reply;
      const items = [...reply.items];
      items[index] = withOutput(items[index] as Activity, text);
      return { ...reply, items };
    }
    case "connector": {
      // A connector's own status during the reply. Only a failure is kept,
      // once per connector, so a banner shows once per connector per run.
      const event = parseConnectorEvent(data);
      if (!event || event.status !== "failed") return reply;
      if (reply.connectorFailures[event.connector] === event.reason)
        return reply;
      return {
        ...reply,
        connectorFailures: {
          ...reply.connectorFailures,
          [event.connector]: event.reason,
        },
      };
    }
    case "approval": {
      // A write-tool approval. A pending event opens the card at its tool
      // row; a settled event (a decision, or an auto allow-for-chat replay)
      // updates it to an outcome label by approvalId.
      const event = parseApprovalEvent(data);
      if (!event) return reply;
      const current = reply.approvals[event.approvalId];
      // First answer wins: a late or replayed *pending* event must not reopen
      // a card this tab already settled (withApproval) or raced to a 409/404
      // (withApprovalRace). A settled event (a real decision) still applies.
      if (
        event.status === "pending" &&
        current &&
        (current.status !== "pending" || current.race)
      )
        return reply;
      return {
        ...reply,
        approvals: {
          ...reply.approvals,
          [event.approvalId]: {
            ...event,
            ...(current?.race ? { race: current.race } : {}),
          },
        },
        phase: reply.phase === "waiting" ? "streaming" : reply.phase,
      };
    }
    case "usage": {
      const usage = parseUsage(data);
      return usage ? { ...reply, usage } : reply;
    }
    case "completed": {
      const status = oneOf(data?.status, RUN_STATUSES);
      if (!data || !status) return reply;
      const items = parseItems(data.items);
      return {
        ...reply,
        phase: "settled",
        items: items.length ? items : reply.items,
        usage: parseUsage(data.usage) ?? reply.usage,
        helpers: withHelpers(
          reply.helpers,
          list(data.agents, parseLiveHelper).slice(0, MAX_HELPERS),
        ),
        outcome: { status, error: parseRunError(data.error) },
      };
    }
    case "files": {
      const files = parseFiles(data);
      const unsaved = parseUnsaved(data?.unsaved);
      if (!files.length && !unsaved.length) return reply;
      return { ...reply, files: withFiles(reply.files, files), unsaved };
    }
    case "save_failed":
      return { ...reply, saveFailed: true };
    default:
      return reply;
  }
}

// The `saved` event: the reply's run and messages as stored.
export function parseSaved(
  data: unknown,
): { run: ChatRun; messages: ChatMessage[] } | null {
  const d = record(data);
  const run = parseRun(d?.run);
  if (!run) return null;
  return { run, messages: list(d?.messages, parseMessage) };
}

// A saved reply applied to the open chat: its messages and run join the
// history, and the chat can take the next message. A lost thread makes the
// chat read-only, as the platform reports on the next read.
export function withSaved(
  thread: ChatThread,
  saved: { run: ChatRun; messages: ChatMessage[] },
): ChatThread {
  const next = withRun(withMessages(thread, saved.messages), saved.run);
  if (next.chat.activeRunId !== saved.run.id) return next;
  return {
    ...next,
    chat: {
      ...next.chat,
      activeRunId: null,
      readOnly:
        saved.run.error?.code === "THREAD_LOST"
          ? "THREAD_LOST"
          : next.chat.readOnly,
    },
  };
}

// The owner's answer to a network card, applied to its saved message.
export function withNetworkDecision(
  thread: ChatThread,
  messageId: string,
  decision: NetworkDecision,
): ChatThread {
  let changed = false;
  const messages = thread.messages.map((m) => {
    if (m.id !== messageId || !m.network || m.network.decision) return m;
    changed = true;
    return { ...m, network: { ...m.network, decision } };
  });
  return changed ? { ...thread, messages } : thread;
}

// One card per site and method in a reply (the platform's networkKey).
function sameBlock(item: LiveReplyItem, block: NetworkBlock): boolean {
  return (
    item.type === "network" &&
    item.kind === block.kind &&
    item.host === block.host &&
    (block.kind === "unlisted" || item.method === block.method)
  );
}

// An older page of history added above what is loaded. Runs already known
// are newer than the page's copy and are kept.
export function withOlder(
  thread: ChatThread,
  page: { messages: ChatMessage[]; runs: ChatRun[]; hasMore: boolean },
): ChatThread {
  const merged = withMessages(thread, page.messages);
  const runs = { ...merged.runs };
  for (const run of page.runs) runs[run.id] ??= run;
  return { ...merged, runs, hasMore: page.hasMore };
}

// The chat named by the page's ?chat= parameter, if it is a chat ID.
export function chatParam(search: string): string | null {
  return id(new URLSearchParams(search).get("chat"));
}

// Enter sends and Shift+Enter starts a new line. On touch keyboards Enter is
// a new line and the button sends; Ctrl/Cmd+Enter sends everywhere. Nothing
// is sent while an input method is composing.
export function sendsOnEnter(
  key: {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
  },
  touch: boolean,
): boolean {
  if (key.key !== "Enter" || key.isComposing || key.shiftKey || key.altKey)
    return false;
  return key.ctrlKey || key.metaKey || !touch;
}

// Why the draft cannot be sent as it is, or null. Counted as the platform
// counts it (after NFC).
export function draftProblem(text: string): string | null {
  const length = text.normalize("NFC").length;
  if (length <= MAX_MESSAGE_CHARS) return null;
  return `Shorten your message to ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters (now ${length.toLocaleString("en-US")}).`;
}

export const canSendDraft = (text: string) =>
  text.trim().length > 0 && draftProblem(text) === null;

// A message can be text, files, or both. Files must all be uploaded, and
// can't be added to a reply that is running (`busy`).
export function canSendMessage(
  text: string,
  files: readonly DraftFile[],
  busy: boolean,
): boolean {
  if (draftProblem(text) !== null) return false;
  if (files.length === 0) return text.trim().length > 0;
  return !busy && filesReady(files);
}

export interface SendFailure {
  message: string;
  // The message may have been saved; sending again reuses its ID.
  unknown: boolean;
  // The chat changed underneath (busy, read-only, gone): read it again.
  reload: boolean;
  // A refusal about the running reply (busy, too many follow-ups): it no
  // longer applies once that reply ends, so the composer drops it then.
  untilReplyEnds: boolean;
}

// The open chat's running reply, as last seen.
export interface RunningReply {
  chatId: string;
  runId: string | null;
}

// True when the reply that was running in this chat has ended (or another
// has replaced it). A chat that was idle, or a different chat, is not an
// ending: a stale idle copy that a reload shows as busy must not clear a
// "still answering" refusal.
export const replyEnded = (
  before: RunningReply | null,
  after: RunningReply | null,
): boolean =>
  !!before?.runId &&
  before.chatId === after?.chatId &&
  before.runId !== after.runId;

// What the composer says when a send fails.
export function sendFailure(error: unknown): SendFailure {
  if (sendOutcomeUnknown(error))
    return {
      message:
        "Your message may not have reached Truex. Send it again: if it already arrived, it won't be sent twice.",
      unknown: true,
      reload: false,
      untilReplyEnds: false,
    };
  const e = error as { code?: unknown; message?: unknown };
  const message =
    typeof e.message === "string" && e.message
      ? e.message
      : "This message couldn't be sent. Try again.";
  switch (e.code) {
    case "CHAT_BUSY":
      return {
        message:
          "This chat is still answering. Wait for the reply, or stop it.",
        unknown: false,
        reload: true,
        untilReplyEnds: true,
      };
    case "CHAT_READ_ONLY":
    case "NOT_FOUND":
      return { message, unknown: false, reload: true, untilReplyEnds: false };
    case "STEER_LIMIT":
      // Too many steers on one reply. The draft is kept so the member can
      // send it as a new message once the reply ends; no reload is needed.
      return {
        message:
          typeof e.message === "string" && e.message
            ? e.message
            : "This reply already has too many follow-ups.",
        unknown: false,
        reload: false,
        untilReplyEnds: true,
      };
    default:
      return { message, unknown: false, reload: false, untilReplyEnds: false };
  }
}

// One run and all of its saved messages, in seq order. A run can hold more
// than the first user message and one reply now: a steer adds another user
// message, and a steered turn can write several replies, interleaved in the
// order Codex produced them.
export interface Exchange {
  runId: string;
  messages: ChatMessage[];
  run: ChatRun | null;
}

export function exchangesOf(thread: ChatThread): Exchange[] {
  const exchanges: Exchange[] = [];
  const byRun = new Map<string, Exchange>();
  for (const message of thread.messages) {
    let exchange = byRun.get(message.runId);
    if (!exchange) {
      exchange = {
        runId: message.runId,
        messages: [],
        run: thread.runs[message.runId] ?? null,
      };
      byRun.set(message.runId, exchange);
      exchanges.push(exchange);
    }
    exchange.messages.push(message);
  }
  return exchanges;
}

// The row an exchange is rendered as: its first user message's browser ID
// when it has one, so a message shown on Send keeps its row (and the reply
// under it) when the saved copy replaces it.
export const exchangeKey = (exchange: Exchange): string => {
  const firstUser = exchange.messages.find((m) => m.role === "user");
  return firstUser?.clientMessageId
    ? `message:${firstUser.clientMessageId}`
    : exchange.runId;
};

const SETTLED: readonly RunStatus[] = ["completed", "stopped", "failed"];
export const isSettled = (status: RunStatus) => SETTLED.includes(status);

// The quiet line under a finished reply: "2.4 s · 1,240 in · 312 out".
export function usageLine(run: ChatRun | null): string {
  if (!run) return "";
  const parts: string[] = [];
  const start = Date.parse(run.timings.acceptedAt);
  const end = run.timings.completedAt
    ? Date.parse(run.timings.completedAt)
    : NaN;
  if (Number.isFinite(end) && end >= start) parts.push(seconds(end - start));
  const usage = run.usage;
  if (usage && (usage.input || usage.output)) {
    parts.push(`${usage.input.toLocaleString("en-US")} in`);
    if (usage.cached)
      parts.push(`${usage.cached.toLocaleString("en-US")} cached`);
    parts.push(`${usage.output.toLocaleString("en-US")} out`);
  }
  return parts.join(" · ");
}

function seconds(ms: number): string {
  return ms < 10_000
    ? `${(ms / 1000).toFixed(1)} s`
    : `${Math.round(ms / 1000)} s`;
}

// What a reply's footer says when it did not complete normally.
export function outcomeNote(
  status: RunStatus,
  error: RunError | null,
): string | null {
  if (status === "stopped") return "Stopped";
  if (status === "failed")
    return error?.message ?? "This reply failed. Try again.";
  if (status === "uncertain")
    return "Checking whether this message reached the assistant…";
  return null;
}

// The quiet label under a saved message whose state is not the plain
// `complete`. An assistant reply `interrupted` by the member's next message
// keeps its partial text under this note; a `not_sent` user message was
// added to a reply the assistant never read, and offers a Resend.
export function messageStateNote(message: ChatMessage): string | null {
  if (message.role === "assistant" && message.state === "interrupted")
    return "Cut short by your next message";
  if (message.role === "user" && message.state === "not_sent")
    return "Not sent";
  return null;
}

/**
 * One message ID per intent: sending the same text to the same chat again
 * after a lost answer reuses the ID, so the platform returns the message it
 * already saved instead of running it twice. Any edit, or a confirmed
 * answer, starts a new intent.
 */
export function messageIds(generate: () => string = () => crypto.randomUUID()) {
  let last: { key: string; id: string } | null = null;
  return {
    for(target: string, text: string): string {
      const key = JSON.stringify([target, text]);
      if (last?.key !== key) last = { key, id: generate() };
      return last.id;
    },
    reset() {
      last = null;
    },
  };
}

// Whether a failed send may have been saved anyway, so retrying should reuse
// the same message ID rather than treat it as refused.
export function sendOutcomeUnknown(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  if (!e || typeof e.status !== "number") return true;
  return e.status === 0 || e.status >= 500;
}

// Why the chat cannot take another message, or null when it can.
export function readOnlyNote(chat: ChatSummary): string | null {
  if (chat.status === "archived")
    return "This chat is archived. Start a new chat to continue.";
  switch (chat.readOnly) {
    case "THREAD_LOST":
      return "This chat's history is no longer available to the assistant, so it can't continue. Start a new chat.";
    case "MODEL_UNAVAILABLE":
      return "This chat's model is no longer available, so it can't continue. Start a new chat.";
    case "AGENT_UNAVAILABLE":
      return "This chat's agent is no longer available, so it can't continue. Start a new chat.";
    default:
      return null;
  }
}

export function titleProblem(title: string): string | null {
  const t = title.trim();
  if (!t) return "Give the chat a title.";
  if (t.length > MAX_TITLE_CHARS)
    return `Keep the title under ${MAX_TITLE_CHARS + 1} characters.`;
  return null;
}

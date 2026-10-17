// Chats in the tenant workspace (platform-next /api/v1/chats). Wire parsers,
// thin API wrappers and the pure state changes the chat screen applies, so
// the components only render. Every request names this tab's tenant through
// api(); the live reply stream is in tenant-chat-stream.ts.
import { api } from "./api.ts";
import type { AgentSource, AgentTint, TenantModel } from "./tenant-agents.ts";

// Kept in step with platform-next/src/modules/chats/chat.ts.
export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_TITLE_CHARS = 120;
// "Still working…" appears when a reply has shown nothing for this long.
export const SLOW_REPLY_MS = 15_000;

export type ReadOnlyReason =
  "THREAD_LOST" | "MODEL_UNAVAILABLE" | "AGENT_UNAVAILABLE";
export type MessageState = "complete" | "stopped" | "failed";
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
}

export interface ChatMessage {
  id: string;
  seq: number;
  runId: string;
  role: "user" | "assistant";
  text: string;
  state: MessageState;
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

const WIRE_ID = /^[0-9a-f]{24}$/;
const SOURCES: readonly AgentSource[] = ["builtin", "personal", "tenant"];
const TINTS: readonly AgentTint[] = ["ice", "mint", "butter", "peach", "lilac"];
const READ_ONLY: readonly ReadOnlyReason[] = [
  "THREAD_LOST",
  "MODEL_UNAVAILABLE",
  "AGENT_UNAVAILABLE",
];
const STATES: readonly MessageState[] = ["complete", "stopped", "failed"];
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
  };
}

export function parseMessage(value: unknown): ChatMessage | null {
  const m = record(value);
  const messageId = id(m?.id);
  const runId = id(m?.runId);
  const text = str(m?.text, 1_000_000);
  const createdAt = date(m?.createdAt);
  const role = m?.role === "user" || m?.role === "assistant" ? m.role : null;
  if (!m || !messageId || !runId || text === null || !createdAt || !role)
    return null;
  if (typeof m.seq !== "number" || !Number.isInteger(m.seq)) return null;
  const clientMessageId = str(m.clientMessageId, 64);
  return {
    id: messageId,
    seq: m.seq,
    runId,
    role,
    text,
    state: oneOf(m.state, STATES) ?? "complete",
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
  return {
    id: runId,
    status,
    error: parseRunError(r.error),
    usage: parseUsage(r.usage),
    timings,
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

function receiptOf(data: unknown): SendReceipt {
  const d = record(data);
  const chat = parseChat(d?.chat);
  const message = parseMessage(d?.message);
  const run = parseRun(d?.run);
  if (!chat || !message || !run) unreadable();
  return { chat, message, run };
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

export const startChat = async (
  agentId: string,
  text: string,
  clientMessageId: string,
): Promise<SendReceipt> =>
  receiptOf(await api("/api/v1/chats", { agentId, clientMessageId, text }));

export const sendMessage = async (
  chatId: string,
  text: string,
  clientMessageId: string,
): Promise<SendReceipt> =>
  receiptOf(
    await api(chatPath(chatId, "/messages"), { clientMessageId, text }),
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

// What the screen shows for one reply while it is not yet saved.
export interface LiveReply {
  runId: string;
  phase: Phase;
  items: Array<{ itemId: string; text: string }>;
  usage: RunUsage | null;
  // The outcome is known (completed event) but not yet saved.
  outcome: { status: RunStatus; error: RunError | null } | null;
  saveFailed: boolean;
  // When the reply started, for the "Still working…" note.
  since: number;
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
  };
}

function parseItems(value: unknown): LiveReply["items"] {
  return list(value, (v) => {
    const item = record(v);
    const itemId = str(item?.itemId, 200);
    const text = str(item?.text, 1_000_000);
    return item && itemId && text !== null ? { itemId, text } : null;
  });
}

export type StreamEvent =
  | { type: "snapshot"; data: unknown }
  | { type: "status"; data: unknown }
  | { type: "delta"; data: unknown }
  | { type: "item"; data: unknown }
  | { type: "usage"; data: unknown }
  | { type: "completed"; data: unknown }
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
        items: parseItems(data.items),
        usage: parseUsage(data.usage) ?? reply.usage,
      };
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
      const index = reply.items.findIndex((i) => i.itemId === itemId);
      const items = [...reply.items];
      if (index < 0) items.push({ itemId, text });
      else
        items[index] = {
          itemId,
          text: event.type === "delta" ? items[index].text + text : text,
        };
      return {
        ...reply,
        items,
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
        outcome: { status, error: parseRunError(data.error) },
      };
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

export interface SendFailure {
  message: string;
  // The message may have been saved; sending again reuses its ID.
  unknown: boolean;
  // The chat changed underneath (busy, read-only, gone): read it again.
  reload: boolean;
}

// What the composer says when a send fails.
export function sendFailure(error: unknown): SendFailure {
  if (sendOutcomeUnknown(error))
    return {
      message:
        "Your message may not have reached Truex. Send it again: if it already arrived, it won't be sent twice.",
      unknown: true,
      reload: false,
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
      };
    case "CHAT_READ_ONLY":
    case "NOT_FOUND":
      return { message, unknown: false, reload: true };
    default:
      return { message, unknown: false, reload: false };
  }
}

// One user message and what answered it, in the order shown.
export interface Exchange {
  runId: string;
  user: ChatMessage | null;
  replies: ChatMessage[];
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
        user: null,
        replies: [],
        run: thread.runs[message.runId] ?? null,
      };
      byRun.set(message.runId, exchange);
      exchanges.push(exchange);
    }
    if (message.role === "user") exchange.user = message;
    else exchange.replies.push(message);
  }
  return exchanges;
}

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

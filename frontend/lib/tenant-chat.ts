// Chats in the tenant workspace (platform-next /api/v1/chats). Wire parsers,
// thin API wrappers and the pure state changes the chat screen applies, so
// the components only render. Every request names this tab's tenant through
// api(); the live reply stream is in tenant-chat-stream.ts.
import { api } from "./api.ts";
import type {
  AgentSource,
  AgentTint,
  TenantAgent,
  TenantModel,
} from "./tenant-agents.ts";

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

export function parseSteer(value: unknown): SteerView | null {
  const s = record(value);
  const clientMessageId = str(s?.clientMessageId, 64);
  const text = str(s?.text, 1_000_000);
  const createdAt = date(s?.createdAt);
  if (!s || !clientMessageId || text === null || !createdAt) return null;
  return { clientMessageId, text, createdAt };
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
  return {
    id: runId,
    status,
    error: parseRunError(r.error),
    usage: parseUsage(r.usage),
    timings,
    ...(steers ? { steers } : {}),
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

export const startChat = async (
  agentId: string,
  text: string,
  clientMessageId: string,
): Promise<SendReceipt> =>
  receiptOf(await api("/api/v1/chats", { agentId, clientMessageId, text }));

// A message to an open chat. The platform decides whether it starts a new
// run or steers the one still replying, so the receipt is one or the other.
export const sendMessage = async (
  chat: ChatSummary,
  text: string,
  clientMessageId: string,
): Promise<MessageReceipt> =>
  messageReceiptOf(
    await api(chatPath(chat.id, "/messages"), { clientMessageId, text }),
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
    };

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
    const itemId = str(item.itemId, 200);
    const text = str(item.text, 1_000_000);
    if (!itemId || text === null) return null;
    return { type: "reply", itemId, text, completed: item.completed === true };
  });
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

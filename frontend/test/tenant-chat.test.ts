import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ApiRequestError } from "../lib/api.ts";
import {
  applyStreamEvent,
  canSendDraft,
  chatParam,
  draftProblem,
  MAX_MESSAGE_CHARS,
  sendFailure,
  sendsOnEnter,
  withOlder,
  withSaved,
  exchangesOf,
  exchangeKey,
  fetchChat,
  fetchChats,
  liveReply,
  messageIds,
  outcomeNote,
  parseChat,
  parseSaved,
  pendingRunId,
  pendingThread,
  readOnlyNote,
  sendMessage,
  sendOutcomeUnknown,
  startChat,
  titleProblem,
  usageLine,
  withChat,
  withPending,
  withReceipt,
  type ChatRun,
  type ChatSummary,
  type ChatThread,
} from "../lib/tenant-chat.ts";

const CHAT = "64b7f0c2a1b2c3d4e5f60c01";
const RUN = "64b7f0c2a1b2c3d4e5f60d01";
const RUN2 = "64b7f0c2a1b2c3d4e5f60d02";

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: CHAT,
  title: "Plan the launch",
  agent: {
    id: "64b7f0c2a1b2c3d4e5f60aa1",
    source: "builtin",
    name: "General",
    look: 2,
    tint: "ice",
  },
  model: {
    id: "64b7f0c2a1b2c3d4e5f60001",
    displayName: "Claude Sonnet 5.5",
    shortLabel: "sonnet 5.5",
    family: "anthropic",
  },
  readOnly: null,
  activeRunId: null,
  status: "active",
  lastMessageAt: "2026-10-17T10:00:00.000Z",
  createdAt: "2026-10-17T09:00:00.000Z",
  ...overrides,
});

const message = (
  seq: number,
  role: "user" | "assistant",
  runId = RUN,
  overrides: Record<string, unknown> = {},
) => ({
  id: `64b7f0c2a1b2c3d4e5f60e${String(seq).padStart(2, "0")}`,
  seq,
  runId,
  role,
  text: `${role} ${seq}`,
  state: "complete",
  createdAt: "2026-10-17T10:00:00.000Z",
  ...overrides,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  id: RUN,
  status: "completed",
  error: null,
  usage: { input: 1240, cached: 0, cacheWrite: 0, output: 312, reasoning: 0 },
  timings: {
    acceptedAt: "2026-10-17T10:00:00.000Z",
    completedAt: "2026-10-17T10:00:02.400Z",
  },
  ...overrides,
});

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(
  t: { after: (fn: () => void) => void },
  reply: (sent: Sent) => Response,
) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const entry = {
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(entry);
    return reply(entry);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

beforeEach(() => signInForTest());

test("parses chats and drops malformed ones", () => {
  assert.equal(parseChat(chat())?.agent?.name, "General");
  assert.equal(parseChat(chat({ id: "nope" })), null);
  assert.equal(parseChat(chat({ lastMessageAt: "yesterday" })), null);
  // Unknown read-only reasons and agent sources are not trusted.
  const odd = parseChat(chat({ readOnly: "SOMETHING", agent: null }));
  assert.equal(odd?.readOnly, null);
  assert.equal(odd?.agent, null);
});

test("lists chats for this tab's tenant with a cursor", async (t) => {
  const sent = mockFetch(t, () =>
    Response.json({ chats: [chat(), { id: "bad" }], nextCursor: "17_abc" }),
  );
  const page = await fetchChats("17_abc");
  assert.equal(
    sent[0].url,
    `/api/v1/chats?cursor=17_abc&tenantId=${TENANT_ID}`,
  );
  assert.equal(page.chats.length, 1);
  assert.equal(page.nextCursor, "17_abc");
});

test("opens a chat with its messages in order and runs by id", async (t) => {
  mockFetch(t, () =>
    Response.json({
      chat: chat(),
      messages: [message(2, "assistant"), message(1, "user")],
      runs: [run()],
      hasMore: true,
    }),
  );
  const thread = await fetchChat(CHAT);
  assert.deepEqual(
    thread.messages.map((m) => m.seq),
    [1, 2],
  );
  assert.equal(thread.runs[RUN]?.status, "completed");
  assert.equal(thread.hasMore, true);
});

test("starts a chat and sends follow-ups with the message ID", async (t) => {
  const sent = mockFetch(t, () =>
    Response.json(
      {
        chat: chat({ activeRunId: RUN }),
        message: message(1, "user"),
        run: run({ status: "accepted" }),
        created: true,
      },
      { status: 202 },
    ),
  );
  const receipt = await startChat(
    "64b7f0c2a1b2c3d4e5f60aa1",
    "Hi",
    "client-id-1",
  );
  assert.equal(receipt.run.status, "accepted");
  assert.deepEqual(sent[0].body, {
    agentId: "64b7f0c2a1b2c3d4e5f60aa1",
    clientMessageId: "client-id-1",
    text: "Hi",
  });
  const open = parseChat(chat())!;
  await sendMessage(open, "More", "client-id-2");
  assert.equal(
    sent[1].url,
    `/api/v1/chats/${CHAT}/messages?tenantId=${TENANT_ID}`,
  );
  assert.deepEqual(sent[1].body, {
    clientMessageId: "client-id-2",
    text: "More",
  });
});

test("a follow-up receipt without its agent keeps the chat's agent", async (t) => {
  const { agent: _left, ...withoutAgent } = chat({ activeRunId: RUN });
  const replies = [
    // Left out: unchanged since this follow-up did not read it.
    { chat: withoutAgent, message: message(3, "user"), run: run() },
    // Sent as null: the server says the agent is gone.
    {
      chat: chat({ agent: null, readOnly: "AGENT_UNAVAILABLE" }),
      message: message(3, "user"),
      run: run(),
    },
  ];
  mockFetch(t, () => Response.json(replies.shift(), { status: 202 }));
  const open = parseChat(chat())!;
  const receipt = await sendMessage(open, "More", "client-id-4");
  assert.deepEqual(receipt.chat.agent, open.agent);
  assert.equal(receipt.chat.activeRunId, RUN);
  const gone = await sendMessage(open, "More", "client-id-4");
  assert.equal(gone.chat.agent, null);
});

test("an unreadable receipt is an error, not a half-rendered chat", async (t) => {
  mockFetch(t, () =>
    Response.json({ chat: chat(), message: null, run: run() }),
  );
  await assert.rejects(
    sendMessage(parseChat(chat())!, "x", "client-id-3"),
    /unreadable/,
  );
});

test("stream events build the live reply; a snapshot replaces it", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "delta",
    data: { itemId: "a", text: "Hel" },
  });
  assert.equal(reply.phase, "streaming");
  reply = applyStreamEvent(reply, {
    type: "delta",
    data: { itemId: "a", text: "lo" },
  });
  assert.equal(reply.items[0].text, "Hello");
  // A reconnect's snapshot is the truth, even when shorter.
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [{ itemId: "a", text: "Hel" }],
      usage: null,
    },
  });
  assert.equal(reply.items[0].text, "Hel");
  reply = applyStreamEvent(reply, {
    type: "item",
    data: { itemId: "a", text: "Hello there" },
  });
  assert.equal(reply.items[0].text, "Hello there");
  reply = applyStreamEvent(reply, {
    type: "completed",
    data: {
      status: "failed",
      error: {
        code: "PROVIDER_ERROR",
        message: "The model failed.",
        retryable: true,
      },
      items: [],
      usage: null,
    },
  });
  assert.equal(reply.phase, "settled");
  assert.equal(reply.items[0].text, "Hello there");
  assert.equal(reply.outcome?.error?.message, "The model failed.");
  assert.equal(
    applyStreamEvent(reply, { type: "save_failed", data: {} }).saveFailed,
    true,
  );
});

test("malformed or foreign stream events change nothing", () => {
  const reply = liveReply(RUN, 0);
  for (const event of [
    {
      type: "snapshot",
      data: { runId: RUN2, items: [{ itemId: "x", text: "no" }] },
    },
    { type: "delta", data: { itemId: 3, text: "x" } },
    { type: "status", data: { phase: "exploding" } },
    { type: "completed", data: { status: "weird" } },
    { type: "surprise", data: {} },
  ])
    assert.equal(applyStreamEvent(reply, event), reply);
});

test("the saved event carries the stored run and messages", () => {
  const saved = parseSaved({
    run: run(),
    messages: [message(2, "assistant"), 7],
  });
  assert.equal(saved?.run.status, "completed");
  assert.equal(saved?.messages.length, 1);
  assert.equal(parseSaved({ run: null }), null);
});

test("chat list stays newest first; archived chats leave it", () => {
  const older = parseChat(
    chat({
      id: "64b7f0c2a1b2c3d4e5f60c02",
      lastMessageAt: "2026-10-16T10:00:00.000Z",
    }),
  )!;
  const current = parseChat(chat())!;
  let chats: ChatSummary[] = withChat([older], current);
  assert.deepEqual(
    chats.map((c) => c.id),
    [CHAT, older.id],
  );
  chats = withChat(chats, {
    ...older,
    lastMessageAt: "2026-10-18T10:00:00.000Z",
  });
  assert.deepEqual(
    chats.map((c) => c.id),
    [older.id, CHAT],
  );
  chats = withChat(chats, { ...current, status: "archived" });
  assert.deepEqual(
    chats.map((c) => c.id),
    [older.id],
  );
});

test("receipts start or extend the open chat; exchanges group by run", () => {
  const receipt = {
    chat: parseChat(chat())!,
    message: { ...message(1, "user"), state: "complete" as const },
    run: run({ status: "accepted" }) as unknown as ChatRun,
  };
  let thread: ChatThread = withReceipt(null, receipt);
  assert.equal(thread.messages.length, 1);
  thread = {
    ...thread,
    messages: [...thread.messages, message(2, "assistant") as never],
  };
  thread = withReceipt(thread, {
    ...receipt,
    message: message(3, "user", RUN2) as never,
    run: { ...receipt.run, id: RUN2 },
  });
  const exchanges = exchangesOf(thread);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].replies[0].text, "assistant 2");
  assert.equal(exchanges[1].user?.text, "user 3");
  // A receipt for another chat starts fresh rather than mixing transcripts.
  const other = withReceipt(thread, {
    ...receipt,
    chat: { ...receipt.chat, id: "64b7f0c2a1b2c3d4e5f60c09" },
  });
  assert.equal(other.messages.length, 1);
});

test("a pending message shows at once and keeps its row when the saved copy replaces it", () => {
  const cmid = "5b0e5f0e-8a4c-4f3e-9d0e-1f2a3b4c5d6e";
  const pending = {
    key: CHAT,
    text: "Next question",
    clientMessageId: cmid,
    since: Date.parse("2026-10-17T10:05:00.000Z"),
  };
  const before: ChatThread = {
    chat: parseChat(chat())!,
    messages: [message(1, "user") as never, message(2, "assistant") as never],
    runs: {},
    hasMore: false,
  };
  const shown = withPending(before, pending);
  assert.equal(shown.messages.length, 3);
  const added = shown.messages[2];
  assert.equal(added.role, "user");
  assert.equal(added.text, "Next question");
  assert.equal(added.seq, 3);
  assert.equal(added.runId, pendingRunId(pending));
  assert.equal(before.messages.length, 2);

  // The pending exchange and the saved one render under the same key.
  const pendingExchange = exchangesOf(shown).at(-1)!;
  const saved = withReceipt(before, {
    chat: parseChat(chat({ activeRunId: RUN2 }))!,
    message: message(3, "user", RUN2, {
      text: "Next question",
      clientMessageId: cmid,
    }) as never,
    run: run({ id: RUN2, status: "accepted" }) as unknown as ChatRun,
  });
  const savedExchange = exchangesOf(saved).at(-1)!;
  assert.notEqual(pendingExchange.runId, savedExchange.runId);
  assert.equal(exchangeKey(pendingExchange), exchangeKey(savedExchange));
  // Older messages without a browser ID keep their run as the key.
  assert.equal(exchangeKey(exchangesOf(shown)[0]), RUN);

  // A message already saved (a resend after a lost answer) is not doubled.
  assert.equal(withPending(saved, pending), saved);
});

test("a first message shows as the start of its chat", () => {
  const pending = {
    key: "new",
    text: "Hi",
    clientMessageId: "0f1e2d3c-4b5a-4968-8776-655443322110",
    since: Date.parse("2026-10-17T10:05:00.000Z"),
  };
  const agent = {
    id: "64b7f0c2a1b2c3d4e5f60aa1",
    source: "builtin" as const,
    name: "General",
    description: "",
    look: 3,
    tint: "mint" as const,
    model: null,
    available: true,
    revision: 1,
    createdByMe: false,
    status: "active" as const,
    canEdit: false,
    canArchive: false,
    canPromote: false,
  };
  const thread = pendingThread(agent, pending);
  assert.equal(thread.chat.title, "");
  assert.equal(thread.chat.activeRunId, null);
  assert.deepEqual(thread.chat.agent, {
    id: agent.id,
    source: "builtin",
    name: "General",
    look: 3,
    tint: "mint",
  });
  assert.deepEqual(
    thread.messages.map((m) => [m.seq, m.role, m.text]),
    [[1, "user", "Hi"]],
  );
});

test("usage line and outcome notes", () => {
  assert.equal(
    usageLine(run() as unknown as ChatRun),
    "2.4 s · 1,240 in · 312 out",
  );
  assert.equal(
    usageLine(
      run({
        usage: { input: 10, cached: 8, cacheWrite: 0, output: 2, reasoning: 0 },
        timings: {
          acceptedAt: "2026-10-17T10:00:00.000Z",
          completedAt: "2026-10-17T10:00:12.600Z",
        },
      }) as unknown as ChatRun,
    ),
    "13 s · 10 in · 8 cached · 2 out",
  );
  assert.equal(usageLine(null), "");
  assert.equal(outcomeNote("completed", null), null);
  assert.equal(outcomeNote("stopped", null), "Stopped");
  assert.equal(
    outcomeNote("failed", {
      code: "NOT_SENT",
      message: "Not sent.",
      retryable: true,
    }),
    "Not sent.",
  );
});

test("one message ID per intent", () => {
  let n = 0;
  const ids = messageIds(() => `id-${++n}`);
  assert.equal(ids.for("chat", "Hi"), "id-1");
  assert.equal(ids.for("chat", "Hi"), "id-1");
  assert.equal(ids.for("chat", "Hi!"), "id-2");
  ids.reset();
  assert.equal(ids.for("chat", "Hi!"), "id-3");
});

test("only network and server failures leave a send's outcome unknown", () => {
  assert.equal(
    sendOutcomeUnknown(new ApiRequestError("x", 0, "NETWORK_ERROR")),
    true,
  );
  assert.equal(
    sendOutcomeUnknown(new ApiRequestError("x", 503, "UNAVAILABLE")),
    true,
  );
  assert.equal(
    sendOutcomeUnknown(new ApiRequestError("x", 409, "CHAT_BUSY")),
    false,
  );
  assert.equal(
    sendOutcomeUnknown(new ApiRequestError("x", 429, "RATE_LIMITED")),
    false,
  );
});

test("read-only notes and title checks", () => {
  const c = parseChat(chat())!;
  assert.equal(readOnlyNote(c), null);
  assert.match(
    readOnlyNote({ ...c, readOnly: "THREAD_LOST" })!,
    /no longer available/,
  );
  assert.match(readOnlyNote({ ...c, status: "archived" })!, /archived/);
  assert.equal(titleProblem("  "), "Give the chat a title.");
  assert.equal(titleProblem("x".repeat(121)) !== null, true);
  assert.equal(titleProblem("Fine"), null);
});

test("a saved reply joins the history and frees the chat", () => {
  const open: ChatThread = {
    chat: parseChat(chat({ activeRunId: RUN }))!,
    messages: [message(1, "user") as never],
    runs: { [RUN]: run({ status: "running" }) as never },
    hasMore: false,
  };
  const saved = parseSaved({
    run: run(),
    messages: [message(2, "assistant")],
  })!;
  const next = withSaved(open, saved);
  assert.equal(next.chat.activeRunId, null);
  assert.equal(next.runs[RUN]?.status, "completed");
  assert.deepEqual(
    next.messages.map((m) => m.seq),
    [1, 2],
  );
  // Applying it twice changes nothing more.
  assert.deepEqual(withSaved(next, saved), next);
  // A lost thread makes the chat read-only.
  const lost = parseSaved({
    run: run({
      status: "failed",
      error: { code: "THREAD_LOST", message: "Gone.", retryable: false },
    }),
    messages: [],
  })!;
  assert.equal(withSaved(open, lost).chat.readOnly, "THREAD_LOST");
  // Another run's save does not free a chat busy with this one.
  const other = parseSaved({ run: run({ id: RUN2 }), messages: [] })!;
  assert.equal(withSaved(open, other).chat.activeRunId, RUN);
});

test("older history goes above; known runs keep their newer state", () => {
  const thread: ChatThread = {
    chat: parseChat(chat())!,
    messages: [message(3, "user", RUN2) as never],
    runs: { [RUN2]: run({ id: RUN2, status: "running" }) as never },
    hasMore: true,
  };
  const next = withOlder(thread, {
    messages: [message(1, "user") as never, message(2, "assistant") as never],
    runs: [run() as never, run({ id: RUN2, status: "accepted" }) as never],
    hasMore: false,
  });
  assert.deepEqual(
    next.messages.map((m) => m.seq),
    [1, 2, 3],
  );
  assert.equal(next.runs[RUN2]?.status, "running");
  assert.equal(next.runs[RUN]?.status, "completed");
  assert.equal(next.hasMore, false);
});

test("only a chat ID in ?chat= opens a chat", () => {
  assert.equal(chatParam(`?chat=${CHAT}`), CHAT);
  assert.equal(chatParam(`?x=1&chat=${CHAT}`), CHAT);
  for (const search of [
    "",
    "?chat=",
    "?chat=abc",
    `?chat=${CHAT.toUpperCase()}`,
    "?chat=../x",
  ])
    assert.equal(chatParam(search), null, search);
});

test("Enter sends on keyboards, not on touch or while composing", () => {
  const key = (
    overrides: Partial<Parameters<typeof sendsOnEnter>[0]> = {},
  ) => ({
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  });
  assert.equal(sendsOnEnter(key(), false), true);
  assert.equal(sendsOnEnter(key({ shiftKey: true }), false), false);
  assert.equal(sendsOnEnter(key({ altKey: true }), false), false);
  assert.equal(sendsOnEnter(key({ isComposing: true }), false), false);
  assert.equal(sendsOnEnter(key({ key: "a" }), false), false);
  assert.equal(sendsOnEnter(key(), true), false);
  assert.equal(sendsOnEnter(key({ metaKey: true }), true), true);
  assert.equal(sendsOnEnter(key({ ctrlKey: true }), false), true);
});

test("drafts are checked against the platform's limit", () => {
  assert.equal(canSendDraft("  \n "), false);
  assert.equal(canSendDraft("Hi"), true);
  assert.equal(draftProblem("x".repeat(MAX_MESSAGE_CHARS)), null);
  assert.match(draftProblem("x".repeat(MAX_MESSAGE_CHARS + 1))!, /32,000/);
  assert.equal(canSendDraft("x".repeat(MAX_MESSAGE_CHARS + 1)), false);
});

test("send failures say whether the message may have arrived", () => {
  const lost = sendFailure(new ApiRequestError("x", 0, "NETWORK_ERROR"));
  assert.equal(lost.unknown, true);
  assert.match(lost.message, /won't be sent twice/);
  const busy = sendFailure(new ApiRequestError("x", 409, "CHAT_BUSY"));
  assert.deepEqual([busy.unknown, busy.reload], [false, true]);
  const limited = sendFailure(
    new ApiRequestError("Slow down.", 429, "RATE_LIMITED"),
  );
  assert.deepEqual(limited, {
    message: "Slow down.",
    unknown: false,
    reload: false,
  });
  assert.equal(
    sendFailure(new ApiRequestError("Archived.", 409, "CHAT_READ_ONLY")).reload,
    true,
  );
});

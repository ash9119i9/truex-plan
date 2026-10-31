import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ApiRequestError } from "../lib/api.ts";
import {
  applyStreamEvent,
  canSendDraft,
  chatParam,
  draftProblem,
  dropSteer,
  MAX_MESSAGE_CHARS,
  messageStateNote,
  replyItems,
  sendFailure,
  sendsOnEnter,
  steerText,
  withLiveSteer,
  isCutShort,
  progressFlags,
  withOlder,
  withSaved,
  withSteer,
  exchangesOf,
  exchangeKey,
  fetchChat,
  fetchChats,
  helperApprovalNote,
  helperLabel,
  helpersSummary,
  liveReply,
  messageIds,
  outcomeNote,
  parseChat,
  parseRun,
  parseSaved,
  parseSteer,
  parseMessage,
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
  type ChatMessage,
  type ChatRun,
  type ChatSummary,
  type ChatThread,
  replyEnded,
  sentSteerId,
  withApproval,
  withApprovalRace,
  hasPendingApproval,
  pendingApprovalForItem,
  approvalForItem,
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

test("a chat carries its goal badge and whether goals are on in it", () => {
  const withGoal = parseChat(
    chat({
      goal: { status: "complete", review: "pending" },
      goals: { maxTokenBudget: 3_000_000 },
    }),
  );
  assert.deepEqual(withGoal?.goal, { status: "complete", review: "pending" });
  assert.deepEqual(withGoal?.goals, { maxTokenBudget: 3_000_000 });
  // An older platform, or goals off: neither field.
  const plain = parseChat(chat());
  assert.equal(plain?.goal, null);
  assert.equal(plain?.goals, null);
  // Unknown values are not trusted; the chat still shows.
  const odd = parseChat(
    chat({
      goal: { status: "done", review: "pending" },
      goals: { maxTokenBudget: -1 },
    }),
  );
  assert.equal(odd?.goal, null);
  assert.equal(odd?.goals, null);
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

test("a Follow Up click sends its origin with the message", async (t) => {
  const sent = mockFetch(t, () =>
    Response.json(
      {
        chat: chat({ activeRunId: RUN }),
        message: message(3, "user"),
        run: run({ status: "accepted" }),
        created: true,
      },
      { status: 202 },
    ),
  );
  const open = parseChat(chat())!;
  await sendMessage(open, "Check the access sequence", "client-id-fu", [], {
    fromRunId: RUN,
    slot: 2,
  });
  assert.deepEqual(sent[0].body, {
    clientMessageId: "client-id-fu",
    text: "Check the access sequence",
    followUp: { fromRunId: RUN, slot: 2 },
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
  assert.equal(receipt.kind, "send");
  assert.deepEqual(receipt.receipt.chat.agent, open.agent);
  assert.equal(receipt.receipt.chat.activeRunId, RUN);
  const gone = await sendMessage(open, "More", "client-id-4");
  assert.equal(gone.kind === "send" && gone.receipt.chat.agent, null);
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
  assert.equal(replyItems(reply)[0]?.text, "Hello");
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
  assert.equal(replyItems(reply)[0]?.text, "Hel");
  reply = applyStreamEvent(reply, {
    type: "item",
    data: { itemId: "a", text: "Hello there" },
  });
  assert.equal(replyItems(reply)[0]?.text, "Hello there");
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
  assert.equal(replyItems(reply)[0]?.text, "Hello there");
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
  assert.equal(
    exchanges[0].messages.find((m) => m.role === "assistant")?.text,
    "assistant 2",
  );
  assert.equal(
    exchanges[1].messages.find((m) => m.role === "user")?.text,
    "user 3",
  );
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
    connectors: [],
    skills: [],
    helpers: false,
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
  assert.deepEqual(
    [busy.unknown, busy.reload, busy.untilReplyEnds],
    [false, true, true],
  );
  const limited = sendFailure(
    new ApiRequestError("Slow down.", 429, "RATE_LIMITED"),
  );
  assert.deepEqual(limited, {
    message: "Slow down.",
    unknown: false,
    reload: false,
    untilReplyEnds: false,
  });
  // A message that may have arrived keeps its warning until it is resent.
  assert.equal(lost.untilReplyEnds, false);
  assert.equal(
    sendFailure(new ApiRequestError("Archived.", 409, "CHAT_READ_ONLY")).reload,
    true,
  );
});

// ---- Steer while busy ----

const CMID = "5b0e5f0e-8a4c-4f3e-9d0e-1f2a3b4c5d6e";

test("a steer receipt is told apart from a send by its shape", async (t) => {
  const steer = {
    chat: chat({ activeRunId: RUN }),
    run: run({
      status: "running",
      steers: [
        {
          clientMessageId: CMID,
          text: "Also cover costs",
          createdAt: "2026-10-19T10:00:01.000Z",
        },
      ],
    }),
    steer: {
      clientMessageId: CMID,
      text: "Also cover costs",
      createdAt: "2026-10-19T10:00:01.000Z",
    },
    created: true,
  };
  mockFetch(t, () => Response.json(steer, { status: 202 }));
  const open = parseChat(chat({ activeRunId: RUN }))!;
  const receipt = await sendMessage(open, "Also cover costs", CMID);
  assert.equal(receipt.kind, "steer");
  if (receipt.kind !== "steer") throw new Error("unreachable");
  assert.equal(receipt.receipt.steer.text, "Also cover costs");
  assert.equal(receipt.receipt.run.steers?.[0].clientMessageId, CMID);
});

test("a steer receipt missing its run or steer is unreadable", async (t) => {
  mockFetch(t, () =>
    Response.json({ chat: chat(), steer: { clientMessageId: CMID } }),
  );
  await assert.rejects(
    sendMessage(parseChat(chat())!, "x", CMID),
    /unreadable/,
  );
});

test("parseRun reads the steers it is carrying; absent once settled", () => {
  const withSteers = parseRun(
    run({
      steers: [
        {
          clientMessageId: CMID,
          text: "Steer",
          createdAt: "2026-10-19T10:00:01.000Z",
        },
        { clientMessageId: "bad" },
      ],
    }),
  )!;
  assert.equal(withSteers.steers?.length, 1);
  assert.equal(withSteers.steers?.[0].text, "Steer");
  // No steers array (a settled run / an older platform) leaves the field off.
  assert.equal("steers" in parseRun(run())!, false);
});

test("parseRun keeps only well-formed Follow Up items", () => {
  const items = [
    { slot: 1, intent: "act", text: "Draft the report" },
    { slot: 2, intent: "ask", text: "Which table is it?" },
    { slot: 0, intent: "act", text: "Bad slot" },
    { slot: 3, intent: "shout", text: "Bad intent" },
    { slot: 3, intent: "verify", text: "" },
    "not an item",
  ];
  const parsed = parseRun(run({ followUps: { items } }))!;
  assert.deepEqual(parsed.followUps, {
    items: [
      { slot: 1, intent: "act", text: "Draft the report" },
      { slot: 2, intent: "ask", text: "Which table is it?" },
    ],
  });
  assert.equal("followUps" in parseRun(run())!, false);
  assert.equal(
    "followUps" in parseRun(run({ followUps: { items: [] } }))!,
    false,
  );
});

test("a steer joins the run on the open chat; a foreign one is ignored", () => {
  const open: ChatThread = {
    chat: parseChat(chat({ activeRunId: RUN }))!,
    messages: [message(1, "user") as never],
    runs: { [RUN]: parseRun(run({ status: "running" })) as never },
    hasMore: false,
  };
  const receipt = {
    chat: parseChat(chat({ activeRunId: RUN }))!,
    run: parseRun(
      run({
        status: "running",
        steers: [
          {
            clientMessageId: CMID,
            text: "Steer",
            createdAt: "2026-10-19T10:00:01.000Z",
          },
        ],
      }),
    )!,
    steer: {
      clientMessageId: CMID,
      text: "Steer",
      createdAt: "2026-10-19T10:00:01.000Z",
    },
  };
  const next = withSteer(open, receipt)!;
  assert.equal(next.runs[RUN]?.steers?.[0].clientMessageId, CMID);
  // No new message is saved yet: the bubble is shown live until settle.
  assert.deepEqual(
    next.messages.map((m) => m.seq),
    [1],
  );
  // A steer for a different chat leaves the thread unchanged.
  assert.equal(
    withSteer(open, { ...receipt, chat: { ...receipt.chat, id: RUN2 } }),
    open,
  );
  assert.equal(withSteer(null, receipt), null);
});

test("the stream places a steer in order; the input event fixes it", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "delta",
    data: { itemId: "a", text: "First" },
  });
  // Optimistic: the bubble shows at the bottom before the input event.
  reply = withLiveSteer(reply, { clientMessageId: CMID, text: "Steer me" });
  assert.deepEqual(
    reply.items.map((i) => i.type),
    ["reply", "input"],
  );
  const optimistic = reply.items[1];
  assert.equal(optimistic.type === "input" && optimistic.text, "Steer me");
  // Not cut short yet: Codex has not read the steer, and it may be refused.
  assert.equal(isCutShort(reply, 0), false);
  // Adding the same steer twice changes nothing.
  assert.equal(
    withLiveSteer(reply, { clientMessageId: CMID, text: "Steer me" }),
    reply,
  );
  // The input event fixes the steer at this point and keeps its text.
  reply = applyStreamEvent(reply, {
    type: "input",
    data: { clientMessageId: CMID },
  });
  const fixed = reply.items[1];
  assert.equal(fixed.type === "input" && fixed.clientMessageId, CMID);
  assert.equal(fixed.type === "input" && fixed.text, "Steer me");
  assert.equal(reply.items.length, 2);
  // Codex read it, so the unfinished reply above was cut short.
  assert.equal(isCutShort(reply, 0), true);
  // The next reply streams below the steer.
  reply = applyStreamEvent(reply, {
    type: "delta",
    data: { itemId: "b", text: "Second" },
  });
  assert.deepEqual(
    reply.items.map((i) => i.type),
    ["reply", "input", "reply"],
  );
  assert.equal(replyItems(reply).at(-1)?.text, "Second");
});

test("a follow-up just sent is the one the transcript scrolls to", () => {
  let reply = liveReply(RUN, 0);
  assert.equal(sentSteerId(null), null);
  assert.equal(sentSteerId(reply), null);
  reply = applyStreamEvent(reply, {
    type: "delta",
    data: { itemId: "a", text: "First" },
  });
  reply = withLiveSteer(reply, { clientMessageId: CMID, text: "Steer me" });
  assert.equal(sentSteerId(reply), CMID);
  // A second one sent before Codex reads the first is the newest.
  const second = "6c1f6f1f-9b5d-4f4f-8e1f-2a3b4c5d6e7f";
  const both = withLiveSteer(reply, { clientMessageId: second, text: "And" });
  assert.equal(sentSteerId(both), second);
  // Once Codex reads it, nothing is waiting to be scrolled to.
  reply = applyStreamEvent(reply, {
    type: "input",
    data: { clientMessageId: CMID },
  });
  assert.equal(sentSteerId(reply), null);
});

test("an input event with no optimistic bubble still places the steer", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "input",
    data: { clientMessageId: CMID },
  });
  const item = reply.items[0];
  assert.equal(item.type === "input" && item.clientMessageId, CMID);
  // Its text is read from the run's steers when rendered.
  assert.equal(item.type === "input" && item.text, null);
  // A malformed input event changes nothing.
  assert.equal(applyStreamEvent(reply, { type: "input", data: {} }), reply);
});

test("a snapshot rebuilds ordered reply and input items", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [
        { type: "reply", itemId: "a", text: "Cut text", completed: false },
        { type: "input", clientMessageId: CMID },
        { type: "reply", itemId: "b", text: "New answer", completed: true },
        { type: "input", clientMessageId: "x" },
      ],
      usage: null,
    },
  });
  assert.deepEqual(
    reply.items.map((i) => i.type),
    ["reply", "input", "reply", "input"],
  );
  const [cut, steer, answer] = reply.items;
  assert.equal(cut.type === "reply" && cut.completed, false);
  assert.equal(steer.type === "input" && steer.clientMessageId, CMID);
  assert.equal(answer.type === "reply" && answer.completed, true);
});

test("completed items keep their reply/input order and completion", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "completed",
    data: {
      status: "completed",
      error: null,
      items: [
        { type: "reply", itemId: "a", text: "A", completed: true },
        { type: "input", clientMessageId: CMID },
        { type: "reply", itemId: "b", text: "B", completed: true },
      ],
      usage: null,
    },
  });
  assert.equal(reply.phase, "settled");
  assert.deepEqual(
    replyItems(reply).map((r) => r.text),
    ["A", "B"],
  );
});

test("steerText reads a steer's text off its run", () => {
  const r = parseRun(
    run({
      steers: [
        {
          clientMessageId: CMID,
          text: "From the run",
          createdAt: "2026-10-19T10:00:01.000Z",
        },
      ],
    }),
  )!;
  assert.equal(steerText(r, CMID), "From the run");
  assert.equal(steerText(r, "missing"), null);
  assert.equal(steerText(null, CMID), null);
});

test("dropSteer removes only an optimistic steer, by id", () => {
  let reply = liveReply(RUN, 0);
  reply = withLiveSteer(reply, { clientMessageId: CMID, text: "Steer" });
  assert.equal(reply.items.length, 1);
  const dropped = dropSteer(reply, CMID);
  assert.equal(dropped.items.length, 0);
  // Dropping an id that is not there returns the same reply.
  assert.equal(dropSteer(reply, "other"), reply);
});

test("message state notes label interrupted replies and not-sent steers", () => {
  const interrupted = message(2, "assistant", RUN, { state: "interrupted" });
  assert.equal(
    messageStateNote(interrupted as unknown as ChatMessage),
    "Cut short by your next message",
  );
  const notSent = message(3, "user", RUN, { state: "not_sent" });
  assert.equal(messageStateNote(notSent as unknown as ChatMessage), "Not sent");
  // A plain complete message has no note; states are role-specific.
  assert.equal(
    messageStateNote(message(1, "user") as unknown as ChatMessage),
    null,
  );
  assert.equal(
    messageStateNote(
      message(2, "assistant", RUN, {
        state: "not_sent",
      }) as unknown as ChatMessage,
    ),
    null,
  );
});

test("a run renders all its saved messages in seq order", () => {
  const thread: ChatThread = {
    chat: parseChat(chat())!,
    messages: [
      message(1, "user", RUN, { text: "First question" }) as never,
      message(2, "assistant", RUN, {
        state: "interrupted",
        text: "Cut",
      }) as never,
      message(3, "user", RUN, { text: "Steer", state: "complete" }) as never,
      message(4, "assistant", RUN, { text: "Answer" }) as never,
      message(5, "user", RUN, {
        text: "Never read",
        state: "not_sent",
      }) as never,
    ],
    runs: { [RUN]: parseRun(run()) as never },
    hasMore: false,
  };
  const exchanges = exchangesOf(thread);
  assert.equal(exchanges.length, 1);
  assert.deepEqual(
    exchanges[0].messages.map((m) => [m.seq, m.role, m.state]),
    [
      [1, "user", "complete"],
      [2, "assistant", "interrupted"],
      [3, "user", "complete"],
      [4, "assistant", "complete"],
      [5, "user", "not_sent"],
    ],
  );
});

test("STEER_LIMIT keeps the draft and does not reload", () => {
  const limit = sendFailure(
    new ApiRequestError(
      "Too many follow-ups on this reply.",
      409,
      "STEER_LIMIT",
    ),
  );
  assert.deepEqual(limit, {
    message: "Too many follow-ups on this reply.",
    unknown: false,
    reload: false,
    untilReplyEnds: true,
  });
  // A code-less STEER_LIMIT still gets a sensible default message.
  const bare = sendFailure(new ApiRequestError("", 409, "STEER_LIMIT"));
  assert.match(bare.message, /too many follow-ups/i);
  assert.equal(bare.reload, false);
});

test("a refusal about the running reply ends with that reply", () => {
  const busy = { chatId: CHAT, runId: RUN };
  // The reply was saved, or the next one replaced it.
  assert.equal(replyEnded(busy, { chatId: CHAT, runId: null }), true);
  assert.equal(replyEnded(busy, { chatId: CHAT, runId: "run-2" }), true);
  // Still the same reply.
  assert.equal(replyEnded(busy, { chatId: CHAT, runId: RUN }), false);
  // A stale idle copy that a reload shows as busy is not an ending.
  assert.equal(
    replyEnded({ chatId: CHAT, runId: null }, { chatId: CHAT, runId: RUN }),
    false,
  );
  // Opening another chat, or none, ends nothing in this one.
  assert.equal(replyEnded(busy, { chatId: "other", runId: null }), false);
  assert.equal(replyEnded(busy, null), false);
  assert.equal(replyEnded(null, { chatId: CHAT, runId: null }), false);
});

test("a resend reuses no earlier intent, minting a new id", () => {
  let n = 0;
  const ids = messageIds(() => `id-${++n}`);
  // The original send of this text.
  assert.equal(ids.for(CHAT, "Try again"), "id-1");
  // A resend: a fresh intent (a distinct target key), so a new id.
  ids.reset();
  assert.equal(ids.for(`resend:${CHAT}:1`, "Try again"), "id-2");
  assert.notEqual("id-1", "id-2");
});

// ---- Connector tool calls & connector banners ----

test("a tool event places a card inProgress then settles it by itemId", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "tool",
    data: {
      itemId: "t1",
      connector: "github",
      tool: "list_issues",
      status: "inProgress",
    },
  });
  assert.equal(reply.phase, "streaming");
  const started = reply.items[0];
  assert.equal(started.type, "tool");
  assert.equal(started.type === "tool" && started.status, "inProgress");
  // The same itemId completing settles the one card, not a second one.
  reply = applyStreamEvent(reply, {
    type: "tool",
    data: {
      itemId: "t1",
      connector: "github",
      tool: "list_issues",
      status: "completed",
      durationMs: 1200,
    },
  });
  assert.equal(reply.items.length, 1);
  const done = reply.items[0];
  assert.equal(done.type === "tool" && done.status, "completed");
  assert.equal(done.type === "tool" && done.durationMs, 1200);
});

test("a repeat tool start after it settled is ignored", () => {
  let reply = liveReply(RUN, 0);
  for (const status of ["inProgress", "failed"] as const)
    reply = applyStreamEvent(reply, {
      type: "tool",
      data: { itemId: "t1", connector: "github", tool: "get_issue", status },
    });
  const before = reply;
  // A late duplicate start must not flip the finished card back to running.
  reply = applyStreamEvent(reply, {
    type: "tool",
    data: {
      itemId: "t1",
      connector: "github",
      tool: "get_issue",
      status: "inProgress",
    },
  });
  assert.equal(reply, before);
  assert.equal(
    reply.items[0].type === "tool" && reply.items[0].status,
    "failed",
  );
});

test("a snapshot keeps tool items interleaved in order", () => {
  let reply = liveReply(RUN, 0);
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [
        { type: "reply", itemId: "a", text: "Looking…", completed: true },
        {
          type: "tool",
          itemId: "t1",
          connector: "github",
          tool: "search_issues",
          status: "completed",
          durationMs: 400,
        },
        { type: "reply", itemId: "b", text: "Here it is", completed: false },
      ],
      usage: null,
    },
  });
  assert.deepEqual(
    reply.items.map((i) => i.type),
    ["reply", "tool", "reply"],
  );
  const tool = reply.items[1];
  assert.equal(tool.type === "tool" && tool.connector, "github");
  assert.equal(tool.type === "tool" && tool.status, "completed");
  // The reply items alone are still readable in order.
  assert.deepEqual(
    replyItems(reply).map((r) => r.text),
    ["Looking…", "Here it is"],
  );
});

test("a connector failure is kept once per connector for its banner", () => {
  let reply = liveReply(RUN, 0);
  // starting/ready are not failures a member should see.
  reply = applyStreamEvent(reply, {
    type: "connector",
    data: { connector: "github", status: "ready" },
  });
  assert.deepEqual(reply.connectorFailures, {});
  reply = applyStreamEvent(reply, {
    type: "connector",
    data: { connector: "github", status: "failed", reason: "auth" },
  });
  assert.deepEqual(reply.connectorFailures, { github: "auth" });
  // The same failure again changes nothing (shown once per connector/run).
  const before = reply;
  reply = applyStreamEvent(reply, {
    type: "connector",
    data: { connector: "github", status: "failed", reason: "auth" },
  });
  assert.equal(reply, before);
});

test("parseMessage reads a role:tool message and keeps its payload", () => {
  const parsed = parseMessage({
    id: "64b7f0c2a1b2c3d4e5f60e09",
    seq: 4,
    runId: RUN,
    role: "tool",
    text: "",
    state: "complete",
    tool: {
      connector: "github",
      name: "list_issues",
      status: "completed",
      durationMs: 1200,
    },
    createdAt: "2026-10-17T10:00:00.000Z",
  });
  assert.equal(parsed?.role, "tool");
  assert.equal(parsed?.tool?.connector, "github");
  assert.equal(parsed?.tool?.status, "completed");
  // A tool message with no readable tool payload is dropped.
  assert.equal(
    parseMessage({
      id: "64b7f0c2a1b2c3d4e5f60e10",
      seq: 5,
      runId: RUN,
      role: "tool",
      text: "",
      state: "complete",
      createdAt: "2026-10-17T10:00:00.000Z",
    }),
    null,
  );
});

test("a tool message is not counted as assistant text or a reply", () => {
  const thread: ChatThread = {
    chat: parseChat(chat())!,
    messages: [
      message(1, "user", RUN, { text: "List my issues" }) as never,
      parseMessage({
        id: "64b7f0c2a1b2c3d4e5f60e22",
        seq: 2,
        runId: RUN,
        role: "tool",
        text: "",
        state: "complete",
        tool: { connector: "github", name: "list_issues", status: "completed" },
        createdAt: "2026-10-17T10:00:00.000Z",
      }) as never,
      message(3, "assistant", RUN, { text: "Here they are" }) as never,
    ],
    runs: { [RUN]: parseRun(run()) as never },
    hasMore: false,
  };
  const exchange = exchangesOf(thread)[0];
  // The tool message is carried in order, not dropped.
  assert.deepEqual(
    exchange.messages.map((m) => m.role),
    ["user", "tool", "assistant"],
  );
  // The assistant-text helper (what the transcript collects as replies) must
  // exclude tool messages: only the real reply counts.
  const replyText = exchange.messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.text);
  assert.deepEqual(replyText, ["Here they are"]);
  // A tool message carries no state note (states are user/assistant only).
  const tool = exchange.messages.find((m) => m.role === "tool")!;
  assert.equal(messageStateNote(tool), null);
});

test("progressFlags: a reply before a tool call is progress, the last reply is the answer", () => {
  // The GitHub run: narration, tool, narration, tool, answer.
  assert.deepEqual(progressFlags(["reply", "tool", "reply", "tool", "reply"]), [
    true,
    false,
    true,
    false,
    false,
  ]);
  // Tools first, then one answer.
  assert.deepEqual(progressFlags(["tool", "tool", "reply"]), [
    false,
    false,
    false,
  ]);
  // No tools: every reply stays an answer (steer-split replies included).
  assert.deepEqual(progressFlags(["reply", "input", "reply"]), [
    false,
    false,
    false,
  ]);
  // A steer ends the stretch: a tool after it does not reach back over it.
  assert.deepEqual(progressFlags(["reply", "input", "tool", "reply"]), [
    false,
    false,
    false,
    false,
  ]);
  // A run that ends on a tool (stopped or failed) leaves its reply as progress.
  assert.deepEqual(progressFlags(["reply", "tool"]), [true, false]);
  // Two replies in a row: a call with no transcript row (update_plan) sat
  // between them, so only the last is the answer.
  assert.deepEqual(progressFlags(["reply", "reply"]), [true, false]);
  assert.deepEqual(progressFlags(["reply", "tool", "reply", "reply"]), [
    true,
    false,
    true,
    false,
  ]);
  assert.deepEqual(progressFlags([]), []);
});

// ---- Write-tool approvals in the live reply ----

const APPROVAL = (overrides: Record<string, unknown> = {}) => ({
  approvalId: "ap1",
  itemId: "t1",
  connector: "github",
  tool: "create_branch",
  params: [{ name: "repo", value: "octo/widgets" }],
  status: "pending",
  expiresAt: "2026-10-20T10:05:00.000Z",
  ...overrides,
});

test("an approval event opens a pending card at its tool row", () => {
  const reply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL(),
  });
  const pending = pendingApprovalForItem(reply, "t1");
  assert.equal(pending?.approvalId, "ap1");
  assert.equal(pending?.tool, "create_branch");
  assert.equal(hasPendingApproval(reply), true);
  // The reply leaves "waiting" so the composer is not stuck on "Working".
  assert.equal(reply.phase, "streaming");
});

test("a resolved approval event settles the card to its decision", () => {
  const pendingReply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL(),
  });
  const resolved = applyStreamEvent(pendingReply, {
    type: "approval",
    data: APPROVAL({ status: "deny", auto: false }),
  });
  assert.equal(pendingApprovalForItem(resolved, "t1"), null);
  assert.equal(approvalForItem(resolved, "t1")?.status, "deny");
  assert.equal(hasPendingApproval(resolved), false);
});

test("an auto allow-for-chat settles with no pending card", () => {
  const reply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL({ status: "allow_for_chat", auto: true }),
  });
  assert.equal(pendingApprovalForItem(reply, "t1"), null);
  const settled = approvalForItem(reply, "t1");
  assert.equal(settled?.status, "allow_for_chat");
  assert.equal(settled?.auto, true);
  assert.equal(hasPendingApproval(reply), false);
});

test("a snapshot carries pending approvals and replaces a settled one", () => {
  // A reconnect snapshot with one pending approval shows its card again.
  const snapshot = applyStreamEvent(liveReply(RUN), {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [],
      approvals: [APPROVAL()],
    },
  });
  assert.equal(pendingApprovalForItem(snapshot, "t1")?.approvalId, "ap1");
  // A later snapshot without that approval (it settled server-side) clears it.
  const cleared = applyStreamEvent(snapshot, {
    type: "snapshot",
    data: { runId: RUN, phase: "streaming", items: [], approvals: [] },
  });
  assert.equal(pendingApprovalForItem(cleared, "t1"), null);
  assert.equal(hasPendingApproval(cleared), false);
  // A snapshot with no approvals field leaves the map untouched.
  const kept = applyStreamEvent(snapshot, {
    type: "snapshot",
    data: { runId: RUN, phase: "streaming", items: [] },
  });
  assert.equal(pendingApprovalForItem(kept, "t1")?.approvalId, "ap1");
});

test("withApproval settles a pending approval and ignores a settled one", () => {
  const reply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL(),
  });
  const allowed = withApproval(reply, "ap1", "allow");
  assert.equal(allowed.approvals.ap1.status, "allow");
  // A second answer is a no-op (first answer wins locally too).
  assert.equal(
    withApproval(allowed, "ap1", "deny").approvals.ap1.status,
    "allow",
  );
  // An unknown approvalId changes nothing.
  assert.equal(withApproval(reply, "nope", "allow"), reply);
});

test("withApprovalRace marks a lost first-answer race for the card", () => {
  const reply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL(),
  });
  const resolved = withApprovalRace(reply, "ap1", "resolved");
  assert.equal(resolved.approvals.ap1.race, "resolved");
  // Still pending underneath, but the card shows "Already answered".
  assert.equal(resolved.approvals.ap1.status, "pending");
  const notFound = withApprovalRace(reply, "ap1", "not_found");
  assert.equal(notFound.approvals.ap1.race, "not_found");
  assert.equal(withApprovalRace(reply, "nope", "resolved"), reply);
});

test("approvalForItem returns the latest approval for a tool row", () => {
  assert.equal(approvalForItem(null, "t1"), null);
  const reply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL({ status: "allow", auto: false }),
  });
  assert.equal(approvalForItem(reply, "t1")?.status, "allow");
  // A tool row with no approval has none.
  assert.equal(approvalForItem(reply, "other"), null);
});

test("a malformed approval event leaves the reply unchanged", () => {
  const reply = liveReply(RUN);
  assert.equal(
    applyStreamEvent(reply, { type: "approval", data: { itemId: "t1" } }),
    reply,
  );
});

test("a replayed pending event does not reopen a locally settled approval", () => {
  const pendingReply = applyStreamEvent(liveReply(RUN), {
    type: "approval",
    data: APPROVAL(),
  });
  // The member answered (optimistic settle); a reconnect replays the pending
  // event, which must not reopen the card (first answer wins).
  const allowed = withApproval(pendingReply, "ap1", "allow");
  const replayed = applyStreamEvent(allowed, {
    type: "approval",
    data: APPROVAL(),
  });
  assert.equal(replayed.approvals.ap1.status, "allow");
  assert.equal(pendingApprovalForItem(replayed, "t1"), null);
  // A raced card (409) also survives a replayed pending event.
  const raced = withApprovalRace(pendingReply, "ap1", "resolved");
  const replayedRace = applyStreamEvent(raced, {
    type: "approval",
    data: APPROVAL(),
  });
  assert.equal(replayedRace.approvals.ap1.race, "resolved");
  // A real settled event (a decision) still applies over a pending card.
  const settledByStream = applyStreamEvent(pendingReply, {
    type: "approval",
    data: APPROVAL({ status: "deny" }),
  });
  assert.equal(settledByStream.approvals.ap1.status, "deny");
});

test("a used skill shows once, live and from a snapshot or saved message", () => {
  let reply = liveReply(RUN, 0);
  for (let i = 0; i < 2; i++)
    reply = applyStreamEvent(reply, {
      type: "skill",
      data: { slug: "invoice-check", name: "Invoice check" },
    });
  assert.deepEqual(reply.items, [
    { type: "skill", slug: "invoice-check", name: "Invoice check" },
  ]);
  reply = applyStreamEvent(reply, { type: "skill", data: { slug: "x" } });
  assert.equal(reply.items.length, 1);
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [{ type: "skill", slug: "invoice-check", name: "Invoice check" }],
    },
  });
  assert.equal(reply.items[0]?.type, "skill");
  const saved = parseMessage({
    id: "64b7f0c2a1b2c3d4e5f60e01",
    seq: 3,
    runId: "64b7f0c2a1b2c3d4e5f60e02",
    role: "tool",
    text: "",
    state: "complete",
    skill: { slug: "invoice-check", name: "Invoice check" },
    createdAt: "2026-10-23T10:00:00.000Z",
  });
  assert.deepEqual(saved?.skill, {
    slug: "invoice-check",
    name: "Invoice check",
  });
});

test("helper agents stream into their own list, merge by id and survive a reconnect", () => {
  let reply = liveReply(RUN);
  reply = applyStreamEvent(reply, {
    type: "agent",
    data: { agentId: "th1", path: "/root/crm", status: "running" },
  });
  reply = applyStreamEvent(reply, {
    type: "agent",
    data: {
      agentId: "th1",
      path: "/root/crm",
      status: "running",
      preview: "Reading deals",
    },
  });
  // Unreadable events change nothing.
  reply = applyStreamEvent(reply, { type: "agent", data: { agentId: "x" } });
  reply = applyStreamEvent(reply, {
    type: "agent",
    data: { status: "running" },
  });
  assert.deepEqual(reply.helpers, [
    {
      agentId: "th1",
      path: "/root/crm",
      status: "running",
      preview: "Reading deals",
    },
  ]);
  // Helpers never become reply items.
  assert.equal(reply.items.length, 0);

  // A snapshot adds what this tab missed and keeps what it had.
  reply = applyStreamEvent(reply, {
    type: "snapshot",
    data: {
      runId: RUN,
      phase: "streaming",
      items: [],
      agents: [{ agentId: "th2", path: "/root/email", status: "running" }],
    },
  });
  assert.deepEqual(
    reply.helpers.map((h) => h.agentId),
    ["th1", "th2"],
  );

  reply = applyStreamEvent(reply, {
    type: "completed",
    data: {
      status: "completed",
      error: null,
      items: [{ itemId: "a", text: "Globex is at risk.", completed: true }],
      agents: [
        {
          agentId: "th1",
          path: "/root/crm",
          status: "completed",
          result: "Globex stalled 21 days.",
        },
        { agentId: "th2", path: "/root/email", status: "failed" },
      ],
    },
  });
  assert.deepEqual(
    reply.helpers.map((h) => [h.agentId, h.status, h.result ?? null]),
    [
      ["th1", "completed", "Globex stalled 21 days."],
      ["th2", "failed", null],
    ],
  );
});

test("helper text is bounded and at most ten helpers are kept", () => {
  let reply = liveReply(RUN);
  for (let i = 0; i < 12; i++)
    reply = applyStreamEvent(reply, {
      type: "agent",
      data: {
        agentId: `th${i}`,
        path: "p".repeat(500),
        status: "running",
        preview: "v".repeat(500),
      },
    });
  assert.equal(reply.helpers.length, 10);
  assert.equal(reply.helpers[0]!.path.length, 120);
  assert.equal(reply.helpers[0]!.preview!.length, 240);
});

test("a saved helper row parses without its preview; a running or empty one is dropped", () => {
  const base = {
    id: "64b7f0c2a1b2c3d4e5f60e01",
    seq: 3,
    runId: "64b7f0c2a1b2c3d4e5f60e02",
    role: "tool",
    text: "",
    state: "complete",
    createdAt: "2026-10-26T10:00:00.000Z",
  };
  const saved = parseMessage({
    ...base,
    agent: {
      path: "/root/crm",
      status: "completed",
      result: "Globex stalled 21 days.",
      preview: "should not show",
    },
  });
  assert.deepEqual(saved?.agent, {
    path: "/root/crm",
    status: "completed",
    result: "Globex stalled 21 days.",
  });
  assert.equal(
    parseMessage({ ...base, agent: { path: "/x", status: "running" } }),
    null,
  );
  assert.equal(parseMessage({ ...base, agent: { path: "/x" } }), null);
});

test("helper labels and the group summary", () => {
  assert.equal(helperLabel("/root/crm_deals"), "crm deals");
  assert.equal(helperLabel("/root/"), "root");
  assert.equal(helperLabel(""), "Helper");
  assert.equal(
    helpersSummary([
      { path: "/a", status: "completed" },
      { path: "/b", status: "running" },
    ]),
    "Checking with 2 helpers · 1 done",
  );
  assert.equal(
    helpersSummary([{ path: "/a", status: "failed" }]),
    "Checked with 1 helper",
  );
});

test("approval cards say when the request followed helper results", () => {
  assert.equal(helperApprovalNote([]), null);
  assert.match(
    helperApprovalNote([{ path: "/root/crm", status: "completed" }]) ?? "",
    /after helper results/,
  );
});

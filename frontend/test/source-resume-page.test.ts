import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { SessionHistory } from "../lib/session-history.ts";
import { SessionCache } from "../lib/session-cache.ts";
import {
  applyChatEvent,
  mergeHistoryWindow,
  addApprovals,
} from "../lib/chat.ts";
import {
  advanceSourceSync,
  beginSourceSync,
  overlaySourceEntries,
  SynchronizationWaiter,
} from "../lib/source-sync.ts";
import { ApiRequestError } from "../lib/api.ts";
import { coalesceChatEvents } from "../lib/chat-batch.ts";

// Execute the actual page callbacks, including cache ownership and the recovery
// return value. The stream boundary uses the real source reducer; no provider,
// credentials, DOM shim or network service is involved.
const source = readFileSync(
  process.env.TRUEX_SOURCE_RESUME_PAGE ??
    new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "page.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "rememberDisplayed",
  "invalidateConversation",
  "recover",
  "requestSourceHandoff",
  "open",
  "streamEffect",
]);
const handlers: string[] = [];
function collect(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "useEffect" &&
    node.arguments[0]?.getText(ast).includes("transport.subscribe(")
  )
    handlers.push(`const streamEffect = ${node.arguments[0].getText(ast)};`);
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast)))
    handlers.push(
      `const ${node.name.getText(ast)} = ${node.initializer!.getText(ast)};`,
    );
  ts.forEachChild(node, collect);
}
collect(ast);
const code = ts.transpileModule(
  `${handlers.join("\n")} Object.assign(globalThis, {${[...names].join(",")}});`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
function harness(recoveryError: string | null = null) {
  const ref = (current: any) => ({ current });
  const calls = { persisted: 0, full: 0, handoff: 0 };
  const entriesWrites: any[][] = [];
  const c: any = {
    useCallback: (fn: any) => fn,
    ApiRequestError,
    beginSourceSync,
    advanceSourceSync,
    overlaySourceEntries,
    applyChatEvent,
    mergeHistoryWindow,
    addApprovals,
    generation: ref(0),
    sending: ref(false),
    displayed: ref(null),
    sessionRef: ref(null),
    streamFlush: ref(null),
    scroll: ref(null),
    heldTimeline: ref(null),
    restoreScroll: ref(null),
    conversationCache: ref(new SessionCache()),
    sourcePairs: ref(new SessionCache()),
    sourceSync: ref(beginSourceSync(null)),
    sourceOwner: ref(null),
    sourceWaiter: ref(new SynchronizationWaiter()),
    sourceConnection: ref(0),
    sourceRequestedCursor: ref(null),
    sourceProtocol: ref(true),
    sourceCapability: ref(false),
    sourceRecovered: ref(false),
    liveRevision: ref(0),
    recoveryStarts: ref(new WeakMap()),
    preparation: ref({ reset() {} }),
    openingSession: ref(false),
    freshSession: ref(null),
    timelineSettling: ref(false),
    expandedHistory: ref(false),
    olderFlight: ref(false),
    following: ref(true),
    seen: ref(new Set()),
    entriesRef: ref([]),
    planRef: ref([]),
    subAgentsRef: ref({}),
    observabilityRef: ref({ traces: [] }),
    emptySubAgents: {},
    emptyObservability: { traces: [] },
    history: { replaceState() {} },
    getTraces: async () => ({ traces: [] }),
    api: async () => ({ turns: [] }),
    mergeTraces: (old: any) => old,
    warnFailure() {},
    rehydrate: (old: any) => old,
    applyObservabilityEvent: (old: any) => old,
    applySubAgentEvent: (old: any) => old,
    applyPlanEvent: (old: any) => old,
    coalesceChatEvents,
    follow: { reset() {}, onEvent() {} },
    actions: { recheck() {} },
    syncSessionGoal() {},
    transport: {
      subscribe(_id: string, _event: unknown, _status: unknown, handlers: any) {
        c.streamHandlers = handlers;
        return () => {};
      },
    },
    reportError: (e: Error) => {
      c.error = e.message;
    },
  };
  const snapshot = {
    cursor: "fixture:1",
    state: { kind: "idle" },
    pending: [],
    messages: [{ id: "a", turnId: "turn", text: "answer", final: true }],
    thinking: [],
    plan: [],
  };
  const session = { _id: "public-session", agentId: "agent" };
  const data = {
    session,
    messages: [{ _id: "user", role: "user", text: "question", turnId: "turn" }],
    approvals: [],
    snapshot,
    recoveryError,
  };
  c.historyLoader = ref(
    new SessionHistory(async (_id, persisted) => {
      if (persisted) calls.persisted++;
      else calls.full++;
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...data, recoveryError: persisted ? null : recoveryError };
    }),
  );
  const displayed = () => {
    if (c.session)
      c.displayed.current = {
        session: c.session,
        entries: c.entries ?? [],
        events: [],
        plan: [],
        subAgents: {},
        observability: { traces: [] },
        text: "",
        following: true,
        expanded: false,
      };
    else c.displayed.current = null;
  };
  for (const name of new Set(handlers.join("\n").match(/set[A-Z]\w+/g)))
    c[name] = (value: any) => {
      const key = name[3].toLowerCase() + name.slice(4);
      c[key] = typeof value === "function" ? value(c[key]) : value;
      if (key === "entries") entriesWrites.push(c[key]);
      const reference = c[`${key}Ref`];
      if (reference) reference.current = c[key];
      displayed();
    };
  c.setError = (value: string) => {
    c.error = value;
  };
  c.setStreamKey = () =>
    queueMicrotask(() => {
      if (!c.sourceProtocol.current) return;
      const state = c.sourceSync.current;
      const mode = state.phase === "warm" ? "replay" : "snapshot";
      const events: any[] =
        mode === "snapshot"
          ? [
              {
                type: "snapshot",
                threadId: session._id,
                seq: 1,
                cursor: "fixture:1",
                at: "",
                data: snapshot,
              },
            ]
          : [];
      events.push({
        type: "sync.completed",
        threadId: session._id,
        seq: 1,
        cursor: "fixture:1",
        at: "",
        data: {
          protocol: 1,
          mode,
          fromCursor: state.fromCursor,
          highWaterCursor: "fixture:1",
          snapshot: { ...snapshot, messages: [], thinking: [] },
        },
      });
      const result = advanceSourceSync(state, events);
      assert.equal(result.failure, null);
      c.sourceCapability.current = true;
      c.sourceSync.current = result.state;
      c.liveRevision.current += events.length;
      if (state.phase === "handoff") calls.handoff++;
      if (result.operational)
        c.sourceWaiter.current.complete(session._id, c.generation.current);
    });
  vm.runInNewContext(code, c);
  return { c, calls, entriesWrites };
}

test("failed full recovery never qualifies a pair or bypasses the next full read", async () => {
  const { c, calls } = harness("Runtime ingestion failed");
  await c.open("public-session");
  assert.equal(c.error, "Runtime ingestion failed");
  assert.equal(c.sourceRecovered.current, false);
  assert.equal(c.sourceSync.current.pair, null);
  assert.equal(calls.handoff, 0);
  assert.equal(c.openingId, null);
  await c.open("public-session");
  assert.equal(calls.full, 2);
  assert.equal(c.sourcePairs.current.get("public-session"), undefined);
});

test("successful cold recovery needs a fresh handoff; warm reopen still reads authorized durable history", async () => {
  const { c, calls } = harness();
  await c.open("public-session");
  assert.equal(c.sourceRecovered.current, true);
  assert.equal(calls.handoff, 1);
  assert.equal(c.sourceSync.current.phase, "ready");
  await c.open("public-session");
  assert.equal(calls.full, 1);
  assert.equal(calls.persisted, 2);
  assert.equal(c.sourceSync.current.pair.threadId, "public-session");
  assert.equal(c.entries.filter((e: any) => e.role === "user").length, 1);
});

test("authorization revocation clears source and displayed owners before another remember call", async () => {
  for (const [id, status] of [
    ["public-session", 403],
    ["other-session", 401],
  ] as const) {
    const { c } = harness();
    await c.open("public-session");
    c.rememberDisplayed();
    assert.ok(c.sourcePairs.current.get("public-session"));
    c.invalidateConversation(
      id,
      new ApiRequestError("Revoked", status, "FORBIDDEN"),
    );
    c.rememberDisplayed();
    assert.equal(c.sourceOwner.current, null);
    assert.equal(c.sourceSync.current.pair, null);
    assert.equal(c.displayed.current, null);
    assert.equal(c.sourcePairs.current.get("public-session"), undefined);
    assert.equal(c.conversationCache.current.get("public-session"), undefined);
  }
});

test("revoked cached and cold opens cannot commit a pending persisted read", async () => {
  for (const cached of [true, false]) {
    const { c } = harness();
    if (cached) await c.open("public-session");
    let resolve!: (value: any) => void;
    const pending = new Promise((yes) => {
      resolve = yes;
    });
    c.historyLoader.current = new SessionHistory(() => pending);
    const opening = c.open("public-session");
    await Promise.resolve();
    const previousGeneration = c.generation.current;
    c.invalidateConversation(
      "public-session",
      new ApiRequestError("Revoked", 403, "FORBIDDEN"),
    );
    resolve({
      session: { _id: "public-session", agentId: "agent" },
      messages: [
        { _id: "user", role: "user", text: "previously authorized data" },
      ],
      approvals: [],
    });
    await opening;
    assert.ok(c.generation.current > previousGeneration);
    assert.equal(c.sessionRef.current, null);
    assert.equal(c.session, null);
    assert.equal(c.entries.length, 0);
    assert.equal(c.sourceSync.current.pair, null);
    assert.equal(c.openingId, null);
  }
});

test("an independent source pair does not paint orphan AI rows before durable history", async () => {
  const { c, entriesWrites } = harness();
  await c.open("public-session");
  c.rememberDisplayed();
  c.conversationCache.current.clear();
  c.displayed.current = null;
  entriesWrites.length = 0;
  await c.open("public-session");
  assert.equal(entriesWrites[0].length, 0);
  assert.equal(c.entries[0].role, "user");
  assert.equal(c.entries.at(-1).role, "assistant");
});

test("a fresh session takes its first source snapshot without a full history recovery", async () => {
  const { c, calls } = harness();
  c.session = { _id: "public-session", agentId: "agent" };
  c.sessionRef.current = c.session;
  c.entries = [];
  c.timings = [];
  c.freshSession.current = c.session._id;
  const stop = c.streamEffect();
  const snapshot = {
    type: "snapshot",
    threadId: c.session._id,
    seq: 1,
    cursor: "fixture:1",
    at: "",
    data: {
      cursor: "fixture:1",
      state: { kind: "idle" },
      pending: [],
      messages: [
        { id: "a", turnId: "turn", text: "early answer", final: true },
      ],
      thinking: [],
      plan: [],
    },
  };
  c.streamHandlers.onBatch([snapshot]);
  c.streamHandlers.onBatch([
    {
      type: "sync.completed",
      threadId: c.session._id,
      seq: 1,
      cursor: "fixture:1",
      at: "",
      data: {
        protocol: 1,
        mode: "snapshot",
        fromCursor: null,
        highWaterCursor: "fixture:1",
        snapshot: { ...snapshot.data, messages: [] },
      },
    },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.full, 0);
  assert.equal(calls.handoff, 1);
  assert.equal(c.sourceSync.current.phase, "ready");
  assert.equal(
    c.entries.filter((entry: any) => entry.role === "assistant").length,
    1,
  );
  stop();
});

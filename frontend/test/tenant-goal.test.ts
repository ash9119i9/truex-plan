import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Auth, Authorized } from "../lib/auth.ts";
import type { ChatThread } from "../lib/tenant-chat.ts";
import {
  applyGoalEvent,
  followChatEvents,
  formatGoalElapsed,
  formatTokensCompact,
  goalStatusText,
  NO_GOAL,
  parseGoal,
  pauseGoal,
  startGoal,
  watchChatGoal,
  withGoalRun,
  type GoalState,
  type TenantGoal,
} from "../lib/tenant-goal.ts";

const CHAT = "64b7f0c2a1b2c3d4e5f60c01";
const RUN = "64b7f0c2a1b2c3d4e5f60d01";
const OTHER_RUN = "64b7f0c2a1b2c3d4e5f60d02";

beforeEach(() => signInForTest());

const goal = (over: Partial<TenantGoal> = {}): TenantGoal => ({
  objective: "Quarterly report",
  status: "active",
  tokenBudget: 200_000,
  tokensUsed: 40_000,
  timeUsedSeconds: 90,
  origin: "user",
  review: "none",
  rev: 3,
  ...over,
});

const frame = (type: string, data: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function thread(activeRunId: string | null): ChatThread {
  return {
    chat: {
      id: CHAT,
      title: "Report",
      agent: null,
      model: null,
      readOnly: null,
      activeRunId,
      status: "active",
      lastMessageAt: "2026-10-31T00:00:00.000Z",
      createdAt: "2026-10-31T00:00:00.000Z",
      connectors: [],
      goal: null,
      goals: null,
    },
    messages: [],
    runs: {},
    hasMore: false,
  };
}

test("a run.started on the chat's event stream attaches the open chat to that run", async () => {
  const urls: string[] = [];
  const answers = [
    sse([
      frame("snapshot", { goal: goal(), activeRunId: null }),
      ": hb\n\n",
      frame("run.started", { runId: RUN, turnId: "turn-1" }),
      frame("end", { reason: "unavailable" }),
    ]),
  ];
  const auth = {
    async request(url: string) {
      urls.push(url);
      return { kind: "response", response: answers.shift()! } as Authorized;
    },
  } as unknown as Auth;
  const events: Array<{ type: string; data: unknown }> = [];
  await new Promise<void>((done) =>
    followChatEvents(
      CHAT,
      { onEvent: (event) => events.push(event), onEnd: () => done() },
      { auth, sleep: async () => {} },
    ),
  );
  assert.equal(urls[0], `/api/v1/chats/${CHAT}/events?tenantId=${TENANT_ID}`);
  assert.deepEqual(
    events.map((e) => e.type),
    ["snapshot", "run.started"],
  );
  const started = events[1]!.data as { runId: string };
  // An idle chat follows the goal run at once.
  assert.equal(withGoalRun(thread(null), started.runId)?.chat.activeRunId, RUN);
  // Already following it: nothing changes.
  const following = thread(RUN);
  assert.equal(withGoalRun(following, RUN), following);
  // Another run is still on screen: wait for it to be saved, then attach.
  assert.equal(withGoalRun(thread(OTHER_RUN), RUN), null);
});

test("watching a chat hands goal events to the screen and names each goal run to follow", async () => {
  const answers = [
    sse([
      frame("snapshot", { goal: goal(), activeRunId: OTHER_RUN }),
      frame("goal.updated", { goal: goal({ rev: 4 }) }),
      frame("run.started", { runId: RUN, turnId: "turn-1" }),
      frame("run.started", { runId: "not-an-id", turnId: "turn-2" }),
      frame("end", { reason: "unavailable" }),
    ]),
  ];
  const auth = {
    async request() {
      return { kind: "response", response: answers.shift()! } as Authorized;
    },
  } as unknown as Auth;
  const goalEvents: string[] = [];
  const runs: string[] = [];
  await new Promise<void>((done) =>
    watchChatGoal(
      CHAT,
      {
        onGoalEvent: (event) => goalEvents.push(event.type),
        onRun: (runId) => runs.push(runId),
        onEnd: () => done(),
      },
      { auth, sleep: async () => {} },
    ),
  );
  assert.deepEqual(goalEvents, ["snapshot", "goal.updated", "run.started"]);
  // The run a (re)connect's snapshot names, then each started goal run.
  assert.deepEqual(runs, [OTHER_RUN, RUN]);
});

test("out-of-order or repeated goal events never move the goal backwards", () => {
  const apply = (state: GoalState, type: string, data: unknown) =>
    applyGoalEvent(state, { type, data });
  let state = apply(NO_GOAL, "snapshot", { goal: goal({ rev: 3 }) });
  const newer = goal({ rev: 5, status: "paused", tokensUsed: 52_000 });
  state = apply(state, "goal.updated", { goal: newer });
  assert.deepEqual(state.goal, newer);
  // An older update, then the same one again, arriving late.
  for (const late of [goal({ rev: 4, tokensUsed: 48_000 }), newer])
    assert.equal(apply(state, "goal.updated", { goal: late }), state);
  // A reconnect's snapshot older than a route answer already applied.
  assert.equal(apply(state, "snapshot", { goal: goal({ rev: 4 }) }), state);
  // Malformed events change nothing.
  assert.equal(apply(state, "goal.updated", { goal: { rev: 9 } }), state);
  assert.equal(apply(state, "delta", { text: "x" }), state);
  // Once goal mode ends in the chat, no later update brings the goal back.
  const ended = apply(state, "goal.cleared", {});
  assert.deepEqual(ended, { goal: null, ended: true });
  assert.equal(apply(ended, "goal.updated", { goal: goal({ rev: 9 }) }), ended);
  assert.deepEqual(apply(state, "goal.updated", { goal: null }), ended);
  // A reconnect's empty snapshot means the goal it had is gone.
  assert.deepEqual(apply(state, "snapshot", { goal: null }), ended);
  assert.deepEqual(apply(NO_GOAL, "snapshot", { goal: null }), NO_GOAL);
});

test("status text copies the Codex footer for every status, plus review", () => {
  const text = (over: Partial<TenantGoal>) => goalStatusText(goal(over));
  assert.equal(text({}), "Pursuing goal (40K / 200K)");
  assert.equal(text({ tokenBudget: null }), "Pursuing goal (1m)");
  assert.equal(text({ status: "paused" }), "Goal paused");
  assert.equal(text({ status: "blocked" }), "Goal stalled");
  assert.equal(text({ status: "usageLimited" }), "Goal hit usage limits");
  assert.equal(
    text({ status: "budgetLimited", tokensUsed: 201_250 }),
    "Goal unmet (201K / 200K tokens)",
  );
  assert.equal(
    text({ status: "budgetLimited", tokenBudget: null }),
    "Goal abandoned",
  );
  assert.equal(
    text({ status: "budgetLimited", review: "accepted_as_is" }),
    "Goal achieved (stopped at budget)",
  );
  assert.equal(
    text({ status: "complete", review: "pending" }),
    "Waiting for your review",
  );
  assert.equal(
    text({ status: "complete", review: "approved" }),
    "Goal achieved (40K tokens)",
  );
  assert.equal(
    text({ status: "complete", tokenBudget: null, timeUsedSeconds: 5_400 }),
    "Goal achieved (1h 30m)",
  );
});

test("token and time formats match Codex's, including its rounding", () => {
  const tokens: Array<[number, string]> = [
    [0, "0"],
    [-5, "0"],
    [999, "999"],
    [1_000, "1K"],
    // Codex rounds an exact half to even.
    [1_125, "1.12K"],
    [1_135, "1.14K"],
    [1_005, "1K"],
    [12_250, "12.2K"],
    [12_350, "12.3K"],
    [1_375, "1.38K"],
    [2_625, "2.62K"],
    [12_750, "12.8K"],
    [100_500, "100K"],
    [101_500, "102K"],
    [40_000, "40K"],
    [999_999, "1000K"],
    [1_500_000, "1.5M"],
    [3_000_000_000, "3B"],
  ];
  for (const [value, shown] of tokens)
    assert.equal(formatTokensCompact(value), shown, String(value));
  const times: Array<[number, string]> = [
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [30 * 60, "30m"],
    [90 * 60, "1h 30m"],
    [2 * 60 * 60, "2h"],
    [24 * 60 * 60 - 60, "23h 59m"],
    [24 * 60 * 60, "1d 0h 0m"],
    [(2 * 24 + 23) * 60 * 60 + 42 * 60, "2d 23h 42m"],
  ];
  for (const [seconds, shown] of times)
    assert.equal(formatGoalElapsed(seconds), shown, String(seconds));
});

test("goal routes are addressed to the chat and answers are parsed", async (t) => {
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ goal: goal() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const started = await startGoal(CHAT, {
    clientRequestId: "goal-start-1",
    objective: "Quarterly report",
    tokenBudget: 200_000,
  });
  assert.deepEqual(started, goal());
  await pauseGoal(CHAT);
  assert.deepEqual(
    sent.map(({ url, method, body }) => [method, url, body]),
    [
      [
        "POST",
        `/api/v1/chats/${CHAT}/goal?tenantId=${TENANT_ID}`,
        {
          clientRequestId: "goal-start-1",
          objective: "Quarterly report",
          tokenBudget: 200_000,
        },
      ],
      [
        "POST",
        `/api/v1/chats/${CHAT}/goal/pause?tenantId=${TENANT_ID}`,
        undefined,
      ],
    ],
  );
  assert.equal(parseGoal({ ...goal(), status: "done" }), null);
  assert.equal(parseGoal({ ...goal(), rev: -1 }), null);
});

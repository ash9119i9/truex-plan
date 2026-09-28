import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_LIMIT,
  TITLE_LIMIT,
  agentName,
  applySubAgentEvent,
  elapsedMs,
  elapsedSeconds,
  emptySubAgents,
  durationParts,
  formatDuration,
  groupElapsedMs,
  helperName,
  learnSkew,
  normalizeDelegation,
  previewTail,
  rehydrate,
  taskTitle,
  upsertAgent,
} from "../lib/subagents.ts";
import { applyChatEvent } from "../lib/chat.ts";
import type { DomainEvent, SubAgent } from "../../shared/contracts.ts";

const agent = (extra: Partial<SubAgent> = {}): SubAgent => ({
  threadId: "child",
  path: "/root/researcher",
  nickname: "Researcher",
  role: "explorer",
  depth: 1,
  status: "running",
  startedAt: "2026-09-28T10:00:00.000Z",
  ...extra,
});
const event = (
  type: DomainEvent["type"],
  data: Record<string, unknown>,
  extra: Partial<DomainEvent> = {},
) => ({ type, data, turnId: "turn", ...extra }) as DomainEvent;

test("spawn and status events upsert one helper by thread ID", () => {
  let state = applySubAgentEvent(
    emptySubAgents,
    event("subagent.spawned", { agent: agent({ task: "Find sources" }) }),
  );
  state = applySubAgentEvent(
    state,
    event("subagent.status", {
      agent: agent({ task: undefined, lastMessage: "Halfway" }),
    }),
  );
  assert.equal(state.agents.length, 1);
  assert.equal(state.agents[0].task, "Find sources");
  assert.equal(state.agents[0].lastMessage, "Halfway");
  assert.equal(state.agents[0].endedAt, undefined);
});

test("completion sets endedAt and a late running update cannot revive it", () => {
  let list = upsertAgent([], agent());
  list = upsertAgent(
    list,
    agent({ status: "completed", endedAt: "2026-09-28T10:01:30.000Z" }),
  );
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].endedAt, "2026-09-28T10:01:30.000Z");
  list = upsertAgent(list, agent({ status: "running" }));
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].endedAt, "2026-09-28T10:01:30.000Z");
  assert.equal(elapsedSeconds(list[0]), 90);
});

test("a terminal helper seen first still gets an end time", () => {
  const list = upsertAgent([], agent({ status: "errored" }));
  assert.equal(list[0].endedAt, list[0].startedAt);
  const stopped = upsertAgent(
    upsertAgent([], agent()),
    agent({ status: "interrupted" }),
  );
  assert.ok(stopped[0].endedAt);
});

test("snapshot rebuilds membership and tolerates servers without subAgents", () => {
  const live = applySubAgentEvent(
    applySubAgentEvent(
      emptySubAgents,
      event("subagent.spawned", { agent: agent() }),
    ),
    event("subagent.event", {
      agentThreadId: "child",
      kind: "message.delta",
      delta: "partial",
    }),
  );
  // Old server: snapshot has no subAgents, keep streamed state.
  assert.equal(applySubAgentEvent(live, event("snapshot", {})), live);
  const rebuilt = applySubAgentEvent(
    live,
    event("snapshot", {
      subAgents: [
        agent({ status: "completed" }),
        agent({ threadId: "other", nickname: null }),
      ],
    }),
  );
  assert.deepEqual(
    rebuilt.agents.map((a) => [a.threadId, a.status]),
    [
      ["child", "completed"],
      ["other", "running"],
    ],
  );
  assert.equal(rebuilt.previews.child, "partial");
  // Membership is authoritative: a helper missing from the snapshot is dropped.
  const trimmed = rehydrate(rebuilt, [agent({ threadId: "other" })]);
  assert.deepEqual(
    trimmed.agents.map((a) => a.threadId),
    ["other"],
  );
  assert.equal(trimmed.previews.child, undefined);
  assert.deepEqual(rehydrate(emptySubAgents, []), emptySubAgents);
});

test("live preview is bounded and replaced by the final message", () => {
  let state = emptySubAgents;
  const chunk = "x".repeat(1000);
  for (let i = 0; i < 10; i++)
    state = applySubAgentEvent(
      state,
      event("subagent.event", {
        agentThreadId: "child",
        nickname: "Scout",
        kind: "message.delta",
        delta: chunk + i,
      }),
    );
  assert.equal(state.previews.child.length, PREVIEW_LIMIT);
  assert.ok(state.previews.child.endsWith("9"));
  // Output before the spawn event still registers the helper.
  assert.equal(state.agents[0].nickname, "Scout");
  state = applySubAgentEvent(
    state,
    event("subagent.event", {
      agentThreadId: "child",
      kind: "message.final",
      text: "Done: 3 sources",
    }),
  );
  assert.equal(state.previews.child, "Done: 3 sources");
  assert.equal(state.agents[0].lastMessage, "Done: 3 sources");
  const ignored = applySubAgentEvent(
    state,
    event("subagent.event", { kind: "message.delta", delta: "orphan" }),
  );
  assert.equal(ignored, state);
});

test("names fall back from nickname to role, path and a generic label", () => {
  assert.equal(agentName(agent()), "Researcher");
  assert.equal(agentName(agent({ nickname: null })), "explorer");
  assert.equal(
    agentName(agent({ nickname: null, role: null })),
    "/root/researcher",
  );
  assert.equal(
    agentName(agent({ nickname: null, role: null, path: null })),
    "Helper",
  );
});

test("delegation prefs are clamped to the supported range", () => {
  assert.deepEqual(normalizeDelegation(null), {
    mode: "explicitRequestOnly",
    maxConcurrent: 3,
  });
  assert.deepEqual(
    normalizeDelegation({ mode: "proactive", maxConcurrent: 9 }),
    {
      mode: "proactive",
      maxConcurrent: 5,
    },
  );
  assert.equal(normalizeDelegation({ maxConcurrent: 0 }).maxConcurrent, 3);
  assert.equal(
    normalizeDelegation({ mode: "other" }).mode,
    "explicitRequestOnly",
  );
});

test("helpers group into one chat block per turn, idempotently", () => {
  const spawned = (id: string, turnId = "turn") =>
    event(
      "subagent.spawned",
      { agent: agent({ threadId: id }), label: "Spawned" },
      { turnId },
    );
  let list = applyChatEvent([], spawned("a"));
  list = applyChatEvent(list, spawned("b"));
  // Replays and status updates for known helpers add nothing.
  list = applyChatEvent(list, spawned("a"));
  list = applyChatEvent(
    list,
    event(
      "subagent.status",
      { agent: agent({ threadId: "b" }) },
      { itemId: "wait-1" },
    ),
  );
  list = applyChatEvent(
    list,
    event("subagent.completed", {
      agent: agent({ threadId: "a", status: "completed" }),
    }),
  );
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    kind: "agents",
    id: "agents:turn",
    turnId: "turn",
    threadIds: ["a", "b"],
  });
  // A later turn waiting on or closing an earlier helper adds no block.
  list = applyChatEvent(
    list,
    event(
      "subagent.completed",
      { agent: agent({ threadId: "b", status: "shutdown" }) },
      { turnId: "turn-2" },
    ),
  );
  assert.equal(list.length, 1);
  // A new helper in a later turn gets that turn's own block.
  list = applyChatEvent(list, spawned("c", "turn-2"));
  assert.deepEqual(
    list.map((e) => (e.kind === "agents" ? e.threadIds : [])),
    [["a", "b"], ["c"]],
  );
  assert.equal(
    applyChatEvent([], event("subagent.status", { agent: {} })).length,
    0,
  );
});

test("snapshots show helpers the chat has not placed yet", () => {
  const listed = applyChatEvent(
    [],
    event("subagent.spawned", { agent: agent({ threadId: "a" }) }),
  );
  const next = applyChatEvent(
    listed,
    event("snapshot", {
      state: { kind: "running", turnId: "turn-2" },
      messages: [],
      subAgents: [agent({ threadId: "a" }), agent({ threadId: "b" })],
    }),
  );
  assert.deepEqual(
    next
      .filter((e) => e.kind === "agents")
      .map((e) => [e.turnId, e.kind === "agents" ? e.threadIds : []]),
    [
      ["turn", ["a"]],
      ["turn-2", ["b"]],
    ],
  );
});

test("helper names use the nickname, a real role, then spawn order", () => {
  const all = [
    agent({
      threadId: "late",
      nickname: null,
      role: null,
      startedAt: "2026-09-28T10:00:05.000Z",
    }),
    agent({
      threadId: "b",
      nickname: null,
      role: "default",
      startedAt: "2026-09-28T10:00:00.000Z",
    }),
    agent({
      threadId: "a",
      nickname: null,
      role: null,
      startedAt: "2026-09-28T10:00:00.000Z",
    }),
    agent({
      threadId: "named",
      nickname: "Hypatia",
      startedAt: "2026-09-28T10:00:01.000Z",
    }),
  ];
  assert.equal(helperName(all[3], all), "Hypatia");
  assert.equal(
    helperName(agent({ nickname: null, role: "reviewer" }), all),
    "Reviewer",
  );
  // Same start time: thread ID breaks the tie. "default" is not a name.
  assert.equal(helperName(all[2], all), "Helper 1");
  assert.equal(helperName(all[1], all), "Helper 2");
  assert.equal(helperName(all[0], all), "Helper 4");
  // The old generic label never appears.
  assert.ok(all.every((a) => !helperName(a, all).includes("Helper agent")));
});

test("task titles come from the first sentence, cut at a word", () => {
  assert.equal(
    taskTitle("Research Songkran celebrations. Include dates and venues."),
    "Research Songkran celebrations",
  );
  const long = taskTitle(
    "Research fine dining and notable food experiences in Thailand for a luxury traveler",
  );
  assert.ok(long.length <= TITLE_LIMIT + 1, long);
  assert.ok(long.endsWith("…"));
  assert.equal(long, "Research fine dining and notable food…");
  assert.equal(taskTitle("   "), "Working on a task");
  assert.equal(taskTitle(undefined), "Working on a task");
});

test("elapsed time uses server time, never goes negative, and survives reload", () => {
  const start = Date.parse("2026-09-28T10:00:00.000Z");
  const running = agent();
  assert.equal(elapsedMs(running, start + 38_000), 38_000);
  // Browser clock 5s behind the server: add the skew back.
  assert.equal(elapsedMs(running, start + 33_000, 5_000), 38_000);
  // A browser clock ahead of the server can't make time negative.
  assert.equal(elapsedMs(running, start - 10_000), 0);
  assert.equal(elapsedMs(agent({ startedAt: "nonsense" }), start), 0);
  assert.equal(elapsedMs(running, start + 1000, NaN), 1000);
  const ended = agent({
    status: "completed",
    endedAt: "2026-09-28T10:00:45.000Z",
  });
  assert.equal(elapsedMs(ended, start + 999_999), 45_000);
  // After a snapshot rebuild the timer continues from the saved start time.
  const rebuilt = rehydrate(emptySubAgents, [running]);
  assert.equal(elapsedMs(rebuilt.agents[0], start + 72_000), 72_000);
  assert.equal(
    groupElapsedMs(
      [
        ended,
        agent({
          threadId: "x",
          status: "completed",
          endedAt: "2026-09-28T10:01:12.000Z",
        }),
      ],
      start + 999_999,
    ),
    72_000,
  );
});

test("clock skew is learned from event times and kept through snapshots", () => {
  const now = Date.parse("2026-09-28T10:00:00.000Z");
  assert.equal(learnSkew(undefined, "2026-09-28T10:00:03.000Z", now), 3000);
  // Delayed events look older; the largest sample wins.
  assert.equal(learnSkew(3000, "2026-09-28T10:00:01.000Z", now), 3000);
  // Replayed history far in the past is not a clock sample.
  assert.equal(learnSkew(3000, "2026-09-27T10:00:00.000Z", now), 3000);
  assert.equal(learnSkew(undefined, undefined, now), undefined);
  const state = applySubAgentEvent(
    emptySubAgents,
    {
      ...event("subagent.spawned", { agent: agent() }),
      at: "2026-09-28T10:00:02.000Z",
    },
    now,
  );
  assert.equal(state.skewMs, 2000);
  assert.equal(
    applySubAgentEvent(state, event("snapshot", { subAgents: [agent()] }), now)
      .skewMs,
    2000,
  );
});

test("closing a finished helper keeps its outcome", () => {
  let list = upsertAgent([], agent());
  list = upsertAgent(
    list,
    agent({ status: "completed", endedAt: "2026-09-28T10:00:30.000Z" }),
  );
  list = upsertAgent(list, agent({ status: "shutdown" }));
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].endedAt, "2026-09-28T10:00:30.000Z");
  // A running helper that is closed shows as closed.
  assert.equal(
    upsertAgent(upsertAgent([], agent()), agent({ status: "shutdown" }))[0]
      .status,
    "shutdown",
  );
});

test("previews end at a word boundary and keep the last lines", () => {
  const text =
    "Which would be most useful: " +
    "exactly what would be wrong or stale. ".repeat(10);
  const tail = previewTail(text, 60);
  assert.ok(tail.startsWith("…"));
  // The cut never lands mid-word (the "actly" bug).
  assert.match(tail.slice(1), /^(exactly|what|would|be|wrong|or|stale\.)\b/);
  assert.ok(tail.length <= 61);
  assert.equal(
    previewTail("one\ntwo\nthree\nfour\nfive\nsix", 500, 3),
    "…four\nfive\nsix",
  );
  assert.equal(previewTail("short answer"), "short answer");
  assert.equal(previewTail(""), "");
});

test("durations read as m:ss or h:mm:ss", () => {
  assert.equal(formatDuration(38_000), "0:38");
  assert.equal(formatDuration(72_400), "1:12");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(NaN), "0:00");
});

test("previews keep whole lines and never leave an unpaired marker", () => {
  const text = [
    "Tips for commit messages:",
    "1. **Use the imperative mood** in the subject line.",
    "2. **Separate subject from body** with a blank line.",
    "3. **Explain why**, not what the diff already shows.",
  ].join("\n");
  // Short limit: only the last whole line fits, so no marker is split.
  const tail = previewTail(text, 60, 4);
  assert.equal(
    tail,
    "…\n\n3. **Explain why**, not what the diff already shows.",
  );
  // A single long line cut mid-bold drops the orphaned marker.
  const cut = previewTail(
    "intro " + "word ".repeat(40) + "**bold end** done",
    30,
  );
  assert.equal((cut.match(/\*\*/g) || []).length % 2, 0);
  assert.equal(previewTail("a **b** `c`"), "a **b** `c`");
  assert.equal(previewTail("text ends in **half"), "text ends in half");
  // A cut heading starts its own line so it still renders as a heading.
  const heading = previewTail("intro line\n## Specificity: point to it", 30);
  assert.equal(heading, "…\n\n## Specificity: point to it");
});

test("duration parts split whole hours, minutes and seconds", () => {
  assert.deepEqual(durationParts(59_999), { h: 0, m: 0, s: 59 });
  assert.deepEqual(durationParts(60_000), { h: 0, m: 1, s: 0 });
  assert.deepEqual(durationParts(3_723_000), { h: 1, m: 2, s: 3 });
  assert.deepEqual(durationParts(-5), { h: 0, m: 0, s: 0 });
  assert.deepEqual(durationParts(Number.NaN), { h: 0, m: 0, s: 0 });
});

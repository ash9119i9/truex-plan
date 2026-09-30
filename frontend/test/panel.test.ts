import { test } from "node:test";
import assert from "node:assert/strict";
import type { DomainEvent, SubAgent, TurnTrace } from "../../shared/contracts";
import type { Entry } from "../lib/chat.ts";
import {
  buildTurns,
  defaultScope,
  effectiveScope,
  helperRoster,
  helperTurns,
  liveTurn,
  parseDiff,
  planDiff,
  planVersions,
  selectedTurnId,
  sessionFiles,
  sessionSubLine,
  sessionTotals,
  showBackToLive,
  versionForTurn,
} from "../lib/vm-panel.ts";

let seq = 0;
const ev = (
  type: string,
  turnId: string | undefined,
  data: Record<string, unknown> = {},
  at = "2026-09-30T10:00:00.000Z",
) => ({ type, turnId, data, at, seq: ++seq }) as unknown as DomainEvent;
const user = (turnId: string, text: string, steer = false): Entry => ({
  kind: "message",
  id: `u:${turnId}`,
  role: "user",
  text,
  turnId,
  steer,
});
const trace = (turnId: string, total: number, helper = 0, ms = 1000) =>
  ({
    turnId,
    startedAt: "2026-09-30T10:02:00.000Z",
    totalMs: ms,
    status: "completed",
    steps: [
      { id: "s1", kind: "command", label: "Ran", agent: "main", agentThreadId: "", startMs: 0, durationMs: 1, status: "completed" },
      { id: "s2", kind: "tool", label: "Tool", agent: "main", agentThreadId: "", startMs: 0, durationMs: 1, status: "failed" },
    ],
    usage: { inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total, contextWindow: null, contextUsedTokens: null },
    helperUsage: helper
      ? { inputTokens: helper, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: helper }
      : null,
    rateLimits: null,
    privacy: { scannedChars: 0, findings: [] },
  }) as TurnTrace;
const agent = (threadId: string, nickname: string, startedAt: string): SubAgent => ({
  threadId,
  nickname,
  role: "docs",
  path: null,
  depth: 1,
  status: "completed",
  startedAt,
  endedAt: startedAt,
});

const DIFF = `diff --git a/plans/onboarding.md b/plans/onboarding.md
new file mode 100644
--- /dev/null
+++ b/plans/onboarding.md
@@ -0,0 +1,2 @@
+Week 1
+Week 2
diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1,2 +1,2 @@
 keep
-old
+new
`;

test("parseDiff splits a unified diff per file with line counts", () => {
  const files = parseDiff(DIFF);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed, f.created]),
    [
      ["plans/onboarding.md", 2, 0, true],
      ["notes.md", 1, 1, false],
    ],
  );
  assert.deepEqual(files[1].lines, [" keep", "-old", "+new"]);
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff(undefined), []);
});

test("scope defaults: This turn while running, Session when idle; Goal locked", () => {
  assert.equal(defaultScope("activity", true), "turn");
  assert.equal(defaultScope("activity", false), "session");
  assert.equal(defaultScope("agents", true), "turn");
  assert.equal(defaultScope("agents", false), "turn");
  assert.equal(defaultScope("plan", true), "session");
  assert.equal(effectiveScope("goal", { goal: "turn" }, true), "session");
  assert.equal(effectiveScope("plan", { plan: "turn" }, false), "turn");
});

test("turn selection follows live unless the user picked one", () => {
  const turns = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(selectedTurnId(turns, null, "c"), "c");
  assert.equal(selectedTurnId(turns, "b", "c"), "b");
  assert.equal(selectedTurnId(turns, "gone", null), "c");
  assert.equal(selectedTurnId([], null, null), null);
  assert.equal(showBackToLive("b", "c"), true);
  assert.equal(showBackToLive("c", "c"), false);
  assert.equal(showBackToLive("b", null), false);
});

test("liveTurn is the turn started after the last completion", () => {
  assert.equal(liveTurn([ev("turn.started", "a"), ev("turn.completed", "a")]), null);
  assert.equal(
    liveTurn([ev("turn.started", "a"), ev("turn.completed", "a"), ev("turn.started", "b")]),
    "b",
  );
});

test("plan versions are a history: a new step list supersedes, status changes advance", () => {
  const v1 = [
    { step: "Read handbook", status: "completed" },
    { step: "Map week one", status: "completed" },
  ];
  const v2a = [
    { step: "Map week one", status: "completed" },
    { step: "Build checklist", status: "pending" },
  ];
  const v2b = [
    { step: "Map week one", status: "completed" },
    { step: "Build checklist", status: "inProgress" },
  ];
  const events = [
    ev("plan.updated", "t1", { plan: v1 }),
    ev("plan.updated", "t3", { plan: v2a }),
    ev("plan.updated", "t4", { plan: v2b }),
  ];
  const versions = planVersions(events);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].createdTurnId, "t1");
  assert.equal(versions[0].supersededTurnId, "t3");
  assert.equal(versions[1].createdTurnId, "t3");
  assert.deepEqual(versions[1].steps[1].history, [{ status: "inProgress", turnId: "t4" }]);
  assert.equal(versionForTurn(versions, ["t1", "t2", "t3", "t4"], "t2")?.version, 1);
  assert.equal(versionForTurn(versions, ["t1", "t2", "t3", "t4"], "t4")?.version, 2);
  const diff = planDiff(versions[0].steps, versions[1].steps);
  assert.equal(diff.label, "1 kept, 1 removed, 1 added");
  assert.deepEqual(
    diff.lines.map((l) => l.kind),
    ["keep", "del", "add"],
  );
  // A snapshot-only plan still shows as v1.
  assert.equal(planVersions([], v1).length, 1);
});

test("buildTurns groups events by turn id first, errors stay with their turn", () => {
  const entries: Entry[] = [
    user("t1", "Draft a plan"),
    { kind: "agents", id: "agents:t1", turnId: "t1", threadIds: ["h1", "h2"] },
    user("t2", "Keep it short", true),
    user("t3", "Turn it into a file"),
  ];
  const events = [
    ev("turn.started", "t1", {}, "2026-09-30T10:02:00.000Z"),
    ev("activity.updated", "t1", { label: "Researching the web" }),
    ev("activity.updated", "t1", { label: "Web research finished" }),
    ev("plan.updated", "t1", { plan: [{ step: "A", status: "completed" }] }),
    ev("turn.completed", "t1", { turn: { status: "completed" } }),
    ev("turn.started", "t2", {}, "2026-09-30T10:09:00.000Z"),
    ev("error", "t2", { code: "err_7f3a21", message: "token expired" }),
    ev("diff.updated", "t2", { diff: DIFF }),
    ev("turn.completed", "t2", { turn: { status: "completed" } }),
    ev("turn.started", "t3", {}, "2026-09-30T10:16:00.000Z"),
    ev("diff.updated", "t3", {
      diff: "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-x\n+y\n",
    }),
  ];
  const agents = [
    agent("h1", "Atlas", "2026-09-30T10:02:10.000Z"),
    agent("h2", "Birch", "2026-09-30T10:02:20.000Z"),
  ];
  const turns = buildTurns({
    events,
    entries,
    agents,
    traces: [trace("t1", 58200, 16900)],
    liveUsage: { totalTokens: 26600 } as never,
    now: Date.parse("2026-09-30T10:17:01.000Z"),
  });
  assert.deepEqual(
    turns.map((t) => [t.label, t.status]),
    [
      ["T1", "done"],
      ["T2", "done"],
      ["T3", "live"],
    ],
  );
  const [t1, t2, t3] = turns;
  assert.equal(t1.prompt, "Draft a plan");
  assert.equal(t1.tokens, 58200 + 16900);
  assert.equal(t1.toolCalls, 2); // from the trace
  assert.equal(t1.failedTools, 1);
  assert.deepEqual(t1.helperIds, ["h1", "h2"]);
  assert.equal(t1.planCreated, 1);
  assert.ok(t1.rows.some((r) => r.title === "Plan v1 created"));
  assert.ok(t1.rows.some((r) => r.kind === "agent" && r.sub === "Atlas, Birch"));
  assert.equal(t1.errors, 0);
  assert.equal(t2.steer, true);
  assert.equal(t2.errors, 1);
  assert.equal(t2.rows.find((r) => r.kind === "err")?.ref, "err_7f3a21");
  assert.equal(t3.errors, 0, "the T2 error does not follow into T3");
  assert.equal(t3.tokens, 26600);
  assert.equal(t3.durationMs, 61_000);
  assert.ok(t3.rows.some((r) => r.title === "Writing notes.md" && r.live));

  const files = sessionFiles(turns);
  const notes = files.find((f) => f.path === "notes.md")!;
  assert.deepEqual(
    notes.edits.map((e) => e.label),
    ["T2", "T3"],
  );
  assert.equal(notes.added, 2);
  assert.equal(notes.writing, true);
  assert.equal(files.find((f) => f.path === "plans/onboarding.md")?.edits[0].created, true);

  const totals = sessionTotals(turns);
  assert.equal(totals.turns, 3);
  assert.equal(totals.files, 2);
  assert.equal(totals.errors, 1);
  assert.equal(totals.tokens, 58200 + 16900 + 26600);
});

test("helper roster merges runs of the same helper across turns", () => {
  const agents = [
    agent("h1", "Atlas", "2026-09-30T10:02:10.000Z"),
    agent("h2", "Cedar", "2026-09-30T10:02:20.000Z"),
    agent("h3", "Atlas", "2026-09-30T10:16:10.000Z"),
  ];
  const entries: Entry[] = [
    { kind: "agents", id: "agents:t1", turnId: "t1", threadIds: ["h1", "h2"] },
    { kind: "agents", id: "agents:t3", turnId: "t3", threadIds: ["h3"] },
  ];
  const turnOf = helperTurns(entries, []);
  assert.deepEqual(turnOf, { h1: "t1", h2: "t1", h3: "t3" });
  const turns = buildTurns({ events: [], entries });
  const roster = helperRoster(agents, turns, turnOf);
  assert.equal(roster.length, 2);
  assert.deepEqual(
    roster[0].runs.map((r) => r.turnLabel),
    ["T1", "T2"],
  );
  assert.equal(
    sessionSubLine(roster, [], 31000),
    "2 helpers (Atlas twice) · 31k tokens from helpers",
  );
});

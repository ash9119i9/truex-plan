import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditRows,
  commandView,
  deliveryView,
  diffLines,
  helperRows,
  helperTally,
  itemRow,
  parseCommandText,
  refText,
  stepTime,
  streamError,
  thinkingHeading,
  thoughtTitle,
  turnNumbers,
  workView,
} from "../lib/vm-stream.ts";
import type { Entry } from "../lib/chat.ts";
import type {
  ApprovalRecord,
  CommandRecord,
  SubAgent,
  TurnTrace,
} from "../../shared/contracts";

test("delivery states map to the wireframe's meta and bubble classes", () => {
  assert.deepEqual(
    [deliveryView("pending"), deliveryView("failed"), deliveryView("unknown")].map(
      (d) => [d.meta, d.bubble, d.label, d.retry, d.spinner],
    ),
    [
      ["pend", "st-pend", "Sending", false, true],
      ["fail", "st-fail", "Not sent", true, false],
      ["unk", "", "Not confirmed", true, false],
    ],
  );
  const ok = deliveryView("accepted", "not a date");
  assert.equal(ok.state, "accepted");
  assert.equal(ok.icon, "check");
  assert.equal(ok.label, "");
  // Legacy messages with no delivery field read as accepted.
  assert.equal(deliveryView(undefined).state, "accepted");
});

test("slash command text splits into chip name and argument", () => {
  assert.deepEqual(parseCommandText("/goal One-page plan"), {
    name: "goal",
    arg: "One-page plan",
  });
  assert.deepEqual(parseCommandText("/export pdf"), { name: "export", arg: "pdf" });
  assert.deepEqual(parseCommandText("plain", "thread/fork"), {
    name: "fork",
    arg: "plain",
  });
});

const cmd = (over: Partial<CommandRecord>): CommandRecord => ({
  method: "thread/goal/set",
  params: {},
  state: "succeeded",
  ...over,
});

test("command result card: goal set, running and failed", () => {
  const set = commandView("/goal Ship it", cmd({}), "Ship it", true);
  assert.equal(set.title, "Goal set");
  assert.equal(set.tile, "target");
  assert.equal(set.pill.label, "Done");
  assert.equal(set.body, "Ship it");
  assert.equal(set.foot?.text, "Pinned to the topbar until you clear it");
  // An older card for a goal that is no longer current is not pinned.
  assert.equal(commandView("/goal Ship it", cmd({}), "Ship it", false).foot, null);

  const run = commandView("/goal x", cmd({ state: "running" }));
  assert.equal(run.pill.spinner, true);

  const bad = commandView(
    "/export pdf",
    cmd({ method: "export", state: "failed", error: "Export needs a finished answer." }),
  );
  assert.equal(bad.tone, "bad");
  assert.equal(bad.title, "Export failed");
  assert.equal(bad.pill.label, "Failed");
  assert.equal(bad.body, "Export needs a finished answer.");
  assert.deepEqual(bad.foot, {
    mono: "/export pdf",
    text: "edit the command and send again",
  });
});

test("turn numbers follow first appearance", () => {
  const entries = [
    { kind: "message", id: "u1", role: "user", text: "a", turnId: "t-a" },
    { kind: "thinking", id: "k", turnId: "t-a", text: "" },
    { kind: "message", id: "u2", role: "user", text: "b", turnId: "t-b" },
    { kind: "message", id: "m", role: "assistant", text: "c" },
  ] as Entry[];
  assert.deepEqual([...turnNumbers(entries)], [
    ["t-a", 1],
    ["t-b", 2],
  ]);
});

test("audit rows cover every decision, auto mode and masked secrets", () => {
  const record: ApprovalRecord = {
    requestId: "r",
    outcome: "answered",
    items: [
      { kind: "toolApproval", action: "npm test", decision: "allowedOnce" },
      { kind: "toolApproval", action: "ls", decision: "allowedSession" },
      { kind: "toolApproval", action: "cat", decision: "allowedChat" },
      { kind: "toolApproval", action: "git status", decision: "allowedAlways" },
      { kind: "toolApproval", action: "rm -rf drafts/", decision: "declined" },
      { kind: "toolApproval", action: "gdrive", decision: "expired" },
      { kind: "question", question: "Qlik API key", answer: "sk-123", secret: true },
      { kind: "question", question: "Which week?", answer: "Two" },
    ],
  } as ApprovalRecord;
  const rows = auditRows(record);
  assert.deepEqual(
    rows.map((r) => [r.tone, r.label]),
    [
      ["ok", "Allowed once"],
      ["ok", "Allowed for session"],
      ["ok", "Allowed for this chat"],
      ["ok", "Always allowed"],
      ["no", "Declined"],
      ["exp", "Expired"],
      ["st-s", "Answered"],
      ["ok", "Answered"],
    ],
  );
  // The secret answer never reaches the view model.
  assert.equal(rows[6].masked, true);
  assert.ok(!JSON.stringify(rows).includes("sk-123"));
  assert.equal(rows[7].detail, "Which week? · Two");

  const auto = auditRows({
    requestId: "a",
    outcome: "auto",
    autoMode: "auto",
    items: [
      { kind: "toolApproval", action: "write plan.md", decision: "allowedOnce" },
      { kind: "toolApproval", action: "rm", decision: "declined" },
    ],
  } as ApprovalRecord);
  assert.deepEqual(
    auto.map((r) => r.label),
    ["Auto mode", "Declined"],
  );
});

test("unified diffs become coloured lines with counts", () => {
  const d = diffLines("--- a\n+++ b\n@@ -1 +1,2 @@\n-Week 2: TBD\n+Week 2: Shadow\n+Day 9: Publish\n");
  assert.equal(d.adds, 2);
  assert.equal(d.dels, 1);
  assert.deepEqual(d.lines.map((l) => l.kind), ["del", "add", "add"]);
  // A new file's content is all additions.
  const add = diffLines("# Plan\nWeek 1", "add");
  assert.equal(add.adds, 2);
  assert.deepEqual(diffLines(""), { lines: [], adds: 0, dels: 0 });
});

test("item rows: command, file change, MCP, web search, unknown", () => {
  const run = itemRow("1", {
    type: "commandExecution",
    command: "grep -ril onboarding docs",
    aggregatedOutput: "a.md\nb.md\nc.md\n",
    exitCode: 0,
    durationMs: 1234,
    status: "completed",
    commandActions: [{ type: "unknown", command: "grep" }],
  })!;
  assert.equal(run.title, "Ran a command");
  assert.equal(run.node, "k-tool");
  assert.equal(run.t, "1.2s");
  assert.equal(run.code?.lines, 3);

  const reads = itemRow("r", {
    type: "commandExecution",
    command: "cat a b c",
    commandActions: [{ type: "read" }, { type: "read" }, { type: "read" }],
    exitCode: 0,
    status: "completed",
  })!;
  assert.equal(reads.title, "Read 3 workspace documents");

  const failed = itemRow("2", {
    type: "commandExecution",
    command: "npm test",
    exitCode: 1,
    status: "failed",
  })!;
  assert.equal(failed.node, "k-err");

  const long = itemRow("l", {
    type: "commandExecution",
    command: "seq 20",
    aggregatedOutput: Array.from({ length: 20 }, (_, i) => i).join("\n"),
    exitCode: 0,
  })!;
  assert.equal(long.code?.output.split("\n").length, 12);
  assert.equal(long.code?.lines, 20);

  const created = itemRow("3", {
    type: "fileChange",
    status: "completed",
    changes: [{ path: "plans/onboarding.md", kind: { type: "add" }, diff: "# Plan" }],
  })!;
  assert.equal(created.title, "Created plans/onboarding.md");
  assert.equal(created.adds, 1);
  const edited = itemRow("4", {
    type: "fileChange",
    changes: [
      { path: "a", kind: { type: "update" }, diff: "-x\n+y" },
      { path: "b", kind: { type: "update" }, diff: "+z" },
    ],
  })!;
  assert.equal(edited.title, "Edited 2 files");
  assert.equal(edited.files?.length, 2);

  const mcp = itemRow("5", {
    type: "mcpToolCall",
    server: "qlik",
    tool: "list_spaces",
    status: "completed",
    durationMs: 800,
    result: { content: [{ type: "text", text: "12 spaces returned" }] },
  })!;
  assert.equal(mcp.title, "qlik · list_spaces");
  assert.equal(mcp.sub, "12 spaces returned");
  assert.equal(mcp.t, "0.8s");

  const web = itemRow("6", {
    type: "webSearch",
    query: "Qlik Sense analyst certification",
    results: [1, 2, 3, 4, 5],
  })!;
  assert.equal(web.sub, '"Qlik Sense analyst certification" · 5 results');
  assert.equal(web.query, true);

  const other = itemRow("7", { type: "todoList" })!;
  assert.equal(other.title, "Other");
  assert.equal(other.mono, "todoList");
  assert.equal(other.icon, "layers");

  assert.equal(itemRow("8", { type: "agentMessage" }), null);
  assert.equal(itemRow("9", { type: "collabAgentToolCall", tool: "spawnAgent" }), null);
});

test("thinking labels", () => {
  assert.equal(thoughtTitle(4200), "Thought for 4s");
  assert.equal(thoughtTitle(300), "Thought for 1s");
  assert.equal(thoughtTitle(null), "Thought");
  assert.equal(thinkingHeading("**Planning week 2 milestones**\n\nbody"), "Planning week 2 milestones…");
  assert.equal(thinkingHeading(""), "Thinking…");
  assert.equal(stepTime(300), "0.3s");
  assert.equal(stepTime(null), "");
});

const turn = (id: string): Entry[] => [
  { kind: "thinking", id: "th", turnId: id, itemId: "r1", text: "s", summary: "Check the handbook", done: true },
  {
    kind: "item",
    id: "i1",
    turnId: id,
    item: { type: "commandExecution", id: "c", command: "ls", exitCode: 0, status: "completed" },
  },
  {
    kind: "approval",
    id: "ap",
    turnId: id,
    record: {
      requestId: "q",
      outcome: "answered",
      items: [{ kind: "toolApproval", action: "ls", decision: "allowedOnce" }],
    } as ApprovalRecord,
  },
];

test("work group: working, streaming and folded", () => {
  const working = workView(turn("t"), { active: true, answering: false })!;
  assert.equal(working.running, true);
  assert.equal(working.defaultOpen, true);
  // Nothing was running, so a live row keeps the last row moving.
  assert.equal(working.rows.at(-1)?.live, true);
  assert.equal(working.title, "Working · 3 done, 1 running");
  assert.equal(working.rows[2].title, "Approvals · 1 decision");

  const waiting = workView(turn("t"), { active: true, answering: false, waiting: 1 })!;
  assert.ok(!waiting.rows.some((r) => r.id === "live"));
  assert.equal(waiting.title, "Working · 3 done, 1 running");

  const streaming = workView(turn("t"), {
    active: true,
    answering: true,
    liveUsage: {
      last: { inputTokens: 20000, cachedInputTokens: 0, outputTokens: 6600, reasoningOutputTokens: 0, totalTokens: 26600 },
    } as any,
  })!;
  assert.equal(streaming.shimmer, true);
  assert.equal(streaming.defaultOpen, false);

  // A request raised while the answer streams keeps its hold row visible.
  const heldWhileStreaming = workView(turn("t"), { active: true, answering: true, waiting: 1 })!;
  assert.equal(heldWhileStreaming.defaultOpen, true);

  const trace = {
    turnId: "t",
    totalMs: 72_000,
    steps: [{ id: "r1", durationMs: 4000 }],
  } as unknown as TurnTrace;
  const done = workView(turn("t"), { active: false, answering: true, trace })!;
  assert.equal(done.running, false);
  assert.equal(done.title, "Worked for 1m 12s");
  assert.equal(done.small, "3 steps");
  assert.equal(done.rows[0].title, "Thought for 4s");
  assert.deepEqual(done.types, ["brain", "term", "shield"]);

  assert.equal(workView([], { active: false, answering: true }), null);
});

const agent = (over: Partial<SubAgent>): SubAgent => ({
  threadId: "a",
  path: null,
  nickname: null,
  role: null,
  depth: 1,
  status: "running",
  startedAt: "2026-09-30T10:00:00.000Z",
  ...over,
});

test("helper rows map status to pills and tally in legend order", () => {
  const all = [
    agent({ threadId: "1", nickname: "Atlas", role: "docs", task: "Reading week-one.md." }),
    agent({ threadId: "2", nickname: "Birch", status: "interrupted", role: "access" }),
    agent({ threadId: "3", nickname: "Cedar", status: "completed", lastMessage: "Drafted a schedule." }),
  ];
  const rows = helperRows(all, all);
  assert.deepEqual(
    rows.map((r) => [r.name, r.role, r.tone, r.pill.label, r.running]),
    [
      ["Atlas", "Docs", 0, "Running", true],
      ["Birch", "Access", 1, "Stopped", false],
      ["Cedar", "", 2, "Done", false],
    ],
  );
  assert.equal(rows[0].task, "Reading week-one.md");
  assert.equal(rows[2].task, "Drafted a schedule");
  assert.equal(helperTally(rows), "1 running · 1 done · 1 stopped");
});

test("inline error keeps its turn, hint and ref", () => {
  assert.equal(streamError(""), null);
  const e = streamError(
    "Google Drive search failed",
    { code: "err_7f3a21", turnId: "t3" },
    { reason: "rateLimited", message: "x" },
  )!;
  assert.equal(e.turnId, "t3");
  assert.match(e.hint || "", /limiting requests/);
  assert.equal(refText(e.ref), "err_7f3a21 · t3");
  assert.equal(refText({ code: "E1", requestId: "req" }), "E1 · req");
  assert.equal(refText(null), "");
});

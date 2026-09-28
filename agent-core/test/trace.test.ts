import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TraceBuilder,
  contextLimit,
  rateLimitView,
  sectionLimit,
  stepLimit,
  stepOf,
} from "../src/trace";

const main = { agent: "main", agentThreadId: "thread_1" };
const helper = { agent: "Scout", agentThreadId: "child_1" };
const email = "jane.doe@example.com",
  card = "4111 1111 1111 1111";

test("steps are labelled in plain words without arguments", () => {
  const label = (item: any) => stepOf(item)?.label;
  assert.equal(label({ type: "reasoning" }), "Thinking");
  assert.equal(label({ type: "agentMessage" }), "Wrote the reply");
  assert.equal(
    label({ type: "commandExecution", command: "cat /etc/secret" }),
    "Ran a command",
  );
  assert.equal(
    label({
      type: "mcpToolCall",
      server: "files",
      tool: "read",
      arguments: { path: "/home/jane" },
    }),
    "Used read from files",
  );
  assert.equal(
    label({ type: "dynamicToolCall", tool: "lookup" }),
    "Used lookup",
  );
  assert.equal(
    label({ type: "fileChange", changes: [{}, {}, {}] }),
    "Changed 3 files",
  );
  assert.equal(label({ type: "fileChange", changes: [{}] }), "Changed 1 file");
  assert.equal(label({ type: "webSearch", query: "jane" }), "Searched the web");
  assert.equal(
    label({ type: "collabAgentToolCall", tool: "spawnAgent" }),
    "Started a helper",
  );
  assert.equal(
    label({ type: "collabAgentToolCall", tool: "wait" }),
    "Waited for helpers",
  );
  assert.equal(stepOf({ type: "userMessage" }), null);
});

test("steps time relative to the turn and finish running ones", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 1000);
  b.onItem("started", { type: "userMessage", id: "u" }, 1000, main);
  b.onItem("started", { type: "reasoning", id: "r" }, 1100, main);
  b.onItem("completed", { type: "reasoning", id: "r" }, 1400, main);
  b.onItem(
    "started",
    { type: "commandExecution", id: "c", status: "inProgress" },
    1500,
    main,
  );
  b.onItem(
    "completed",
    { type: "commandExecution", id: "c", status: "declined" },
    1600,
    main,
  );
  b.onItem("started", { type: "agentMessage", id: "m" }, 1700, main);
  const trace = b.finish("interrupted", 2000);
  assert.equal(trace.startedAt, new Date(1000).toISOString());
  assert.equal(trace.totalMs, 2000);
  assert.deepEqual(
    trace.steps.map((s) => [s.id, s.startMs, s.durationMs, s.status]),
    [
      ["r", 100, 300, "completed"],
      ["c", 500, 100, "declined"],
      // Still running when the turn ended.
      ["m", 700, 1300, "failed"],
    ],
  );
});

test("steps are capped per turn", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 0);
  for (let i = 0; i < stepLimit + 50; i++)
    b.onItem("completed", { type: "reasoning", id: `r${i}` }, i, main);
  assert.equal(b.finish("completed", 1).steps.length, stepLimit);
});

test("main usage sums model calls and helper usage is kept apart", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 0);
  const call = (input: number, output: number) => ({
    inputTokens: input,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 5,
    totalTokens: input + output,
  });
  b.onUsage({
    last: call(100, 20),
    total: call(100, 20),
    modelContextWindow: 1000,
  });
  const usage = b.onUsage({
    last: call(300, 30),
    total: call(400, 50),
    modelContextWindow: 1000,
  });
  assert.deepEqual(usage, {
    inputTokens: 400,
    cachedInputTokens: 20,
    outputTokens: 50,
    reasoningOutputTokens: 10,
    totalTokens: 450,
    contextWindow: 1000,
    contextUsedTokens: 300,
  });
  b.onHelperUsage(call(50, 5));
  b.onHelperUsage(call(70, 7));
  b.onItem("started", { type: "reasoning", id: "r" }, 10, helper);
  const trace = b.finish("completed", 100);
  assert.deepEqual(trace.helperUsage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 12,
    reasoningOutputTokens: 10,
    totalTokens: 132,
  });
  assert.equal(trace.usage?.totalTokens, 450);
  assert.deepEqual(
    trace.steps.map((s) => [s.id, s.agent, s.agentThreadId]),
    [["child_1:r", "Scout", "child_1"]],
  );
});

test("privacy findings and the trace never hold raw values", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 0, null, `mail ${email}`);
  b.onItem(
    "completed",
    {
      type: "commandExecution",
      id: "c",
      command: `echo ${email}`,
      aggregatedOutput: `card ${card}`,
      status: "completed",
    },
    5,
    main,
  );
  b.onItem(
    "completed",
    {
      type: "mcpToolCall",
      id: "m",
      server: "crm",
      tool: "find",
      status: "completed",
      result: { content: [{ type: "text", text: `owner ${email}` }] },
    },
    6,
    main,
  );
  b.onItem(
    "completed",
    {
      type: "fileChange",
      id: "f",
      changes: [{ diff: `+${card}` }],
      status: "completed",
    },
    7,
    main,
  );
  const trace = b.finish("completed", 10);
  const json = JSON.stringify(trace);
  assert.ok(!json.includes(email) && !json.includes(card));
  assert.ok(!json.includes("jane"));
  const rows = trace.privacy.findings
    .map((f) => `${f.kind}:${f.source}:${f.count}`)
    .sort();
  assert.deepEqual(rows, [
    "card:fileContent:1",
    "card:toolOutput:1",
    "email:command:1",
    "email:toolOutput:1",
    "email:userMessage:1",
  ]);
  assert.ok(trace.privacy.scannedChars > 0);
  const context = JSON.stringify(b.context());
  assert.ok(!context.includes(email) && !context.includes(card));
  assert.equal(b.context().reconstructed, true);
});

test("the turn's userMessage item wins over the sent input", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 0, null, "typed text");
  b.onItem(
    "completed",
    {
      type: "userMessage",
      id: "u",
      content: [{ type: "text", text: `hi ${email}`, text_elements: [] }],
    },
    1,
    main,
  );
  // A helper's prompt is not the user's message.
  b.onItem(
    "completed",
    {
      type: "userMessage",
      id: "hu",
      content: [{ type: "text", text: "task" }],
    },
    1,
    helper,
  );
  b.finish("completed", 2);
  const sections = b.context().sections;
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, "user");
  assert.ok(sections[0].text.startsWith("hi j***@***.com"));
});

test("context sections are masked and truncated", () => {
  const b = new TraceBuilder("turn_1", "thread_1", 0);
  const big = `${email} ` + "x".repeat(sectionLimit * 2);
  for (let i = 0; i < 15; i++)
    b.onItem(
      "completed",
      {
        type: "commandExecution",
        id: `c${i}`,
        command: "ls",
        aggregatedOutput: big,
      },
      i,
      main,
    );
  const context = b.context();
  assert.equal(context.truncated, true);
  const output = context.sections.filter((s) => s.kind === "toolOutput");
  assert.ok(output.every((s) => s.text.length <= sectionLimit));
  assert.equal(output[0].chars, big.length);
  assert.ok(!output[0].text.includes(email));
  const total = context.sections.reduce((n, s) => n + s.text.length, 0);
  assert.ok(total <= contextLimit);
});

test("rate limit updates merge sparse values", () => {
  const first = rateLimitView(
    {
      limitName: "codex",
      primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 99 },
      secondary: null,
      rateLimitReachedType: null,
    },
    null,
    "t1",
  );
  const next = rateLimitView(
    { primary: { usedPercent: 55 }, rateLimitReachedType: "primary" },
    first,
    "t2",
  );
  assert.deepEqual(next, {
    limitName: "codex",
    primaryUsedPercent: 55,
    primaryWindowMins: 300,
    primaryResetsAt: 99,
    secondaryUsedPercent: null,
    secondaryWindowMins: null,
    secondaryResetsAt: null,
    reached: "primary",
    at: "t2",
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { validateResponse } from "../src/requests";
import {
  approvalMode,
  findTool,
  grantKey,
  indexTools,
  parseToolQuestion,
  readOnlyName,
  withChatGrant,
  singleCallApprovals,
} from "../src/approval-modes";
import { ALLOW_FOR_CHAT } from "../../shared/contracts";
const RUI = "item/tool/requestUserInput";
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  // Pages of mcpServerStatus/list; a function may change between calls.
  status: (() => any[][]) | null = () => [
    [
      {
        name: "crm",
        tools: {
          lookup: { name: "lookup", annotations: { readOnlyHint: true } },
          update: { name: "update", annotations: { readOnlyHint: false } },
          get_orders: { name: "get_orders" },
          listNotes: { name: "listNotes", annotations: {} },
        },
      },
    ],
    [
      {
        name: "docs",
        tools: {
          search: { name: "search", annotations: { readOnlyHint: true } },
        },
      },
    ],
  ];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread_1" } };
    if (method === "mcpServerStatus/list") {
      if (!this.status) throw new Error("lookup failed");
      const pages = this.status();
      const at = params.cursor ? Number(params.cursor) : 0;
      return {
        data: pages[at],
        nextCursor: at + 1 < pages.length ? String(at + 1) : null,
      };
    }
    return {};
  }
  respond(id: any, result: any, error: any) {
    this.replies.push({ id, result, error });
  }
}
function fixture(t: any, timeout = 1000) {
  const runtime = new Fake(),
    dir = mkdtempSync(join(tmpdir(), "approval-modes-")),
    manager = new ThreadManager(runtime, dir, 2, 50, timeout);
  t.after(() => {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, manager };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const tool = (
  server: string,
  name: string,
  id = `mcp_tool_call_approval_${name}`,
) => ({
  id,
  header: "Approve app tool call?",
  question: `Allow the ${server} MCP server to run tool "${name}"?`,
  isOther: false,
  isSecret: false,
  options: [
    { label: "Allow", description: "Run the tool and continue." },
    { label: "Allow for this session", description: "" },
    { label: "Cancel", description: "Cancel this tool call." },
  ],
});
const question = (id: string, labels: string[], extra: any = {}) => ({
  id,
  header: "Q",
  question: "Pick one?",
  isOther: false,
  isSecret: false,
  options: labels.map((label) => ({ label, description: "" })),
  ...extra,
});
function ask(runtime: Fake, id: number, questions: any[]) {
  runtime.emit("serverRequest", {
    id,
    method: RUI,
    params: {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: `call_${id}`,
      questions,
    },
  });
}
const reply = (runtime: Fake, id: number) =>
  runtime.replies.find((r) => r.id === id);
const resolved = (manager: ThreadManager) =>
  manager
    .records("thread_1")
    .filter((r) => r.event.type === "approval.resolved")
    .map((r) => r.event.data);
const statusCalls = (runtime: Fake) =>
  runtime.calls.filter((c) => c.method === "mcpServerStatus/list").length;

test("Omni dispatcher approvals cannot grant unrelated tools for a session or chat", () => {
  const detail = {
    questions: [tool("omni", "invoke_tool"), tool("qlik", "get_apps")],
  };
  const scoped = withChatGrant(detail);
  assert.deepEqual(
    scoped.questions[0].options.map((o: any) => o.label),
    ["Allow", "Cancel"],
  );
  assert.ok(
    scoped.questions[1].options.some((o: any) => o.label === ALLOW_FOR_CHAT),
  );
  assert.ok(
    detail.questions[0].options.some(
      (o) => o.label === "Allow for this session",
    ),
  );
  const qualified = singleCallApprovals({
    questions: [tool("omni", "mcp__omni__invoke_tool")],
  });
  assert.deepEqual(
    qualified.questions[0].options.map((o: any) => o.label),
    ["Allow", "Cancel"],
  );
});

for (const mode of [undefined, "ask", "readOnly"] as const)
  test(`Omni approval is single-call under ${mode || "legacy"} mode`, async (t) => {
    const { runtime, manager } = fixture(t);
    await manager.create({ ...(mode ? { approvalMode: mode } : {}) });
    ask(runtime, 71, [tool("omni", "invoke_tool")]);
    await tick();
    const pending = manager.snapshot("thread_1").pending[0];
    assert.ok(pending);
    assert.deepEqual(
      (pending.detail as any).questions[0].options.map((o: any) => o.label),
      ["Allow", "Cancel"],
    );
    const qid = (pending.detail as any).questions[0].id;
    for (const broad of [ALLOW_FOR_CHAT, "Allow for this session"])
      assert.throws(
        () =>
          manager.answer("thread_1", pending.requestId, {
            answers: { [qid]: { answers: [broad] } },
          }),
        /this call only/,
      );
    assert.equal(reply(runtime, 71), undefined);
    manager.answer("thread_1", pending.requestId, {
      answers: { [qid]: { answers: ["Allow"] } },
    });
    assert.ok(reply(runtime, 71));
    ask(runtime, 72, [tool("omni", "invoke_tool")]);
    await tick();
    assert.equal(
      reply(runtime, 72),
      undefined,
      "A different dispatcher invocation still needs its own decision",
    );
  });

test("an unanswered Omni invocation expires as Cancel, not an automatic Allow", async (t) => {
  const { runtime, manager } = fixture(t, 35);
  await manager.create({});
  ask(runtime, 73, [tool("omni", "invoke_tool")]);
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(
    reply(runtime, 73).result.answers.mcp_tool_call_approval_invoke_tool
      .answers,
    ["Cancel"],
  );
});

test("helpers parse questions, names, modes and annotations", () => {
  assert.deepEqual(
    parseToolQuestion('Allow the crm MCP server to run tool "update"?'),
    {
      server: "crm",
      tool: "update",
    },
  );
  assert.deepEqual(parseToolQuestion('Allow this app to run tool "run"?'), {
    server: "codex_apps",
    tool: "run",
  });
  assert.equal(parseToolQuestion("Approve the plan?"), null);
  assert.equal(
    parseToolQuestion('Allow Sales CRM to run tool "x"?')?.actor,
    "Sales CRM",
  );
  for (const n of [
    "get_orders",
    "listNotes",
    "search-docs",
    "readFile",
    "COUNT_rows",
    "describe",
  ])
    assert.equal(readOnlyName(n), true, n);
  for (const n of ["update", "getaway", "delete_list", "sendQuery", ""])
    assert.equal(readOnlyName(n), false, n);
  assert.equal(approvalMode("readOnly"), "readOnly");
  assert.throws(() => approvalMode("yolo"), /Approval mode/);
  const index = indexTools(
    [
      {
        name: "crm",
        tools: {
          a: { annotations: { readOnlyHint: true } },
          get_b: {},
          get_c: { annotations: {} },
        },
      },
    ],
    true,
  );
  assert.deepEqual(findTool(index, { server: "crm", tool: "a" }), {
    server: "crm",
    readOnly: true,
  });
  assert.equal(
    findTool(index, { server: "crm", tool: "get_b" })?.readOnly,
    true,
  );
  // Annotations without readOnlyHint never count, even with the heuristic.
  assert.equal(
    findTool(index, { server: "crm", tool: "get_c" })?.readOnly,
    false,
  );
  assert.equal(
    findTool(index, { server: null, tool: "mcp__crm__a" })?.readOnly,
    true,
  );
  assert.equal(findTool(index, { server: "crm", tool: "missing" }), null);
  assert.equal(
    grantKey({ server: null, tool: "mcp__crm__a" }),
    grantKey({ server: "crm", tool: "a" }),
  );
  const labels = withChatGrant({
    questions: [tool("crm", "update")],
  }).questions[0].options.map((o: any) => o.label);
  assert.deepEqual(labels, [
    "Allow",
    ALLOW_FOR_CHAT,
    "Allow for this session",
    "Cancel",
  ]);
});

test("no mode keeps today's behaviour: everything waits, no lookup, no grant option", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  assert.deepEqual(runtime.calls[0].params, {});
  ask(runtime, 1, [tool("crm", "lookup")]);
  ask(runtime, 2, [question("scope", ["A", "B (Recommended)"])]);
  await tick();
  const pending = manager.snapshot("thread_1").pending;
  assert.equal(pending.length, 2);
  assert.equal(runtime.replies.length, 0);
  assert.equal(statusCalls(runtime), 0);
  assert.ok(
    !(pending[0].detail as any).questions[0].options.some(
      (o: any) => o.label === ALLOW_FOR_CHAT,
    ),
  );
  manager.answer("thread_1", pending[0].requestId, {
    answers: { mcp_tool_call_approval_lookup: { answers: ["Allow"] } },
  });
  assert.deepEqual(reply(runtime, 1).result, {
    answers: { mcp_tool_call_approval_lookup: { answers: ["Allow"] } },
  });
  assert.equal(resolved(manager)[0].reason, "user");
});

test("ask mode asks for every row of the table", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "ask" });
  assert.equal(runtime.calls[0].params.approvalMode, undefined);
  ask(runtime, 1, [tool("crm", "lookup")]);
  ask(runtime, 2, [tool("crm", "update")]);
  ask(runtime, 3, [question("scope", ["A", "B (Recommended)"])]);
  ask(runtime, 4, [question("plan_approval", ["Approve", "Revise"])]);
  await tick();
  assert.equal(manager.snapshot("thread_1").pending.length, 4);
  assert.equal(runtime.replies.length, 0);
  const shown = manager.snapshot("thread_1").pending[0].detail as any;
  assert.deepEqual(
    shown.questions[0].options.map((o: any) => o.label),
    ["Allow", ALLOW_FOR_CHAT, "Allow for this session", "Cancel"],
  );
});

test("readOnly mode allows annotated read-only tools and asks for the rest", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "readOnly" });
  ask(runtime, 1, [tool("crm", "lookup")]);
  ask(runtime, 2, [tool("crm", "update")]);
  ask(runtime, 3, [question("scope", ["A", "B (Recommended)"])]);
  ask(runtime, 4, [question("plan_approval", ["Approve", "Revise"])]);
  ask(runtime, 5, [question("token", ["x"], { isSecret: true })]);
  // Found on the second page, qualified name.
  ask(runtime, 6, [
    {
      ...tool("docs", "search"),
      question: 'Allow the docs MCP server to run tool "mcp__docs__search"?',
    },
  ]);
  await tick();
  assert.deepEqual(reply(runtime, 1).result, {
    answers: { mcp_tool_call_approval_lookup: { answers: ["Allow"] } },
  });
  assert.deepEqual(
    reply(runtime, 6).result.answers.mcp_tool_call_approval_search.answers,
    ["Allow"],
  );
  validateResponse(RUI, reply(runtime, 1).result);
  assert.deepEqual(
    manager
      .snapshot("thread_1")
      .pending.map((p) => (p.detail as any).itemId)
      .sort(),
    ["call_2", "call_3", "call_4", "call_5"],
  );
  assert.deepEqual(
    resolved(manager).map((d) => d.reason),
    ["auto-mode:readOnly", "auto-mode:readOnly"],
  );
  // The auto-handled request was never shown.
  const requested = manager
    .records("thread_1")
    .map((r) => r.event)
    .filter((e) => e.type === "approval.requested");
  assert.equal(requested.length, 0);
  const call = runtime.calls.find((c) => c.method === "mcpServerStatus/list")!;
  assert.equal(call.params.threadId, "thread_1");
});

test("auto mode allows tools and answers questions; plan and secret questions ask", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "auto" });
  ask(runtime, 1, [tool("crm", "update")]);
  ask(runtime, 2, [question("scope", ["A", "B (Recommended)"])]);
  ask(runtime, 3, [question("plan_approval", ["Approve", "Revise"])]);
  ask(runtime, 4, [question("token", ["x"], { isSecret: true })]);
  await tick();
  assert.deepEqual(
    reply(runtime, 1).result.answers.mcp_tool_call_approval_update.answers,
    ["Allow"],
  );
  assert.equal(
    reply(runtime, 2).result.answers.scope.answers[0],
    "B (Recommended)",
  );
  validateResponse(RUI, reply(runtime, 2).result);
  assert.equal(manager.snapshot("thread_1").pending.length, 2);
  assert.deepEqual(
    resolved(manager).map((d) => d.reason),
    ["auto-mode:auto", "auto-mode:auto"],
  );
  // Auto mode needs no lookup.
  assert.equal(statusCalls(runtime), 0);
});

test("a request is auto-handled only when every question is", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "readOnly" });
  ask(runtime, 1, [tool("crm", "lookup"), tool("crm", "update")]);
  ask(runtime, 2, [tool("crm", "lookup"), tool("docs", "search")]);
  await tick();
  assert.equal(reply(runtime, 1), undefined);
  assert.deepEqual(Object.keys(reply(runtime, 2).result.answers).sort(), [
    "mcp_tool_call_approval_lookup",
    "mcp_tool_call_approval_search",
  ]);
  await manager.setApprovalMode("thread_1", "auto");
  ask(runtime, 3, [
    question("scope", ["A"]),
    question("plan_approval", ["Approve"]),
  ]);
  await tick();
  assert.ok(reply(runtime, 1));
  assert.equal(reply(runtime, 3), undefined);
});

test("switching mode answers requests that are already waiting", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "ask" });
  ask(runtime, 1, [tool("crm", "lookup")]);
  ask(runtime, 2, [tool("crm", "update")]);
  await tick();
  assert.equal(manager.snapshot("thread_1").pending.length, 2);
  assert.deepEqual(manager.setApprovalMode("thread_1", "readOnly"), {
    mode: "readOnly",
  });
  await tick();
  assert.ok(reply(runtime, 1));
  assert.equal(reply(runtime, 2), undefined);
  manager.setApprovalMode("thread_1", "auto");
  await tick();
  assert.ok(reply(runtime, 2));
  assert.deepEqual(
    resolved(manager).map((d) => d.reason),
    ["auto-mode:readOnly", "auto-mode:auto"],
  );
  assert.throws(
    () => manager.setApprovalMode("thread_1", "everything"),
    /Approval mode/,
  );
});

test("Allow for this chat sends Allow, is recorded, and allows the tool later in any mode", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "ask" });
  ask(runtime, 1, [tool("crm", "update")]);
  ask(runtime, 2, [tool("crm", "update", "mcp_tool_call_approval_second")]);
  await tick();
  const [first] = manager.snapshot("thread_1").pending;
  manager.answer("thread_1", first.requestId, {
    answers: { mcp_tool_call_approval_update: { answers: [ALLOW_FOR_CHAT] } },
  });
  await tick();
  assert.deepEqual(reply(runtime, 1).result, {
    answers: { mcp_tool_call_approval_update: { answers: ["Allow"] } },
  });
  validateResponse(RUI, reply(runtime, 1).result);
  const records = resolved(manager);
  assert.equal(records[0].reason, "user");
  assert.deepEqual(
    records[0].result.answers.mcp_tool_call_approval_update.answers,
    [ALLOW_FOR_CHAT],
  );
  // The waiting request for the same tool is covered by the new grant.
  assert.deepEqual(
    reply(runtime, 2).result.answers.mcp_tool_call_approval_second.answers,
    ["Allow"],
  );
  assert.equal(records[1].reason, "auto-mode:grant");
  ask(runtime, 3, [tool("crm", "update", "mcp_tool_call_approval_third")]);
  ask(runtime, 4, [tool("crm", "lookup")]);
  await tick();
  assert.ok(reply(runtime, 3));
  assert.equal(reply(runtime, 4), undefined);
  assert.equal(statusCalls(runtime), 0);
});

test("an unannotated or unknown tool asks; the heuristic only covers unannotated tools", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "readOnly" });
  ask(runtime, 1, [tool("crm", "get_orders")]);
  ask(runtime, 2, [tool("crm", "brand_new")]);
  await tick();
  assert.equal(runtime.replies.length, 0);
  // The unknown tool refreshed once.
  assert.equal(statusCalls(runtime), 2 * 2);
  const heuristic = fixture(t);
  await heuristic.manager.create({
    approvalMode: "readOnly",
    approvalNameHeuristic: true,
  });
  ask(heuristic.runtime, 1, [tool("crm", "get_orders")]);
  ask(heuristic.runtime, 2, [tool("crm", "listNotes")]);
  await tick();
  assert.ok(reply(heuristic.runtime, 1));
  assert.equal(reply(heuristic.runtime, 2), undefined);
});

test("a lookup failure asks and never allows", async (t) => {
  const { runtime, manager } = fixture(t);
  runtime.status = null;
  await manager.create({ approvalMode: "readOnly" });
  ask(runtime, 1, [tool("crm", "lookup")]);
  await tick();
  assert.equal(runtime.replies.length, 0);
  assert.equal(manager.snapshot("thread_1").pending.length, 1);
  const requested = manager
    .records("thread_1")
    .filter((r) => r.event.type === "approval.requested");
  assert.equal(requested.length, 0);
});

test("resume sets the mode without sending it to the runtime", async (t) => {
  const { runtime, manager } = fixture(t);
  runtime.request = async function (method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/resume")
      return { thread: { id: "thread_1", turns: [] } };
    return Fake.prototype.request.call(this, method, params);
  };
  await manager.resume("thread_1", {
    approvalMode: "auto",
    approvalNameHeuristic: false,
  });
  const resume = runtime.calls.find((c) => c.method === "thread/resume")!;
  assert.deepEqual(resume.params, { threadId: "thread_1" });
  ask(runtime, 1, [tool("crm", "update")]);
  await tick();
  assert.ok(reply(runtime, 1));
  await assert.rejects(
    manager.resume("thread_1", { approvalMode: "bad" }),
    /Approval mode/,
  );
});

test("helper threads keep today's answers in every mode", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ approvalMode: "auto" });
  runtime.emit("serverRequest", {
    id: 9,
    method: RUI,
    params: { threadId: "helper_1", questions: [tool("crm", "update")] },
  });
  await tick();
  assert.notDeepEqual(
    reply(runtime, 9).result.answers.mcp_tool_call_approval_update.answers,
    ["Allow"],
  );
});

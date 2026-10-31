import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { threadStartParams } from "../../src/codex/config";
import type { McpServerSpec } from "../../src/contract";
import {
  CodexProcess,
  type Notification,
  type ServerRequest,
} from "../../src/codex/rpc";
import { McpFixture } from "../support/mcp-fixture";
import {
  ModelFixture,
  sleep,
  type Behavior,
  type ModelRequest,
} from "../support/model-fixture";
import { TOKEN } from "../support/harness";

// Phase 0 of tasks/subagents-plan.md: Codex multi-agent V2 behaviour on the
// pin, observed directly. No adapter code uses V2 yet; these assertions are
// the facts the adapter will be built on. Each test uses its own lead
// thread, so agent trees never share a concurrency budget.

const LEAD_PROMPT = "PROBE_LEAD_PROMPT";
const HELPER_RULES = "PROBE_HELPER_RULES: you are a helper.";
const CHILD_RESULT = "PROBE_CHILD_RESULT: Acme, Globex, Initech.";

type Body = Record<string, unknown>;
type Item = Record<string, unknown>;

// A helper's request carries the task the lead sent it; the lead's never
// carries an agent_message authored by itself.
const isChild = (body: Body) =>
  ((body.input as Item[] | undefined) ?? []).some(
    (i) => i.type === "agent_message" && i.author === "/root",
  );
const inputItems = (body: Body) => (body.input as Item[] | undefined) ?? [];

const toolNames = (body: Body): string[] =>
  ((body.tools as Item[] | undefined) ?? []).flatMap((t) => {
    const inner = t.tools as Item[] | undefined;
    if (inner) return inner.map((i) => `${String(t.name)}.${String(i.name)}`);
    return [String(t.name ?? t.type)];
  });

const collab = (name: string, args: unknown): Behavior => ({
  kind: "call",
  name,
  namespace: "collaboration",
  args,
});

const spawn = (task: string, message = `PROBE_TASK ${task}`) =>
  collab("spawn_agent", { task_name: task, message, fork_turns: "none" });

describe("pinned Codex multi-agent V2", () => {
  const model = new ModelFixture();
  const mcp = new McpFixture();
  let root = "";
  let workspace = "";
  let codex: CodexProcess;
  const notes: Notification[] = [];
  const serverRequests: ServerRequest[] = [];

  before(async () => {
    await model.start();
    await mcp.start();
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-subagents-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    const { codexBinary } = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: root,
      // A worktree without its own Codex build can use another checkout's.
      ...(process.env.RUNTIME_CODEX_BINARY
        ? { RUNTIME_CODEX_BINARY: process.env.RUNTIME_CODEX_BINARY }
        : {}),
    });
    codex = new CodexProcess({
      binary: codexBinary,
      home: root,
      workspace,
      rpcMs: 10_000,
    });
    codex.setListener((n) => notes.push(n));
    codex.setRequestHandler((r) => {
      serverRequests.push(r);
      return false;
    });
    await codex.initialize();
  });

  after(async () => {
    await codex.stop();
    await mcp.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  });

  async function startLead(
    maxConcurrent: number,
    servers: McpServerSpec[] = [],
    extra: Record<string, unknown> = {},
  ) {
    const params = threadStartParams(
      {
        modelName: "fixture-model",
        gatewayUrl: model.url,
        gatewayToken: model.token,
        contextWindow: 100_000,
        autoCompactTokenLimit: 80_000,
      },
      LEAD_PROMPT,
      workspace,
      servers,
    );
    const started = await codex.request<{ thread: { id: string } }>(
      "thread/start",
      {
        ...params,
        config: {
          ...params.config,
          "features.multi_agent_v2": {
            enabled: true,
            max_concurrent_threads_per_session: maxConcurrent,
            subagent_developer_instructions: HELPER_RULES,
          },
          ...extra,
        },
      },
    );
    return started.thread.id;
  }

  async function until(check: () => boolean, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(20);
    return check();
  }

  async function startTurn(threadId: string, text: string) {
    const r = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    return r.turn.id;
  }

  const completed = (threadId: string, turnId?: string) =>
    notes.find(
      (n) =>
        n.method === "turn/completed" &&
        n.params.threadId === threadId &&
        (!turnId || (n.params.turn as { id: string }).id === turnId),
    );

  // Child thread ids of a lead, from its subAgentActivity items.
  const childrenOf = (leadId: string) => [
    ...new Set(
      notes
        .filter((n) => n.params.threadId === leadId)
        .map((n) => n.params.item as Item | undefined)
        .filter((i) => i?.type === "subAgentActivity")
        .map((i) => String(i!.agentThreadId)),
    ),
  ];

  // A lead router: the lead's requests are answered in order by `lead`, a
  // helper's by `child`. Returns the requests each side made.
  function route(lead: Behavior[], child: (body: Body) => Behavior) {
    const seen = { lead: [] as ModelRequest["body"][], child: [] as Body[] };
    model.router = (body) => {
      if (isChild(body)) {
        seen.child.push(body);
        return child(body);
      }
      seen.lead.push(body);
      return lead.shift() ?? { kind: "reply", text: "lead done" };
    };
    return seen;
  }

  test("spawn, child stream, wait and result", async () => {
    const leadId = await startLead(2);
    const seen = route(
      [spawn("deals"), collab("wait_agent", { timeout_ms: 15_000 })],
      () => ({ kind: "reply", text: CHILD_RESULT }),
    );
    const turnId = await startTurn(leadId, "find my deals");
    assert.ok(await until(() => !!completed(leadId, turnId)), "lead finished");
    model.router = undefined;

    // The lead is offered exactly the V2 collaboration tools and the plan
    // checklist.
    assert.deepEqual(toolNames(seen.lead[0]!).sort(), [
      "collaboration.followup_task",
      "collaboration.interrupt_agent",
      "collaboration.list_agents",
      "collaboration.send_message",
      "collaboration.spawn_agent",
      "collaboration.wait_agent",
      "update_plan",
    ]);
    // A depth-1 helper on the fixture model gets only the plan checklist it
    // inherits from the lead's config: no shell, no files and no
    // collaboration tools (no nesting). Its plan updates arrive on its own
    // thread, which the adapter does not relay.
    assert.equal(seen.child.length, 1);
    assert.deepEqual(toolNames(seen.child[0]!), ["update_plan"]);

    // The helper inherits the lead's base prompt, then the helper rules.
    const childDev = inputItems(seen.child[0]!)
      .filter((i) => i.role === "developer")
      .map((i) => JSON.stringify(i.content));
    assert.ok(childDev[0]!.includes(LEAD_PROMPT));
    assert.ok(childDev[1]!.includes("PROBE_HELPER_RULES"));
    // fork_turns "none": the member's message does not reach the helper.
    assert.ok(!JSON.stringify(seen.child[0]).includes("find my deals"));

    // The task arrives as an agent_message whose payload is plain text in
    // `encrypted_content`; the answer comes back the same way, as plain text.
    const task = inputItems(seen.child[0]!).find(
      (i) => i.type === "agent_message",
    );
    assert.ok(
      JSON.stringify(task).includes('"encrypted_content":"PROBE_TASK deals"'),
    );
    const answer = inputItems(seen.lead.at(-1)!).find(
      (i) => i.type === "agent_message",
    );
    assert.ok(JSON.stringify(answer).includes(CHILD_RESULT));
    assert.equal(answer!.author, "/root/deals");

    // No thread/started is emitted for the child (only the lead's), so
    // `source.thread_spawn` is never seen. The only link from child to lead
    // is the lead's subAgentActivity item (agentThreadId, agentPath).
    const [childId] = childrenOf(leadId);
    assert.ok(childId);
    assert.equal(
      notes.find(
        (n) =>
          n.method === "thread/started" &&
          (n.params.thread as { id: string }).id === childId,
      ),
      undefined,
    );
    const activity = notes
      .filter(
        (n) => n.params.threadId === leadId && n.method === "item/completed",
      )
      .map((n) => n.params.item as Item)
      .filter((i) => i.type === "subAgentActivity");
    assert.deepEqual(
      activity.map((i) => [i.kind, i.agentPath]),
      [
        ["started", "/root/deals"],
        ["completed", "/root/deals"],
      ],
    );

    // The child streams on the same connection under its own thread and
    // turn, including its own token usage (dropped by today's turn filter).
    const childUsage = notes.filter(
      (n) =>
        n.method === "thread/tokenUsage/updated" &&
        n.params.threadId === childId,
    );
    assert.ok(childUsage.length >= 1);
    assert.notEqual(childUsage[0]!.params.turnId, turnId);
    assert.ok(completed(childId!), "child turn/completed is emitted");
    // Nothing asked the client anything.
    assert.equal(serverRequests.length, 0);
  });

  test("the concurrency cap is a model-visible error, not a crash", async () => {
    const leadId = await startLead(2); // root counts: one helper
    const seen = route([spawn("a"), spawn("b")], () => ({
      kind: "hangAfterCreated",
    }));
    const turnId = await startTurn(leadId, "two helpers");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    model.router = undefined;
    const outputs = inputItems(seen.lead.at(-1)!)
      .filter((i) => i.type === "function_call_output")
      .map((i) => JSON.stringify(i.output));
    assert.equal(outputs.length, 2);
    assert.ok(!/limit|maximum|too many/i.test(outputs[0]!), outputs[0]);
    assert.ok(
      /limit|maximum|too many|concurren/i.test(outputs[1]!),
      outputs[1],
    );
    assert.equal(childrenOf(leadId).length, 1);
    for (const child of childrenOf(leadId))
      await codex
        .request("thread/archive", { threadId: child })
        .catch(() => {});
  });

  test("a helper outlives the lead's turn, and its late answer is lost", async () => {
    const leadId = await startLead(2);
    const seen = route(
      [spawn("slow"), { kind: "reply", text: "answered early" }],
      () => ({
        kind: "reply",
        text: CHILD_RESULT,
        chunk: 4,
        delayMs: 60,
      }),
    );
    const turnId = await startTurn(leadId, "do not wait");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    const [childId] = childrenOf(leadId);
    assert.ok(childId);
    // The lead's turn ended while the helper was still writing.
    assert.equal(
      completed(childId!),
      undefined,
      "child still running at lead end",
    );
    assert.ok(
      await until(() => !!completed(childId!)),
      "child finished on its own",
    );
    await sleep(500);
    // Its answer did not start a lead turn on its own.
    const leadTurns = notes.filter(
      (n) => n.method === "turn/started" && n.params.threadId === leadId,
    );
    assert.equal(leadTurns.length, 1);

    // The next member message picks the stale answer up.
    const leadBefore = seen.lead.length;
    const next = await startTurn(leadId, "next question");
    assert.ok(await until(() => !!completed(leadId, next)));
    model.router = undefined;
    const nextInput = JSON.stringify(seen.lead.slice(leadBefore));
    // Observed: the late answer does NOT reach the next reply; it is absent
    // from the lead's history, so a helper that outlives its reply is billed
    // work nobody sees.
    assert.ok(
      !nextInput.includes(CHILD_RESULT),
      "late answer is not delivered",
    );
    // The lead IS told, but late: a subAgentActivity "completed" item arrives
    // on the lead thread after its turn/completed, still tagged with that
    // finished turn's id. Today's adapter ignores it (run already settled).
    const leadDoneAt = notes.indexOf(completed(leadId, turnId)!);
    const lateDone = notes.findIndex(
      (n) =>
        n.params.threadId === leadId &&
        n.method === "item/completed" &&
        (n.params.item as Item | undefined)?.type === "subAgentActivity" &&
        (n.params.item as Item).kind === "completed",
    );
    assert.ok(
      lateDone > leadDoneAt,
      "completion arrives after the lead's turn ended",
    );
    assert.equal(
      notes[lateDone]!.params.turnId,
      turnId,
      "tagged with the finished turn",
    );
    // The child's own agentMessage item carries the result text, so the
    // adapter can read a helper's result from the child stream directly.
    assert.ok(
      notes.some(
        (n) =>
          n.params.threadId === childId &&
          n.method === "item/completed" &&
          (n.params.item as Item).type === "agentMessage" &&
          (n.params.item as Item).text === CHILD_RESULT,
      ),
    );
  });

  test("interrupting the lead does not stop its helper; interrupt + archive on the child does", async () => {
    const leadId = await startLead(2);
    route(
      [spawn("stuck"), collab("wait_agent", { timeout_ms: 60_000 })],
      () => ({
        kind: "hangAfterCreated",
      }),
    );
    const turnId = await startTurn(leadId, "stuck helper");
    assert.ok(await until(() => childrenOf(leadId).length === 1));
    const [childId] = childrenOf(leadId);
    const childTurn = () =>
      notes.find(
        (n) => n.method === "turn/started" && n.params.threadId === childId,
      );
    assert.ok(await until(() => !!childTurn()));
    await sleep(300);

    await codex.request("turn/interrupt", { threadId: leadId, turnId });
    assert.ok(await until(() => !!completed(leadId, turnId)), "lead stops");
    await sleep(500);
    assert.equal(completed(childId!), undefined, "child keeps running");

    const childTurnId = (childTurn()!.params.turn as { id: string }).id;
    await codex.request("turn/interrupt", {
      threadId: childId,
      turnId: childTurnId,
    });
    assert.ok(
      await until(() => !!completed(childId!)),
      "child stops on its own interrupt",
    );
    const status = (completed(childId!)!.params.turn as { status?: string })
      .status;
    assert.equal(status, "interrupted");
    await codex.request("thread/archive", { threadId: childId });
    const after = notes.length;
    await sleep(500);
    assert.ok(
      !notes
        .slice(after)
        .some(
          (n) => n.params.threadId === childId && n.method.startsWith("item/"),
        ),
      "no child items after archive",
    );
    model.router = undefined;
  });

  test("a helper gets the lead's connector tools and calls them itself", async () => {
    mcp.reset();
    const servers: McpServerSpec[] = [
      {
        name: "fixture",
        url: mcp.url,
        headers: { Authorization: "Bearer probe-token" },
        toolTimeoutSec: 30,
        startupTimeoutSec: 15,
      },
    ];
    const leadId = await startLead(2, servers);
    let childCalls = 0;
    const seen = route(
      [spawn("issue"), collab("wait_agent", { timeout_ms: 15_000 })],
      () =>
        childCalls++ === 0
          ? {
              kind: "call",
              name: "get_issue",
              namespace: "mcp__fixture",
              args: { number: 1 },
            }
          : { kind: "reply", text: CHILD_RESULT },
    );
    const turnId = await startTurn(leadId, "read issue 1");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    model.router = undefined;
    const childTools = toolNames(seen.child[0]!);
    assert.ok(
      childTools.some((t) => t.startsWith("mcp__fixture")),
      `child tools: ${childTools.join(", ")}`,
    );
    assert.ok(
      mcp.toolCalls() >= 1,
      "the helper's read-only call reached the server",
    );
    const [childId] = childrenOf(leadId);
    // Each helper starts its own MCP connections and reports their startup
    // under its own thread id; the adapter must not show them as the lead's.
    const childMcpStatus = notes.filter(
      (n) =>
        n.method === "mcpServer/startupStatus/updated" &&
        n.params.threadId === childId,
    );
    assert.ok(
      childMcpStatus.length >= 1,
      "child reports its own connector startup",
    );
  });

  test("a helper's write tool raises an approval tagged with the helper's thread", async () => {
    mcp.reset();
    const before = serverRequests.length;
    const servers: McpServerSpec[] = [
      {
        name: "fixture",
        url: mcp.url,
        headers: { Authorization: "Bearer probe-token" },
        toolTimeoutSec: 30,
        startupTimeoutSec: 15,
      },
    ];
    const leadId = await startLead(2, servers);
    let childCalls = 0;
    route([spawn("write"), collab("wait_agent", { timeout_ms: 15_000 })], () =>
      childCalls++ === 0
        ? {
            kind: "call",
            name: "create_issue",
            namespace: "mcp__fixture",
            args: { title: "x" },
          }
        : { kind: "reply", text: CHILD_RESULT },
    );
    const turnId = await startTurn(leadId, "file an issue");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    model.router = undefined;
    const [childId] = childrenOf(leadId);
    const asks = serverRequests.slice(before);
    assert.equal(asks.length, 1, asks.map((r) => r.method).join(","));
    assert.equal(asks[0]!.method, "mcpServer/elicitation/request");
    // The approval names the helper's thread and turn, never the lead's, so
    // the adapter can tell a helper write apart and decline it.
    assert.equal(asks[0]!.params.threadId, childId);
    assert.notEqual(asks[0]!.params.turnId, turnId);
    // Unanswered (the client said "not supported"), the write never ran.
    assert.equal(mcp.toolCalls(), 0);
  });

  test("a finished helper frees its slot: one reply can spawn again and again", async () => {
    const leadId = await startLead(2); // one helper at a time
    const seen = route(
      [
        spawn("first"),
        collab("wait_agent", { timeout_ms: 15_000 }),
        spawn("second"),
        collab("wait_agent", { timeout_ms: 15_000 }),
        spawn("third"),
        collab("wait_agent", { timeout_ms: 15_000 }),
      ],
      () => ({ kind: "reply", text: CHILD_RESULT }),
    );
    const turnId = await startTurn(leadId, "one after another");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    model.router = undefined;
    // close_agent is not offered, yet a completed helper releases its slot,
    // so the cap bounds helpers running at once, not helpers per reply. A
    // total per-run limit has to come from the adapter.
    assert.ok(!toolNames(seen.lead[0]!).includes("collaboration.close_agent"));
    const outputs = inputItems(seen.lead.at(-1)!)
      .filter((i) => i.type === "function_call_output")
      .map((i) => JSON.stringify(i.output));
    assert.ok(
      outputs.every((o) => !/limit|maximum|too many|concurren/i.test(o)),
      outputs.join(" | "),
    );
    assert.equal(childrenOf(leadId).length, 3);
    for (const child of childrenOf(leadId))
      await codex
        .request("thread/archive", { threadId: child })
        .catch(() => {});
  });

  test("fork_turns none sends only the task; all resends the whole chat", async () => {
    const sizes: Record<string, number> = {};
    for (const fork of ["none", "all"]) {
      const leadId = await startLead(2);
      model.router = undefined;
      const first = await startTurn(
        leadId,
        "PROBE_HISTORY " + "x".repeat(20_000),
      );
      assert.ok(await until(() => !!completed(leadId, first)));
      const seen = route(
        [
          collab("spawn_agent", {
            task_name: `f${fork}`,
            message: "PROBE_TASK fork",
            fork_turns: fork,
          }),
          collab("wait_agent", { timeout_ms: 15_000 }),
        ],
        () => ({ kind: "reply", text: CHILD_RESULT }),
      );
      const turnId = await startTurn(leadId, "now delegate");
      assert.ok(await until(() => !!completed(leadId, turnId)));
      model.router = undefined;
      const raw = JSON.stringify(seen.child[0]);
      sizes[fork] = raw.length;
      // Both forms carry the lead's base prompt and the helper rules.
      assert.ok(
        raw.includes(LEAD_PROMPT) && raw.includes("PROBE_HELPER_RULES"),
      );
      assert.equal(raw.includes("PROBE_HISTORY"), fork === "all");
      assert.equal(raw.includes("now delegate"), fork === "all");
    }
    // Every helper spawned with "all" pays for the whole chat again.
    assert.ok(sizes.all! > sizes.none! + 20_000, JSON.stringify(sizes));
  });

  test("rollout_budget is shared by the tree and fails every turn when spent", async () => {
    const leadId = await startLead(2, [], {
      "features.rollout_budget": {
        enabled: true,
        limit_tokens: 50,
        reminder_at_remaining_tokens: [10],
      },
    });
    const seen = route(
      [spawn("budget"), collab("wait_agent", { timeout_ms: 15_000 })],
      () => ({ kind: "reply", text: CHILD_RESULT }),
    );
    const turnId = await startTurn(leadId, "spend tokens");
    assert.ok(await until(() => !!completed(leadId, turnId)));
    const [childId] = childrenOf(leadId);
    assert.ok(childId && (await until(() => !!completed(childId))));
    model.router = undefined;
    for (const id of [leadId, childId!]) {
      const turn = completed(id)!.params.turn as {
        status: string;
        error?: { codexErrorInfo?: string };
      };
      assert.equal(turn.status, "failed");
      assert.equal(turn.error?.codexErrorInfo, "sessionBudgetExceeded");
    }
    // The model is told its remaining budget in a <rollout_budget> block.
    assert.ok(
      seen.lead
        .concat(seen.child)
        .some((b) => JSON.stringify(b).includes("<rollout_budget>")),
    );
    // Upstream marks it under development.
    assert.ok(
      notes.some(
        (n) =>
          n.method === "warning" &&
          n.params.threadId === leadId &&
          String(n.params.message).includes("rollout_budget"),
      ),
    );
  });
});

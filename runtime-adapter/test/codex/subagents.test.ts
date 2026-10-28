import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  Harness,
  completed,
  readSse,
  runAnswering,
  streamedText,
  type SseEvent,
} from "../support/harness";
import { McpFixture } from "../support/mcp-fixture";
import { sleep, type Behavior } from "../support/model-fixture";

// Helper agents through the adapter on the real pinned Codex. The engine's
// own behaviour is pinned in subagents-probe.test.ts; this covers what the
// adapter adds: routing, billing, settling, stopping and the write rule.

type Item = Record<string, unknown>;

const CHILD_RESULT = "HELPER_RESULT_MARKER Acme, Globex.";
const CONNECTOR = "fixture";
const NAMESPACE = `mcp__${CONNECTOR}`;

// A helper's request carries the task the lead sent it.
const isChild = (body: Record<string, unknown>) =>
  ((body.input as Item[] | undefined) ?? []).some(
    (i) => i.type === "agent_message" && i.author === "/root",
  );

const collab = (name: string, args: unknown): Behavior => ({
  kind: "call",
  name,
  namespace: "collaboration",
  args,
});
const spawn = (task: string) =>
  collab("spawn_agent", {
    task_name: task,
    message: `Task ${task}`,
    fork_turns: "none",
  });
const wait = () => collab("wait_agent", { timeout_ms: 15_000 });

function mcpSpec(fixture: McpFixture, approvedTools?: string[]) {
  return [
    {
      name: CONNECTOR,
      url: fixture.url,
      headers: { Authorization: "Bearer helper-test-token" },
      toolTimeoutSec: 30,
      startupTimeoutSec: 15,
      ...(approvedTools ? { approvedTools } : {}),
    },
  ];
}

const ofType = (events: SseEvent[], type: string) =>
  events.filter((e) => e.type === type).map((e) => e.data);

describe("helper agents (real Codex)", () => {
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  const mcp = new McpFixture();
  let chat = 0;

  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  // Each test gets its own chat, so no thread or helper tree is shared.
  function body(overrides: Record<string, unknown> = {}) {
    chat += 1;
    return h.body({
      chatId: `helpers${chat}`,
      subAgents: { maxConcurrent: 2 },
      ...overrides,
    });
  }

  function route(lead: Behavior[], child: () => Behavior) {
    const seen = { lead: 0, child: 0 };
    h.model.router = (b) => {
      if (isChild(b)) {
        seen.child += 1;
        return child();
      }
      seen.lead += 1;
      return lead.shift() ?? { kind: "reply", text: "lead answer" };
    };
    return seen;
  }

  const logs = (event: string) =>
    h.logs.filter((l) => l.event === event).map((l) => l.fields);

  async function until(check: () => boolean, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(20);
    return check();
  }

  test("a helper's work is billed with the lead's, and only the lead's text is shown", async () => {
    const before = h.model.requests.length;
    const seen = route([spawn("deals"), wait()], () => ({
      kind: "reply",
      text: CHILD_RESULT,
    }));
    const events = await h.run(body());
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.equal(seen.child, 1);
    // The helper's answer is never the lead's text: it reaches the member
    // only as the helper's own bounded result.
    assert.equal(streamedText(events), "lead answer");
    assert.ok(
      !JSON.stringify(ofType(events, "item.completed")).includes(
        "HELPER_RESULT_MARKER",
      ),
    );
    assert.ok(
      !JSON.stringify(done.items).includes("HELPER_RESULT_MARKER"),
      "helper text is not a reply item",
    );
    const started = ofType(events, "agent.started");
    assert.equal(started.length, 1);
    assert.equal(started[0]!.path, "/root/deals");
    const finished = ofType(events, "agent.completed");
    assert.equal(finished.length, 1);
    assert.equal(finished[0]!.agentId, started[0]!.agentId);
    assert.equal(finished[0]!.status, "completed");
    assert.equal(finished[0]!.result, CHILD_RESULT);
    assert.equal(
      (finished[0]!.usage as { totalTokens: number }).totalTokens,
      30,
    );
    // The outcome carries the helpers too, for saving and reconnects.
    const agents = done.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.status, "completed");
    assert.equal(agents[0]!.result, CHILD_RESULT);
    // Every fixture response costs 30 tokens: the turn sums lead and helper.
    const calls = h.model.requests.length - before;
    const usage = done.usage as { turn: { totalTokens: number } };
    assert.equal(usage.turn.totalTokens, 30 * calls);
    assert.ok(calls > seen.lead, "the helper's call is in the count");
  });

  test("a helper still working when the lead answers is stopped before the run settles", async () => {
    const started = Date.now();
    route([spawn("slow"), { kind: "reply", text: "answered early" }], () => ({
      kind: "hangAfterCreated",
    }));
    const events = await h.run(body());
    h.model.router = undefined;
    assert.equal(completed(events).status, "completed");
    assert.ok(Date.now() - started < 10_000, "no long wait on a hung helper");
    const finished = logs("subagent_finished");
    assert.equal(finished.at(-1)?.status, "stopped");
    // Reported to the member before the run's last event.
    const agentDone = ofType(events, "agent.completed");
    assert.equal(agentDone.length, 1);
    assert.equal(agentDone[0]!.status, "stopped");
    assert.equal(
      (completed(events).agents as Array<{ status: string }>)[0]!.status,
      "stopped",
    );
  });

  test("stopping the run stops its helpers", async () => {
    route([spawn("stuck"), wait()], () => ({ kind: "hangAfterCreated" }));
    const b = body();
    const res = await h.post("/v1/runs", b);
    assert.equal(res.status, 200);
    const stream = readSse(res);
    const startedBefore = logs("subagent_started").length;
    assert.ok(
      await until(() => logs("subagent_started").length > startedBefore),
    );
    await sleep(300);
    await h.stop(String(b.runId), {
      tenantId: "tenant1",
      chatId: String(b.chatId),
    });
    const events = await stream;
    h.model.router = undefined;
    assert.equal(completed(events).status, "stopped");
    assert.ok(
      await until(() => logs("subagent_finished").at(-1)?.status === "stopped"),
    );
  });

  test("a helper's write is declined and never runs", async () => {
    mcp.reset();
    let childCalls = 0;
    route([spawn("write"), wait()], () =>
      childCalls++ === 0
        ? {
            kind: "call",
            name: "create_issue",
            namespace: NAMESPACE,
            args: { title: "x" },
          }
        : { kind: "reply", text: CHILD_RESULT },
    );
    const events = await h.run(body({ mcp: mcpSpec(mcp) }));
    h.model.router = undefined;
    assert.equal(completed(events).status, "completed");
    assert.equal(ofType(events, "approval.requested").length, 0);
    assert.ok(
      logs("approval_declined").some((l) => l.reason === "helper_write"),
    );
    assert.equal(mcp.toolCalls(), 0);
  });

  test("after a helper ran, a write allowed for the chat still asks", async () => {
    mcp.reset();
    route(
      [
        spawn("read"),
        wait(),
        {
          kind: "call",
          name: "create_issue",
          namespace: NAMESPACE,
          args: { title: "x" },
        },
      ],
      () => ({ kind: "reply", text: CHILD_RESULT }),
    );
    const { events } = await runAnswering(
      h,
      body({ mcp: mcpSpec(mcp, ["create_issue"]) }),
      () => "deny",
    );
    h.model.router = undefined;
    assert.deepEqual(
      ofType(events, "approval.requested").map((a) => a.tool),
      ["create_issue"],
    );
    assert.equal(mcp.toolCalls(), 0);
  });

  test("a reply that starts too many helpers fails with SUBAGENT_LIMIT", async () => {
    const lead: Behavior[] = [];
    for (let i = 0; i < 8; i += 1) lead.push(spawn(`h${i}`), wait());
    route(lead, () => ({ kind: "reply", text: CHILD_RESULT }));
    const events = await h.run(body({ subAgents: { maxConcurrent: 1 } }));
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "failed");
    assert.equal((done.error as { code: string }).code, "SUBAGENT_LIMIT");
    assert.ok(logs("subagent_limit").length >= 1);
  });

  test("a helper stopped at the end of one reply does not hold a slot in the next", async () => {
    const b1 = body({ subAgents: { maxConcurrent: 1 } });
    route([spawn("first"), { kind: "reply", text: "early" }], () => ({
      kind: "hangAfterCreated",
    }));
    const first = await h.run(b1);
    assert.equal(completed(first).status, "completed");
    assert.equal(ofType(first, "agent.completed")[0]!.status, "stopped");
    // Same chat, same thread, a cap of one: the stopped helper must be gone.
    const seen = route([spawn("second"), wait()], () => ({
      kind: "reply",
      text: CHILD_RESULT,
    }));
    const second = await h.run(
      h.body({
        chatId: b1.chatId,
        threadId: completed(first).threadId,
        subAgents: { maxConcurrent: 1 },
      }),
    );
    h.model.router = undefined;
    assert.equal(completed(second).status, "completed");
    assert.equal(seen.child, 1, "the second helper ran");
    const done = ofType(second, "agent.completed");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.status, "completed");
  });

  test("helpers turned on for an existing chat work on the resumed thread", async () => {
    chat += 1;
    const chatId = `helpers${chat}`;
    h.model.router = undefined;
    const first = await h.run(h.body({ chatId }));
    assert.equal(completed(first).status, "completed");
    const seen = route([spawn("later"), wait()], () => ({
      kind: "reply",
      text: CHILD_RESULT,
    }));
    const second = await h.run(
      h.body({
        chatId,
        threadId: completed(first).threadId,
        subAgents: { maxConcurrent: 2 },
      }),
    );
    h.model.router = undefined;
    assert.equal(completed(second).status, "completed");
    assert.equal(seen.child, 1);
    assert.equal(ofType(second, "agent.completed")[0]!.status, "completed");
    // And off again: the next reply offers no collaboration tools.
    await h.run(h.body({ chatId, threadId: completed(first).threadId }));
    assert.ok(
      !JSON.stringify(h.model.lastRequest().body.tools ?? []).includes(
        "spawn_agent",
      ),
    );
  });

  test("without subAgents the lead is offered no collaboration tools", async () => {
    h.model.router = undefined;
    const events = await h.run(h.body({ chatId: "nohelpers" }));
    const tools = JSON.stringify(h.model.lastRequest().body.tools ?? []);
    assert.ok(!tools.includes("spawn_agent"));
    // And its outcome is shaped exactly as before.
    assert.equal("agents" in completed(events), false);
    assert.equal(ofType(events, "agent.started").length, 0);
  });

  test("a helper's plan stays on its own thread and never becomes the lead's", async () => {
    let childCalls = 0;
    const seen = route([spawn("plans"), wait()], () =>
      ++childCalls === 1
        ? {
            kind: "call",
            name: "update_plan",
            args: { plan: [{ step: "HELPER_STEP", status: "in_progress" }] },
          }
        : { kind: "reply", text: CHILD_RESULT },
    );
    const events = await h.run(body());
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.ok(seen.child >= 2, "the helper called update_plan, then replied");
    assert.deepEqual(ofType(events, "plan.updated"), []);
    assert.ok(!("plan" in done), "no plan on the lead's outcome");
    assert.ok(!JSON.stringify(events).includes("HELPER_STEP"));
  });
});

// Codex-exact design, Option B (tasks/subagents-research/06-codex-exact-design.md):
// coding and helpers run together in one shared workspace. A helper may read
// and write files / run commands in the sandbox like the lead; only a helper's
// MCP connector write still asks (and is declined). This block is the GO/NO-GO
// probe for the pin — it is the first time coding + multi_agent_v2 run together
// — and a durable regression test for the two guarantees.
describe("helper agents on a coding runtime (real Codex)", () => {
  const h = new Harness({
    coding: true,
    allowLoopbackMcp: true,
    limits: { stopMs: 3000 },
  });
  const mcp = new McpFixture();
  let chat = 0;

  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  const workspaceFile = (chatId: string, name: string) =>
    join(h.stateDir, "t", "tenant1", "c", chatId, "workspace", name);

  function body(overrides: Record<string, unknown> = {}) {
    chat += 1;
    return h.body({
      chatId: `codehelp${chat}`,
      subAgents: { maxConcurrent: 2 },
      ...overrides,
    });
  }

  // Lead and child each answered from their own queue; anything past the queue
  // is a plain reply, so an extra turn never hangs the run.
  function route(lead: Behavior[], child: Behavior[]) {
    const seen = { lead: 0, child: 0 };
    h.model.router = (b) => {
      if (isChild(b)) {
        seen.child += 1;
        return child.shift() ?? { kind: "reply", text: CHILD_RESULT };
      }
      seen.lead += 1;
      return lead.shift() ?? { kind: "reply", text: "lead done" };
    };
    return seen;
  }

  const exec = (cmd: string): Behavior => ({
    kind: "call",
    name: "exec_command",
    args: { cmd },
  });
  const addFile = (name: string, text: string): Behavior => ({
    kind: "custom",
    name: "apply_patch",
    input: `*** Begin Patch\n*** Add File: ${name}\n+${text}\n*** End Patch\n`,
  });

  test("a helper writes a file in the shared workspace and the lead reads it", async () => {
    const b = body();
    const chatId = String(b.chatId);
    // Lead spawns a writer, waits for it, then reads the file the helper wrote
    // (proving one shared cwd), then answers.
    route(
      [
        spawn("writer"),
        wait(),
        exec("cat shared.txt"),
        { kind: "reply", text: "lead saw it" },
      ],
      [
        addFile("shared.txt", "HELPER_WROTE_THIS"),
        { kind: "reply", text: CHILD_RESULT },
      ],
    );
    const events = await h.run(b);
    h.model.router = undefined;
    const done = completed(events);

    // The gate is gone: a helper ran under coding, no SUBAGENTS_DISABLED.
    assert.equal(done.status, "completed", JSON.stringify(done.error));
    assert.equal(ofType(events, "agent.started").length, 1);
    assert.equal(ofType(events, "agent.completed")[0]?.status, "completed");

    // Shared filesystem: the helper's file is in the lead's workspace.
    assert.equal(
      await readFile(workspaceFile(chatId, "shared.txt"), "utf8"),
      "HELPER_WROTE_THIS\n",
    );
    // And the lead could read it in the same workspace (its cat saw the text).
    const leadInput = JSON.stringify(h.model.lastRequest().body.input ?? []);
    assert.ok(
      leadInput.includes("HELPER_WROTE_THIS"),
      "the lead's cat returned the helper's file content",
    );
    // The helper's tokens are billed on the run.
    const usage = done.usage as { turn: { totalTokens: number } };
    assert.ok(usage.turn.totalTokens >= 30, "run usage includes the helper");
  });

  test("a helper may write a file but its MCP connector write is declined", async () => {
    const before = mcp.log.length;
    const logFrom = h.logs.length;
    const b = body({ mcp: mcpSpec(mcp) });
    const chatId = String(b.chatId);
    route(
      [spawn("worker"), wait(), { kind: "reply", text: "lead done" }],
      [
        // Allowed: a file write in the sandbox.
        addFile("draft.md", "SECTION_FROM_HELPER"),
        // Declined: an external connector write.
        {
          kind: "call",
          name: "create_issue",
          namespace: NAMESPACE,
          args: { title: "from helper" },
        },
        { kind: "reply", text: CHILD_RESULT },
      ],
    );
    const events = await h.run(b);
    h.model.router = undefined;
    const done = completed(events);
    assert.equal(done.status, "completed", JSON.stringify(done.error));

    // The helper's file write landed.
    assert.equal(
      await readFile(workspaceFile(chatId, "draft.md"), "utf8"),
      "SECTION_FROM_HELPER\n",
    );
    // The helper's MCP write never reached the connector.
    const created = mcp.log
      .slice(before)
      .filter((r) => r.rpcMethod === "tools/call" && r.tool === "create_issue");
    assert.equal(created.length, 0, "the helper's create_issue never ran");
    // And it was declined as a helper write, not some other reason.
    const declines = h.logs
      .slice(logFrom)
      .filter(
        (l) =>
          l.event === "approval_declined" && l.fields.reason === "helper_write",
      );
    assert.ok(declines.length >= 1, "the helper write was declined");
  });

  test("a helper's publishing command (git push) is declined, not run", async () => {
    const logFrom = h.logs.length;
    const b = body();
    route(
      [spawn("pusher"), wait(), { kind: "reply", text: "lead done" }],
      [exec("git push origin main"), { kind: "reply", text: CHILD_RESULT }],
    );
    const events = await h.run(b);
    h.model.router = undefined;
    assert.equal(completed(events).status, "completed");
    // The command reached a coding approval from the child thread and was
    // declined with the helper reason (not the generic other_turn).
    const declines = h.logs
      .slice(logFrom)
      .filter((l) => l.event === "approval_declined")
      .map((l) => l.fields.reason);
    assert.ok(
      declines.includes("helper_command"),
      `expected helper_command, saw ${JSON.stringify(declines)}`,
    );
  });

  test("the lead is offered the coding tools and the collaboration tools together", async () => {
    const b = body();
    route([{ kind: "reply", text: "ok" }], []);
    await h.run(b);
    h.model.router = undefined;
    const names = (
      (h.model.lastRequest().body.tools as Array<Record<string, unknown>>) ?? []
    ).flatMap((t) => {
      const inner = t.tools as Array<Record<string, unknown>> | undefined;
      if (inner) return inner.map((i) => `${String(t.name)}.${String(i.name)}`);
      return [`${String(t.type)}:${String(t.name)}`];
    });
    // Both families are present in one request (what the gateway must forward).
    assert.ok(
      names.some((n) => n.includes("apply_patch")),
      `coding tool present: ${JSON.stringify(names)}`,
    );
    assert.ok(
      names.includes("collaboration.spawn_agent"),
      `spawn_agent present: ${JSON.stringify(names)}`,
    );
  });
});

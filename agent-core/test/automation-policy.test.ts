import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadManager } from "../src/manager";
import { CodexClient } from "../src/client";
import { BusinessRuntime } from "../src/business-runtime";

const policy = {
  automationId: "auto_1",
  runId: "run_1",
  revision: 1,
  promptRef: "prompt_1",
};
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  replies: any[] = [];
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "root_1" } };
    if (method === "turn/start") return { turn: { id: "turn_1" } };
    return {};
  }
  respond(id: any, result: any) {
    this.replies.push({ id, result });
  }
}
function fixture(t: any) {
  const home = mkdtempSync(join(tmpdir(), "automation-policy-"));
  const runtime = new Fake();
  const manager = new ThreadManager(runtime, home, 20, 500, 10);
  t.after(() => {
    manager.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, runtime, manager };
}
test("automation questions deny before auto mode or timeout and preserve durable blocker evidence", async (t) => {
  const { runtime, manager, home } = fixture(t);
  const created = await manager.create({
    automationPolicy: policy,
    approvalMode: "auto",
  });
  assert.deepEqual(created.automationPolicy, policy);
  assert.equal(created.automationPolicyVersion, 1);
  const configuration = runtime.calls[0].params;
  assert.equal(configuration.config["features.multi_agent"], false);
  assert.match(configuration.baseInstructions, /reviewed automation/);
  await manager.message("root_1", "Execute approved recipe");
  runtime.emit("serverRequest", {
    id: 7,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "root_1",
      turnId: "turn_1",
      questions: [
        {
          id: "plan_approval",
          question: "secret question",
          options: [{ label: "Approve" }, { label: "Revise" }],
        },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(runtime.replies, [{ id: 7, result: { answers: {} } }]);
  assert.equal(manager.snapshot("root_1").pending.length, 0);
  assert.ok(runtime.calls.some((c) => c.method === "turn/interrupt"));
  const restored = new ThreadManager(new Fake(), home);
  t.after(() => restored.close());
  const blocked = restored
    .records("root_1")
    .find((r) => r.event.type === "automation.blocked")?.event;
  assert.equal(blocked?.turnId, "turn_1");
  assert.equal(blocked?.data.reason, "human_action_required");
  assert.equal(blocked?.data.automationPolicy.runId, "run_1");
  assert.ok(!JSON.stringify(blocked).includes("secret question"));
});
test("native approvals and persisted resume policy cannot bypass unattended denial", async (t) => {
  const { runtime, manager, home } = fixture(t);
  await manager.create({ automationPolicy: policy });
  manager.close();
  const next = new ThreadManager(runtime, home);
  t.after(() => next.close());
  const resumed = await next.resume("root_1", { response: "operational" });
  assert.deepEqual(resumed.automationPolicy, policy);
  assert.equal(resumed.automationPolicyVersion, 1);
  assert.equal(next.snapshot("root_1").automationPolicyVersion, 1);
  runtime.emit("serverRequest", {
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "root_1", turnId: "turn_1", command: "secret command" },
  });
  assert.deepEqual(runtime.replies.at(-1).result, { decision: "decline" });
  assert.equal(
    next.records("root_1").find((r) => r.event.type === "automation.blocked")
      ?.event.data.reason,
    "approval_required",
  );
});
test("automation tool evidence is durable metadata and exact root completion remains attributable", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ automationPolicy: policy });
  for (const method of ["item/started", "item/completed"])
    runtime.emit("notification", {
      method,
      params: {
        threadId: "root_1",
        turnId: "turn_1",
        item: {
          id: "tool_1",
          type: "mcpToolCall",
          server: "crm",
          tool: "list_accounts",
          status: "completed",
          arguments: { token: "secret" },
          result: { content: "private" },
        },
      },
    });
  runtime.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "turn_1", status: "completed" } },
  });
  const evidence = manager
    .records("root_1")
    .filter((r) => r.event.type === "automation.tool");
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].event.data.tool, "list_accounts");
  assert.ok(!JSON.stringify(evidence).includes("secret"));
  assert.ok(!JSON.stringify(evidence).includes("private"));
  const complete = manager
    .records("root_1")
    .find((r) => r.event.type === "turn.completed")!.event;
  assert.equal(complete.turnId, "turn_1");
  assert.equal(complete.data.automationPolicy.runId, "run_1");
  assert.equal(complete.data.terminationEvidence, "runtime");
});
test("automation business configuration uses reviewed scope without fresh plan consent and disables helpers across resume", async (t) => {
  const { home } = fixture(t);
  const sent: any[] = [];
  const original = CodexClient.prototype.request;
  CodexClient.prototype.request = async function (method, params) {
    sent.push({ method, params });
    return method === "thread/start" ? { thread: { id: "root_1" } } : {};
  };
  t.after(() => {
    CodexClient.prototype.request = original;
  });
  const client = new BusinessRuntime("codex", home);
  await client.request("thread/start", { automationPolicy: policy });
  await client.request("thread/resume", { threadId: "root_1" });
  for (const call of sent) {
    assert.equal(call.params.config["features.multi_agent"], false);
    assert.equal(call.params.config["agents.max_depth"], 0);
    assert.equal(call.params.config["features.goals"], false);
    assert.match(call.params.baseInstructions, /reviewed automation/);
    assert.doesNotMatch(call.params.baseInstructions, /treat it as Approve/);
    assert.doesNotMatch(
      call.params.baseInstructions,
      /first call update_plan.*plan_approval/,
    );
  }
});
test("automation policy cannot be changed on resume, and prohibited helper spawn stops the root", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ automationPolicy: policy });
  await manager.message("root_1", "recipe");
  await assert.rejects(
    manager.resume("root_1", {
      automationPolicy: { ...policy, runId: "other_run" },
    }),
    /immutable/,
  );
  runtime.emit("notification", {
    method: "thread/started",
    params: {
      thread: {
        id: "child_1",
        source: { subagent: { thread_spawn: { parent_thread_id: "root_1" } } },
      },
    },
  });
  assert.equal(manager.threads.has("child_1"), false);
  assert.ok(
    runtime.calls.some(
      (c) => c.method === "thread/archive" && c.params.threadId === "child_1",
    ),
  );
  assert.equal(
    manager.records("root_1").find((r) => r.event.type === "automation.blocked")
      ?.event.data.reason,
    "delegation_prohibited",
  );
  runtime.emit("serverRequest", {
    id: 13,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "child_1",
      questions: [{ id: "choice", options: [{ label: "Approve" }] }],
    },
  });
  assert.deepEqual(runtime.replies.at(-1).result, { answers: {} });
});
test("interactive timeout recommendations retain existing behavior", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({});
  runtime.emit("serverRequest", {
    id: 1,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "root_1",
      questions: [
        { id: "choice", options: [{ label: "Proceed (Recommended)" }] },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    runtime.replies[0].result.answers.choice.answers[0],
    "Proceed (Recommended)",
  );
  assert.equal(
    manager
      .records("root_1")
      .some((r) => r.event.type === "automation.blocked"),
    false,
  );
});
test("malformed policy is rejected before allocating a runtime thread", async (t) => {
  const { runtime, manager } = fixture(t);
  await assert.rejects(
    manager.create({ automationPolicy: { ...policy, revision: 0 } }),
    /Invalid automation policy/,
  );
  assert.equal(runtime.calls.length, 0);
});
test("adapter failure does not fabricate confirmed runtime termination", async (t) => {
  const { runtime, manager } = fixture(t);
  await manager.create({ automationPolicy: policy });
  await manager.message("root_1", "recipe");
  runtime.emit("exit");
  const complete = manager
    .records("root_1")
    .find((r) => r.event.type === "turn.completed")!.event;
  assert.equal(complete.data.terminationEvidence, "unconfirmed");
});
test("automation lifecycle controls cannot fork policy-free work or create new goal turns", async (t) => {
  const { manager } = fixture(t);
  await manager.create({ automationPolicy: policy });
  await assert.rejects(
    manager.capability("root_1", "thread/fork", {}),
    /unavailable for automations/,
  );
  await assert.rejects(
    manager.capability("root_1", "thread/goal/set", {
      objective: "unreviewed",
    }),
    /unavailable for automations/,
  );
});
test("restricted automation records use private permissions and write failure stops admission without recursive errors", async (t) => {
  const { manager, runtime, home } = fixture(t);
  await manager.create({ automationPolicy: policy });
  runtime.emit("notification", {
    method: "turn/started",
    params: { threadId: "root_1", turn: { id: "turn_1" } },
  });
  const record = manager.records("root_1")[0];
  assert.equal(
    statSync(join(home, "adapter-records", "root_1", record.key)).mode & 0o777,
    0o600,
  );
  rmSync(join(home, "adapter-records", "root_1"), { recursive: true });
  writeFileSync(join(home, "adapter-records", "root_1"), "unavailable");
  assert.doesNotThrow(() =>
    runtime.emit("notification", {
      method: "turn/started",
      params: { threadId: "root_1", turn: { id: "turn_2" } },
    }),
  );
  assert.equal(manager.draining, true);
  manager.close();
  rmSync(join(home, "adapter-records", "root_1"));
  const recoveredRuntime = new Fake();
  const recovered = new ThreadManager(recoveredRuntime, home);
  t.after(() => recovered.close());
  await recovered.resume("root_1");
  recoveredRuntime.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "turn_2", status: "completed" } },
  });
  assert.equal(recovered.records("root_1")[0].event.data.auditIncomplete, true);
  await assert.rejects(
    recovered.create({ automationPolicy: { ...policy, runId: "next_run" } }),
    /audit is incomplete/,
  );
  await assert.rejects(
    recovered.message("root_1", "dispatch again"),
    /audit is incomplete/,
  );
});

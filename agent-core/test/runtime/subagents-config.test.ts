import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../../src/client";
import { BusinessRuntime, subAgentOptions } from "../../src/business-runtime";

// Captures what the business runtime sends to Codex without starting it.
function runtime(t: any) {
  const home = mkdtempSync(join(tmpdir(), "subagents-config-"));
  const sent: { method: string; params: any }[] = [];
  const original = CodexClient.prototype.request;
  CodexClient.prototype.request = async function (method: string, params: any) {
    sent.push({ method, params });
    if (method === "thread/start") return { thread: { id: "root_1" } };
    return {};
  };
  t.after(() => {
    CodexClient.prototype.request = original;
    rmSync(home, { recursive: true, force: true });
  });
  return { client: new BusinessRuntime("codex", home), sent };
}
test("helper options are clamped and default to proactive with three helpers", () => {
  assert.deepEqual(subAgentOptions(undefined), {
    mode: "proactive",
    maxConcurrent: 3,
  });
  assert.deepEqual(
    subAgentOptions({ mode: "explicitRequestOnly", maxConcurrent: 9 }),
    {
      mode: "explicitRequestOnly",
      maxConcurrent: 5,
    },
  );
  assert.equal(subAgentOptions({ maxConcurrent: 0 }).maxConcurrent, 1);
  assert.equal(subAgentOptions({ mode: "anything" }).mode, "proactive");
});
test("threads pin the V1 helper backend and helpers inherit the restricted profile", async (t) => {
  const { client, sent } = runtime(t);
  await client.request("thread/start", {
    model: "m",
    subAgents: { mode: "explicitRequestOnly", maxConcurrent: 2 },
    config: {
      "features.shell_tool": true,
      "features.multi_agent_v2": true,
      "agents.max_depth": 5,
      "agents.max_concurrent_threads_per_session": 50,
    },
  });
  const start = sent[0].params;
  const c = start.config;
  assert.equal(start.subAgents, undefined);
  assert.equal(start.sandbox, "read-only");
  assert.equal(c["features.multi_agent"], true);
  assert.equal(c["features.multi_agent_v2"], false);
  assert.equal(c["agents.max_depth"], 1);
  assert.equal(c["agents.max_concurrent_threads_per_session"], 2);
  for (const key of [
    "features.shell_tool",
    "features.unified_exec",
    "features.hooks",
    "features.plugin_hooks",
    "features.view_image",
    "features.request_permissions_tool",
  ])
    assert.equal(c[key], false, key);
  assert.match(start.baseInstructions, /only when the user explicitly asks/);
  // Instructions are sent once; a developer copy would duplicate them.
  assert.equal(start.developerInstructions, undefined);
  // Resume keeps the conversation's helper settings.
  await client.request("thread/resume", { threadId: "root_1" });
  const resume = sent[1].params;
  assert.equal(resume.config["agents.max_concurrent_threads_per_session"], 2);
  assert.match(resume.baseInstructions, /only when the user explicitly asks/);
});
test("helper threads may be interrupted but reach no other operation", async (t) => {
  const { client, sent } = runtime(t);
  client.helpers.add("child_1");
  await client.request("turn/interrupt", {
    threadId: "child_1",
    turnId: "turn",
    extra: "dropped",
  });
  assert.deepEqual(sent.at(-1), {
    method: "turn/interrupt",
    params: { threadId: "child_1", turnId: "turn" },
  });
  await assert.rejects(
    client.request("turn/start", { threadId: "child_1", input: [] }),
    /new Truex conversation/,
  );
  await client.request("thread/archive", { threadId: "child_1", extra: 1 });
  assert.deepEqual(sent.at(-1), {
    method: "thread/archive",
    params: { threadId: "child_1" },
  });
  // Reading a helper returns its name only, never its history.
  await client.request("thread/read", {
    threadId: "child_1",
    includeTurns: true,
  });
  assert.deepEqual(sent.at(-1), {
    method: "thread/read",
    params: { threadId: "child_1", includeTurns: false },
  });
});

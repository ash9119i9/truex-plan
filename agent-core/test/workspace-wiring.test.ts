import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../src/client";
import { BusinessRuntime } from "../src/business-runtime";
import type { ScriptRunner } from "../src/script-runner";

// Captures what the business runtime sends to Codex without starting it.
function runtime(t: any, runner?: ScriptRunner) {
  const home = mkdtempSync(join(tmpdir(), "workspace-wiring-"));
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
  return { client: new BusinessRuntime("codex", home, 1000, runner), sent };
}
const names = (params: any) =>
  params.dynamicTools.map((tool: { name: string }) => tool.name);
const call = (client: BusinessRuntime, tool: string, args: any) =>
  client.executeTool({ threadId: "root_1", tool, arguments: args });
const output = (result: any) => JSON.parse(result.contentItems[0].text);

test("threads get workspace tools and no script tool when scripts are disabled", async (t) => {
  const { client, sent } = runtime(t);
  await client.request("thread/start", { model: "m" });
  const start = sent[0].params;
  for (const tool of [
    "create_document",
    "write_file",
    "append_file",
    "edit_file",
    "read_file",
    "list_files",
    "search_files",
    "delete_file",
    "export_workspace_file",
  ])
    assert.ok(names(start).includes(tool), tool);
  assert.ok(!names(start).includes("run_script"));
  assert.doesNotMatch(start.baseInstructions, /run_script/);
  assert.equal(start.config["features.shell_tool"], false);
  assert.equal(start.config["features.unified_exec"], false);
});

test("workspace tools route to the thread workspace and export to Documents", async (t) => {
  const { client } = runtime(t);
  await client.request("thread/start", { model: "m" });
  assert.equal(
    (await call(client, "write_file", { path: "src/zr.abap", content: "A\n" }))
      .success,
    true,
  );
  await call(client, "append_file", { path: "src/zr.abap", content: "B\n" });
  const read = output(await call(client, "read_file", { path: "src/zr.abap" }));
  assert.equal(read.totalLines, 2);
  const exported = output(
    await call(client, "export_workspace_file", { path: "src/zr.abap" }),
  );
  const files = output(await call(client, "conversation_files", {})).files;
  assert.deepEqual(
    files.map((f: any) => [f.id, f.name]),
    [[exported.id, "zr.abap"]],
  );
  const escape = await call(client, "read_file", { path: "../x" });
  assert.equal(escape.success, false);
});

test("run_script is offered and routed only when a runner is configured", async (t) => {
  const runs: any[] = [];
  const runner: ScriptRunner = {
    async run(options) {
      runs.push(options);
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
      };
    },
  };
  const { client, sent } = runtime(t, runner);
  await client.request("thread/start", { model: "m" });
  assert.ok(names(sent[0].params).includes("run_script"));
  assert.match(sent[0].params.baseInstructions, /run_script/);
  await call(client, "write_file", { path: "tmp/a.js", content: "1" });
  const result = output(
    await call(client, "run_script", { language: "node", path: "tmp/a.js" }),
  );
  assert.equal(result.stdout, "ok");
  assert.equal(runs[0].path, "tmp/a.js");
  assert.ok(runs[0].workRoot.endsWith(join("", "work")));
});

test("tmp/ is cleared when a turn completes", async (t) => {
  const { client } = runtime(t);
  await client.request("thread/start", { model: "m" });
  await call(client, "write_file", { path: "tmp/s.py", content: "x" });
  await call(client, "write_file", { path: "keep.txt", content: "x" });
  const listing = () =>
    call(client, "list_files", {}).then(output) as Promise<any>;
  assert.equal(JSON.stringify(await listing()).includes("tmp/s.py"), true);
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "root_1", turn: { id: "t" } },
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "../bad", turn: { id: "t" } },
  });
  await new Promise((r) => setTimeout(r, 50));
  const after = JSON.stringify(await listing());
  assert.equal(after.includes("tmp/s.py"), false);
  assert.equal(after.includes("keep.txt"), true);
  assert.ok(!existsSync(join(tmpdir(), "bad")));
});

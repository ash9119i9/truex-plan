import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DisabledScriptRunner,
  DockerScriptRunner,
  ScriptTools,
  scriptRunnerFromEnv,
  scriptTools,
  type ScriptRunOptions,
  type SpawnFn,
} from "../../src/script-runner";

async function workspace(t: any) {
  const root = await mkdtemp(join(tmpdir(), "script-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tmp"));
  await writeFile(join(root, "tmp", "a.js"), "console.log(1)");
  return root;
}
function recorder() {
  const calls: ScriptRunOptions[] = [];
  return {
    calls,
    runner: {
      async run(o: ScriptRunOptions) {
        calls.push(o);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
  };
}
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}
function fakeSpawn() {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const spawn = ((command: string, args: string[]) => {
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child;
  }) as unknown as SpawnFn;
  return { calls, spawn };
}
const rejects = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: any) => e.status === status || e.statusCode === status);

test("exposes a single run_script tool", () => {
  assert.deepEqual(
    scriptTools.map((t) => (t as any).name),
    ["run_script"],
  );
});

test("validates arguments and applies timeout defaults", async (t) => {
  const root = await workspace(t);
  const { calls, runner } = recorder();
  const tools = new ScriptTools(() => root, runner);
  for (const bad of [
    { language: "ruby", path: "tmp/a.js" },
    { language: "node" },
    { language: "node", path: "tmp/a.js", timeout_seconds: 121 },
    { language: "node", path: "tmp/a.js", timeout_seconds: 0 },
    { language: "node", path: "tmp/a.js", args: [1] },
    { language: "node", path: "tmp/a.js", extra: true },
    { language: "node", path: "tmp/a.js", args: ["a\0b"] },
  ])
    await rejects(tools.execute("t", "run_script", bad), 400);
  await rejects(
    tools.execute("t", "other", { language: "node", path: "tmp/a.js" }),
    400,
  );
  await tools.execute("t", "run_script", {
    language: "node",
    path: "tmp/a.js",
  });
  await tools.execute("t", "run_script", {
    language: "python",
    path: "tmp/a.js",
    args: ["-x", "y"],
    timeout_seconds: 5,
  });
  assert.deepEqual(calls, [
    {
      workRoot: root,
      language: "node",
      path: "tmp/a.js",
      args: [],
      timeoutMs: 30_000,
    },
    {
      workRoot: root,
      language: "python",
      path: "tmp/a.js",
      args: ["-x", "y"],
      timeoutMs: 5_000,
    },
  ]);
});

test("rejects path escapes, links and non-files", async (t) => {
  const root = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "script-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "x.js"), "");
  await symlink(join(outside, "x.js"), join(root, "tmp", "link.js"));
  await symlink(outside, join(root, "linkdir"));
  const { calls, runner } = recorder();
  const tools = new ScriptTools(() => root, runner);
  const run = (path: string) =>
    tools.execute("t", "run_script", { language: "node", path });
  for (const path of [
    "../x.js",
    "tmp/../../x.js",
    "/etc/passwd",
    join(root, "tmp/a.js"),
    "tmp\\a.js",
    "tmp/a.js\0",
    "./tmp/a.js",
    "tmp//a.js",
    "tmp/",
    "tmp/link.js",
    "linkdir/x.js",
    "tmp",
  ])
    await rejects(run(path), 400);
  await rejects(run("tmp/missing.js"), 404);
  assert.equal(calls.length, 0);
});

test("disabled runner and env selection", async () => {
  await assert.rejects(
    new DisabledScriptRunner().run(),
    /Script execution is not enabled on this server/,
  );
  await rejects(new DisabledScriptRunner().run(), 503);
  assert.ok(scriptRunnerFromEnv({}) instanceof DisabledScriptRunner);
  assert.ok(
    scriptRunnerFromEnv({ SCRIPT_RUNNER: "shell" }) instanceof
      DisabledScriptRunner,
  );
  const docker = scriptRunnerFromEnv({
    SCRIPT_RUNNER: "docker",
    SCRIPT_RUNNER_IMAGE: "runner:1",
  });
  assert.ok(docker instanceof DockerScriptRunner);
  assert.equal(
    (docker as DockerScriptRunner).dockerArgs("n", {
      workRoot: "/w",
      language: "node",
      path: "a.js",
      args: [],
      timeoutMs: 1,
    })[25],
    "runner:1",
  );
});

test("docker runner spawns the sandboxed container with exact arguments", async () => {
  const { calls, spawn } = fakeSpawn();
  const runner = new DockerScriptRunner({ image: "runner:1", spawn });
  const pending = runner.run({
    workRoot: "/data/ws/t/work",
    language: "python",
    path: "tmp/a.py",
    args: ["--flag", "v"],
    timeoutMs: 10_000,
  });
  const [{ command, args, child }] = calls;
  const name = args[3];
  assert.match(name, /^truex-script-[a-f0-9-]{36}$/);
  assert.equal(command, "docker");
  assert.deepEqual(args, [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/tmp:size=64m",
    "-v",
    "/data/ws/t/work:/work:rw",
    "-w",
    "/work",
    "runner:1",
    "python3",
    "/work/tmp/a.py",
    "--flag",
    "v",
  ]);
  child.stdout.emit("data", Buffer.from("hello "));
  child.stdout.emit("data", Buffer.from("world"));
  child.stderr.emit("data", Buffer.from("warn"));
  child.emit("close", 3);
  const result = await pending;
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "hello world");
  assert.equal(result.stderr, "warn");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 1);
});

test("docker runner rejects unsafe mount paths", () => {
  const runner = new DockerScriptRunner({ spawn: fakeSpawn().spawn });
  for (const workRoot of ["relative", "/a:/etc", "/a,b"])
    assert.throws(() =>
      runner.dockerArgs("n", {
        workRoot,
        language: "node",
        path: "a.js",
        args: [],
        timeoutMs: 1,
      }),
    );
});

test("docker runner kills the container on timeout", async () => {
  const { calls, spawn } = fakeSpawn();
  const runner = new DockerScriptRunner({ image: "i", spawn });
  const pending = runner.run({
    workRoot: "/w",
    language: "node",
    path: "a.js",
    args: [],
    timeoutMs: 20,
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ["kill", calls[0].args[3]]);
  calls[0].child.emit("close", 137);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test("docker runner caps output and reports truncation", async () => {
  const { calls, spawn } = fakeSpawn();
  const runner = new DockerScriptRunner({ image: "i", spawn });
  const pending = runner.run({
    workRoot: "/w",
    language: "node",
    path: "a.js",
    args: [],
    timeoutMs: 10_000,
  });
  const { child } = calls[0];
  child.stdout.emit("data", Buffer.alloc(40_000, "a"));
  child.stdout.emit("data", Buffer.alloc(40_000, "b"));
  child.stdout.emit("data", Buffer.alloc(10, "c"));
  child.stderr.emit("data", Buffer.from("e"));
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.stdout.length, 65_536);
  assert.equal(result.stdout.at(-1), "b");
  assert.equal(result.stderr, "e");
  assert.equal(result.truncated, true);
});

test("docker runner reports a missing docker binary", async () => {
  const { calls, spawn } = fakeSpawn();
  const pending = new DockerScriptRunner({ spawn }).run({
    workRoot: "/w",
    language: "node",
    path: "a.js",
    args: [],
    timeoutMs: 10_000,
  });
  calls[0].child.emit("error", new Error("spawn docker ENOENT"));
  await rejects(pending, 503);
});

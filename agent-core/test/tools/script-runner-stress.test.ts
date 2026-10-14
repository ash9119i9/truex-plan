// Worst-case stress tests for run_script. Docker is not required: a shim spawn
// runs the real interpreter locally, which proves the runner's own process,
// pipe and timer handling. The shim is NOT a sandbox; container isolation is
// covered only by the argument assertions below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerScriptRunner,
  ScriptTools,
  type ScriptResult,
  type ScriptRunOptions,
  type SpawnFn,
} from "../../src/tools/scripts";

const IMAGE = "stress:1";
const PYTHON = "/usr/bin/python3";

async function workRoot(t: any) {
  const root = await mkdtemp(join(tmpdir(), "script-stress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "tmp"));
  return root;
}
async function script(root: string, name: string, body: string) {
  await writeFile(join(root, "tmp", name), body);
  return `tmp/${name}`;
}

// Runs `<interpreter> /work/<path> ...args` locally, with /work mapped to the
// mounted host directory. `docker kill <name>` kills the process group, like a
// container stop would.
function localShim() {
  const live = new Map<string, ChildProcess>();
  const spawned: ChildProcess[] = [];
  const spawn = ((command: string, args: string[], options: any) => {
    if (args[0] === "kill") {
      const child = live.get(args[1]);
      if (child?.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      return realSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    }
    const name = args[args.indexOf("--name") + 1];
    const mount = args[args.indexOf("-v") + 1];
    const root = mount.slice(0, -":/work:rw".length);
    const [interp, target, ...rest] = args.slice(args.indexOf(IMAGE) + 1);
    assert.ok(target.startsWith("/work/"));
    const bin = interp === "node" ? process.execPath : PYTHON;
    const child = realSpawn(
      bin,
      [join(root, target.slice("/work/".length)), ...rest],
      { ...options, cwd: root, detached: true },
    );
    live.set(name, child);
    spawned.push(child);
    child.on("close", () => live.delete(name));
    return child;
  }) as unknown as SpawnFn;
  return { spawn, spawned };
}
function runOpts(root: string, o: Partial<ScriptRunOptions>): ScriptRunOptions {
  return {
    workRoot: root,
    language: "node",
    path: "tmp/a.js",
    args: [],
    timeoutMs: 10_000,
    ...o,
  };
}

// Fake child with real streams, so destroy() behaves like the real thing.
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}
function fakeSpawn(
  behaviour: { throwOn?: "run" | "kill"; killError?: boolean } = {},
) {
  const calls: { command: string; args: string[]; child: FakeChild }[] = [];
  const spawn = ((command: string, args: string[]) => {
    const kind = args[0] === "kill" ? "kill" : "run";
    if (behaviour.throwOn === kind) throw new Error(`spawn ${kind} EMFILE`);
    const child = new FakeChild();
    calls.push({ command, args, child });
    if (kind === "kill" && behaviour.killError)
      setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  }) as unknown as SpawnFn;
  return { calls, spawn };
}
const rejects = (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: any) => e.status === status || e.statusCode === status);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- real processes -------------------------------------------------------

test(
  "real infinite loops are killed close to the timeout",
  { timeout: 20_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn, spawned } = localShim();
    const runner = new DockerScriptRunner({
      image: IMAGE,
      spawn,
      killGraceMs: 1_000,
    });
    const node = await script(root, "spin.js", "while (true) {}");
    const py = await script(root, "sleep.py", "import time\ntime.sleep(999)\n");
    const timeoutMs = 500;
    const results: Record<string, ScriptResult> = {
      node: await runner.run(runOpts(root, { path: node, timeoutMs })),
      python: await runner.run(
        runOpts(root, { language: "python", path: py, timeoutMs }),
      ),
    };
    for (const [lang, r] of Object.entries(results)) {
      assert.equal(r.timedOut, true, lang);
      assert.equal(r.exitCode, null, lang);
      const latency = r.durationMs - timeoutMs;
      console.log(
        `kill latency ${lang}: ${latency} ms after a ${timeoutMs} ms timeout`,
      );
      assert.ok(latency >= 0 && latency < 500, `${lang} latency ${latency}`);
    }
    for (const child of spawned) assert.equal(alive(child.pid!), false);
  },
);

test(
  "100 MB of output is capped at 64 KB without growing memory",
  { timeout: 30_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn } = localShim();
    const runner = new DockerScriptRunner({ image: IMAGE, spawn });
    const path = await script(
      root,
      "flood.js",
      `const fs = require("fs"); const b = Buffer.alloc(1 << 20, 97);
     let n = 0; for (let i = 0; i < 100; i++) { n += fs.writeSync(1, b); n += fs.writeSync(2, b); }
     fs.writeFileSync("tmp/flood.done", String(n));`,
    );
    global.gc?.();
    const before = process.memoryUsage();
    const r = await runner.run(runOpts(root, { path, timeoutMs: 25_000 }));
    const after = process.memoryUsage();
    const rssMb = (after.rss - before.rss) / 2 ** 20;
    const heapMb = (after.heapUsed - before.heapUsed) / 2 ** 20;
    console.log(
      `200 MB piped (100 MB each stream) in ${r.durationMs} ms: rss ${rssMb.toFixed(1)} MB, heap ${heapMb.toFixed(1)} MB delta`,
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.truncated, true);
    assert.equal(r.stdout.length, 65_536);
    assert.equal(r.stderr.length, 65_536);
    assert.match(r.stdout, /^a+$/);
    // The script really wrote all 200 MB rather than dying early.
    assert.equal(
      await readFile(join(root, "tmp", "flood.done"), "utf8"),
      String(200 * 2 ** 20),
    );
    // Holding the full output would add at least 200 MB.
    assert.ok(rssMb < 150, `rss grew ${rssMb} MB`);
  },
);

test(
  "an escaped grandchild holding the pipes open does not hang the runner",
  { timeout: 15_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn } = localShim();
    const runner = new DockerScriptRunner({
      image: IMAGE,
      spawn,
      killGraceMs: 200,
    });
    // The grandchild starts its own process group, so even the group kill that
    // stands in for `docker kill` misses it. It inherits stdout/stderr.
    const path = await script(
      root,
      "orphan.js",
      `const { spawn } = require("child_process");
     const c = spawn("sleep", ["20"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
     process.stderr.write("pid:" + c.pid + "\\n");
     c.unref();`,
    );
    const r = await runner.run(runOpts(root, { path, timeoutMs: 300 }));
    const pid = Number(/pid:(\d+)/.exec(r.stderr)?.[1]);
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    });
    assert.ok(pid > 0);
    // The script itself exited 0 immediately, but 'close' never fires while the
    // pipes are held, so the runner falls through to the abandon path.
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.ok(
      r.durationMs >= 300 + 2 * 200 && r.durationMs < 300 + 2 * 200 + 1_000,
      `${r.durationMs}`,
    );
  },
);

test(
  "exit codes, stderr, argv and non-UTF-8 bytes come through",
  { timeout: 15_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn } = localShim();
    const runner = new DockerScriptRunner({ image: IMAGE, spawn });
    const node = await script(
      root,
      "codes.js",
      `process.stdout.write(Buffer.from([0x6f, 0x6b, 0xff, 0xfe, 0xe2, 0x82]));
     process.stderr.write(JSON.stringify(process.argv.slice(2)));
     process.exitCode = 7;`,
    );
    const hostile = [
      "; rm -rf /",
      "$(id)",
      "`id`",
      "a\nb",
      "--network=host",
      "-v",
      "/:/host",
      "*",
      "",
      "é🙂",
    ];
    const r = await runner.run(runOpts(root, { path: node, args: hostile }));
    assert.equal(r.exitCode, 7);
    assert.equal(r.timedOut, false);
    // Invalid UTF-8 (and a truncated multibyte sequence) decodes to U+FFFD.
    assert.equal(r.stdout, "ok\ufffd\ufffd\ufffd");
    assert.deepEqual(JSON.parse(r.stderr), hostile);

    const py = await script(
      root,
      "codes.py",
      "import sys\nsys.stderr.write('boom')\nsys.exit(3)\n",
    );
    const p = await runner.run(runOpts(root, { language: "python", path: py }));
    assert.deepEqual([p.exitCode, p.stdout, p.stderr], [3, "", "boom"]);

    const thrown = await script(root, "throw.js", "throw new Error('kaboom')");
    const e = await runner.run(runOpts(root, { path: thrown }));
    assert.equal(e.exitCode, 1);
    assert.match(e.stderr, /kaboom/);

    // A script killed by a signal (e.g. the OOM killer) reports exitCode null
    // with timedOut false. Under real Docker the client exits 137 instead.
    const signalled = await script(
      root,
      "sig.js",
      "process.kill(process.pid, 'SIGKILL')",
    );
    const s = await runner.run(runOpts(root, { path: signalled }));
    assert.deepEqual([s.exitCode, s.timedOut], [null, false]);
  },
);

test(
  "truncation at the byte cap can split a multibyte character",
  { timeout: 10_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn } = localShim();
    const runner = new DockerScriptRunner({
      image: IMAGE,
      spawn,
      maxOutput: 5,
    });
    const path = await script(root, "euro.js", "process.stdout.write('ab€cd')");
    const r = await runner.run(runOpts(root, { path }));
    assert.equal(r.truncated, true);
    // 'ab' + first 3 bytes of '€' (3 bytes) = 5 bytes, so here it fits exactly;
    // one byte less would leave a trailing U+FFFD. Documented, harmless.
    assert.equal(r.stdout, "ab€");
    const cut = new DockerScriptRunner({ image: IMAGE, spawn, maxOutput: 4 });
    assert.equal((await cut.run(runOpts(root, { path }))).stdout, "ab\ufffd");
  },
);

test(
  "20 real runs in parallel all complete",
  { timeout: 20_000 },
  async (t) => {
    const root = await workRoot(t);
    const { spawn } = localShim();
    const runner = new DockerScriptRunner({ image: IMAGE, spawn });
    const path = await script(
      root,
      "echo.js",
      "setTimeout(() => { console.log(process.argv[2]); process.exitCode = Number(process.argv[2]) % 5 }, 50)",
    );
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runner.run(runOpts(root, { path, args: [String(i)] })),
      ),
    );
    console.log(`20 parallel runs: ${Date.now() - started} ms`);
    results.forEach((r, i) => {
      assert.equal(r.stdout, `${i}\n`);
      assert.equal(r.exitCode, i % 5);
      assert.equal(r.timedOut, false);
    });
  },
);

// ---- fake spawn -----------------------------------------------------------

test("hostile args stay literal after the image; no docker flag injection", () => {
  const runner = new DockerScriptRunner({
    image: IMAGE,
    spawn: fakeSpawn().spawn,
  });
  const base = runner.dockerArgs("n", runOpts("/w", {}));
  const hostile = [
    "; rm -rf /",
    "$(id)",
    "`id`",
    "a\nb",
    "--network=host",
    "--network",
    "host",
    "-v",
    "/:/host",
    "--privileged",
    "--",
    "&& curl x | sh",
  ];
  for (const path of ["tmp/a.js", "--privileged", "-v", "tmp/--network=host"]) {
    const args = runner.dockerArgs("n", runOpts("/w", { path, args: hostile }));
    const image = args.indexOf(IMAGE);
    // Everything docker parses as options is unchanged.
    assert.deepEqual(args.slice(0, image + 2), base.slice(0, image + 2));
    assert.equal(args.indexOf(IMAGE), base.indexOf(IMAGE));
    // The script path is absolute, so it can never look like an interpreter flag.
    assert.equal(args[image + 2], `/work/${path}`);
    assert.deepEqual(args.slice(image + 3), hostile);
    assert.equal(args.filter((a) => a === "--network").length, 2); // ours + literal arg
    assert.equal(args[args.indexOf("--network") + 1], "none");
  }
});

test("tool-level validation rejects bad timeouts, NUL and oversize input", async (t) => {
  const root = await workRoot(t);
  await script(root, "a.js", "");
  const calls: ScriptRunOptions[] = [];
  const tools = new ScriptTools(() => root, {
    async run(o) {
      calls.push(o);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    },
  });
  const run = (extra: object) =>
    tools.execute("t", "run_script", {
      language: "node",
      path: "tmp/a.js",
      ...extra,
    });
  for (const bad of [
    { timeout_seconds: 0 },
    { timeout_seconds: 121 },
    { timeout_seconds: -1 },
    { timeout_seconds: 1.5 },
    { timeout_seconds: "5" },
    { args: ["ok", "a\0b"] },
    { args: ["\0"] },
    { args: Array(33).fill("x") },
    { args: ["x".repeat(4097)] },
    { path: "tmp/a.js\0" },
    { path: "x".repeat(513) },
  ])
    await rejects(run(bad), 400);
  await run({ timeout_seconds: 1 });
  await run({ timeout_seconds: 120, args: Array(32).fill("x".repeat(4096)) });
  assert.deepEqual(
    calls.map((c) => c.timeoutMs),
    [1_000, 120_000],
  );
});

test("unsafe workRoot values reject before anything is spawned", async () => {
  const { calls, spawn } = fakeSpawn();
  const runner = new DockerScriptRunner({ spawn });
  for (const workRoot of [
    "/a:/etc",
    "/a,b",
    "/a\nb",
    "/a\0b",
    "rel/ative",
    "",
  ]) {
    assert.throws(
      () => runner.dockerArgs("n", runOpts(workRoot, {})),
      (e: any) => e.status === 500,
    );
    // run() rejects rather than throwing synchronously out of the call.
    await rejects(runner.run(runOpts(workRoot, {})), 500);
  }
  assert.equal(calls.length, 0);
});

test("spawn failures become 503s", async () => {
  const error = fakeSpawn();
  const pending = new DockerScriptRunner({ spawn: error.spawn }).run(
    runOpts("/w", {}),
  );
  error.calls[0].child.emit("error", new Error("spawn docker EACCES"));
  await rejects(pending, 503);
  // A late 'close' after the error is ignored.
  error.calls[0].child.emit("close", 0);

  const sync = fakeSpawn({ throwOn: "run" });
  await rejects(
    new DockerScriptRunner({ spawn: sync.spawn }).run(runOpts("/w", {})),
    503,
  );
});

test(
  "a throwing or failing kill spawn is contained",
  { timeout: 5_000 },
  async () => {
    for (const behaviour of [
      { throwOn: "kill" as const },
      { killError: true },
    ]) {
      const { calls, spawn } = fakeSpawn(behaviour);
      const pending = new DockerScriptRunner({ spawn, killGraceMs: 20 }).run(
        runOpts("/w", { timeoutMs: 10 }),
      );
      await new Promise((r) => setTimeout(r, 25));
      calls[0].child.emit("close", 137);
      const r = await pending;
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, null);
    }
  },
);

test(
  "a child that ignores every kill is abandoned after killGraceMs",
  { timeout: 5_000 },
  async () => {
    const { calls, spawn } = fakeSpawn();
    const started = Date.now();
    const pending = new DockerScriptRunner({ spawn, killGraceMs: 50 }).run(
      runOpts("/w", { timeoutMs: 20 }),
    );
    calls[0].child.stdout.write("partial");
    const r = await pending;
    const elapsed = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.stdout, "partial");
    assert.ok(elapsed >= 20 + 2 * 50 && elapsed < 1_000, `${elapsed}`);
    const { child } = calls[0];
    assert.deepEqual(child.killed, ["SIGKILL"]);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    // Two `docker kill` attempts: at the timeout and after the first grace.
    assert.deepEqual(
      calls.slice(1).map((c) => c.args),
      [
        ["kill", calls[0].args[3]],
        ["kill", calls[0].args[3]],
      ],
    );
    // Nothing more happens afterwards, and a late close is a no-op.
    child.emit("close", 0);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls.length, 3);
  },
);

test(
  "the default grace period is 5 s per stage",
  { timeout: 5_000 },
  async () => {
    const { calls, spawn } = fakeSpawn();
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const pending = new DockerScriptRunner({ spawn }).run(
        runOpts("/w", { timeoutMs: 1_000 }),
      );
      mock.timers.tick(1_000);
      assert.equal(calls.length, 2);
      mock.timers.tick(4_999);
      assert.equal(calls.length, 2);
      mock.timers.tick(1);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0].child.killed, ["SIGKILL"]);
      mock.timers.tick(5_000);
      const r = await pending;
      assert.equal(r.timedOut, true);
    } finally {
      mock.timers.reset();
    }
  },
);

test("container names are unique per run", () => {
  const { calls, spawn } = fakeSpawn();
  const runner = new DockerScriptRunner({ spawn });
  for (let i = 0; i < 500; i++) {
    void runner.run(runOpts("/w", {}));
    calls.at(-1)!.child.emit("close", 0);
  }
  const names = new Set(calls.map((c) => c.args[3]));
  assert.equal(names.size, 500);
  for (const name of names) assert.match(name, /^truex-script-[0-9a-f-]{36}$/);
});

// ---- TOCTOU ---------------------------------------------------------------

test("TOCTOU: a symlink swapped in after validation is not re-checked", async (t) => {
  const root = await workRoot(t);
  const outside = await mkdtemp(join(tmpdir(), "script-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.js"), "host secret");
  await script(root, "a.js", "console.log(1)");
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "b.js"), "");

  const seen: ScriptRunOptions[] = [];
  const tools = new ScriptTools(() => root, {
    // Runs after scriptPath() has validated, just before the container starts.
    async run(o) {
      seen.push(o);
      if (o.path === "tmp/a.js") {
        await rm(join(root, "tmp", "a.js"));
        await symlink(join(outside, "secret.js"), join(root, "tmp", "a.js"));
      } else {
        await rename(join(root, "dir"), join(root, "dir.old"));
        await symlink(outside, join(root, "dir"));
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      };
    },
  });
  await tools.execute("t", "run_script", {
    language: "node",
    path: "tmp/a.js",
  });
  await tools.execute("t", "run_script", {
    language: "node",
    path: "dir/b.js",
  });
  // Current behaviour: the swap goes undetected on the host and the runner is
  // handed the original relative path.
  assert.deepEqual(
    seen.map((o) => o.path),
    ["tmp/a.js", "dir/b.js"],
  );
  // What the container would see: only workRoot is bind-mounted at /work, and
  // the interpreter resolves `/work/tmp/a.js` inside the container, so the
  // absolute link target `${outside}/secret.js` names a path in the image's
  // own filesystem, not the host's. The link cannot reach host files, and
  // the same holds for relative targets (`../../..` stops at the container
  // root). The runner therefore relies on the mount, not the host check.
  const args = new DockerScriptRunner({
    image: IMAGE,
    spawn: fakeSpawn().spawn,
  }).dockerArgs("n", seen[0]);
  assert.deepEqual(
    args.filter((a, i) => args[i - 1] === "-v"),
    [`${root}:/work:rw`],
  );
  assert.equal(args.includes("--read-only"), true);
});

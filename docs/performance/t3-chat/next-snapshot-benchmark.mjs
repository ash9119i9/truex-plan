import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolvePlatformSource } from "../../../platform/scripts/source-paths.mjs";

const repo = path.resolve(process.argv[2] ?? ".");
const baselineRef = "d6e3f45a45e6948873b8a64d0a9453fb2c2f4307";
process.env.PROJECT_ROOT = repo;
const sourcePath = resolvePlatformSource(repo, "agent-core/src/manager.ts");
const baselineSourcePath = path.join(repo, "agent-core/src/manager.ts");
const beforeSource = execFileSync(
  "git",
  ["show", `${baselineRef}:agent-core/src/manager.ts`],
  { cwd: repo, encoding: "utf8" },
);
const afterSource = await readFile(sourcePath, "utf8");
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "truex-snapshot-benchmark-"),
);
const hash = (source) => createHash("sha256").update(source).digest("hex");
const beforePath = path.join(temporary, "before-manager.ts");
// Use the actual pinned manager, importing unchanged dependencies from the repo.
const coverageRegression = process.argv.includes("--coverage-red-tests");
// Reproduce the reviewed synchronization candidate before its coverage guard.
// The pinned pre-protocol manager cannot expose this new marker-specific bug.
const importOverrides = new Map();
const importable = (source, origin) =>
  source.replace(
    /(from\s+)(["'])(\.{1,2}\/[^"']+)\2/g,
    (_match, prefix, quote, relative) => {
      const requested = path.resolve(path.dirname(origin), relative);
      const file = /\.(?:ts|json)$/.test(requested)
        ? requested
        : `${requested}.ts`;
      const canonical = resolvePlatformSource(repo, path.relative(repo, file));
      const absolute = importOverrides.get(canonical) ?? canonical;
      return `${prefix}${quote}${/\.(?:ts|json)$/.test(absolute) ? absolute : `${absolute}.ts`}${quote}`;
    },
  );
try {
  let regressionSource = beforeSource;
  let regressionOrigin = baselineSourcePath;
  if (coverageRegression) {
    regressionOrigin = sourcePath;
    regressionSource = afterSource.replace(
      'options.sync === "v1" && t.sourceCovered',
      'options.sync === "v1"',
    );
    if (regressionSource === afterSource) {
      // The same coverage guard now belongs to the extracted stream module.
      const streamPath = path.join(repo, "agent-core/src/threads/stream.ts");
      const streamSource = await readFile(streamPath, "utf8");
      const regressionStream = streamSource.replace(
        'options.sync === "v1" && t.sourceCovered',
        'options.sync === "v1"',
      );
      assert.notEqual(regressionStream, streamSource);
      const temporaryStream = path.join(temporary, "before-stream.ts");
      await writeFile(
        temporaryStream,
        importable(regressionStream, streamPath),
      );
      importOverrides.set(streamPath, temporaryStream);
    } else assert.notEqual(regressionSource, afterSource);
  }
  const importableBefore = importable(regressionSource, regressionOrigin);
  await writeFile(beforePath, importableBefore);
  if (
    process.argv.includes("--red-tests") ||
    process.argv.includes("--sync-red-tests") ||
    coverageRegression
  ) {
    const syncRegressions =
      process.argv.includes("--sync-red-tests") || coverageRegression;
    const testSource = await readFile(
      path.join(
        repo,
        syncRegressions
          ? "agent-core/test/threads/sync-protocol.test.ts"
          : "agent-core/test/threads/snapshot-window.test.ts",
      ),
      "utf8",
    );
    const rewritten = testSource
      .replace(
        /(["'])(?:\.\.\/src\/manager|\.\.\/\.\.\/src\/threads\/manager)\1/,
        JSON.stringify(beforePath),
      )
      .replace(
        /(["'])(?:\.\.\/){2,3}shared\/contracts\1/,
        JSON.stringify(path.join(repo, "shared/contracts.ts")),
      );
    const testPath = path.join(temporary, "snapshot-window-before.test.ts");
    await writeFile(testPath, rewritten);
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "./node_modules/tsx/dist/loader.mjs",
        "--test",
        ...(coverageRegression
          ? ["--test-name-pattern=cold-resumed source"]
          : []),
        testPath,
      ],
      {
        cwd: path.join(repo, "agent-core"),
        env: process.env,
        encoding: "utf8",
      },
    );
    process.stdout.write(
      `${coverageRegression ? "Reviewed candidate with coverage guard removed" : `Pinned baseline ${baselineRef}`}; expected failing regressions\n${run.stdout}${run.stderr}`,
    );
    assert.equal(run.status, 1);
    assert.match(run.stdout, syncRegressions ? /fail [1-9]/ : /fail 4/);
  } else {
    const baselineModule = await import(pathToFileURL(beforePath).href);
    const candidateModule = await import(pathToFileURL(sourcePath).href);
    const Before =
      baselineModule.ThreadManager ?? baselineModule.default?.ThreadManager;
    const After =
      candidateModule.ThreadManager ?? candidateModule.default?.ThreadManager;
    class FakeRuntime extends EventEmitter {
      async request(method) {
        return method === "thread/start" ? { thread: { id: "thread" } } : {};
      }
      respond() {}
    }
    const managers = [];
    const results = [];
    try {
      for (const messageInputs of [100, 1000, 10000]) {
        const fixtures = [];
        for (const [mode, Manager] of [
          ["baseline", Before],
          ["candidate", After],
        ]) {
          const runtime = new FakeRuntime();
          const home = path.join(temporary, `${mode}-${messageInputs}`);
          const manager = new Manager(runtime, home, 20, 500);
          managers.push(manager);
          manager.generation = "fixture-generation";
          await manager.create({});
          for (let i = 0; i < messageInputs; i++)
            runtime.emit("notification", {
              method: "item/completed",
              params: {
                threadId: "thread",
                turnId: `turn-${i}`,
                item: {
                  id: `item-${i}`,
                  type: "agentMessage",
                  text: `answer-${i}:` + "x".repeat(2048),
                },
              },
            });
          fixtures.push({ mode, manager });
        }
        const full = fixtures[0].manager.snapshot("thread");
        assert.deepEqual(fixtures[1].manager.snapshot("thread"), full);
        const selected = full.messages.filter(
          (message) => Number(message.turnId.slice(5)) >= messageInputs - 10,
        );
        for (const { mode, manager } of fixtures) {
          for (const scenario of ["snapshot", "zero-gap-stream"]) {
            let snapshotCalls = 0;
            const original = manager.snapshot.bind(manager);
            manager.snapshot = (...args) => {
              snapshotCalls++;
              return original(...args);
            };
            const cursor = full.cursor;
            const samples = [];
            let expectedBytes;
            for (let run = 0; run < 6; run++) {
              snapshotCalls = 0;
              const chunks = [];
              const response = Object.assign(new EventEmitter(), {
                writableLength: 0,
                set() {},
                flushHeaders() {},
                write(chunk) {
                  chunks.push(chunk);
                  return true;
                },
                destroy() {
                  this.emit("close");
                },
                end() {
                  this.emit("close");
                },
              });
              const cpuStarted = process.cpuUsage();
              const started = performance.now();
              if (scenario === "snapshot")
                chunks.push(
                  JSON.stringify(
                    manager.snapshot(
                      "thread",
                      mode === "candidate" ? { window: true } : {},
                    ),
                  ),
                );
              else
                manager.subscribe(
                  "thread",
                  response,
                  cursor,
                  mode === "candidate" ? { window: true, sync: "v1" } : {},
                );
              const elapsedMs = performance.now() - started;
              const cpu = process.cpuUsage(cpuStarted);
              response.emit("close");
              const payload = chunks.join("");
              const bytes = Buffer.byteLength(payload);
              expectedBytes ??= bytes;
              if (scenario === "snapshot") {
                const snapshot = JSON.parse(payload);
                assert.deepEqual(
                  snapshot.messages,
                  mode === "candidate" ? selected : full.messages,
                );
                assert.equal(snapshot.cursor, cursor);
                assert.deepEqual(snapshot.pending, full.pending);
              } else {
                const events = payload.split("\n\n").flatMap((frame) => {
                  const data = frame
                    .split("\n")
                    .find((line) => line.startsWith("data: "));
                  return data ? [JSON.parse(data.slice(6))] : [];
                });
                assert.equal(events.length, 1);
                assert.equal(events[0].cursor, cursor);
                if (mode === "candidate") {
                  assert.equal(events[0].type, "sync.completed");
                  assert.equal(events[0].data.mode, "replay");
                  assert.deepEqual(events[0].data.snapshot.messages, []);
                  assert.equal(snapshotCalls, 0);
                } else {
                  assert.equal(events[0].type, "snapshot");
                  assert.deepEqual(events[0].data.messages, full.messages);
                  assert.equal(snapshotCalls, 2);
                }
              }
              if (run > 0)
                samples.push({
                  elapsedMs,
                  userCpuMs: cpu.user / 1000,
                  systemCpuMs: cpu.system / 1000,
                  encodedBytes: bytes,
                  snapshotCalls,
                });
            }
            const median = [...samples.map((sample) => sample.elapsedMs)].sort(
              (a, b) => a - b,
            )[2];
            results.push({
              mode,
              scenario,
              messageInputs,
              sourceRetainedMessages: full.messages.length,
              selectedRecentMessages: selected.length,
              samples,
              medianMs: median,
              encodedBytes: expectedBytes,
              exactSelectedTextAndCursor: true,
            });
            manager.snapshot = original;
          }
        }
      }
    } finally {
      for (const manager of managers) manager.close();
    }
    console.log(
      JSON.stringify(
        {
          benchmark:
            "Actual ThreadManager isolated source snapshot/zero-gap SSE projection",
          baselineRef,
          baselineManagerSha256: hash(beforeSource),
          candidateManagerSha256: hash(afterSource),
          nodeVersion: process.version,
          v8Version: process.versions.v8,
          cpuModel: os.cpus()[0]?.model,
          platform: process.platform,
          architecture: process.arch,
          measuredAt: new Date().toISOString(),
          warmupRunsPerFixture: 1,
          measuredRunsPerFixture: 5,
          limitations:
            "Synthetic runtime notifications into actual ThreadManager with isolated temporary durable record directories, no user/provider calls. Measures source selection/JSON/SSE synchronous CPU and bytes only, excluding disk seeding, HTTP/AgentCore network/projection, React, full /items reconciliation, Mongo reads, browser paint/readiness and production p95. ThreadManager already caps finalized retained messages at1000, so10000 input fixture retains1000. Dependencies are current repo modules; actual manager baseline is pinned git source.",
          results,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

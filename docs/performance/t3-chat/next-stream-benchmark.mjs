import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// Both reducers use the same importer, fixtures, measurement loop and assertions.
// This reads the pinned baseline without changing the working tree.
const baselineRef = "d6e3f45a45e6948873b8a64d0a9453fb2c2f4307";
const repo = path.resolve(process.argv[2] ?? ".");
const baselineSource = execFileSync(
  "git",
  ["show", `${baselineRef}:frontend/lib/chat.ts`],
  { cwd: repo, encoding: "utf8" },
);
const candidateSource = await readFile(
  path.join(repo, "frontend/lib/chat.ts"),
  "utf8",
);
const batchSource = await readFile(
  path.join(repo, "frontend/lib/chat-batch.ts"),
  "utf8",
);
const hash = (source) => createHash("sha256").update(source).digest("hex");
async function importSource(source) {
  const javascript = stripTypeScriptTypes(source);
  return import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
}
const baseline = await importSource(baselineSource);
const candidate = await importSource(candidateSource);
const { coalesceChatEvents } = await importSource(batchSource);
const events = Array.from({ length: 1000 }, (_, i) => ({
  type: "message.delta",
  threadId: "fixture",
  turnId: "new-turn",
  itemId: "new-item",
  cursor: `g:${i + 1}`,
  data: { delta: "x", messageIndex: 0 },
}));
const measurements = [];
for (const size of [20, 2000, 10000]) {
  // Matches the prior next-plan probe's exact fixture, provided by its author.
  const entries = Array.from({ length: size }, (_, i) => ({
    kind: "message",
    id: `old-${i}`,
    role: i % 2 ? "assistant" : "user",
    text: "Saved text",
    turnId: `old-turn-${i}`,
    itemId: `old-item-${i}`,
    final: true,
  }));
  const expected = events.reduce(baseline.applyChatEvent, entries);
  for (const mode of ["baseline", "candidate"]) {
    const reducer =
      mode === "baseline" ? baseline.applyChatEvent : candidate.applyChatEvent;
    const samples = [];
    for (let run = 0; run < 6; run++) {
      let reducerApplications = 0;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      const projected =
        mode === "candidate" ? coalesceChatEvents(events) : events;
      const output = projected.reduce((state, event) => {
        reducerApplications++;
        return reducer(state, event);
      }, entries);
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      assert.equal(output.length, size + 1);
      assert.equal(output.at(-1).text, "x".repeat(1000));
      assert.deepEqual(output, expected);
      assert.equal(events.length, 1000);
      assert.equal(events.at(-1).cursor, "g:1000");
      assert.equal(reducerApplications, mode === "candidate" ? 1 : 1000);
      if (run > 0)
        samples.push({
          elapsedMs,
          userCpuMs: cpu.user / 1000,
          systemCpuMs: cpu.system / 1000,
          reducerApplications,
        });
    }
    const median = (select) =>
      [...samples.map(select)].sort((a, b) => a - b)[2];
    measurements.push({
      mode,
      entries: size,
      events: 1000,
      samples,
      medianMs: median((sample) => sample.elapsedMs),
      medianProcessCpuMs: median(
        (sample) => sample.userCpuMs + sample.systemCpuMs,
      ),
      reducerApplications: samples[0].reducerApplications,
      finalTextLength: 1000,
      exactFinalState: true,
      exactFinalText: true,
      originalTerminalCursor: "g:1000",
    });
  }
}
console.log(
  JSON.stringify(
    {
      benchmark: "Truex chat projection CPU only, paired baseline/candidate",
      limitations:
        "Elapsed synchronous projection CPU proxy; process CPU includes Node/V8 work across threads. Candidate includes coalescing. No React, DOM, Markdown, network, provider, live browser frame gaps, long tasks, render latency, or production p95 measurement. Synthetic uninterrupted same-item batch represents maximum coalescing; real batches may contain fewer compatible adjacent frames. Terminal cursor here is original input accounting; transport cursor behavior has separate executable tests.",
      measuredAt: new Date().toISOString(),
      repo,
      baselineRef,
      baselineChatSha256: hash(baselineSource),
      candidateChatSha256: hash(candidateSource),
      candidateBatchSha256: hash(batchSource),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      warmupRunsPerFixtureAndMode: 1,
      measuredRunsPerFixtureAndMode: 5,
      measurements,
    },
    null,
    2,
  ),
);

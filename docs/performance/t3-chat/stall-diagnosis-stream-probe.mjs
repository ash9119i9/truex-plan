// Read-only diagnostic: extracts the actual page applyBatch callback, with pure
// real reducers and reference-updating setters. No React, provider or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import ts from "../../../frontend/node_modules/typescript/lib/typescript.js";
import { applyChatEvent } from "../../../frontend/lib/chat.ts";
import { coalesceChatEvents } from "../../../frontend/lib/chat-batch.ts";
import { advanceSourceSync } from "../../../frontend/lib/source-sync.ts";
import {
  applySubAgentEvent,
  emptySubAgents,
} from "../../../frontend/lib/subagents.ts";
import {
  applyObservabilityEvent,
  emptyObservability,
} from "../../../frontend/lib/observability.ts";
import { applyPlanEvent } from "../../../frontend/lib/plan.ts";
import {
  emptySeen,
  followTab,
  noteSeen,
} from "../../../frontend/lib/auto-tab.ts";
import { createOrderedBatch } from "../../../frontend/lib/ordered-batch.ts";

const page = readFileSync(
  new URL("../../../frontend/app/page.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "page.tsx",
  page,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let callback;
function collect(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "applyBatch")
    callback = node.initializer.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
assert.ok(callback);
const code = ts.transpileModule(`globalThis.applyBatch = ${callback}`, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const ref = (current) => ({ current });
const hash = (source) => createHash("sha256").update(source).digest("hex");
const sourceFiles = [
  "frontend/app/page.tsx",
  "frontend/lib/chat.ts",
  "frontend/lib/chat-batch.ts",
  "frontend/lib/source-sync.ts",
  "frontend/lib/observability.ts",
  "frontend/lib/subagents.ts",
  "frontend/lib/ordered-batch.ts",
];
function harness(entries, phase) {
  let followSeen = emptySeen();
  const sourceEntries = entries
    .filter((entry) => entry.role === "assistant")
    .slice(-10);
  const context = {
    active: true,
    token: 1,
    connection: 1,
    id: "fixture",
    ownedSnapshot: false,
    generation: ref(1),
    sourceConnection: ref(1),
    sessionRef: ref({ _id: "fixture" }),
    sourceSync: ref({
      phase,
      fromCursor: null,
      snapshotCursor: null,
      pair:
        phase === "ready"
          ? {
              protocol: 1,
              threadId: "fixture",
              cursor: "g:0",
              entries: sourceEntries,
            }
          : null,
    }),
    sourceCapability: ref(true),
    sourceRecovered: ref(true),
    sourceWaiter: ref({ complete() {} }),
    entriesRef: ref(entries),
    subAgentsRef: ref(emptySubAgents),
    observabilityRef: ref(emptyObservability),
    planRef: ref([]),
    seen: ref(new Set()),
    liveRevision: ref(0),
    advanceSourceSync,
    coalesceChatEvents,
    applyChatEvent,
    applySubAgentEvent,
    applyObservabilityEvent,
    applyPlanEvent,
    follow: {
      onEvent(event) {
        followTab(event, followSeen);
        followSeen = noteSeen(followSeen, event);
      },
    },
    syncSessionGoal() {},
    resync() {
      throw new Error("Unexpected resync");
    },
    requestSourceHandoff() {
      throw new Error("Unexpected handoff");
    },
  };
  for (const [setter, reference] of [
    ["setEntries", "entriesRef"],
    ["setSubAgents", "subAgentsRef"],
    ["setObservability", "observabilityRef"],
    ["setPlan", "planRef"],
  ])
    context[setter] = (value) => {
      context[reference].current =
        typeof value === "function" ? value(context[reference].current) : value;
    };
  for (const name of new Set(callback.match(/set[A-Z]\w+/g)))
    context[name] ??= () => {};
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, sourceEntries };
}
function fixture(size, kind) {
  const entries = Array.from({ length: size }, (_, i) => ({
    kind: "message",
    id: `old-${i}`,
    role: i % 2 ? "assistant" : "user",
    text: "Saved text",
    turnId: `old-turn-${i}`,
    itemId: `old-item-${i}`,
    final: true,
  }));
  const at = new Date().toISOString();
  const events = Array.from({ length: 1000 }, (_, i) => ({
    type:
      kind === "reasoning" || (kind === "mixed" && i % 2)
        ? "reasoning.delta"
        : "message.delta",
    threadId: "fixture",
    turnId: "new-turn",
    itemId:
      kind === "reasoning" || (kind === "mixed" && i % 2)
        ? "reasoning-item"
        : "new-item",
    seq: i + 1,
    cursor: `g:${i + 1}`,
    at,
    data: { delta: "x", messageIndex: 0, method: "item/reasoning/textDelta" },
  }));
  return { entries, events };
}
const median = (samples) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const measurements = [];
for (const size of [20, 2000, 10000])
  for (const kind of ["message", "reasoning", "mixed"])
    for (const phase of ["legacy", "ready"]) {
      const { entries, events } = fixture(size, kind);
      const expected = events.reduce(applyChatEvent, entries);
      const samples = [];
      for (let run = 0; run < 6; run++) {
        const { context, sourceEntries } = harness(entries, phase);
        const cpuStart = process.cpuUsage();
        const start = performance.now();
        assert.equal(context.applyBatch(events), true);
        const elapsedMs = performance.now() - start;
        const cpu = process.cpuUsage(cpuStart);
        // Structural equality crosses a VM realm; serialize only outside measurement.
        assert.equal(
          JSON.stringify(context.entriesRef.current),
          JSON.stringify(expected),
        );
        assert.equal(context.liveRevision.current, 1000);
        assert.equal(context.seen.current.size, 1000);
        if (phase === "ready") {
          assert.equal(context.sourceSync.current.pair.cursor, "g:1000");
          assert.equal(
            JSON.stringify(context.sourceSync.current.pair.entries),
            JSON.stringify(events.reduce(applyChatEvent, sourceEntries)),
          );
        }
        if (run)
          samples.push({
            elapsedMs,
            processCpuMs: (cpu.user + cpu.system) / 1000,
          });
      }
      measurements.push({
        size,
        kind,
        phase,
        originalEvents: 1000,
        sourceHistoricalEntries: Math.min(size / 2, 10),
        samples,
        medianMs: median(samples.map((s) => s.elapsedMs)),
        maxMs: Math.max(...samples.map((s) => s.elapsedMs)),
        exactOracleState: true,
      });
    }
// Same fixture, isolate chat-only coalescer to expose what prior benchmark omits.
const isolated = [];
for (const kind of ["message", "reasoning", "mixed"]) {
  const { entries, events } = fixture(10000, kind);
  const samples = [];
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    const projected = coalesceChatEvents(events);
    const output = projected.reduce(applyChatEvent, entries);
    const elapsedMs = performance.now() - start;
    assert.equal(
      JSON.stringify(output),
      JSON.stringify(events.reduce(applyChatEvent, entries)),
    );
    if (run) samples.push(elapsedMs);
    if (run === 5)
      isolated.push({
        kind,
        displayEntries: 10000,
        reducerCalls: projected.length,
        medianMs: median(samples),
        samples,
      });
  }
}
const scheduling = [];
const publicationSizes = [];
for (const kind of ["message", "reasoning", "mixed"])
  for (const batchSize of [1, 16, 64, 1000]) {
    const { entries, events } = fixture(10000, kind);
    const expected = JSON.stringify(events.reduce(applyChatEvent, entries));
    const samples = [];
    for (let run = 0; run < 6; run++) {
      const { context } = harness(entries, "ready");
      let totalMs = 0,
        largestCallbackMs = 0,
        callbacks = 0;
      for (let offset = 0; offset < events.length; offset += batchSize) {
        const batch = events.slice(offset, offset + batchSize);
        const start = performance.now();
        const accepted = context.applyBatch(batch);
        const elapsedMs = performance.now() - start;
        assert.equal(accepted, true);
        totalMs += elapsedMs;
        largestCallbackMs = Math.max(largestCallbackMs, elapsedMs);
        callbacks++;
      }
      assert.equal(JSON.stringify(context.entriesRef.current), expected);
      assert.equal(context.sourceSync.current.pair.cursor, "g:1000");
      if (run) samples.push({ totalMs, largestCallbackMs, callbacks });
    }
    publicationSizes.push({
      kind,
      batchSize,
      displayEntries: 10000,
      phase: "ready",
      samples,
      medianTotalMs: median(samples.map((s) => s.totalMs)),
      medianLargestCallbackMs: median(samples.map((s) => s.largestCallbackMs)),
      maxCallbackMs: Math.max(...samples.map((s) => s.largestCallbackMs)),
      exactOracleState: true,
    });
  }
for (const mode of ["foreground", "hidden", "barrier"]) {
  let clock = 0,
    frame,
    timer,
    publishedAt;
  const batch = createOrderedBatch(
    () => {
      publishedAt = clock;
    },
    {
      requestFrame:
        mode === "hidden"
          ? undefined
          : (run) => {
              frame = run;
              return 1;
            },
      cancelFrame() {
        frame = null;
      },
      setTimer(run) {
        timer = run;
        return 1;
      },
      clearTimer() {
        timer = null;
      },
    },
  );
  batch.push("first-text");
  assert.equal(publishedAt, undefined);
  if (mode === "barrier") batch.flush();
  else if (mode === "foreground") {
    clock = 1000 / 60;
    frame();
  } else {
    clock = 50;
    timer();
  }
  scheduling.push({
    mode,
    simulatedFirstTextPublicationMs: publishedAt,
    limitation:
      "Deterministic scheduler model, excludes browser timer clamping/event-loop stalls/paint",
  });
}
console.log(
  JSON.stringify(
    {
      description:
        "Actual current page applyBatch callback CPU, real source/display/agent/observability/plan/follow projections; exact raw reducer oracle",
      limitations:
        "Synthetic 1000-event burst, maximum ordered-batch cap 2048; VM setters update refs but exclude React/reconciliation/Markdown/DOM/render/final paint. Source history models latest 10 assistant turns. No transport parsing, provider, network or backend. No production latency/p95 claim. CPU process includes V8 worker CPU. Cold phase has same projection path as legacy but was not benchmarked independently.",
      timestamp: new Date().toISOString(),
      node: process.version,
      sourceHashes: Object.fromEntries(
        sourceFiles.map((file) => [
          file,
          hash(
            readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8"),
          ),
        ]),
      ),
      extractedCallbackSha256: hash(callback),
      warmups: 1,
      runs: 5,
      measurements,
      isolated,
      publicationSizes,
      scheduling,
    },
    null,
    2,
  ),
);

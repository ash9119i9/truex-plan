// Read-only CPU diagnostic. Does not start a server or use user/provider data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { applyChatEvent, visibleEntries } from "../../../frontend/lib/chat.ts";
import { coalesceChatEvents } from "../../../frontend/lib/chat-batch.ts";
import { createChatGroupSelector } from "../../../frontend/lib/chat-groups.ts";
import { advanceSourceSync } from "../../../frontend/lib/source-sync.ts";

const events = Array.from({ length: 1000 }, (_, i) => ({
  type: "message.delta",
  threadId: "fixture",
  turnId: "live-turn",
  itemId: "live-item",
  cursor: `fixture:${i + 1}`,
  seq: i + 1,
  data: { delta: "x", messageIndex: 0 },
}));
const batches = Array.from({ length: 20 }, (_, i) =>
  events.slice(i * 50, (i + 1) * 50),
);
const entry = (i, final = true) => ({
  kind: "message",
  id: `old-${i}`,
  role: i % 2 ? "assistant" : "user",
  text: "Saved text",
  turnId: `old-turn-${i}`,
  itemId: `old-item-${i}`,
  final,
  ...(final ? {} : { done: true }),
});
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measurements = [];
for (const size of [20, 2000, 10000]) {
  const history = Array.from({ length: size }, (_, i) => entry(i));
  const sourceHistory = history
    .filter((e) => e.role === "assistant")
    .slice(-1000);
  for (const mode of ["display-reducer-only", "source-display-and-groups"]) {
    const samples = [];
    for (let run = 0; run < 6; run++) {
      let display = history;
      let state = {
        phase: "ready",
        fromCursor: null,
        snapshotCursor: null,
        pair: {
          protocol: 1,
          threadId: "fixture",
          cursor: "fixture:0",
          entries: sourceHistory,
        },
      };
      const selectGroups = createChatGroupSelector();
      selectGroups(display);
      const stage = { sourceMs: 0, displayMs: 0, groupsAndPresentationMs: 0 };
      const start = performance.now();
      for (const batch of batches) {
        let before = performance.now();
        if (mode === "source-display-and-groups") {
          const result = advanceSourceSync(state, batch);
          assert.equal(result.failure, null);
          state = result.state;
        }
        stage.sourceMs += performance.now() - before;
        before = performance.now();
        display = coalesceChatEvents(batch).reduce(applyChatEvent, display);
        stage.displayMs += performance.now() - before;
        before = performance.now();
        if (mode === "source-display-and-groups") {
          const groups = selectGroups(display);
          // Same two linear presentation traversals as ChatMessages.
          const receiptAt = new Map();
          groups.forEach((g, i) => {
            if (!g.user && g.turnId) receiptAt.set(g.turnId, i);
          });
          const anchored = new Set();
          groups.map((g, i) => {
            const anchor =
              !g.user && g.turnId && !anchored.has(g.turnId)
                ? `turn-${g.turnId}`
                : undefined;
            if (!g.user && g.turnId) anchored.add(g.turnId);
            return {
              anchor,
              receipt: !!g.turnId && receiptAt.get(g.turnId) === i,
            };
          });
        }
        stage.groupsAndPresentationMs += performance.now() - before;
      }
      const elapsedMs = performance.now() - start;
      assert.equal(display.at(-1).text, "x".repeat(1000));
      if (mode === "source-display-and-groups") {
        assert.equal(state.pair.cursor, "fixture:1000");
        assert.equal(state.pair.entries.at(-1).text, "x".repeat(1000));
      }
      if (run) samples.push({ elapsedMs, ...stage });
    }
    measurements.push({
      mode,
      displayEntries: size,
      sourceEntries: sourceHistory.length,
      batches: 20,
      fragmentsPerBatch: 50,
      samples,
      medianMs: median(samples.map((s) => s.elapsedMs)),
      medianStages: Object.fromEntries(
        ["sourceMs", "displayMs", "groupsAndPresentationMs"].map((k) => [
          k,
          median(samples.map((s) => s[k])),
        ]),
      ),
    });
  }
}
const visibilityCases = [];
for (const size of [20, 2000, 10000]) {
  for (const final of [true, false]) {
    const history = Array.from({ length: size }, (_, i) => entry(i, final));
    let someCallbacks = 0;
    // Instrument the real entries.some called by visibleEntries, not a substitute algorithm.
    history.some = (predicate) =>
      Array.prototype.some.call(history, (...args) => {
        someCallbacks++;
        return predicate(...args);
      });
    const start = performance.now();
    const visible = visibleEntries(history);
    const elapsedMs = performance.now() - start;
    assert.equal(visible.length, size);
    delete history.some;
    const uninstrumentedSamplesMs = [];
    for (let run = 0; run < 6; run++) {
      const started = performance.now();
      const result = visibleEntries(history);
      const ms = performance.now() - started;
      assert.equal(result.length, size);
      if (run) uninstrumentedSamplesMs.push(ms);
    }
    visibilityCases.push({
      size,
      final,
      doneForNonFinal: !final,
      someCallbacks,
      instrumentedElapsedMs: elapsedMs,
      uninstrumentedSamplesMs,
      uninstrumentedMedianMs: median(uninstrumentedSamplesMs),
    });
  }
}
const paths = ["chat.ts", "chat-batch.ts", "chat-groups.ts", "source-sync.ts"];
const hashes = Object.fromEntries(
  await Promise.all(
    paths.map(async (name) => [
      name,
      createHash("sha256")
        .update(
          await readFile(
            new URL(`../../../frontend/lib/${name}`, import.meta.url),
          ),
        )
        .digest("hex"),
    ]),
  ),
);
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      hashes,
      scope:
        "Current source stages, synthetic CPU only. No React commits, markdown, DOM geometry, paint, scheduling, network, provider, or production p95. Stage timing overhead and assertions are included; five measured runs after one warmup. Visibility callbacks are deterministic counts; instrumented elapsed is not comparable with uninstrumented timing.",
      measurements,
      visibilityCases,
    },
    null,
    2,
  ),
);

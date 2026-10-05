import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let repo;
let singleTurn = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo") {
    repo = args[++i];
    if (!repo || repo.startsWith("--"))
      throw new Error("--repo requires a repository path");
  } else if (args[i] === "--single-turn") {
    singleTurn = true;
  } else {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}
if (!repo)
  throw new Error(
    "Usage: node --experimental-strip-types benchmark-chat-hydration.mjs --repo PATH [--single-turn]",
  );

repo = path.resolve(repo);
const sourcePath = path.join(repo, "frontend/lib/chat.ts");
const source = await readFile(sourcePath);
const { historyEntries } = await import(pathToFileURL(sourcePath).href);
const fixtures = [100, 1000, 5000, 10000].map((size) => ({
  name: "alternating-distinct-turns",
  size,
}));
if (singleTurn)
  fixtures.push({ name: "single-turn-distinct-items-same-text", size: 10000 });

const measurements = fixtures.map(({ name, size }) => {
  const sameTurn = name === "single-turn-distinct-items-same-text";
  const messages = Array.from({ length: size }, (_, i) => ({
    _id: `message-${i}`,
    sessionId: "synthetic-session",
    at: "2026-10-05T00:00:00.000Z",
    itemId: `item-${i}`,
    role: sameTurn || i % 2 ? "assistant" : "user",
    turnId: sameTurn ? "single-turn" : `turn-${Math.floor(i / 2)}`,
    ...(sameTurn ? { messageIndex: i } : {}),
    text: sameTurn
      ? "Identical text, distinct items"
      : `Synthetic message ${i}`,
  }));
  const samplesMs = [];
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    const entries = historyEntries(messages);
    const duration = performance.now() - start;
    assert.equal(
      entries.length,
      size,
      "Hydration must retain every distinct item",
    );
    if (run > 0) samplesMs.push(duration);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return { fixture: name, messages: size, samplesMs, medianMs: sorted[2] };
});

console.log(
  JSON.stringify(
    {
      benchmark: "Truex historyEntries CPU-only hydration",
      measuredAt: new Date().toISOString(),
      repo,
      chatSourceSha256: createHash("sha256").update(source).digest("hex"),
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      warmupRunsPerFixture: 1,
      measuredRunsPerFixture: 5,
      measurements,
    },
    null,
    2,
  ),
);

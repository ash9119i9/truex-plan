import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

// Actual Store/PlatformService plus isolated Mongo. No provider or user's DB.
// Run with the tsx loader; argument selects preserved or candidate checkout.
const root = resolve(process.argv[2] || ".");
const require = createRequire(resolve(root, "platform/package.json"));
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Store } = await import(
  pathToFileURL(resolve(root, "platform/src/store.ts"))
);
const { PlatformService } = await import(
  pathToFileURL(resolve(root, "platform/src/service.ts"))
);
const { POLICY_VERSION } = await import(
  pathToFileURL(resolve(root, "platform/src/public.ts"))
);
const mongo = await MongoMemoryServer.create();
const store = await new Store(mongo.getUri(), "paired-history").connect();
try {
  const collection = store.messages;
  Object.defineProperty(store, "messages", { get: () => collection });
  const find = collection.find.bind(collection);
  let reads = [];
  collection.find = (...args) => {
    const cursor = find(...args),
      toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async () => {
      const rows = await toArray();
      reads.push({
        kind: args[1]?.projection?.role === 1 ? "metadata" : "payload",
        documents: rows.length,
        jsonBytes: Buffer.byteLength(JSON.stringify(rows)),
      });
      return rows;
    };
    return cursor;
  };
  const service = new PlatformService(store, ["http://fixture.invalid"]);
  const results = [];
  for (const turns of [10, 100, 1000, 10000]) {
    const sessionId = "s" + turns;
    await store.sessions.insertOne({
      _id: sessionId,
      agentId: "fixture",
      threadId: "t",
      agentCoreHost: "http://fixture.invalid",
      status: "active",
      cwd: "/tmp",
      createdAt: "2026-10-05",
      runtimePolicyVersion: POLICY_VERSION,
    });
    const messages = Array.from({ length: turns * 2 }, (_, i) => ({
      _id: `${sessionId}-m${i}`,
      sessionId,
      role: i % 2 ? "assistant" : "user",
      text: `message ${i}:` + "x".repeat(1024),
      at: "2026-10-05T00:00:00Z",
      order: i,
      turnId: `turn-${Math.floor(i / 2)}`,
    }));
    await collection.insertMany(messages);
    const samples = [];
    for (let run = 0; run < 8; run++) {
      reads = [];
      const cpu = process.cpuUsage(),
        start = performance.now();
      const result = await service.history(sessionId, {
        persistedOnly: true,
        window: true,
      });
      const elapsedMs = performance.now() - start,
        used = process.cpuUsage(cpu);
      assert.deepEqual(result.messages, messages.slice(-20));
      assert.equal(result.historyWindow.hasOlder, turns > 10);
      if (run)
        samples.push({
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          reads: [...reads],
        });
    }
    const median = (key) => samples.map((s) => s[key]).sort((a, b) => a - b)[3];
    const stats = await collection
      .find(
        { sessionId },
        {
          projection: {
            _id: 1,
            at: 1,
            role: 1,
            order: 1,
            "command.afterMessageId": 1,
          },
        },
      )
      .explain("executionStats");
    results.push({
      turns,
      medianMs: median("elapsedMs"),
      medianCpuMs: median("cpuMs"),
      payloadDocuments: samples[0].reads
        .filter((r) => r.kind === "payload")
        .reduce((n, r) => n + r.documents, 0),
      dbJsonBytes: samples[0].reads.reduce((n, r) => n + r.jsonBytes, 0),
      metadataDocsExamined: stats.executionStats.totalDocsExamined,
      samples,
    });
  }
  console.log(
    JSON.stringify(
      {
        root,
        node: process.version,
        bodyBytes: 1024,
        warmups: 1,
        measuredRuns: 7,
        scope:
          "isolated Mongo/service CPU; no browser/network/provider latency; metadata remains O(total history), giant groups stay complete",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await store.client.close();
  await mongo.stop();
}

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { MongoMemoryServer } from "mongodb-memory-server";
import { PlatformReadCache, ValkeyReadCache } from "../src/cache";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { tenantContext } from "../src/tenant";
import { asUser, ashok, insertFixtures } from "../test/fixtures";
import { startValkey, valkeyAvailable } from "../test/cache-fixture";

// Real MongoDB/Valkey loopback service calls; no injected source delay.
// This measures catalogs, not authenticated HTTP or AWS latency.
async function main() {
  if (!valkeyAvailable)
    throw new Error(
      "Set VALKEY_SERVER_BIN to a local Valkey binary before benchmarking",
    );
  const mongo = await MongoMemoryServer.create();
  const server = await startValkey();
  const store = new Store(mongo.getUri(), "cache-benchmark");
  (store.client.options as { monitorCommands: boolean }).monitorCommands = true;
  let queries = 0;
  store.client.on("commandStarted", (event) => {
    if (["find", "aggregate", "getMore"].includes(event.commandName)) queries++;
  });
  const services: PlatformService[] = [];
  try {
    await store.connect();
    await insertFixtures(store);
    await store.profiles.insertMany(
      Array.from({ length: 24 }, (_, i) => ({
        _id: `model-${i}`,
        provider: "fixture",
        baseUrl: "http://127.0.0.1:1",
        modelName: `Model ${i}`,
        apikey: "fixture-only",
        wireApi: "responses" as const,
      })),
    );
    await store.agents.insertMany(
      Array.from({ length: 198 }, (_, i) => ({
        _id: `agent-${i}`,
        name: `Agent ${i}`,
        description: "Fixture catalog",
        modelProfileId: `model-${i % 24}`,
        systemPrompt: "Fixture prompt",
        mcpProfileIds: [],
        sandbox: "read-only" as const,
        approvalPolicy: "never" as const,
      })),
    );
    const make = (enabled: boolean, shared = false) => {
      let cache!: PlatformReadCache;
      cache = new PlatformReadCache(
        {
          enabled,
          namespace: "bench",
          backend: shared
            ? new ValkeyReadCache(server.url, "benchmark-clear", () =>
                cache.clearLocal(),
              )
            : undefined,
        },
        {},
      );
      const service = new PlatformService(
        store,
        ["http://127.0.0.1:1"],
        undefined,
        undefined,
        cache,
      );
      services.push(service);
      return { service, cache };
    };
    const off = make(false),
      local = make(true),
      distributed = make(true, true);
    await distributed.cache.start();
    const invoke = (service: PlatformService) =>
      tenantContext.run({ id: "default", dbName: store.database }, () =>
        asUser(ashok, async () => ({
          agents: await service.agents(),
          models: await service.models(),
        })),
      );
    const expected = await invoke(off.service);
    assert.equal(expected.agents.length, 200);
    assert.equal(expected.models.length, 25);
    const results: unknown[] = [];
    async function run(
      name: string,
      target: ReturnType<typeof make>,
      cold: boolean,
      concurrent = 8,
    ) {
      if (!cold) await invoke(target.service);
      const before = queries,
        samples: number[] = [];
      const start = performance.now();
      // 128 catalog pairs in batches; cold clears between batches, preserving
      // same-batch miss coalescing and avoiding unrealistically global clearing.
      for (let i = 0; i < 128; i += concurrent) {
        if (cold) target.cache.clearLocal();
        await Promise.all(
          Array.from({ length: concurrent }, async () => {
            const began = performance.now();
            assert.deepEqual(await invoke(target.service), expected);
            samples.push(performance.now() - began);
          }),
        );
      }
      samples.sort((a, b) => a - b);
      const percentile = (p: number) =>
        Number(samples[Math.ceil(samples.length * p) - 1].toFixed(3));
      const count = queries - before;
      results.push({
        name,
        calls: samples.length,
        concurrent,
        elapsedMs: Number((performance.now() - start).toFixed(2)),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        mongoCommands: count,
        local: target.cache.local.snapshot(),
        valkey: (target.cache.backend as ValkeyReadCache | undefined)?.counters,
      });
      return count;
    }
    assert.ok(
      (await run("disabled", off, false)) > 0,
      "Mongo command monitoring must be active",
    );
    await run("cold-L1-batches", local, true);
    assert.equal(await run("warm-L1", local, false), 0);
    await invoke(distributed.service);
    await run("warm-L2-empty-L1-batches", distributed, true);
    await server.stop();
    await run("Valkey-outage-empty-L1-batches", distributed, true);
    // Correctness at the boundary: warm display cannot authorize a disabled model.
    await store.profiles.updateOne(
      { _id: "default" },
      { $set: { enabled: false } },
    );
    await tenantContext.run({ id: "default", dbName: store.database }, () =>
      asUser(ashok, () =>
        assert.rejects(local.service.configuration("assistant"), {
          code: "MODEL_CONFIGURATION",
        }),
      ),
    );
    console.log(
      JSON.stringify(
        {
          node: process.version,
          arch: process.arch,
          fixtures: { agents: 200, models: 25 },
          source:
            "real local MongoMemoryServer and native Valkey; no synthetic delay; service layer; includes equality assertion cost",
          payloadBytes: Buffer.byteLength(JSON.stringify(expected)),
          results,
          authorityRevocation: "PASS",
          rssBytes: process.memoryUsage().rss,
        },
        null,
        2,
      ),
    );
  } finally {
    services.forEach((s) => s.stop());
    await store.client.close();
    await server.stop();
    await mongo.stop();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

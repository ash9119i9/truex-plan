import { resolvePlatformSource } from "../../../platform/scripts/source-paths.mjs";
// Isolated PlatformService/Store fixture. Run using platform's installed tsx loader.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
const root = resolve(new URL("../../../", import.meta.url).pathname);
const require = createRequire(resolve(root, "platform/package.json"));
const { MongoMemoryServer } = require("mongodb-memory-server");
const { PlatformService } = await import(
  pathToFileURL(resolvePlatformSource(root, "platform/src/service.ts"))
);
const { Store } = await import(
  pathToFileURL(resolvePlatformSource(root, "platform/src/store.ts"))
);
const { insertFixtures } = await import(
  pathToFileURL(resolve(root, "platform/test/fixtures.ts"))
);
const configured = process.argv.includes("--configured");
const clientDelayMs = 20;
const runtimeDelayMs = 8;
const repeats = 30;
const warmups = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mongo = await MongoMemoryServer.create();
const store = await new Store(
  mongo.getUri(),
  "first_send_probe",
  "first_send_probe",
).connect();
try {
  await insertFixtures(store);
  const flags = {
    enabled: true,
    defaultMode: "ask",
    autopilot: true,
    nameHeuristic: false,
  };
  let counts;
  for (const name of ["sessions", "messages"]) {
    const original = store[name];
    Object.defineProperty(store, name, {
      configurable: true,
      get: () =>
        new Proxy(original, {
          get(target, key) {
            const value = target[key];
            if (typeof value !== "function") return value;
            return (...args) => {
              if (
                [
                  "findOne",
                  "insertOne",
                  "updateOne",
                  "findOneAndUpdate",
                ].includes(String(key))
              ) {
                const op = `${name}.${String(key)}`;
                counts[op] = (counts[op] || 0) + 1;
              }
              return value.apply(target, args);
            };
          },
        }),
    });
  }
  const samples = [];
  for (let index = -warmups; index < repeats; index++) {
    counts = { clientRequests: 0, runtimeRequests: 0, configurationCalls: 0 };
    const service = new PlatformService(
      store,
      ["http://fixture.invalid"],
      flags,
    );
    const originalConfiguration = service.configuration.bind(service);
    service.configuration = async (...args) => {
      counts.configurationCalls++;
      return originalConfiguration(...args);
    };
    const runtimePaths = [];
    service.call = async (_host, path, _method, body) => {
      counts.runtimeRequests++;
      runtimePaths.push(path);
      await sleep(runtimeDelayMs);
      if (path === "/threads")
        return { threadId: `thread-${index}`, approvalMode: body.approvalMode };
      if (path.endsWith("/approval-mode")) return { mode: body.mode };
      if (path.endsWith("/resume"))
        return { approvalMode: body.approvalMode, items: [], pending: [] };
      if (path.endsWith("/turns"))
        return { turnId: `turn-${index}`, steer: false };
      throw new Error(`Unexpected fixture runtime request: ${path}`);
    };
    const request = async (operation) => {
      counts.clientRequests++;
      await sleep(clientDelayMs);
      return operation();
    };
    const started = performance.now();
    const phases = {};
    const session = await request(() =>
      service.create(
        "assistant",
        undefined,
        undefined,
        configured ? "readOnly" : undefined,
      ),
    );
    phases.createMs = performance.now() - started;
    if (!configured) {
      const modeStarted = performance.now();
      await request(() => service.setApprovalMode(session._id, "readOnly"));
      phases.modeMs = performance.now() - modeStarted;
    } else {
      assert.equal(
        session.approvalMode,
        "readOnly",
        "configured creation must expose the selected mode",
      );
      assert.equal(
        (await store.sessions.findOne({ _id: session._id })).approvalMode,
        "readOnly",
      );
    }
    const sendStarted = performance.now();
    const result = await request(() =>
      service.message(
        session._id,
        "Synthetic read-only fixture question",
        `message-${index}`,
      ),
    );
    phases.sendToAcceptanceMs = performance.now() - sendStarted;
    const submitToAcceptanceMs = performance.now() - started;
    assert.equal(result.turnId, `turn-${index}`);
    const stored = await store.messages.findOne({
      sessionId: session._id,
      clientId: `message-${index}`,
    });
    assert.equal(stored.delivery, "accepted");
    assert.equal(stored.text, "Synthetic read-only fixture question");
    // Inspection reads above must not inflate measured service counts.
    counts["messages.findOne"]--;
    if (configured) counts["sessions.findOne"]--;
    if (index >= 0)
      samples.push({
        index,
        ...phases,
        submitToAcceptanceMs,
        counts: { ...counts },
        runtimePaths,
      });
  }
  const quantile = (key, q) => {
    const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    return sorted[Math.ceil(q * sorted.length) - 1];
  };
  console.log(
    JSON.stringify(
      {
        mode: configured ? "configured-create" : "create-mode-send",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        clientDelayMs,
        runtimeDelayMs,
        repeats,
        warmups,
        scope:
          "Isolated actual service/Mongo with fake runtime; acceptance only, no provider/delta/paint measurement",
        p50Ms: quantile("submitToAcceptanceMs", 0.5),
        p95Ms: quantile("submitToAcceptanceMs", 0.95),
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await store.client.close();
  await mongo.stop();
}

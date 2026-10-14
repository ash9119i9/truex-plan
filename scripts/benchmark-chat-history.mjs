import { resolvePlatformSource } from "../platform/scripts/source-paths.mjs";
// Run with the existing platform tsx loader; see docs/performance/t3-chat/README.md.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
let repo = workspace;
let persisted = false;
let windowed = false;
for (let index = 0; index < arguments_.length; index++) {
  const argument = arguments_[index];
  if (argument === "--repo" && arguments_[index + 1])
    repo = resolve(arguments_[++index]);
  else if (argument === "--persisted") persisted = true;
  else if (argument === "--window") windowed = true;
  else
    throw new Error(
      "Usage: benchmark-chat-history.mjs [--repo checkout] [--persisted] [--window]",
    );
}
// This benchmark uses installed dependencies and an already cached mongod.
// Never download a runtime binary implicitly while measuring performance.
process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
const require = createRequire(
  new URL("../platform/package.json", import.meta.url),
);
const { MongoMemoryServer } = require("mongodb-memory-server");
const { PlatformService } = await import(
  pathToFileURL(resolvePlatformSource(repo, "platform/src/service.ts"))
);
const { Store } = await import(
  pathToFileURL(resolvePlatformSource(repo, "platform/src/store.ts"))
);
const mongo = await MongoMemoryServer.create();
const store = new Store(mongo.getUri(), "chat_benchmark", "chat_benchmark");
const ownerDelayMs = 8;
const repeats = 3;
try {
  await store.connect();
  for (const turns of [10, 100, 1000]) {
    await store.messages.deleteMany({});
    await store.sessions.deleteMany({});
    const session = {
      _id: "fixture",
      threadId: "thread",
      agentId: "fixture-agent",
      status: "active",
      createdAt: "2026-10-05T00:00:00Z",
      runtimePolicyVersion: 1,
      plan: { steps: [{ step: "Done", status: "completed" }] },
    };
    await store.sessions.insertOne(session);
    const documents = [],
      items = [];
    for (let index = 0; index < turns; index++) {
      const turnId = `turn-${index}`;
      const user = {
        _id: `u-${index}`,
        sessionId: "fixture",
        role: "user",
        text: `Synthetic question ${index}`,
        clientId: `c-${index}`,
        itemId: `u-${index}`,
        at: session.createdAt,
      };
      const answer = {
        _id: `fixture:assistant:${turnId}:0`,
        sessionId: "fixture",
        role: "assistant",
        text: `Synthetic answer ${index}`,
        turnId,
        at: session.createdAt,
      };
      documents.push(user, answer);
      items.push(
        {
          turnId,
          item: {
            id: user.itemId,
            type: "userMessage",
            clientId: user.clientId,
            content: [{ type: "text", text: user.text }],
          },
        },
        {
          turnId,
          item: { id: `a-${index}`, type: "agentMessage", text: answer.text },
        },
      );
    }
    await store.messages.insertMany(documents);
    const service = new PlatformService(store, ["http://fixture.invalid"]);
    let counts;
    const originalMessages = store.messages,
      originalSessions = store.sessions;
    function watch(collection, prefix) {
      return new Proxy(collection, {
        get(target, property) {
          const value = target[property];
          if (typeof value !== "function") return value;
          return (...arguments_) => {
            if (
              ["find", "findOne", "updateOne", "bulkWrite"].includes(
                String(property),
              )
            ) {
              const key = `${prefix}.${String(property)}`;
              counts[key] = (counts[key] || 0) + 1;
            }
            if (property === "bulkWrite")
              counts.bulkWriteOperations =
                (counts.bulkWriteOperations || 0) + arguments_[0].length;
            return value.apply(target, arguments_);
          };
        },
      });
    }
    Object.defineProperty(store, "messages", {
      configurable: true,
      get: () => watch(originalMessages, "messages"),
    });
    Object.defineProperty(store, "sessions", {
      configurable: true,
      get: () => watch(originalSessions, "sessions"),
    });
    // The actual history/reconciliation code and Mongo operations run. Only
    // the owning runtime is replaced with synthetic, deterministic pages.
    service.owned = async (_session, path) => {
      counts.runtimeCalls++;
      await new Promise((done) => setTimeout(done, ownerDelayMs));
      if (path === "/snapshot")
        return {
          cursor: "g:1",
          state: { kind: "idle" },
          goal: null,
          plan: session.plan.steps,
        };
      if (path === "/records") return [];
      if (path.startsWith("/items")) {
        const start = Number(
          new URL("http://fixture.invalid" + path).searchParams.get("cursor") ||
            0,
        );
        return {
          data: items.slice(start, start + 100),
          nextCursor: start + 100 < items.length ? String(start + 100) : null,
        };
      }
      throw new Error(`Unexpected fixture runtime call: ${path}`);
    };
    const modes = [
      "first-open",
      "repeat-open",
      ...(persisted ? ["persisted-open"] : []),
      ...(windowed ? ["persisted-window"] : []),
    ];
    for (const mode of modes) {
      const timings = [];
      let result;
      for (let repeat = 0; repeat < repeats; repeat++) {
        counts = { runtimeCalls: 0 };
        const started = performance.now();
        result = await service.history(
          "fixture",
          mode.startsWith("persisted-")
            ? { persistedOnly: true, window: mode === "persisted-window" }
            : undefined,
        );
        timings.push(performance.now() - started);
        assert.equal(result.recoveryError, null);
        assert.equal(
          result.messages.length,
          mode === "persisted-window" ? Math.min(turns, 10) * 2 : turns * 2,
        );
        if (mode.startsWith("persisted-")) {
          assert.equal(counts.runtimeCalls, 0);
          assert.equal(counts["messages.updateOne"], undefined);
          assert.equal(counts["messages.bulkWrite"], undefined);
          assert.equal(counts["sessions.updateOne"], undefined);
        }
      }
      console.log(
        JSON.stringify({
          repo,
          turns,
          mode,
          ownerDelayMs,
          repeats,
          medianMs: +timings.sort((a, b) => a - b)[1].toFixed(2),
          ...counts,
          returnedMessages: result.messages.length,
          payloadBytes: Buffer.byteLength(JSON.stringify(result)),
          recoveryError: result.recoveryError,
        }),
      );
    }
    delete store.messages;
    delete store.sessions;
  }
} finally {
  try {
    await store.client.close();
  } finally {
    await mongo.stop();
  }
}

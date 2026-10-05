import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@redis/client";
import net from "node:net";
import { PlatformReadCache, ValkeyReadCache, publicRows } from "../src/cache";
import {
  startValkey,
  startValkeyCluster,
  valkeyAvailable,
} from "./cache-fixture";

const options = { skip: !valkeyAvailable, timeout: 30000 };
const valid = publicRows<{ id: string; name: string; provider: string }>(
  ["id", "name", "provider"],
  ["id", "name", "provider"],
);
const value = [{ id: "m", name: "Model", provider: "fixture" }];
test(
  "real Valkey: replicas share only safe display data, retain TTL, reconnect flush and fail safely",
  options,
  async (t) => {
    const server = await startValkey();
    t.after(server.stop);
    let one!: PlatformReadCache, two!: PlatformReadCache;
    const left = new ValkeyReadCache(server.url, "test-clear", () =>
      one?.clearLocal(),
    );
    const right = new ValkeyReadCache(server.url, "test-clear", () =>
      two?.clearLocal(),
    );
    // The read-cache constructor uses injected transports so tests control servers.
    one = new PlatformReadCache(
      { enabled: true, namespace: "integration", backend: left },
      {},
    );
    two = new PlatformReadCache(
      { enabled: true, namespace: "integration", backend: right },
      {},
    );
    t.after(() => {
      one.close();
      two.close();
    });
    await Promise.all([one.start(), two.start()]);
    const key = one.key(["tenant", "user"], "models");
    let loads = 0;
    const load = async () => {
      loads++;
      return value;
    };
    await one.read(key, 2000, load, valid, true);
    assert.deepEqual(await two.read(key, 2000, load, valid, true), value);
    assert.equal(loads, 1);
    await left.flush();
    for (let i = 0; i < 20 && two.local.snapshot().entries; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(two.local.snapshot().entries, 0);
    const client = createClient({ url: server.url });
    client.on("error", () => {});
    await client.connect();
    t.after(() => {
      if (client.isOpen) client.destroy();
    });
    assert.ok((await client.pTTL(key)) > 0);
    const raw = await client.get(key);
    assert.equal(raw!.includes("apiKey"), false);
    await client.set(key, "invalid-json", { PX: 1000 });
    two.local.clear();
    await two.read(key, 2000, load, valid, true);
    assert.equal(loads, 2);
    await client.sendCommand(["CLIENT", "PAUSE", "200", "ALL"]);
    const start = performance.now();
    assert.equal(await left.get(key), null);
    assert.ok(performance.now() - start < 500);
    assert.ok(left.counters.errors > 0);
    await server.stop();
    one.local.clear();
    assert.deepEqual(await one.read(key, 2000, load, valid, true), value);
    assert.equal(loads, 3);
  },
);

test(
  "written GET with a blackholed reply respects the end-to-end deadline",
  options,
  async (t) => {
    const server = await startValkey();
    t.after(server.stop);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((incoming) => {
      sockets.add(incoming);
      const upstream = net.connect(server.port, "127.0.0.1");
      sockets.add(upstream);
      let blocked = false;
      incoming.on("data", (data) => {
        if (data.includes(Buffer.from("\r\nGET\r\n"))) blocked = true;
        upstream.write(data);
      });
      upstream.on("data", (data) => {
        if (!blocked) incoming.write(data);
      });
      incoming.on("error", () => upstream.destroy());
      upstream.on("error", () => incoming.destroy());
      incoming.on("close", () => {
        sockets.delete(incoming);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        incoming.destroy();
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => proxy.close(() => r()));
    });
    const cache = new ValkeyReadCache(
      `redis://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
      "blackhole",
      () => {},
      false,
      30,
    );
    t.after(() => cache.close());
    await cache.start();
    const started = performance.now();
    assert.equal(await cache.get("blackhole-key"), null);
    assert.ok(performance.now() - started < 300);
    assert.ok(cache.counters.errors > 0);
  },
);
test(
  "real Valkey recovers commands and invalidation after a command deadline",
  options,
  async (t) => {
    const server = await startValkey();
    t.after(server.stop);
    let clears = 0;
    const cache = new ValkeyReadCache(
      server.url,
      "recovery",
      () => {
        clears++;
      },
      false,
      30,
    );
    const admin = createClient({ url: server.url });
    admin.on("error", () => {});
    t.after(() => {
      cache.close();
      if (admin.isOpen) admin.destroy();
    });
    await Promise.all([cache.start(), admin.connect()]);
    await admin.set("recover", "healthy", { PX: 5000 });
    await admin.sendCommand(["CLIENT", "PAUSE", "120", "ALL"]);
    assert.equal(await cache.get("recover"), null);
    assert.ok(cache.counters.errors > 0);
    let value: string | null = null;
    for (let attempt = 0; attempt < 20 && value === null; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      value = await cache.get("recover");
    }
    assert.equal(
      value,
      "healthy",
      "deadline fallback must not permanently disconnect the cache",
    );
    const before = clears;
    await admin.publish("recovery", "clear");
    for (let attempt = 0; attempt < 20 && clears === before; attempt++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      clears,
      before + 1,
      "recovered subscriber delivers exactly one invalidation",
    );
  },
);
test(
  "real Valkey Pub/Sub clears remote pending/local display fills",
  options,
  async (t) => {
    const server = await startValkey();
    t.after(server.stop);
    let cleared = 0;
    const a = new ValkeyReadCache(server.url, "invalidations", () => {});
    const b = new ValkeyReadCache(server.url, "invalidations", () => {
      cleared++;
    });
    t.after(() => {
      a.close();
      b.close();
    });
    await Promise.all([a.start(), b.start()]);
    const before = cleared;
    await a.flush();
    for (let i = 0; i < 20 && cleared === before; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(cleared > before);
  },
);
test(
  "real three-primary Valkey cluster supports selected commands and invalidation",
  options,
  async (t) => {
    const server = await startValkeyCluster();
    t.after(server.stop);
    let cleared = 0;
    const cache = new ValkeyReadCache(
      server.url,
      "cluster-clear",
      () => {
        cleared++;
      },
      true,
      200,
    );
    t.after(() => cache.close());
    await cache.start();
    await cache.set("different-slot:a", "one", 1000);
    await cache.set("different-slot:b", "two", 1000);
    assert.equal(await cache.get("different-slot:a"), "one");
    assert.equal(await cache.get("different-slot:b"), "two");
    const before = cleared;
    await cache.flush();
    for (let i = 0; i < 20 && cleared === before; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(cleared > before);
  },
);

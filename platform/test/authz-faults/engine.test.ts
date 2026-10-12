// Dedicated destructive-to-fixture fault suite: never run concurrently with
// benchmarks/integration suites. Only named truex-authz-poc services are killed.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { testEnvironment } from "../environment";
import {
  pocEngine,
  type EngineKind,
  type PocEngine,
} from "../authz-integration/poc-engine";
import {
  component,
  compileComponent,
  componentFixture,
} from "../authz-integration/poc-components";

const run = promisify(execFile);
async function compose(...args: string[]) {
  return run(
    "docker",
    ["compose", "-f", "infra/authz/compose.poc.yml", ...args],
    {
      cwd: resolve(".."),
      env: testEnvironment(),
      timeout: 30_000,
      maxBuffer: 100_000,
    },
  );
}
async function faultProxy(kind: EngineKind) {
  const base = `http://127.0.0.1:${kind === "openfga" ? 18088 : 18089}`;
  let drop = false;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1_000_000)
          throw new Error("Fixture proxy body exceeds limit");
        chunks.push(buffer);
      }
      if (!req.url?.startsWith("/") || req.url.startsWith("//"))
        throw new Error("Invalid fixture path");
      const upstream = await fetch(base + req.url, {
        method: req.method,
        headers: {
          Authorization: "Bearer truex-poc-fixture-only",
          "Content-Type": "application/json",
        },
        body: ["GET", "HEAD"].includes(req.method ?? "")
          ? undefined
          : Buffer.concat(chunks),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const body = await upstream.text();
      if (
        drop &&
        upstream.ok &&
        /\/write$/.test(req.url) &&
        (req.url.includes("relationships") || req.url.startsWith("/stores/"))
      ) {
        drop = false;
        // Consume the successful backend response before losing the client
        // response. This proves an unknown outcome with a real persisted write.
        req.socket.destroy();
        return;
      }
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(body);
    } catch {
      req.socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    dropNextWrite() {
      drop = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

for (const kind of ["openfga", "spicedb"] as EngineKind[]) {
  test(
    `${kind}: dropped write response and engine crash preserve isolation`,
    { timeout: 120_000 },
    async (t) => {
      const proxy = await faultProxy(kind);
      let cleanupEngine: PocEngine | undefined;
      t.after(async () => {
        try {
          await compose("up", "-d", "--no-deps", "--pull", "never", kind);
          await cleanupEngine?.close();
        } finally {
          await proxy.close();
        }
      });
      const engine = await pocEngine(kind, true, proxy.port);
      cleanupEngine = engine;
      const f = componentFixture();
      const membership = f.tuples.find(
        (tuple) =>
          tuple.object === f.group.version && tuple.relation === "member",
      )!;
      await engine.write(f.tuples.filter((tuple) => tuple !== membership));
      const check = (active = f.active) =>
        engine.check(f.user("reader"), "can_read", f.owned.alias, { active });
      assert.equal(await check(), false);
      proxy.dropNextWrite();
      await assert.rejects(engine.write([membership]));
      assert.equal(await check(), true);

      const next = component(f.tenant, "group", "readers");
      const nextPayload = compileComponent(next, []);
      await engine.write(nextPayload);
      const current = { ...f.active, [next.alias]: next.version };
      assert.equal(await check(current), false);

      // Kill only this isolated engine process. PostgreSQL and fixture data remain.
      await compose("kill", "-s", "SIGKILL", kind);
      await assert.rejects(check(current));
      await compose("up", "-d", "--no-deps", "--pull", "never", kind);
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          assert.equal(await check(current), false);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      assert.equal(await check(), true); // Old grant survived the actual restart.
      assert.equal(await check(current), false);

      // Restoring only the old graph cannot satisfy the current immutable head.
      await engine.remove(nextPayload);
      assert.equal(await check(), true);
      assert.equal(await check(current), false);
      await engine.write(nextPayload);
      assert.equal(await check(current), false);
    },
  );
}

// Runs the shipped JS entrypoint against isolated fixtures, never platform/.env.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
import { resolve } from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Store as PlatformStore } from "../src/persistence/store";

const platform = resolve(__dirname, "..");
const entry = resolve(platform, "dist/platform/src/index.js");
const requireCompiled = createRequire(resolve(platform, "package.json"));

async function main() {
  assert.ok(existsSync(entry), "Run npm run build before test:compiled");
  const { Store } = requireCompiled(
    resolve(platform, "dist/platform/src/persistence/store.js"),
  ) as { Store: typeof PlatformStore };
  const mongo = await MongoMemoryServer.create();
  let store: PlatformStore | undefined;
  let child: ChildProcess | undefined;
  let logs = "";
  let turns = 0;
  const core = createServer(async (req, res) => {
    for await (const _ of req);
    const path = new URL(req.url!, "http://fixture").pathname;
    const value =
      path === "/healthz"
        ? { ok: true }
        : path === "/threads"
          ? { threadId: "compiled-thread" }
          : path.endsWith("/turns")
            ? { turnId: `turn-${++turns}`, steer: false }
            : path.endsWith("/records")
              ? []
              : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  });
  try {
    store = new Store(mongo.getUri(), "compiled_smoke", "compiled_smoke");
    await store.connect();
    await store.profiles.insertOne({
      _id: "fixture-model",
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "fixture-model",
      apiKey: "fixture-key",
      wireApi: "responses",
    });
    await store.agents.insertOne({
      _id: "assistant",
      name: "Compiled fixture",
      modelProfileId: "fixture-model",
      systemPrompt: "Fixture only",
      mcpProfileIds: [],
    });
    await new Promise<void>((done) => core.listen(0, "127.0.0.1", done));
    const corePort = (core.address() as { port: number }).port;
    const reservation = createPortServer();
    await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done) => reservation.close(() => done()));
    child = spawn(process.execPath, [entry], {
      cwd: platform,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: "/nonexistent",
        HOST: "127.0.0.1",
        PORT: String(port),
        MONGO_URI: mongo.getUri(),
        MONGO_DB: "compiled_smoke",
        CATALOG_MONGO_DB: "compiled_smoke",
        AGENT_CORE_URLS: `http://127.0.0.1:${corePort}`,
        AGENTCORE_RUNTIME_ARN: "",
        AUTH_MODE: "dev",
        ALLOW_DEV_TENANT: "on",
        DEV_TENANT_ID: "default",
        DEV_TENANT_HEADER: "off",
        DEV_USER_ID: "compiled-user",
        DEV_USER_EMAIL: "compiled-user@dev.local",
        DEV_USER_ROLE: "admin",
        DEV_USER_HEADER: "off",
        FRONTEND_ORIGIN: "http://localhost:3000",
        ADMIN_ORIGIN: "",
        DEMO_TENANT_ID: "",
        APPROVAL_MODES: "off",
        MODEL_GATEWAY_URL: "",
        MODEL_GATEWAY_SECRET: "",
        RESEND_API_KEY: "",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => (logs += data));
    child.stderr?.on("data", (data) => (logs += data));
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    while (
      !(await fetch(`${base}/livez`, { signal: AbortSignal.timeout(1_000) })
        .then((r) => r.ok)
        .catch(() => false))
    ) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Compiled startup failed: ${logs}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    const health = await fetch(`${base}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const me = await fetch(`${base}/api/me`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("Cache-Control"), "no-store");
    assert.equal(
      (
        await fetch(`${base}/api/schemas/fixture`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).status,
      403,
    );
    const send = (path: string, body: unknown, origin?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(body),
      });
    const denied = await send(
      "/api/sessions",
      { agentId: "assistant" },
      "http://foreign.invalid",
    );
    assert.equal(denied.status, 403);
    const created = await send("/api/sessions", { agentId: "assistant" });
    const session = await created.json();
    assert.equal(created.status, 201, JSON.stringify(session));
    assert.equal(typeof session._id, "string");
    const body = { text: "Compiled fixture", clientId: "compiled-client" };
    const accepted = await send(`/api/sessions/${session._id}/messages`, body);
    assert.equal(accepted.status, 202, await accepted.text());
    const duplicate = await send(`/api/sessions/${session._id}/messages`, body);
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(turns, 1, "Duplicate send must not dispatch a second turn");
    assert.equal(
      (
        await store.messages.findOne({
          _id: `${session._id}:user:compiled-client`,
        })
      )?.delivery,
      "accepted",
    );
    const exit = await stopChild(child);
    child = undefined;
    assert.deepEqual(
      exit,
      { code: 0, signal: null },
      "Compiled platform should shut down cleanly",
    );
    console.log(
      "Compiled entrypoint verified: health, middleware refusal, create/send, duplicate receipt, persistence and clean shutdown.",
    );
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (child) await stopChild(child);
      },
      async () => {
        core.closeAllConnections();
        await new Promise<void>((done) => core.close(() => done()));
      },
      async () => {
        await store?.client.close();
      },
      async () => {
        await mongo.stop();
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Compiled smoke fixture cleanup failed",
      );
  }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { code: child.exitCode, signal: child.signalCode };
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try {
    return await exit;
  } finally {
    clearTimeout(timer);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

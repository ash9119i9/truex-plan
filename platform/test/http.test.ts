import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn, ChildProcess } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store";
import { insertFixtures } from "./fixtures";
const root = resolve("..");
async function port() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const value = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
async function wait(predicate: () => Promise<boolean>, timeout = 20000) {
  const begin = Date.now();
  while (!(await predicate().catch(() => false))) {
    if (Date.now() - begin > timeout)
      throw new Error("Timed out waiting for HTTP integration");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((r) => {
    child.once("exit", () => r());
    setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 6000).unref();
  });
}
test(
  "HTTP: disconnected final persistence, idempotent messages, cold-open history and agent-core restart",
  { timeout: 90000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-http-"));
    mkdirSync(join(home, "workspace"));
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "http_test").connect();
    const corePort = await port(),
      platformPort = await port();
    let count = 0;
    const requests: any[] = [];
    const provider = httpServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
      const n = ++count;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (x: any) =>
        res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
      emit({ type: "response.created", response: { id: "r" + n } });
      emit({
        type: "response.output_item.added",
        item: { type: "message", id: "m" + n, role: "assistant", content: [] },
      });
      await new Promise((r) => setTimeout(r, 100));
      emit({
        type: "response.output_text.delta",
        delta: "HTTP fixture reply " + n,
      });
      emit({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "m" + n,
          role: "assistant",
          content: [{ type: "output_text", text: "HTTP fixture reply " + n }],
        },
      });
      emit({
        type: "response.completed",
        response: {
          id: "r" + n,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const providerPort = (provider.address() as any).port;
    await insertFixtures(store);
    await store.profiles.updateOne(
      { _id: "default" },
      {
        $set: {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          apikey: "http-fixture-key",
        },
      },
    );
    let logs = "";
    const launch = (service: string, extra: any) => {
      const child = spawn(
        process.execPath,
        [
          resolve(root, service, "node_modules/tsx/dist/cli.mjs"),
          "src/index.ts",
        ],
        {
          cwd: resolve(root, service),
          env: { ...process.env, ...extra },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (x) => (logs += x));
      child.stderr?.on("data", (x) => (logs += x));
      return child;
    };
    const coreEnv = {
      PORT: String(corePort),
      PROJECT_ROOT: root,
      CODEX_HOME: join(home, "codex"),
      AGENT_WORKSPACE: join(home, "workspace"),
    };
    let core = launch("agent-core", coreEnv);
    const platform = launch("platform", {
      PORT: String(platformPort),
      MONGO_URI: mongo.getUri(),
      MONGO_DB: "http_test",
      AGENT_CORE_URLS: `http://127.0.0.1:${corePort}`,
      AGENT_WORKSPACE: join(home, "workspace"),
    });
    t.after(async () => {
      await Promise.all([stop(core), stop(platform)]);
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      await store.client.close();
      await mongo.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const call = async (path: string, body?: any) => {
      const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data) + "\n" + logs);
      return data;
    };
    await wait(async () => {
      const res = await fetch(`http://127.0.0.1:${platformPort}/healthz`);
      return res.ok;
    });
    const health = await call("/healthz");
    assert.ok(health.agentCore.codex);
    assert.ok(health.mongo);
    const session = await call("/api/sessions", { agentId: "assistant" });
    const message = { text: "Hello", clientId: "http-message-1" };
    const first = await call(`/api/sessions/${session._id}/messages`, message);
    const duplicate = await call(
      `/api/sessions/${session._id}/messages`,
      message,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.turnId, first.turnId);
    // No SSE subscriber exists throughout the turn.
    await wait(
      async () =>
        (await store.messages.countDocuments({
          sessionId: session._id,
          role: "assistant",
        })) === 1,
    );
    const history = await call(`/api/sessions/${session._id}`);
    assert.equal(history.messages.length, 2, JSON.stringify(history.messages));
    assert.equal(history.messages[1].text, "HTTP fixture reply 1");
    assert.equal(JSON.stringify(history).includes("http-fixture-key"), false);
    assert.equal(
      (await call(`/api/sessions/${session._id}/timings`)).turns.length,
      1,
    );
    await stop(core);
    core = launch("agent-core", coreEnv);
    await wait(async () => {
      const res = await fetch(`http://127.0.0.1:${corePort}/healthz`);
      return res.ok;
    });
    await call(`/api/sessions/${session._id}/messages`, {
      text: "What did you say?",
      clientId: "http-message-2",
    });
    await wait(
      async () =>
        (await store.messages.countDocuments({
          sessionId: session._id,
          role: "assistant",
        })) === 2,
    );
    assert.match(JSON.stringify(requests.at(-1).input), /HTTP fixture reply 1/);
    const reopened = await call(`/api/sessions/${session._id}`);
    assert.equal(reopened.messages.length, 4);
    assert.equal(logs.includes("http-fixture-key"), false);
  },
);

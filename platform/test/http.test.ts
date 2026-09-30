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
    // The catalog is pinned on both sides: the spawned platform loads
    // platform/.env, whose CATALOG_MONGO_DB would otherwise win.
    const store = await new Store(
      mongo.getUri(),
      "http_test",
      "http_test",
    ).connect();
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
      if (n === 3) {
        emit({ type: "response.created", response: { id: "visual-fixture" } });
        emit({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "visual-call",
            name: "create_visualization",
            arguments: JSON.stringify({
              title: "Chart fixture",
              description: "Saved chart",
              html: '<div id="chart">Fixture chart</div><script>document.getElementById("chart").textContent="Interactive chart";</script>',
            }),
          },
        });
        emit({
          type: "response.completed",
          response: {
            id: "visual-fixture",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
        return;
      }
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
      CATALOG_MONGO_DB: "http_test",
      // Exempt from the private-address check, so no real DNS lookup runs.
      MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
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
    const invalidRequest = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(invalidRequest.status, 400);
    assert.equal((await invalidRequest.json()).error, "agentId is required");
    for (const targetPort of [platformPort, corePort]) {
      const malformed = await fetch(`http://127.0.0.1:${targetPort}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).code, "INVALID_JSON");
    }
    const health = await call("/healthz");
    assert.deepEqual(health, {
      ok: true,
      mongo: true,
      agentCore: { ok: true },
    });
    for (const path of [
      "/api/capabilities",
      "/api/schemas/ThreadStartParams",
    ]) {
      const response = await fetch(`http://127.0.0.1:${platformPort}${path}`);
      assert.equal(response.status, 403);
    }
    await store.sessions.insertOne({
      _id: "legacy",
      agentId: "assistant",
      threadId: "old",
      agentCoreHost: "http://127.0.0.1:" + corePort,
      status: "active",
      cwd: root,
      createdAt: new Date().toISOString(),
    });
    for (const path of [
      "/api/sessions/legacy",
      "/api/sessions/legacy/events",
    ]) {
      const response = await fetch(`http://127.0.0.1:${platformPort}${path}`);
      assert.equal(response.status, 409);
    }
    assert.equal(
      (await call("/api/sessions")).some((s: any) => s._id === "legacy"),
      false,
    );
    const connector = await call("/api/mcp", {
      name: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      auth: { kind: "none" },
    });
    assert.ok(connector.id);
    await call("/api/agents/assistant/mcp");
    const local = await fetch(`http://127.0.0.1:${platformPort}/api/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "local",
        transport: "stdio",
        command: "sh",
      }),
    });
    assert.equal(local.status, 422);
    const session = await call("/api/sessions", { agentId: "assistant" });
    const capabilities = await call("/api/assistant-capabilities");
    assert.deepEqual(
      capabilities.map((c: any) => c.id),
      [
        "explain",
        "questions",
        "web",
        "documents",
        "visualize",
        "goals",
        "collaboration",
      ],
    );
    const document = await call(`/api/sessions/${session._id}/documents`, {
      name: "notes.txt",
      base64: Buffer.from("Conversation document").toString("base64"),
    });
    const documents = await call(`/api/sessions/${session._id}/documents`);
    assert.equal(documents.available, true);
    assert.equal(documents.files[0].id, document.id);
    assert.doesNotMatch(
      JSON.stringify(documents),
      /business-workspaces|\.runtime|cwd/,
    );
    const download = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions/${session._id}/documents/${document.id}`,
    );
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition") || "",
      /attachment/,
    );
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await download.text(), "Conversation document");
    const otherSession = await call("/api/sessions", { agentId: "assistant" });
    const inaccessible = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions/${otherSession._id}/documents/${document.id}`,
    );
    assert.equal(inaccessible.status, 404);
    assert.equal(
      (await inaccessible.json()).error,
      "File not found in this conversation",
    );
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
    assert.doesNotMatch(
      JSON.stringify(history.session),
      /cwd|agentCoreHost|threadId|runtimeStartup/,
    );
    const denied = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions/${session._id}/capabilities`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "command/exec",
          params: { command: ["pwd"] },
        }),
      },
    );
    assert.equal(denied.status, 403);
    const timingData = await call(`/api/sessions/${session._id}/timings`);
    assert.equal(timingData.turns.length, 1);
    assert.ok(timingData.turns[0].totalMs > 0);
    const settings = await call(`/api/sessions/${session._id}/capabilities`, {
      method: "thread/settings/update",
      params: { effort: "low" },
    });
    assert.deepEqual(settings, { ok: true });
    const goal = await call(`/api/sessions/${session._id}/capabilities`, {
      method: "thread/goal/get",
      params: {},
    });
    assert.equal(goal.goal, null);
    for (const [method, params] of [
      ["thread/settings/update", { cwd: root }],
      ["thread/fork", { config: { "features.shell_tool": true } }],
    ]) {
      const rejected = await fetch(
        `http://127.0.0.1:${platformPort}/api/sessions/${session._id}/capabilities`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, params }),
        },
      );
      assert.equal(rejected.status, 403);
    }
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
    await call(`/api/sessions/${session._id}/messages`, {
      text: "Create a visualization",
      clientId: "http-visualization",
    });
    await wait(
      async () =>
        (await store.messages.countDocuments({
          sessionId: session._id,
          role: "assistant",
        })) === 3,
    );
    const savedFiles = await call(`/api/sessions/${session._id}/documents`);
    assert.equal(savedFiles.visualizationAvailable, true);
    const visual = savedFiles.files.find(
      (file: any) => file.kind === "visualization",
    );
    assert.ok(visual);
    const visualPath = `/api/sessions/${session._id}/visualizations/${visual.id}`;
    assert.match((await call(visualPath)).html, /Fixture chart/);
    const crossSession = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions/${otherSession._id}/visualizations/${visual.id}`,
    );
    assert.equal(crossSession.status, 404);
    const rawDownload = await fetch(
      `http://127.0.0.1:${platformPort}/api/sessions/${session._id}/documents/${visual.id}`,
    );
    assert.equal(
      rawDownload.status,
      400,
      "Raw executable HTML must not be exported through the document endpoint",
    );
    await stop(core);
    core = launch("agent-core", coreEnv);
    await wait(
      async () => (await fetch(`http://127.0.0.1:${corePort}/healthz`)).ok,
    );
    assert.equal((await call(visualPath)).title, "Chart fixture");
  },
);

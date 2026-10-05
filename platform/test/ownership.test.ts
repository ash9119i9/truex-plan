import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn, execFile, ChildProcess } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/store";
import { insertFixtures } from "./fixtures";
import { decide } from "../src/access";
import { POLICY_VERSION } from "../src/public";
import { tenantDbName, type TenantRef } from "../src/tenant";
import { ROLE_HEADER, USER_HEADER } from "../src/user";

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
      throw new Error("Timed out waiting for the platform");
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
function tenantDoc(id: string) {
  const now = new Date().toISOString();
  return {
    _id: id,
    name: id.toUpperCase(),
    dbName: tenantDbName(id),
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
}

test("access rules: owner, admin, other user, ownerless", () => {
  const ashok = { id: "ashok", email: "a@x", role: "user" as const };
  const dharun = { id: "dharun", email: "d@x", role: "user" as const };
  const admin = { id: "admin", email: "ad@x", role: "admin" as const };
  for (const v of ["own", "all"] as const) {
    assert.equal(decide("ashok", "read", ashok, v), "allow");
    assert.equal(decide("ashok", "write", ashok, v), "allow");
    assert.equal(decide("ashok", "read", admin, v), "allow");
    assert.equal(decide("ashok", "write", admin, v), "readOnly");
    assert.equal(decide(undefined, "read", admin, v), "allow");
    assert.equal(decide(undefined, "write", admin, v), "readOnly");
    assert.equal(decide(undefined, "read", dharun, v), "hidden");
    assert.equal(decide(undefined, "write", dharun, v), "hidden");
    // Background work (ingestion, polling, cold resume) has no user.
    assert.equal(decide("ashok", "write", undefined, v), "allow");
  }
  assert.equal(decide("ashok", "read", dharun, "own"), "hidden");
  assert.equal(decide("ashok", "write", dharun, "own"), "hidden");
  assert.equal(decide("ashok", "read", dharun, "all"), "allow");
  assert.equal(decide("ashok", "write", dharun, "all"), "readOnly");
});

// Every /api/sessions/:id route must reach sessionFor before touching the
// session: directly, or through a service method that calls it.
test("route coverage: every /api/sessions/:id route goes through sessionFor", () => {
  const index = readFileSync(resolve("src/index.ts"), "utf8");
  const service = readFileSync(resolve("src/service.ts"), "utf8");
  // Service methods that enforce access: they call sessionFor, or call one
  // that does.
  const bodies = new Map<string, string>();
  const heads = [...service.matchAll(/^  (?:async )?(\w+)\(/gm)];
  heads.forEach((m, i) =>
    bodies.set(m[1], service.slice(m.index!, heads[i + 1]?.index)),
  );
  const enforcing = new Set(["sessionFor"]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of bodies)
      if (
        !enforcing.has(name) &&
        [...enforcing].some((e) => body.includes(`this.${e}(`))
      ) {
        enforcing.add(name);
        changed = true;
      }
  }
  // session() itself is not an access check.
  assert.equal(enforcing.has("session"), false);

  const starts = [...index.matchAll(/http\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g)];
  const routes = starts
    .map((m, i) => ({
      key: `${m[1].toUpperCase()} ${m[2]}`,
      path: m[2],
      body: index.slice(m.index!, starts[i + 1]?.index ?? index.length),
    }))
    .filter((r) => r.path.startsWith("/api/sessions/:id"));
  // The plan's read/write table. Routes enforced inside a service method list
  // the mode that method uses; "method" means it depends on the capability.
  const expected: Record<string, "read" | "write" | "method"> = {
    "GET /api/sessions/:id": "read",
    "GET /api/sessions/:id/events": "read",
    "GET /api/sessions/:id/traces": "read",
    "GET /api/sessions/:id/timings": "read",
    "GET /api/sessions/:id/turns/:turnId/context": "read",
    "GET /api/sessions/:id/goal/history": "read",
    "GET /api/sessions/:id/documents": "read",
    "GET /api/sessions/:id/documents/:fileId": "read",
    "GET /api/sessions/:id/visualizations/:fileId": "read",
    "GET /api/sessions/:id/agents": "read",
    "GET /api/sessions/:id/agents/:agentId": "read",
    "POST /api/sessions/:id/capabilities": "method",
    "POST /api/sessions/:id/messages": "write",
    "POST /api/sessions/:id/interrupt": "write",
    "POST /api/sessions/:id/agents/:agentId/interrupt": "write",
    "POST /api/sessions/:id/approvals/:requestId": "write",
    "POST /api/sessions/:id/approval-mode": "write",
    "POST /api/sessions/:id/project": "write",
    "POST /api/sessions/:id/documents": "write",
    "POST /api/sessions/:id/goal/review": "write",
  };
  assert.deepEqual(routes.map((r) => r.key).sort(), Object.keys(expected).sort());
  for (const r of routes) {
    const direct = [...r.body.matchAll(/service\.sessionFor\([^,]+,\s*"(\w+)"\)/g)];
    const via = [...r.body.matchAll(/service\.(\w+)\(/g)]
      .map((m) => m[1])
      .filter((name) => name !== "sessionFor" && enforcing.has(name));
    assert.ok(direct.length || via.length, `${r.key} skips sessionFor`);
    // A bare session() load must only ever follow the access check.
    const bare = r.body.indexOf("service.session(");
    if (bare >= 0)
      assert.ok(
        direct.length && direct[0].index! < bare,
        `${r.key} loads the session before checking access`,
      );
    const mode = expected[r.key];
    if (direct.length)
      assert.ok(
        direct.every((m) => m[1] === mode),
        `${r.key} should check "${mode}"`,
      );
    else if (mode !== "method")
      for (const name of via)
        assert.match(
          bodies.get(name)!,
          new RegExp(`this\\.sessionFor\\(\\w+, "${mode}"\\)`),
          `${r.key}: ${name} should check "${mode}"`,
        );
  }
});

test("tenant CLI: chat-visibility, including the implicit default tenant", { timeout: 60000 }, async (t) => {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "cli_test", "cli_catalog").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  const env = {
    ...process.env,
    MONGO_URI: mongo.getUri(),
    MONGO_DB: "cli_test",
    CATALOG_MONGO_DB: "cli_catalog",
  };
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [resolve(root, "scripts/tenant.mjs"), ...args], { env });
  await store.tenantRegistry.insertOne(tenantDoc("t1"));
  assert.equal((await store.resolveTenant("t1")).chatVisibility, undefined);
  await run("chat-visibility", "t1", "own");
  assert.equal((await store.tenantRegistry.findOne({ _id: "t1" }))?.chatVisibility, "own");
  // Not registered yet: the command registers it.
  await run("chat-visibility", "default", "own");
  const def = await store.tenantRegistry.findOne({ _id: "default" });
  assert.equal(def?.chatVisibility, "own");
  assert.equal(def?.dbName, "cli_test");
  await run("chat-visibility", "default", "all");
  assert.equal((await store.tenantRegistry.findOne({ _id: "default" }))?.chatVisibility, "all");
  await assert.rejects(run("chat-visibility", "t1", "everyone"), /usage: chat-visibility/);
  await assert.rejects(run("chat-visibility", "nobody", "own"), /not registered/);
  assert.match((await run("list")).stdout, /t1\tactive.*chats=own/);
  // TenantRef carries it (fresh store: resolveTenant caches).
  const fresh = await new Store(mongo.getUri(), "cli_test", "cli_catalog").connect();
  t.after(() => fresh.client.close());
  assert.equal((await fresh.resolveTenant("t1")).chatVisibility, "own");
  assert.equal((await fresh.resolveTenant("default")).chatVisibility, "all");
  assert.equal((await fresh.activeTenants()).find((x) => x.id === "t1")?.chatVisibility, "own");
});

test(
  "HTTP: chat ownership and visibility across users and tenants",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "own_test", "own_test").connect();
    await store.tenantRegistry.insertMany([tenantDoc("t1"), tenantDoc("t2")]);
    for (const id of ["t1", "t2"])
      await store.withTenant(await store.resolveTenant(id), () => insertFixtures(store));

    // A fake agent-core that answers every thread call. Access is decided
    // before the platform calls it, so its answers only matter for allowed
    // callers.
    let threads = 0;
    const core = httpServer(async (req, res) => {
      for await (const _ of req);
      const path = new URL(req.url!, "http://x").pathname;
      const reply = (value: unknown) =>
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      if (path === "/threads") return reply({ threadId: "th-" + ++threads });
      if (path.endsWith("/events")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": open\n\n");
        return;
      }
      if (path.endsWith("/records") || path.endsWith("/agents") || path.endsWith("/documents") && req.method === "GET")
        return reply([]);
      if (path.endsWith("/items")) return reply({ data: [] });
      if (path.endsWith("/turns")) return reply({ turnId: "turn-1" });
      if (path.includes("/agents/a1") && !path.endsWith("/interrupt"))
        return reply({ agent: { threadId: "a1" }, messages: [] });
      if (path.includes("/documents/"))
        return reply({ kind: "document", mediaType: "text/plain", name: "a.txt", base64: "aGk=" });
      if (path.endsWith("/capabilities")) return reply({ goal: null });
      return reply({});
    });
    await new Promise<void>((r) => core.listen(0, "127.0.0.1", r));
    const coreUrl = `http://127.0.0.1:${(core.address() as any).port}`;
    const platformPort = await port();
    let logs = "";
    const platform = spawn(
      process.execPath,
      [resolve(root, "platform/node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
      {
        cwd: resolve(root, "platform"),
        env: {
          ...process.env,
          PORT: String(platformPort),
          MONGO_URI: mongo.getUri(),
          MONGO_DB: "own_test",
          CATALOG_MONGO_DB: "own_test",
          AGENT_CORE_URLS: coreUrl,
          AUTH_MODE: "dev",
          DEV_USER_HEADER: "on",
          DEV_TENANT_HEADER: "on",
          APPROVAL_MODES: "on",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    platform.stdout?.on("data", (x) => (logs += x));
    platform.stderr?.on("data", (x) => (logs += x));
    t.after(async () => {
      await stop(platform);
      core.closeAllConnections();
      await new Promise<void>((r) => core.close(() => r()));
      await store.client.close();
      await mongo.stop();
    });
    await wait(async () => (await fetch(`http://127.0.0.1:${platformPort}/livez`)).ok);

    type Who = "ashok" | "dharun" | "admin";
    const call = async (
      who: Who,
      method: string,
      path: string,
      body?: unknown,
      tenant = "t1",
    ) => {
      const abort = new AbortController();
      const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, {
        method,
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "x-truex-tenant": tenant,
          [USER_HEADER]: who,
          ...(who === "admin" ? { [ROLE_HEADER]: "admin" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const type = response.headers.get("content-type") || "";
      // An open SSE stream: the status is all we need.
      const data = type.includes("event-stream")
        ? null
        : type.includes("json")
          ? await response.json()
          : await response.text();
      abort.abort();
      return { status: response.status, data };
    };
    const ok = async (who: Who, method: string, path: string, body?: unknown, tenant?: string) => {
      const r = await call(who, method, path, body, tenant);
      assert.ok(r.status < 300, `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.data)}\n${logs}`);
      return r.data;
    };

    // Data: the owner is recorded on create; projects get an owner too.
    const chat = await ok("ashok", "POST", "/api/sessions", { agentId: "assistant" });
    assert.equal(chat.userId, "ashok");
    const t1 = await store.resolveTenant("t1");
    const stored = await store.withTenant(t1, () => store.sessions.findOne({ _id: chat._id }));
    assert.equal(stored?.userId, "ashok");
    const dharunChat = await ok("dharun", "POST", "/api/sessions", { agentId: "assistant" });
    const project = await ok("ashok", "POST", "/api/projects", { name: "Ashok's" });
    assert.equal(project.ownerId, "ashok");
    const dharunProject = await ok("dharun", "POST", "/api/projects", { name: "Dharun's" });
    // A chat without an owner (should not exist after the purge).
    const ownerless = "sess_ownerless";
    await store.withTenant(t1, () =>
      store.sessions.insertOne({
        _id: ownerless,
        runtimePolicyVersion: POLICY_VERSION,
        agentId: "assistant",
        threadId: "th-ownerless",
        agentCoreHost: coreUrl,
        status: "active",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        approvals: [],
        timings: [],
      }),
    );
    // Tenant indexes build in the background; catalog cache hits must not be
    // used as an accidental delay before verifying the completed index build.
    await store.ensureTenantIndexes(t1.dbName);
    const indexes = await store.withTenant(t1, () => store.sessions.indexes());
    assert.ok(indexes.some((i) => i.name === "userId_1_createdAt_-1"));

    const id = chat._id;
    const s = `/api/sessions/${id}`;
    const reads: [string, string, unknown?][] = [
      ["GET", s],
      ["GET", `${s}/events`],
      ["GET", `${s}/traces`],
      ["GET", `${s}/timings`],
      ["GET", `${s}/turns/turn-1/context`],
      ["GET", `${s}/goal/history`],
      ["GET", `${s}/documents`],
      ["GET", `${s}/documents/f1`],
      ["GET", `${s}/visualizations/f1`],
      ["GET", `${s}/agents`],
      ["GET", `${s}/agents/a1`],
      ["POST", `${s}/capabilities`, { method: "thread/goal/get", params: {} }],
    ];
    const writes: [string, string, unknown?][] = [
      ["POST", `${s}/messages`, { text: "hi", clientId: "c1" }],
      ["POST", `${s}/interrupt`, {}],
      ["POST", `${s}/agents/a1/interrupt`, {}],
      ["POST", `${s}/approvals/r1`, { result: { decision: "accept" } }],
      ["POST", `${s}/approval-mode`, { mode: "readOnly" }],
      ["POST", `${s}/project`, { projectId: null }],
      ["POST", `${s}/documents`, { name: "a.txt", base64: "aGk=" }],
      ["POST", `${s}/goal/review`, { decision: "accepted" }],
      ["POST", `${s}/capabilities`, { method: "thread/archive", params: {} }],
      ["POST", `${s}/capabilities`, { method: "thread/goal/set", params: { objective: "x" }, command: { clientId: "k1", text: "/goal x" } }],
    ];
    const expectAll = async (who: Who, routes: typeof reads, status: number, code?: string) => {
      for (const [method, path, body] of routes) {
        const r = await call(who, method, path, body);
        // 200 stands for "allowed": writes answer 201 or 202.
        const actual = status === 200 && r.status >= 200 && r.status < 300 ? 200 : r.status;
        assert.equal(actual, status, `${who} ${method} ${path} ${JSON.stringify(body ?? "")}: ${r.status} ${JSON.stringify(r.data)}\n${logs}`);
        if (code) assert.equal(r.data.code, code, `${who} ${method} ${path}`);
      }
    };
    const listed = async (who: Who, tenant = "t1") =>
      ((await ok(who, "GET", "/api/sessions", undefined, tenant)) as any[]).map((x) => x._id).sort();
    const projectsOf = async (who: Who, tenant = "t1") =>
      ((await ok(who, "GET", "/api/projects", undefined, tenant)) as any[]).map((x) => x._id).sort();
    const setVisibility = async (value: "own" | "all") => {
      await store.tenantRegistry.updateOne({ _id: "t1" }, { $set: { chatVisibility: value } });
      // The platform caches tenants briefly; wait for the change to apply.
      const dharunReads = value === "all" ? 200 : 404;
      await wait(async () => (await call("dharun", "GET", `${s}/goal/history`)).status === dharunReads, 15000);
    };

    // --- "own" ---
    await setVisibility("own");
    assert.deepEqual(await listed("dharun"), [dharunChat._id]);
    assert.deepEqual(await listed("ashok"), [id]);
    assert.deepEqual(await listed("admin"), [id, dharunChat._id, ownerless].sort());
    await expectAll("dharun", reads, 404, "SESSION_NOT_FOUND");
    await expectAll("dharun", writes, 404, "SESSION_NOT_FOUND");
    await expectAll("admin", reads, 200);
    await expectAll("admin", writes, 403, "NOT_SESSION_OWNER");
    // Projects are per-user folders.
    assert.deepEqual(await projectsOf("dharun"), [dharunProject._id]);
    assert.deepEqual(await projectsOf("admin"), [project._id, dharunProject._id].sort());
    for (const who of ["dharun", "admin"] as const) {
      const status = who === "admin" ? 403 : 404;
      assert.equal((await call(who, "POST", `/api/projects/${project._id}`, { name: "x" })).status, status);
      assert.equal((await call(who, "POST", `/api/projects/${project._id}/delete`)).status, status);
    }
    // Dharun can't file his own chat into Ashok's folder, nor create one there.
    assert.equal((await call("dharun", "POST", `/api/sessions/${dharunChat._id}/project`, { projectId: project._id })).status, 404);
    assert.equal((await call("dharun", "POST", "/api/sessions", { agentId: "assistant", projectId: project._id })).status, 404);
    // Ownerless chats are admin-only and read-only.
    assert.equal((await call("dharun", "GET", `/api/sessions/${ownerless}/goal/history`)).status, 404);
    assert.equal((await call("admin", "GET", `/api/sessions/${ownerless}/goal/history`)).status, 200);
    assert.equal((await call("admin", "POST", `/api/sessions/${ownerless}/interrupt`, {})).status, 403);

    // --- "all" ---
    await setVisibility("all");
    // Ownerless chats stay hidden from users in every mode.
    assert.deepEqual(await listed("dharun"), [id, dharunChat._id].sort());
    assert.deepEqual(await projectsOf("dharun"), [project._id, dharunProject._id].sort());
    await expectAll("dharun", reads, 200);
    await expectAll("dharun", writes, 403, "NOT_SESSION_OWNER");
    assert.equal((await call("dharun", "GET", `/api/sessions/${ownerless}/goal/history`)).status, 404);
    assert.equal((await call("dharun", "POST", `/api/projects/${project._id}`, { name: "x" })).status, 403);
    assert.equal((await call("dharun", "POST", `/api/sessions/${dharunChat._id}/project`, { projectId: project._id })).status, 403);

    // The owner reads and writes in both modes.
    await expectAll("ashok", reads, 200);
    await expectAll("ashok", writes.slice(0, 7), 200);
    await ok("ashok", "POST", `${s}/project`, { projectId: project._id });
    await ok("ashok", "POST", `/api/projects/${project._id}`, { name: "Renamed" });
    // The owner is fixed: another user's write never changes it.
    assert.equal(
      (await store.withTenant(t1, () => store.sessions.findOne({ _id: id })))?.userId,
      "ashok",
    );

    // --- Tenants never mix ---
    for (const who of ["ashok", "dharun", "admin"] as const) {
      assert.deepEqual(await listed(who, "t2"), []);
      assert.deepEqual(await projectsOf(who, "t2"), []);
      assert.equal((await call(who, "GET", s, undefined, "t2")).status, 404);
      assert.equal((await call(who, "POST", `/api/projects/${project._id}`, { name: "x" }, "t2")).status, 404);
    }
    const other = await ok("ashok", "POST", "/api/sessions", { agentId: "assistant" }, "t2");
    assert.deepEqual(await listed("ashok", "t2"), [other._id]);
    assert.equal((await listed("admin")).includes(other._id), false);
    // Background ingestion keeps running with no user in context.
    assert.doesNotMatch(logs, /persistence ingestion failed/);
  },
);

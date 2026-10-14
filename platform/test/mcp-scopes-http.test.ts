import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Store } from "../src/persistence/store";
import { tenantDbName } from "../src/tenancy/tenant";
import { ROLE_HEADER, USER_HEADER } from "../src/identity/user";
import { insertFixtures } from "./fixtures";
import { createSourceAudit, readPlatformSources } from "./source-guards";

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

// Discover registrations in real source modules after route extraction.
function mcpRoutes() {
  const routes = createSourceAudit(readPlatformSources()).routes.filter((route) =>
    /\/mcp|tenant-mcp/.test(route.path),
  );
  assert.deepEqual(
    routes.map((route) => route.key).sort(),
    [
      "DELETE /api/mcp/:id",
      "DELETE /api/tenant/mcp/:id",
      "GET /api/agents/:id/mcp",
      "GET /api/agents/:id/tenant-mcp",
      "GET /api/mcp",
      "GET /api/tenant/mcp",
      "PATCH /api/mcp/:id",
      "PATCH /api/tenant/mcp/:id",
      "POST /api/agents/:id/mcp",
      "POST /api/agents/:id/tenant-mcp",
      "POST /api/mcp",
      "POST /api/tenant/mcp",
    ],
  );
  return routes;
}

test(
  "HTTP: MCP scope routes, 403 for users on tenant routes, 404 on others' MCPs, legacy form",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "mcp_http",
      "mcp_http",
    ).connect();
    const now = new Date().toISOString();
    await store.tenantRegistry.insertOne({
      _id: "t1",
      name: "T1",
      dbName: tenantDbName("t1"),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const t1 = await store.resolveTenant("t1");
    await store.withTenant(t1, () => insertFixtures(store));

    const core = httpServer(async (req, res) => {
      for await (const _ of req);
      const path = new URL(req.url!, "http://x").pathname;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(path === "/threads" ? { threadId: "th-1" } : {}));
    });
    await new Promise<void>((r) => core.listen(0, "127.0.0.1", r));
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
          MONGO_DB: "mcp_http",
          CATALOG_MONGO_DB: "mcp_http",
          AGENT_CORE_URLS: `http://127.0.0.1:${(core.address() as any).port}`,
          AUTH_MODE: "dev",
          DEV_USER_HEADER: "on",
          DEV_TENANT_HEADER: "on",
          MCP_ENCRYPTION_KEY: "",
          MCP_ENCRYPTION_KEYS: "",
          // Exempt from the private-address check, so no real DNS lookup runs.
          MCP_ALLOWED_PRIVATE_HOSTS: "example.com",
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
    await wait(
      async () => (await fetch(`http://127.0.0.1:${platformPort}/livez`)).ok,
    );

    type Who = "ashok" | "dharun" | "admin";
    const bodies: unknown[] = [];
    const call = async (who: Who, method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${platformPort}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-truex-tenant": "t1",
          [USER_HEADER]: who,
          ...(who === "admin" ? { [ROLE_HEADER]: "admin" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      bodies.push(data);
      return { status: response.status, data };
    };
    const ok = async (who: Who, method: string, path: string, body?: unknown) => {
      const r = await call(who, method, path, body);
      assert.ok(
        r.status < 300,
        `${who} ${method} ${path}: ${r.status} ${JSON.stringify(r.data)}\n${logs}`,
      );
      return r.data;
    };

    const tenant = await ok("admin", "POST", "/api/tenant/mcp", {
      name: "qlik",
      url: "https://example.com/qlik",
      auth: { kind: "header", headerName: "x-api-qlik-key" },
      apiKey: "tenant-key-value",
    });
    await ok("admin", "POST", "/api/agents/assistant/tenant-mcp", {
      profileIds: [tenant.id],
    });
    const mine = await ok("ashok", "POST", "/api/mcp", {
      name: "github",
      url: "https://example.com/github",
      auth: { kind: "bearer" },
      apiKey: "user-key-value",
    });
    assert.equal(mine.scope, "user");

    // Every tenant route answers 403 to a user, and changes nothing.
    const tenantRoutes = mcpRoutes().filter((r) =>
      /\/api\/tenant\/mcp|tenant-mcp/.test(r.path),
    );
    assert.deepEqual(
      tenantRoutes.map((r) => `${r.method} ${r.path}`).sort(),
      [
        "DELETE /api/tenant/mcp/:id",
        "GET /api/agents/:id/tenant-mcp",
        "GET /api/tenant/mcp",
        "PATCH /api/tenant/mcp/:id",
        "POST /api/agents/:id/tenant-mcp",
        "POST /api/tenant/mcp",
      ],
    );
    for (const route of tenantRoutes) {
      const path = route.path
        .replace("/api/agents/:id", "/api/agents/assistant")
        .replace(":id", tenant.id);
      const r = await call(
        "ashok",
        route.method,
        path,
        route.method === "GET" || route.method === "DELETE"
          ? undefined
          : { name: "taken", url: "https://example.com/x", profileIds: [] },
      );
      assert.equal(r.status, 403, `${route.method} ${path}: ${r.status}`);
      assert.equal(r.data.code, "TENANT_ADMIN_REQUIRED");
    }
    assert.deepEqual(
      (await ok("admin", "GET", "/api/agents/assistant/tenant-mcp")).profileIds,
      [tenant.id],
    );

    // Someone else's user MCP is 404 on every route that takes its id.
    for (const [method, path, body] of [
      ["PATCH", `/api/mcp/${mine.id}`, { name: "stolen" }],
      ["DELETE", `/api/mcp/${mine.id}`, undefined],
      ["POST", "/api/agents/assistant/mcp", { profileIds: [mine.id] }],
    ] as const) {
      const r = await call("dharun", method, path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.data.code, "MCP_NOT_FOUND");
    }
    assert.deepEqual(
      (await ok("dharun", "GET", "/api/mcp")).userProfiles,
      [],
    );

    // A user MCP named like a tenant MCP: 409.
    const clash = await call("dharun", "POST", "/api/mcp", {
      name: "qlik",
      url: "https://example.com/q",
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.data.code, "MCP_NAME_RESERVED");

    // LEGACY(frontend-v1): the current form reads profiles and profileIds.
    // A user sees only their own; an admin also sees and saves tenant MCPs.
    const userForm = await ok("ashok", "GET", "/api/agents/assistant/mcp");
    assert.deepEqual(
      userForm.profiles.map((p: any) => p.name),
      ["github"],
    );
    assert.deepEqual(userForm.profileIds, []);
    assert.deepEqual(
      userForm.tenantProfiles.map((p: any) => [p.name, p.urlHost, p.hasKey]),
      [["qlik", "example.com", true]],
    );
    await ok("ashok", "POST", "/api/agents/assistant/mcp", {
      profileIds: [mine.id],
    });
    const adminForm = await ok("admin", "GET", "/api/agents/assistant/mcp");
    assert.deepEqual(
      adminForm.profiles.map((p: any) => [p.name, p.attached]),
      [["qlik", true]],
    );
    assert.deepEqual(adminForm.profileIds, [tenant.id]);
    // Unticking qlik in the admin's form detaches the tenant MCP...
    assert.deepEqual(
      (
        await ok("admin", "POST", "/api/agents/assistant/mcp", {
          profileIds: [],
        })
      ).profileIds,
      [],
    );
    // ...and ticking it again re-attaches it, without touching Ashok's.
    await ok("admin", "POST", "/api/agents/assistant/mcp", {
      profileIds: [tenant.id],
    });
    assert.deepEqual(
      (await ok("ashok", "GET", "/api/agents/assistant/mcp")).profileIds,
      [mine.id],
    );

    // Both MCPs load in Ashok's new chat; only the tenant one in Dharun's.
    const stored = async (id: string) =>
      store.withTenant(t1, () => store.sessions.findOne({ _id: id }));
    const ashokChat = await ok("ashok", "POST", "/api/sessions", {
      agentId: "assistant",
    });
    const dharunChat = await ok("dharun", "POST", "/api/sessions", {
      agentId: "assistant",
    });
    assert.notEqual(
      (await stored(ashokChat._id))?.mcpFingerprint,
      (await stored(dharunChat._id))?.mcpFingerprint,
    );

    // DELETE removes only the caller's own.
    await ok("ashok", "DELETE", `/api/mcp/${mine.id}`);
    assert.deepEqual((await ok("ashok", "GET", "/api/mcp")).userProfiles, []);

    // No response carried a key, its ciphertext or a header value.
    assert.doesNotMatch(
      JSON.stringify(bodies),
      /apiKeyEnc|apiKey|apikey|key-value|x-api-qlik-key"?:\s*"[^"]/,
    );
    assert.doesNotMatch(logs, /tenant-key-value|user-key-value/);
  },
);

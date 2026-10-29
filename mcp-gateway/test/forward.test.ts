import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { signGatewayToken } from "../../shared/gateway-token";
import {
  signMcpCallerToken,
  type McpCallerClaims,
} from "../../shared/mcp-caller-token";
import { createCredentials } from "../src/credentials";
import { createCallerResolver } from "../src/revocation";
import { createEgress, EgressBlockedError } from "../src/egress";
import { createArgumentChecker } from "../src/arguments";
import { createMcpGateway } from "../src/server";
import { sealTokens, type TokenKeys } from "../src/token-crypto";
import { toolHash } from "../src/tool-hash";
import { DEFAULT_TOOLS, McpFixture, SESSION_ID } from "./support/mcp-fixture";

// The gateway against a real (in-memory) Mongo holding the same records the
// platform writes, and a fixture standing in for the provider's MCP server.

const SECRET = "mcp-caller-secret-0123456789abcdef";
const CATALOG = "truex_next_catalog_test";
const ACCEPT = "application/json, text/event-stream";

const tenantId = new ObjectId();
const userId = new ObjectId();
const chatId = new ObjectId();
const connectorId = new ObjectId();
const TENANT_DB = `truex_next_t_${tenantId.toHexString()}`;
const CLAIMS: McpCallerClaims = {
  tenantId: tenantId.toHexString(),
  userId: userId.toHexString(),
  chatId: chatId.toHexString(),
  connector: "fixture",
  revision: 1,
};
const TOKEN = signMcpCallerToken(CLAIMS, SECRET);
const REVIEWED_HASHES = {
  get_issue: toolHash(DEFAULT_TOOLS[0]!),
};
// The member's provider token: no expiry, so these tests never refresh
// (inject.test.ts covers that).
const KEYS: TokenKeys = {
  keys: new Map([["k1", Buffer.alloc(32, 4)]]),
  activeKeyId: "k1",
};
const PROVIDER_TOKEN = "provider-access-forward";

const fixture = new McpFixture();
const redirectTarget = new McpFixture();
const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
let mongo: MongoMemoryServer;
let client: MongoClient;
let catalog: Db;
let tenantDb: Db;
let gateway: Server;
let base = "";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

// The records of one member in one tenant, with one chat that uses the
// fixture connector and an active connection to it.
async function seed(): Promise<void> {
  await Promise.all([catalog.dropDatabase(), tenantDb.dropDatabase()]);
  await catalog.collection("tenants").insertOne({
    _id: tenantId,
    name: "Acme",
    dbName: TENANT_DB,
    kind: "organization",
    status: "active",
    provisioningStatus: "ready",
  });
  await catalog
    .collection("memberships")
    .insertOne({ userId, tenantId, role: "user", status: "active" });
  await catalog.collection("truex_mcp_connectors").insertOne({
    _id: connectorId,
    slug: "fixture",
    enabled: true,
    url: fixture.url,
    revision: 1,
    // Strict default (Task 8): only reviewed tools are offered.
    toolHashes: REVIEWED_HASHES,
  });
  await tenantDb.collection("chats").insertOne({
    _id: chatId,
    ownerId: userId,
    status: "active",
    connectors: [{ connectorId, slug: "fixture" }],
  });
  await tenantDb.collection("mcp_connections").insertOne({
    ownerId: userId,
    connectorId,
    slug: "fixture",
    tenantId,
    status: "active",
    secret: sealTokens(
      KEYS,
      {
        tenantId: tenantId.toHexString(),
        ownerId: userId.toHexString(),
        connectorId: connectorId.toHexString(),
      },
      { accessToken: PROVIDER_TOKEN },
    ),
    revision: 1,
  });
}

function credentials() {
  return createCredentials({
    client,
    keys: KEYS,
    refresh: async () => {
      throw new Error("no refresh in these tests");
    },
  });
}

// tools/call names the fixture's one reviewed tool (Task 8 refuses a call
// without a name).
function rpc(method: string, id = 1) {
  const params =
    method === "tools/call" ? { name: "get_issue", arguments: {} } : {};
  return { jsonrpc: "2.0", id, method, params };
}

// A notification has no id at all (an explicit `undefined` would still take
// rpc's default).
function notify(method: string) {
  return { jsonrpc: "2.0", method, params: {} };
}

interface PostOptions {
  readonly token?: string | null;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly to?: string;
}

function post(body: unknown, options: PostOptions = {}): Promise<Response> {
  const token = options.token === undefined ? TOKEN : options.token;
  return fetch(`${options.to ?? base}${options.path ?? "/mcp/fixture"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("MCP gateway: caller checks and forwarding", () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    catalog = client.db(CATALOG);
    tenantDb = client.db(TENANT_DB);
    await fixture.start();
    await redirectTarget.start();
    gateway = createMcpGateway({
      secret: SECRET,
      resolveCaller: createCallerResolver(client, CATALOG),
      argumentChecker: createArgumentChecker(),
      credentials: credentials(),
      egress: createEgress({ allowLoopback: true }),
      upstreamTimeoutMs: 500,
      log: (event, fields) => logs.push({ event, fields }),
    });
    base = await listen(gateway);
  });

  after(async () => {
    await close(gateway);
    await fixture.close();
    await redirectTarget.close();
    await client.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    fixture.reset();
    redirectTarget.reset();
    logs.length = 0;
    await seed();
  });

  test("a missing, malformed or foreign token is 401 and never reaches the provider", async () => {
    const control = await post(rpc("tools/list"));
    assert.equal(
      control.status,
      200,
      "control: the seeded caller is let through",
    );
    fixture.reset();

    for (const token of [
      null,
      "",
      "not-a-token",
      signMcpCallerToken(CLAIMS, "another-secret-0123456789abcdefghij"),
      signGatewayToken("profile1", SECRET, CLAIMS.tenantId),
      // Well formed and signed, but the IDs are not the platform's.
      signMcpCallerToken({ ...CLAIMS, tenantId: "not_an_object_id" }, SECRET),
    ]) {
      const res = await post(rpc("tools/list"), { token });
      assert.equal(res.status, 401, JSON.stringify(token));
      assert.match(res.headers.get("www-authenticate") ?? "", /invalid_token/);
    }
    assert.deepEqual(fixture.log, [], "the provider was never called");
  });

  test("a revoked caller is 401, for every way access can end", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "the member was removed from the tenant",
        () =>
          catalog
            .collection("memberships")
            .updateOne({ userId }, { $set: { status: "removed" } }),
      ],
      [
        "the tenant is disabled",
        () =>
          catalog
            .collection("tenants")
            .updateOne({ _id: tenantId }, { $set: { status: "disabled" } }),
      ],
      [
        "the connector is disabled",
        () =>
          catalog
            .collection("truex_mcp_connectors")
            .updateOne({ _id: connectorId }, { $set: { enabled: false } }),
      ],
      [
        "the chat is archived",
        () =>
          tenantDb
            .collection("chats")
            .updateOne({ _id: chatId }, { $set: { status: "archived" } }),
      ],
      [
        "the chat was deleted",
        () => tenantDb.collection("chats").deleteOne({ _id: chatId }),
      ],
      [
        "the chat belongs to another member",
        () =>
          tenantDb
            .collection("chats")
            .updateOne({ _id: chatId }, { $set: { ownerId: new ObjectId() } }),
      ],
      [
        "the connector is not on the chat",
        () =>
          tenantDb
            .collection("chats")
            .updateOne({ _id: chatId }, { $set: { connectors: [] } }),
      ],
      [
        "the connection needs a new sign-in",
        () =>
          tenantDb
            .collection("mcp_connections")
            .updateOne(
              { ownerId: userId },
              { $set: { status: "needs_reconnect" } },
            ),
      ],
      [
        "the connection was removed",
        () =>
          tenantDb.collection("mcp_connections").deleteOne({ ownerId: userId }),
      ],
      [
        "the connection pins another connector (slug reused)",
        () =>
          tenantDb
            .collection("mcp_connections")
            .updateOne(
              { ownerId: userId },
              { $set: { connectorId: new ObjectId() } },
            ),
      ],
    ];
    for (const [name, revoke] of cases) {
      await seed();
      fixture.reset();
      logs.length = 0;
      await revoke();
      const res = await post(rpc("tools/list"));
      assert.equal(res.status, 401, name);
      assert.match(res.headers.get("www-authenticate") ?? "", /invalid_token/);
      assert.deepEqual(fixture.log, [], `${name}: provider never called`);
      const refused = logs.find((l) => l.event === "mcp_refused");
      assert.ok(refused?.fields.reason, `${name}: the reason is logged`);
    }
    assert.ok(
      !JSON.stringify(logs).includes(TOKEN),
      "the token is never logged",
    );
  });

  test("a token for another connector is 403 and never reaches the provider", async () => {
    const other = signMcpCallerToken(
      { ...CLAIMS, connector: "other_one" },
      SECRET,
    );
    const res = await post(rpc("tools/list"), { token: other });
    assert.equal(res.status, 403);
    assert.deepEqual(fixture.log, []);
  });

  test("when the caller check itself fails the answer is 503, not 401", async () => {
    const failing = createMcpGateway({
      secret: SECRET,
      argumentChecker: createArgumentChecker(),
      resolveCaller: async () => {
        throw new Error("database unavailable");
      },
      credentials: credentials(),
      egress: createEgress({ allowLoopback: true }),
      log: (event, fields) => logs.push({ event, fields }),
    });
    const url = await listen(failing);
    try {
      const res = await post(rpc("tools/list"), { to: url });
      assert.equal(
        res.status,
        503,
        "a database outage must not tell Codex the token is bad",
      );
      assert.deepEqual(fixture.log, []);
      assert.ok(logs.some((l) => l.event === "mcp_caller_check_failed"));
    } finally {
      await close(failing);
    }
  });

  test("a provider address the egress check refuses is never contacted", async () => {
    const strict = createMcpGateway({
      secret: SECRET,
      resolveCaller: createCallerResolver(client, CATALOG),
      argumentChecker: createArgumentChecker(),
      credentials: credentials(),
      // No loopback: the fixture's 127.0.0.1 URL is refused.
      egress: createEgress(),
      log: (event, fields) => logs.push({ event, fields }),
    });
    const url = await listen(strict);
    try {
      const res = await post(rpc("tools/list", 11), { to: url });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        id: number;
        error?: { message: string };
      };
      assert.equal(body.id, 11);
      assert.match(
        body.error?.message ?? "",
        /isn't reachable through the Truex gateway/,
      );
      assert.deepEqual(fixture.log, [], "the provider was never contacted");
      assert.ok(
        logs.some(
          (l) =>
            l.event === "mcp_upstream_failed" &&
            l.fields.reason === "egress_blocked",
        ),
      );
      assert.equal(EgressBlockedError.name, "EgressBlockedError");
    } finally {
      await close(strict);
    }
  });

  test("initialize, tools/list and tools/call reach the provider, with the session kept", async () => {
    const init = await post(rpc("initialize", 1));
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), SESSION_ID);
    assert.equal(((await init.json()) as { id: number }).id, 1);

    const session = {
      "mcp-session-id": SESSION_ID,
      "mcp-protocol-version": "2025-06-18",
    };
    const initialized = await post(notify("notifications/initialized"), {
      headers: session,
    });
    assert.equal(initialized.status, 202);
    const list = await post(rpc("tools/list", 2), { headers: session });
    const listed = (await list.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      ["get_issue"],
    );
    const call = await post(rpc("tools/call", 3), { headers: session });
    assert.equal(((await call.json()) as { id: number }).id, 3);

    assert.deepEqual(
      fixture.log.map((r) => r.rpcMethod),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    for (const request of fixture.log.slice(1)) {
      assert.equal(request.headers["mcp-session-id"], SESSION_ID);
      assert.equal(request.headers["mcp-protocol-version"], "2025-06-18");
    }
    for (const request of fixture.log) {
      assert.equal(
        request.headers.authorization,
        `Bearer ${PROVIDER_TOKEN}`,
        "the provider gets the member's token, never the Truex token",
      );
      assert.equal(request.headers.accept, ACCEPT);
    }
  });

  test("an SSE response streams through before the provider has finished", async () => {
    fixture.mode = "sse-hold";
    const res = await post(rpc("tools/call", 7));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The provider holds its answer until released, so whatever arrives now
    // was streamed, not buffered.
    while (!text.includes("notifications/progress")) {
      const { value, done } = await reader.read();
      assert.ok(!done, "stream ended before the first event");
      text += decoder.decode(value, { stream: true });
    }
    assert.ok(!text.includes('"id":7'), "the result is not there yet");
    fixture.releaseHeld();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.ok(
      text.includes('"id":7'),
      "the result follows once the provider sends it",
    );
  });

  test("a GET stream Codex closes is closed at the provider too", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/mcp/fixture`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "text/event-stream",
        "mcp-session-id": SESSION_ID,
      },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    await reader.read();
    assert.equal(fixture.log[0]?.httpMethod, "GET");
    controller.abort();
    // Resolves only when the provider's side of the stream closes.
    await fixture.getStreamClosed();
  });

  test("methods outside what Codex needs are refused before the provider", async () => {
    const read = await post(rpc("resources/read", 4));
    assert.equal(read.status, 200);
    const body = (await read.json()) as { id: number; error: { code: number } };
    assert.equal(body.id, 4);
    assert.equal(body.error.code, -32601);
    // Resources bypass the tool allowlist, so the gateway lists none itself.
    // Codex's built-in list tools still get a valid, empty answer.
    for (const [method, result] of [
      ["resources/list", { resources: [] }],
      ["resources/templates/list", { resourceTemplates: [] }],
    ] as const) {
      const res = await post(rpc(method, 10));
      assert.equal(res.status, 200, method);
      assert.deepEqual(
        await res.json(),
        { jsonrpc: "2.0", id: 10, result },
        method,
      );
    }
    for (const message of [
      rpc("prompts/list", 5),
      notify("notifications/roots/list_changed"),
      [rpc("tools/list", 6)],
      "{not json",
    ]) {
      const res = await post(message);
      assert.notEqual(res.status, 202, JSON.stringify(message));
      if (res.status === 200) {
        const refusal = (await res.json()) as { error?: unknown };
        assert.ok(refusal.error, JSON.stringify(message));
      }
    }
    assert.deepEqual(fixture.log, [], "nothing reached the provider");

    // Codex's answer to a request the server sent it (a ping) goes through.
    const answer = await post({ jsonrpc: "2.0", id: "srv-1", result: {} });
    assert.equal(answer.status, 202);
    assert.equal(fixture.log.length, 1);
  });

  test("a provider redirect is returned as an error, never followed", async () => {
    fixture.mode = "redirect";
    fixture.redirectTo = redirectTarget.url;
    const res = await post(rpc("tools/call", 8));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: number;
      error: { message: string };
    };
    assert.equal(body.id, 8);
    assert.match(body.error.message, /redirect/i);
    assert.equal(fixture.log.length, 1);
    assert.deepEqual(
      redirectTarget.log,
      [],
      "the redirect target was never contacted",
    );
  });

  test("a provider that doesn't answer in time gives a JSON-RPC error the model can read", async () => {
    fixture.mode = "hang";
    const res = await post(rpc("tools/call", 9));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: number;
      error: { message: string };
    };
    assert.equal(body.id, 9);
    assert.match(body.error.message, /fixture did not respond in time/);
    assert.ok(
      logs.some(
        (l) =>
          l.event === "mcp_upstream_failed" && l.fields.reason === "timeout",
      ),
    );
  });
});

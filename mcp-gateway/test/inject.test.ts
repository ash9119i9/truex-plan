import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  signMcpCallerToken,
  type McpCallerClaims,
} from "../../shared/mcp-caller-token";
import { createCredentials, type ConnectionRow } from "../src/credentials";
import { connectorsIn, createRefreshGrant } from "../src/refresh-grant";
import { createCallerResolver } from "../src/revocation";
import { createEgress } from "../src/egress";
import { createArgumentChecker } from "../src/arguments";
import { createMcpGateway } from "../src/server";
import { openTokens, sealTokens, type TokenKeys } from "../src/token-crypto";
import { AuthFixture } from "./support/auth-fixture";
import { toolHash } from "../src/tool-hash";
import { DEFAULT_TOOLS, McpFixture } from "./support/mcp-fixture";

// Task 6: the gateway sends the member's provider token upstream, refreshing
// it at call time, and handles a provider 401 without ever letting Codex see
// it. Real server, real (in-memory) Mongo, real refresh against a fake
// authorization server.

const SECRET = "mcp-caller-secret-0123456789abcdef";
const CATALOG = "truex_next_catalog_inject_test";
const SECRET_ENV = "MCP_GATEWAY_INJECT_CLIENT_SECRET";
const KEYS: TokenKeys = {
  keys: new Map([["k1", Buffer.alloc(32, 5)]]),
  activeKeyId: "k1",
};
const MIN = 60_000;

const tenantId = new ObjectId();
const userId = new ObjectId();
const chatId = new ObjectId();
const connectorId = new ObjectId();
const connectionId = new ObjectId();
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

const fixture = new McpFixture();
const auth = new AuthFixture();
const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
let mongo: MongoMemoryServer;
let client: MongoClient;
let catalog: Db;
let rows: Collection<ConnectionRow>;
let gateway: Server;
let base = "";

const AAD = {
  tenantId: tenantId.toHexString(),
  ownerId: userId.toHexString(),
  connectorId: connectorId.toHexString(),
};

// One member with one chat and a connection whose access token expires in
// `accessInMs` (undefined: never).
async function seed(
  accessInMs: number | undefined,
  tokens: { accessToken: string; refreshToken?: string } = {
    accessToken: "provider-access-0",
    refreshToken: "provider-refresh-0",
  },
): Promise<void> {
  await Promise.all([
    catalog.dropDatabase(),
    client.db(TENANT_DB).dropDatabase(),
  ]);
  await catalog.collection("tenants").insertOne({
    _id: tenantId,
    dbName: TENANT_DB,
    status: "active",
    provisioningStatus: "ready",
  });
  await catalog
    .collection("memberships")
    .insertOne({ userId, tenantId, status: "active" });
  await catalog.collection("truex_mcp_connectors").insertOne({
    _id: connectorId,
    slug: "fixture",
    enabled: true,
    url: fixture.url,
    revision: 1,
    // Strict default (Task 8): only reviewed tools are offered.
    toolHashes: REVIEWED_HASHES,
    auth: { clientId: "client-1", clientSecret: { env: SECRET_ENV } },
  });
  await client
    .db(TENANT_DB)
    .collection("chats")
    .insertOne({
      _id: chatId,
      ownerId: userId,
      status: "active",
      connectors: [{ connectorId, slug: "fixture" }],
    });
  await rows.insertOne({
    _id: connectionId,
    tenantId,
    ownerId: userId,
    connectorId,
    slug: "fixture",
    status: "active",
    secret: sealTokens(KEYS, AAD, tokens),
    ...(accessInMs === undefined
      ? {}
      : { accessExpiresAt: new Date(Date.now() + accessInMs) }),
    revision: 1,
  });
}

async function connection(): Promise<ConnectionRow> {
  const row = await rows.findOne({ _id: connectionId });
  assert.ok(row);
  return row;
}

function post(body: unknown): Promise<Response> {
  return fetch(`${base}/mcp/fixture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

// tools/call names the fixture's one reviewed tool (Task 8 refuses a call
// without a name).
const rpc = (method: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: method === "tools/call" ? { name: "get_issue", arguments: {} } : {},
});

async function rpcResult(res: Response) {
  assert.equal(res.status, 200, "Codex gets a JSON-RPC answer, never a 401");
  assert.equal(res.headers.get("www-authenticate"), null);
  return (await res.json()) as {
    id: number;
    result?: unknown;
    error?: { message: string };
  };
}

// The requests the gateway forwarded for Codex. Refresh-time discovery also
// probes the MCP URL, unauthenticated (refresh-grant.ts), and is left out.
const forwarded = () =>
  fixture.log.filter((r) => !r.body.includes('"name":"truex"'));
// The bearer token on each forwarded request.
const bearers = () =>
  forwarded().map((r) => r.headers.authorization?.replace(/^Bearer /, ""));

describe("MCP gateway: provider token injection and refresh", () => {
  before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    catalog = client.db(CATALOG);
    rows = client.db(TENANT_DB).collection<ConnectionRow>("mcp_connections");
    await fixture.start();
    await auth.start();
    process.env[SECRET_ENV] = "client-secret-1";
    const credentials = createCredentials({
      client,
      keys: KEYS,
      refresh: createRefreshGrant({
        findConnector: connectorsIn(catalog),
        resolveSecret: async (ref) =>
          process.env[(ref as { env: string }).env]!,
        egress: createEgress({ allowLoopback: true }),
      }),
      log: (event, fields) => logs.push({ event, fields }),
      pollMs: 20,
    });
    gateway = createMcpGateway({
      secret: SECRET,
      resolveCaller: createCallerResolver(client, CATALOG),
      argumentChecker: createArgumentChecker(),
      egress: createEgress({ allowLoopback: true }),
      credentials,
      upstreamTimeoutMs: 2000,
      log: (event, fields) => logs.push({ event, fields }),
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  after(async () => {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    await fixture.close();
    await auth.close();
    delete process.env[SECRET_ENV];
    await client.close();
    await mongo.stop();
  });

  beforeEach(() => {
    fixture.reset();
    auth.reset();
    logs.length = 0;
    // The fixture's discovery probe and metadata point at the auth server.
    fixture.metadataUrl = auth.prmUrl;
    auth.resource = fixture.url;
    // Tokens the provider accepts: the seeded one, plus whatever it issues.
    fixture.tokens = new Set(["provider-access-0"]);
    auth.onIssue = (token) => fixture.tokens!.add(token);
  });

  test("the provider sees only the member's token; the Truex token never leaves", async () => {
    await seed(undefined);
    for (const [i, method] of [
      "initialize",
      "tools/list",
      "tools/call",
    ].entries())
      assert.ok((await rpcResult(await post(rpc(method, i)))).result, method);
    assert.deepEqual(bearers(), [
      "provider-access-0",
      "provider-access-0",
      "provider-access-0",
    ]);
    assert.ok(!JSON.stringify(fixture.log).includes(TOKEN));
    assert.equal(fixture.log.length, 3, "nothing else reached the provider");
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(TOKEN), "no caller token in the logs");
    assert.ok(
      !logged.includes("provider-access-0"),
      "no provider token in the logs",
    );
  });

  test("a token inside the refresh margin is renewed before the call; concurrent calls renew once", async () => {
    await seed(5 * MIN);
    // The provider already stopped accepting the old token, so a call that
    // went out with it would fail.
    fixture.tokens = new Set();
    const answers = await Promise.all([
      post(rpc("tools/list", 1)),
      post(rpc("tools/call", 2)),
    ]);
    for (const answer of answers) assert.ok((await rpcResult(answer)).result);
    assert.equal(auth.tokenRequests.length, 1, "one refresh");
    assert.equal(
      auth.tokenRequests[0]!.get("refresh_token"),
      "provider-refresh-0",
    );
    assert.deepEqual(bearers(), ["refreshed-access-1", "refreshed-access-1"]);
    const row = await connection();
    assert.deepEqual(openTokens(KEYS, AAD, row.secret), {
      accessToken: "refreshed-access-1",
      refreshToken: "refreshed-refresh-1",
    });
  });

  test("a token that expired mid-chat is renewed at call time", async () => {
    await seed(-MIN);
    fixture.tokens = new Set();
    assert.ok((await rpcResult(await post(rpc("tools/call", 3)))).result);
    assert.deepEqual(bearers(), ["refreshed-access-1"]);
  });

  // Read from the catalog record on each refresh, so the opt-out applies
  // without a gateway restart.
  test("the refresh names the MCP server, unless the catalog record opts out", async () => {
    await seed(-MIN);
    fixture.tokens = new Set();
    assert.ok((await rpcResult(await post(rpc("tools/call", 4)))).result);
    await seed(-MIN);
    await catalog
      .collection("truex_mcp_connectors")
      .updateOne(
        { _id: connectorId },
        { $set: { "auth.sendResource": false } },
      );
    assert.ok((await rpcResult(await post(rpc("tools/call", 5)))).result);
    assert.deepEqual(
      auth.tokenRequests.map((form) => form.getAll("resource")),
      [[fixture.url], []],
    );
  });

  test("a 401 on tools/list renews once and retries once", async () => {
    await seed(60 * MIN);
    // The provider revoked the stored token before it expired.
    fixture.tokens = new Set();
    assert.ok((await rpcResult(await post(rpc("tools/list", 4)))).result);
    assert.deepEqual(bearers(), ["provider-access-0", "refreshed-access-1"]);
    assert.equal(auth.tokenRequests.length, 1);
  });

  test("a 401 that survives the renewal asks for a new sign-in", async () => {
    await seed(60 * MIN);
    fixture.tokens = new Set();
    auth.onIssue = undefined; // the provider rejects even its fresh tokens
    const body = await rpcResult(await post(rpc("initialize", 5)));
    assert.match(body.error!.message, /reconnect/i);
    assert.equal(forwarded().length, 2, "one retry, not a loop");
    assert.equal(auth.tokenRequests.length, 1);
    assert.equal((await connection()).status, "needs_reconnect");
  });

  test("a 401 on tools/call is never retried; the token is renewed for the next call", async () => {
    await seed(60 * MIN);
    fixture.tokens = new Set();
    const first = await rpcResult(await post(rpc("tools/call", 6)));
    assert.ok(first.error, "the call failed");
    assert.match(first.error.message, /try (it |the call )?again/i);
    assert.equal(forwarded().length, 1, "not retried");
    assert.equal(auth.tokenRequests.length, 0, "no refresh during the call");
    const row = await connection();
    assert.equal(row.status, "active");
    assert.ok(
      row.accessExpiresAt!.getTime() <= Date.now(),
      "marked for renewal",
    );

    // The model's next call goes out with a renewed token.
    assert.ok((await rpcResult(await post(rpc("tools/call", 7)))).result);
    assert.deepEqual(bearers().at(-1), "refreshed-access-1");
  });

  test("a 401 on tools/call with nothing to refresh with asks for a new sign-in", async () => {
    await seed(undefined, { accessToken: "provider-access-0" });
    fixture.tokens = new Set();
    const body = await rpcResult(await post(rpc("tools/call", 8)));
    assert.match(body.error!.message, /reconnect/i);
    assert.equal(forwarded().length, 1);
    assert.equal((await connection()).status, "needs_reconnect");
  });

  test("a refused or unreachable refresh is a readable error, and the provider is never called", async () => {
    await seed(-MIN);
    auth.behaviour = "refuse";
    const refused = await rpcResult(await post(rpc("tools/list", 9)));
    assert.match(refused.error!.message, /reconnect/i);
    assert.equal((await connection()).status, "needs_reconnect");

    await seed(-MIN);
    auth.reset();
    auth.behaviour = "down";
    const down = await rpcResult(await post(rpc("tools/list", 10)));
    assert.match(down.error!.message, /try again/i);
    assert.equal(
      (await connection()).status,
      "active",
      "the member stays signed in",
    );
    assert.equal(forwarded().length, 0, "the provider was never called");
  });
});

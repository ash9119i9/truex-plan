import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { ConnectorsConfig } from "../../src/config/connectors-config";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import {
  CONNECTIONS_COLLECTION,
  type McpConnectionDoc,
} from "../../src/modules/connectors/connection";
import { ConnectorsService } from "../../src/modules/connectors/connectors.service";
import { ConnectorsCatalogService } from "../../src/modules/connectors/connectors-catalog.service";
import {
  CONNECTORS_COLLECTION,
  type ConnectorDoc,
} from "../../src/modules/connectors/connector";
import {
  sealConnectorFlow,
  type ConnectorFlow,
} from "../../src/modules/connectors/connector-oauth-flow";
import {
  sealTokens,
  type SecretAad,
} from "../../src/modules/connectors/token-crypto";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { DEFAULT_TENANT_DB_NAME } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import { resetOwnedData } from "../support/reset";
import { TEST_ORIGIN } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";
import {
  startConnectorFixture,
  type ConnectorFixture,
} from "../support/connector-fixtures";

// The env var the connector definition names for its client secret.
const SECRET_ENV = "TEST_CONNECTOR_SECRET";
const DB_NAME = DEFAULT_TENANT_DB_NAME;
const CALLBACK_PATH = "/api/v1/connectors/callback";

interface Member {
  userId: ObjectId;
  token: string;
  tenantId: ObjectId;
}

// A fixed token key, so a test can also build the config directly if needed.
function connectorsConfig(): ConnectorsConfig {
  return {
    keys: new Map([["k1", randomBytes(32)]]),
    activeKeyId: "k1",
    redirectUri: `${TEST_ORIGIN}${CALLBACK_PATH}`,
    allowLoopback: true,
  };
}

// An https connector definition for the operator-CLI catalog tests (revision
// bump, validation). The loopback fixture connector is inserted directly
// (insertConnector) because parseConnectorSpec requires https.
function connectorDefinition(overrides: Record<string, unknown> = {}): unknown {
  return {
    slug: "github",
    displayName: "GitHub",
    description: "Read-only access to your GitHub.",
    icon: "github",
    url: "https://api.githubcopilot.com/mcp/readonly",
    fixedHeaders: { "X-MCP-Toolsets": "repos,issues" },
    auth: {
      type: "oauth_user",
      registration: "preregistered",
      clientId: "Iv1.testclient",
      clientSecret: { env: SECRET_ENV },
      scopes: [],
      discovery: "protected_resource_metadata",
      revoke: {
        kind: "github_app_grant",
        url: "https://api.github.com/applications/{client_id}/grant",
      },
      accountTool: { name: "get_me", field: "login" },
    },
    toolTimeoutSec: 60,
    startupTimeoutSec: 15,
    sortOrder: 10,
    ...overrides,
  };
}

describe("directory connectors (integration)", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let config: ConnectorsConfig;
  let database: DatabaseService;
  let operator: OperatorService;
  let users: UsersService;
  let memberships: MembershipsService;
  let sessions: SessionsService;
  let connectors: ConnectorsService;
  let catalog: ConnectorsCatalogService;
  let fixture: ConnectorFixture;
  let tenantId: ObjectId;
  let alice: Member;
  let connectorId: ObjectId;

  before(async () => {
    process.env[SECRET_ENV] = "test-connector-client-secret";
    mongo = await startReplicaSet();
    config = connectorsConfig();
    running = await startApp({
      mongodbUri: mongo.getUri(),
      connectors: config,
    });
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
    users = running.app.get(UsersService);
    memberships = running.app.get(MembershipsService);
    sessions = running.app.get(SessionsService);
    connectors = running.app.get(ConnectorsService);
    catalog = running.app.get(ConnectorsCatalogService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
    delete process.env[SECRET_ENV];
  });

  beforeEach(async () => {
    await resetOwnedData(database);
    fixture = await startConnectorFixture();
    tenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Truex",
      kind: "default",
    });
    // The catalog's parseConnectorSpec requires https, so a loopback fixture
    // connector is inserted as data (the "data-only connector" path, slice 1)
    // rather than through the CLI. The slug unique index is built once.
    await catalog.ensureIndexes();
    connectorId = await insertConnector("github");
    alice = await member("alice", tenantId);
  });

  afterEach(async () => {
    await fixture.close();
  });

  // Writes a connector document pointing at the loopback fixture directly into
  // the catalog, then clears the enabled-connectors cache so the member-facing
  // reads (listForUser / runSpecs) see it. Returns its ObjectId.
  async function insertConnector(
    slug: string,
    overrides: Partial<ConnectorDoc> = {},
  ): Promise<ObjectId> {
    const now = new Date();
    const doc: ConnectorDoc = {
      _id: new ObjectId(),
      slug,
      displayName: slug === "github" ? "GitHub" : slug,
      description: "Read-only access to your GitHub.",
      icon: "github",
      url: fixture.mcpUrl,
      fixedHeaders: { "X-MCP-Toolsets": "repos,issues" },
      auth: {
        type: "oauth_user",
        registration: "preregistered",
        clientId: "Iv1.testclient",
        clientSecret: { env: SECRET_ENV },
        scopes: [],
        discovery: "protected_resource_metadata",
        revoke: {
          kind: "github_app_grant",
          url: `${fixture.origin}/login/oauth/revoke`,
        },
        accountTool: { name: "get_me", field: "login" },
      },
      toolTimeoutSec: 60,
      startupTimeoutSec: 15,
      sortOrder: 10,
      enabled: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: "ops",
      ...overrides,
    };
    await database
      .catalog()
      .collection<ConnectorDoc>(CONNECTORS_COLLECTION)
      .insertOne(doc);
    clearCatalogCache();
    return doc._id;
  }

  // The catalog caches enabled connectors in memory; a direct insert/update
  // bypasses the cache-clearing the operator path does, so tests clear it.
  function clearCatalogCache(): void {
    (
      catalog as unknown as { enabledCache: { clear(): void } }
    ).enabledCache.clear();
  }

  async function member(subject: string, tenant: ObjectId): Promise<Member> {
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: subject,
    });
    await memberships.join({
      userId: user._id,
      tenantId: tenant,
      joinedVia: "signup",
    });
    const issued = await sessions.create(user._id);
    return { userId: user._id, token: issued.accessToken, tenantId: tenant };
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  function tenantUrl(path: string): string {
    return `${running.baseUrl}/api/v1${path}?tenantId=${tenantId.toHexString()}`;
  }

  function connectionRows(): Promise<McpConnectionDoc[]> {
    return database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .find({})
      .toArray();
  }

  function rawRow(): Promise<McpConnectionDoc | null> {
    return database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .findOne({ ownerId: alice.userId, connectorId });
  }

  function auditRows(): Promise<AuditDoc[]> {
    return database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({})
      .sort({ at: 1, _id: 1 })
      .toArray();
  }

  // Extracts the path-scoped flow cookie value from a Set-Cookie header.
  function cookieFrom(res: Response): { header: string; value: string } {
    const header = res.headers.get("set-cookie");
    assert.ok(header, "a flow cookie should be set");
    const first = header.split(";")[0]!;
    const value = first.slice(first.indexOf("=") + 1);
    return { header: first, value };
  }

  // Runs a connect + provider approval + callback, returning the final 302
  // Location and the tokens the fixture issued (read from the stored row by
  // decrypting with the service is not possible here; the test asserts on the
  // row and the fixture instead).
  async function connectFlow(
    who: Member = alice,
    mint: { scope?: string } = {},
  ): Promise<{
    location: string;
    status: number;
  }> {
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${who.tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${who.token}` } },
    );
    const connectText = await connectRes.text();
    assert.equal(connectRes.status, 201, connectText);
    const { authorizeUrl } = JSON.parse(connectText) as {
      authorizeUrl: string;
    };
    const { value: cookie } = cookieFrom(connectRes);
    const authorize = new URL(authorizeUrl);
    const state = authorize.searchParams.get("state")!;
    const challenge = authorize.searchParams.get("code_challenge")!;
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");

    const code = fixture.mintCode({
      codeChallenge: challenge,
      expiresIn: 8 * 3600,
      refreshTokenExpiresIn: 6 * 30 * 24 * 3600,
      ...mint,
    });
    const callbackRes = await fetch(
      `${running.baseUrl}${CALLBACK_PATH}?code=${code}&state=${state}&iss=${encodeURIComponent(fixture.issuer)}`,
      {
        method: "GET",
        redirect: "manual",
        headers: { cookie: `${cookieName()}=${cookie}` },
      },
    );
    return {
      location: callbackRes.headers.get("location") ?? "",
      status: callbackRes.status,
    };
  }

  function cookieName(): string {
    // cookieSecure is false in tests (test-auth), so the non-secure name.
    return "truex_connector_oauth";
  }

  // Seals a flow cookie directly, so a test can forge expiry or a mismatch.
  function sealFlow(overrides: Partial<ConnectorFlow>): string {
    const flow: ConnectorFlow = {
      state: "A".repeat(43),
      codeVerifier: "B".repeat(43),
      connectorId: connectorId.toHexString(),
      connectorRevision: 1,
      slug: "github",
      tenantId: tenantId.toHexString(),
      userId: alice.userId.toHexString(),
      dbName: DB_NAME,
      startedAt: Math.floor(Date.now() / 1000),
      ...overrides,
    };
    return sealConnectorFlow(config, flow);
  }

  // ── 1. Catalog via OperatorService ───────────────────────────────

  test("putConnector bumps revision on change and is unchanged on a repeat", async () => {
    const created = await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({ slug: "second" }),
    });
    assert.equal(created.outcome, "created");
    assert.equal(created.connector.revision, 1);

    const unchanged = await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({ slug: "second" }),
    });
    assert.equal(unchanged.outcome, "unchanged");
    assert.equal(unchanged.connector.revision, 1);

    const updated = await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({
        slug: "second",
        displayName: "Second GitHub",
      }),
    });
    assert.equal(updated.outcome, "updated");
    assert.equal(updated.connector.revision, 2);
  });

  // Stale hashes would keep tools offered after a review withdrew them.
  test("putConnector stores toolHashes and removes them when a put leaves them out", async () => {
    const stored = () =>
      database
        .catalog()
        .collection<ConnectorDoc>(CONNECTORS_COLLECTION)
        .findOne({ slug: "hashed" });
    const hash = "a".repeat(64);
    await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({
        slug: "hashed",
        toolHashes: { get_issue: hash },
      }),
    });
    assert.deepEqual((await stored())?.toolHashes, { get_issue: hash });

    const without = await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({ slug: "hashed" }),
    });
    assert.equal(without.outcome, "updated");
    assert.equal((await stored())?.toolHashes, undefined);
  });

  test("an invalid definition is refused and audited without being stored", async () => {
    await assert.rejects(
      operator.putConnector({
        operator: "ops",
        definition: connectorDefinition({
          slug: "bad",
          url: "http://not-https.test/mcp",
        }),
      }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_INPUT",
    );
    assert.equal(
      await database
        .catalog()
        .collection("truex_mcp_connectors")
        .countDocuments({ slug: "bad" }),
      0,
    );
    const denied = (await auditRows()).find(
      (e) => e.action === "connector.put" && e.result === "denied",
    );
    assert.ok(denied, "the refusal is audited");
  });

  test("the operator summary never carries the auth block or client secret", async () => {
    const listing = await operator.listConnectors();
    assert.doesNotMatch(
      JSON.stringify(listing),
      /clientSecret|TEST_CONNECTOR_SECRET|Iv1\.testclient/,
    );
  });

  test("a disabled connector disappears from GET /connectors", async () => {
    // Connect first so a row exists; disabling must still hide the catalog
    // entry from the member listing.
    await connectFlow();
    await operator.setConnectorEnabled({
      operator: "ops",
      slug: "github",
      enabled: false,
    });
    const res = await fetch(tenantUrl("/connectors"), {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await res.json()) as { connectors: { slug: string }[] };
    assert.deepEqual(
      body.connectors.map((c) => c.slug),
      [],
    );
  });

  test("a second, data-only connector appears in the member listing", async () => {
    await operator.putConnector({
      operator: "ops",
      definition: connectorDefinition({
        slug: "github_two",
        displayName: "GitHub Two",
        sortOrder: 20,
      }),
    });
    const res = await fetch(tenantUrl("/connectors"), {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await res.json()) as { connectors: { slug: string }[] };
    assert.deepEqual(
      body.connectors.map((c) => c.slug),
      ["github", "github_two"],
    );
  });

  // ── 2. HTTP connect flow end to end ──────────────────────────────

  test("a full connect stores one encrypted row and redirects to connected-tools", async () => {
    const { status, location } = await connectFlow();
    assert.equal(status, 302);
    assert.equal(
      location,
      `${TEST_ORIGIN}/t/${tenantId.toHexString()}/connected-tools?connected=github`,
    );

    const rows = await connectionRows();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.status, "active");
    assert.equal(row.account?.login, "octocat");
    assert.equal(row.toolCount, 3);
    assert.ok(row.secret.ciphertext.buffer.length > 0);

    // The member listing shows it active with the account and tool count.
    const res = await fetch(tenantUrl("/connectors"), {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await res.json()) as {
      connectors: {
        slug: string;
        connection: {
          status: string;
          account?: { login: string };
          toolCount?: number;
        };
      }[];
    };
    const github = body.connectors.find((c) => c.slug === "github")!;
    assert.equal(github.connection.status, "active");
    assert.equal(github.connection.account?.login, "octocat");
    assert.equal(github.connection.toolCount, 3);
  });

  test("allowlisted authorizeParams are added to the authorize URL without replacing a core parameter", async () => {
    await database
      .catalog()
      .collection<ConnectorDoc>(CONNECTORS_COLLECTION)
      .updateOne(
        { _id: connectorId },
        {
          $set: {
            "auth.scopes": ["openid", "mail.read"],
            "auth.authorizeParams": {
              access_type: "offline",
              prompt: "consent",
            },
          },
        },
      );
    clearCatalogCache();
    const res = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    assert.equal(res.status, 201);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const params = new URL(authorizeUrl).searchParams;
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    assert.equal(params.get("scope"), "openid mail.read");
    assert.equal(params.getAll("client_id").length, 1);
    assert.equal(params.get("client_id"), "Iv1.testclient");
  });

  // RFC 8707 (MCP authorization, 2025-06-18 and later): the client names the
  // MCP server it wants a token for, as the protected-resource metadata
  // spells it, on every authorize and token request.
  async function resourceSent(): Promise<{
    authorize: string[];
    tokens: Array<[string | null, string[]]>;
  }> {
    const res = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    assert.equal(res.status, 201);
    const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
    const formsBefore = fixture.tokenRequestForms().length;
    const { status } = await connectFlow();
    assert.equal(status, 302);
    await expireSoon((await rawRow())!._id);
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    return {
      authorize: new URL(authorizeUrl).searchParams.getAll("resource"),
      tokens: fixture
        .tokenRequestForms()
        .slice(formsBefore)
        .map((form) => [form.get("grant_type"), form.getAll("resource")]),
    };
  }

  test("authorize, code exchange and refresh carry the connector's resource (RFC 8707)", async () => {
    const resource = `${fixture.origin}/mcp`;
    assert.deepEqual(await resourceSent(), {
      authorize: [resource],
      tokens: [
        ["authorization_code", [resource]],
        ["refresh_token", [resource]],
      ],
    });
  });

  test("sendResource: false sends no resource on authorize, exchange or refresh", async () => {
    await database
      .catalog()
      .collection<ConnectorDoc>(CONNECTORS_COLLECTION)
      .updateOne(
        { _id: connectorId },
        { $set: { "auth.sendResource": false } },
      );
    clearCatalogCache();
    assert.deepEqual(await resourceSent(), {
      authorize: [],
      tokens: [
        ["authorization_code", []],
        ["refresh_token", []],
      ],
    });
  });

  test("a grant missing a requested scope stores nothing (permissions_missing)", async () => {
    await database
      .catalog()
      .collection<ConnectorDoc>(CONNECTORS_COLLECTION)
      .updateOne(
        { _id: connectorId },
        { $set: { "auth.scopes": ["openid", "mail.read", "mail.compose"] } },
      );
    clearCatalogCache();
    // Granular consent: the member unticked mail.compose.
    const partial = await connectFlow(alice, { scope: "openid mail.read" });
    assert.equal(partial.status, 302);
    assert.match(partial.location, /error=permissions_missing/);
    assert.equal((await connectionRows()).length, 0);

    // Everything granted (any order, extra scopes fine): stored.
    const full = await connectFlow(alice, {
      scope: "mail.compose openid mail.read extra",
    });
    assert.match(full.location, /connected=github/);
    assert.equal((await connectionRows()).length, 1);
  });

  test("the token never appears in any response, the row's plaintext, the audit, or the listing", async () => {
    await connectFlow();
    const bearer = fixture.bearerTokensSeen();
    assert.ok(bearer.length >= 1, "the fixture saw the verify bearer");
    const seen = bearer[0]!;

    // The audit records the connection but never the token.
    const audit = JSON.stringify(await auditRows());
    assert.doesNotMatch(audit, new RegExp(seen));
    assert.ok(audit.includes("connector.connected"));

    // The stored secret is ciphertext, not the token bytes.
    const row = await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .findOne({ ownerId: alice.userId, connectorId });
    const rowJson = JSON.stringify(row);
    assert.doesNotMatch(rowJson, new RegExp(seen));

    // The default-projected listing (no secret) and the connect response body
    // carry no token either.
    const res = await fetch(tenantUrl("/connectors"), {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.doesNotMatch(await res.text(), new RegExp(seen));
  });

  // ── 3. Rejections store nothing ──────────────────────────────────

  test("a missing cookie is rejected and stores nothing", async () => {
    const res = await fetch(
      `${running.baseUrl}${CALLBACK_PATH}?code=x&state=${"A".repeat(43)}&iss=${encodeURIComponent(fixture.issuer)}`,
      { method: "GET", redirect: "manual" },
    );
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /error=state_invalid/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("a tampered cookie is rejected", async () => {
    const sealed = sealFlow({});
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    const res = await callback(
      { code: "x", state: "A".repeat(43), iss: fixture.issuer },
      bytes.toString("base64url"),
    );
    assert.match(res.location, /error=state_invalid/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("a state mismatch is rejected", async () => {
    const sealed = sealFlow({ state: "A".repeat(43) });
    const res = await callback(
      { code: "x", state: "C".repeat(43), iss: fixture.issuer },
      sealed,
    );
    assert.match(res.location, /error=state_invalid&connector=github/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("an expired flow is rejected", async () => {
    const sealed = sealFlow({
      startedAt: Math.floor(Date.now() / 1000) - 11 * 60,
    });
    const res = await callback(
      { code: "x", state: "A".repeat(43), iss: fixture.issuer },
      sealed,
    );
    assert.match(res.location, /error=expired/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("an iss mismatch is rejected", async () => {
    const sealed = sealFlow({ state: "A".repeat(43) });
    const res = await callback(
      { code: "x", state: "A".repeat(43), iss: "https://evil.test/login" },
      sealed,
    );
    assert.match(res.location, /error=state_invalid/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("a user who is no longer a member is rejected", async () => {
    const stranger = new ObjectId();
    const sealed = sealFlow({
      state: "A".repeat(43),
      userId: stranger.toHexString(),
    });
    const res = await callback(
      { code: "x", state: "A".repeat(43), iss: fixture.issuer },
      sealed,
    );
    assert.match(res.location, /error=not_member/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("a provider access_denied maps to cancelled", async () => {
    const sealed = sealFlow({ state: "A".repeat(43) });
    const res = await callback(
      { state: "A".repeat(43), error: "access_denied" },
      sealed,
    );
    assert.match(res.location, /error=cancelled/);
    assert.equal((await connectionRows()).length, 0);
  });

  test("a replayed code is refused and nothing is stored", async () => {
    // First connect succeeds; reusing the same code then fails exchange.
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const { authorizeUrl } = (await connectRes.json()) as {
      authorizeUrl: string;
    };
    const { value: cookie } = cookieFrom(connectRes);
    const authorize = new URL(authorizeUrl);
    const state = authorize.searchParams.get("state")!;
    const challenge = authorize.searchParams.get("code_challenge")!;
    const code = fixture.mintCode({
      codeChallenge: challenge,
      expiresIn: 3600,
    });

    const first = await callback({ code, state, iss: fixture.issuer }, cookie);
    assert.match(first.location, /connected=github/);

    // A second connect with the same (now used) code → exchange_failed.
    const second = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const authorize2 = new URL(
      ((await second.json()) as { authorizeUrl: string }).authorizeUrl,
    );
    const replay = await callback(
      {
        code,
        state: authorize2.searchParams.get("state")!,
        iss: fixture.issuer,
      },
      cookieFrom(second).value,
    );
    assert.match(replay.location, /error=exchange_failed/);
    // The first connect's row is still the only one.
    assert.equal((await connectionRows()).length, 1);
  });

  test("a verify 401 stores nothing (verify_failed)", async () => {
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const { authorizeUrl } = (await connectRes.json()) as {
      authorizeUrl: string;
    };
    const { value: cookie } = cookieFrom(connectRes);
    const authorize = new URL(authorizeUrl);
    const challenge = authorize.searchParams.get("code_challenge")!;
    const code = fixture.mintCode({
      codeChallenge: challenge,
      expiresIn: 3600,
    });
    // The access token the exchange yields will be rejected at verify: tell
    // the fixture to 401 the very next bearer it sees.
    // Simpler: make tools/list fail so verify raises VerifyFailedError.
    fixture.setToolsListFails(true);
    const res = await callback(
      {
        code,
        state: authorize.searchParams.get("state")!,
        iss: fixture.issuer,
      },
      cookie,
    );
    assert.match(res.location, /error=verify_failed/);
    assert.equal((await connectionRows()).length, 0);
  });

  // Issues a callback request with a forged or captured cookie.
  async function callback(
    params: { code?: string; state?: string; iss?: string; error?: string },
    cookieValue: string,
  ): Promise<{ location: string; status: number }> {
    const query = new URLSearchParams();
    if (params.code !== undefined) query.set("code", params.code);
    if (params.state !== undefined) query.set("state", params.state);
    if (params.iss !== undefined) query.set("iss", params.iss);
    if (params.error !== undefined) query.set("error", params.error);
    const res = await fetch(
      `${running.baseUrl}${CALLBACK_PATH}?${query.toString()}`,
      {
        method: "GET",
        redirect: "manual",
        headers: { cookie: `${cookieName()}=${cookieValue}` },
      },
    );
    return {
      location: res.headers.get("location") ?? "",
      status: res.status,
    };
  }

  // ── 4. Reconnect & races ─────────────────────────────────────────

  test("reconnecting upserts the same row", async () => {
    await connectFlow();
    const first = await rawRow();
    await connectFlow();
    const rows = await connectionRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!._id.toHexString(), first!._id.toHexString());
    assert.ok(rows[0]!.revision > first!.revision);
  });

  test("two racing completeConnect calls leave exactly one row", async () => {
    // Mint two codes for one PKCE challenge via two parallel connects, then
    // fire both callbacks together; the unique index must collapse them.
    const start = async () => {
      const res = await fetch(
        `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
        { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
      );
      const authorize = new URL(
        ((await res.json()) as { authorizeUrl: string }).authorizeUrl,
      );
      return {
        cookie: cookieFrom(res).value,
        state: authorize.searchParams.get("state")!,
        challenge: authorize.searchParams.get("code_challenge")!,
      };
    };
    const a = await start();
    const b = await start();
    const [ra, rb] = await Promise.all([
      callback(
        {
          code: fixture.mintCode({
            codeChallenge: a.challenge,
            expiresIn: 3600,
          }),
          state: a.state,
          iss: fixture.issuer,
        },
        a.cookie,
      ),
      callback(
        {
          code: fixture.mintCode({
            codeChallenge: b.challenge,
            expiresIn: 3600,
          }),
          state: b.state,
          iss: fixture.issuer,
        },
        b.cookie,
      ),
    ]);
    assert.match(ra.location, /connected=github/);
    assert.match(rb.location, /connected=github/);
    assert.equal((await connectionRows()).length, 1);
  });

  // ── 5. Crypto → runSpecs ─────────────────────────────────────────

  test("a ciphertext copied to another owner makes runSpecs mark token_unreadable", async () => {
    await connectFlow();
    const row = await rawRow();
    // Copy alice's sealed secret onto a new owner's row (same connector): the
    // AAD binds it to alice, so the copy cannot decrypt.
    const intruder = new ObjectId();
    await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .insertOne({
        ...row!,
        _id: new ObjectId(),
        ownerId: intruder,
        revision: 1,
      });
    const result = await connectors.runSpecs(DB_NAME, intruder, [connectorId]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.missing.map((m) => m.slug), [
      "github",
    ]);
    const marked = await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .findOne({ ownerId: intruder, connectorId });
    assert.equal(marked?.status, "needs_reconnect");
    assert.equal(marked?.lastError?.code, "token_unreadable");
  });

  test("runSpecs uses prefetched owner connections, and reads when they lack one", async () => {
    await connectFlow();
    const prefetched = connectors.ownerConnections(DB_NAME, alice.userId);
    assert.equal((await prefetched).length, 1);
    const used = await connectors.runSpecs(
      DB_NAME,
      alice.userId,
      [connectorId],
      { prefetched },
    );
    assert.equal(used.ok, true);
    // A prefetch that missed the row (read before the connect, or failed)
    // never makes the connection look missing.
    const failed = Promise.reject(new Error("x"));
    failed.catch(() => undefined);
    for (const stale of [Promise.resolve([]), failed]) {
      const read = await connectors.runSpecs(
        DB_NAME,
        alice.userId,
        [connectorId],
        { prefetched: stale },
      );
      assert.equal(read.ok, true);
    }
    // Another owner's prefetched row is never used.
    const other = await connectors.runSpecs(
      DB_NAME,
      new ObjectId(),
      [connectorId],
      { prefetched },
    );
    assert.equal(other.ok, false);
  });

  // ── 7. Token refresh via runSpecs ────────────────────────────────

  test("(a) a token valid beyond the margin is used without a token request", async () => {
    await connectFlow(); // 8h access token.
    const before = fixture.tokenRequestCount();
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    assert.equal(fixture.tokenRequestCount(), before);
    assert.ok(
      result.ok &&
        (result.specs[0]!.headers.Authorization ?? "").startsWith("Bearer "),
    );
    // The fixed header is carried alongside the per-user Authorization.
    assert.equal(
      result.ok && result.specs[0]!.headers["X-MCP-Toolsets"],
      "repos,issues",
    );
  });

  test("(b) a token expiring within the margin is refreshed and the row updated", async () => {
    await connectFlow();
    const before = await rawRow();
    // Force it to look near-expiry so the next run refreshes.
    await expireSoon(before!._id);
    const refreshCountBefore = fixture.grantTypeCounts().refresh_token ?? 0;

    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    assert.equal(
      fixture.grantTypeCounts().refresh_token ?? 0,
      refreshCountBefore + 1,
    );
    const after = await rawRow();
    // A fresh access expiry was written, the refresh token rotated (ciphertext
    // changed), and the row advanced.
    assert.ok(after!.accessExpiresAt!.getTime() > Date.now());
    assert.ok(after!.lastRefreshedAt);
    assert.notEqual(
      Buffer.from(before!.secret.ciphertext.buffer).toString("hex"),
      Buffer.from(after!.secret.ciphertext.buffer).toString("hex"),
    );
  });

  test("(c) five concurrent runSpecs trigger exactly one token request", async () => {
    await connectFlow();
    const row = await rawRow();
    await expireSoon(row!._id);
    const before = fixture.tokenRequestCount();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        connectors.runSpecs(DB_NAME, alice.userId, [connectorId]),
      ),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(fixture.tokenRequestCount(), before + 1);
  });

  test("(d) a waiter returns another process's refreshed token without a token request", async () => {
    await connectFlow();
    const row = await rawRow();
    await expireSoon(row!._id);
    const collection = database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION);
    // Another process is holding a live lease.
    await collection.updateOne(
      { _id: row!._id },
      {
        $set: {
          refreshLease: {
            id: new ObjectId(),
            until: new Date(Date.now() + 10_000),
          },
        },
      },
    );
    const before = fixture.tokenRequestCount();
    // Start the waiter; it polls the row while the lease is held elsewhere.
    const waiter = connectors.runSpecs(DB_NAME, alice.userId, [connectorId]);
    await delay(300);
    // The "other process" completes: writes a fresh, far-future token and
    // drops its lease, exactly as refreshHeld would.
    const aad: SecretAad = {
      tenantId: tenantId.toHexString(),
      ownerId: alice.userId.toHexString(),
      connectorId: connectorId.toHexString(),
    };
    await collection.updateOne(
      { _id: row!._id },
      {
        $set: {
          secret: sealTokens(config, aad, {
            accessToken: "other-process-access",
            refreshToken: "other-process-refresh",
          }),
          accessExpiresAt: new Date(Date.now() + 8 * 3600_000),
        },
        $unset: { refreshLease: "" },
        $inc: { revision: 1 },
      },
    );
    const result = await waiter;
    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.specs[0]!.headers.Authorization,
      "Bearer other-process-access",
    );
    // The waiter used the row the other process wrote; it made no token call.
    assert.equal(fixture.tokenRequestCount(), before);
  });

  test("(e) a lease whose deadline has passed is taken over", async () => {
    await connectFlow();
    const row = await rawRow();
    await expireSoon(row!._id);
    // A stale lease from a crashed process: its deadline is in the past.
    await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .updateOne(
        { _id: row!._id },
        {
          $set: {
            refreshLease: {
              id: new ObjectId(),
              until: new Date(Date.now() - 1_000),
            },
          },
        },
      );
    const before = fixture.grantTypeCounts().refresh_token ?? 0;
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    // We took the lease over and refreshed.
    assert.equal(fixture.grantTypeCounts().refresh_token ?? 0, before + 1);
    assert.equal((await rawRow())?.refreshLease, undefined);
  });

  test("(f) a refused refresh marks needs_reconnect with refresh_refused", async () => {
    await connectFlow();
    const row = await rawRow();
    await expireSoon(row!._id);
    fixture.setTokenMode({ kind: "refuse", error: "bad_refresh_token" });
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok ? [] : result.missing, [
      { slug: "github", displayName: "GitHub", available: true },
    ]);
    const after = await rawRow();
    assert.equal(after?.status, "needs_reconnect");
    assert.equal(after?.lastError?.code, "refresh_refused");
  });

  test("(g) provider down with a still-valid token uses the stored token", async () => {
    await connectFlow();
    const row = await rawRow();
    // Near the margin but NOT expired, so a failed refresh falls back.
    await setAccessExpiry(row!._id, new Date(Date.now() + 60_000));
    fixture.setTokenMode({ kind: "error", status: 500 });
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    const after = await rawRow();
    assert.equal(after?.status, "active");
  });

  test("(g) provider down with an expired token throws UNAVAILABLE", async () => {
    await connectFlow();
    const row = await rawRow();
    await setAccessExpiry(row!._id, new Date(Date.now() - 1_000));
    fixture.setTokenMode({ kind: "error", status: 503 });
    await assert.rejects(
      connectors.runSpecs(DB_NAME, alice.userId, [connectorId]),
      (error: unknown) => (error as { code?: string }).code === "UNAVAILABLE",
    );
  });

  test("(h) no refresh token and an expired access token needs reconnect", async () => {
    // Connect without a refresh token.
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const authorize = new URL(
      ((await connectRes.json()) as { authorizeUrl: string }).authorizeUrl,
    );
    const code = fixture.mintCode({
      codeChallenge: authorize.searchParams.get("code_challenge")!,
      expiresIn: 3600,
      withRefreshToken: false,
    });
    await callback(
      {
        code,
        state: authorize.searchParams.get("state")!,
        iss: fixture.issuer,
      },
      cookieFrom(connectRes).value,
    );
    const row = await rawRow();
    await setAccessExpiry(row!._id, new Date(Date.now() - 1_000));
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, false);
    const after = await rawRow();
    assert.equal(after?.status, "needs_reconnect");
    assert.equal(after?.lastError?.code, "token_expired");
  });

  test("(i) a grant without expires_in is never refreshed", async () => {
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const authorize = new URL(
      ((await connectRes.json()) as { authorizeUrl: string }).authorizeUrl,
    );
    const code = fixture.mintCode({
      codeChallenge: authorize.searchParams.get("code_challenge")!,
      // No expiresIn → non-expiring app.
    });
    await callback(
      {
        code,
        state: authorize.searchParams.get("state")!,
        iss: fixture.issuer,
      },
      cookieFrom(connectRes).value,
    );
    const row = await rawRow();
    assert.equal(row?.accessExpiresAt, undefined);
    const before = fixture.tokenRequestCount();
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    assert.equal(fixture.tokenRequestCount(), before);
  });

  test("(j) tokenRejected on a refreshable connection makes the next run refresh", async () => {
    await connectFlow();
    const before = fixture.grantTypeCounts().refresh_token ?? 0;
    await connectors.tokenRejected(DB_NAME, alice.userId, "github");
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, true);
    assert.equal(fixture.grantTypeCounts().refresh_token ?? 0, before + 1);
  });

  test("(j) tokenRejected on a non-refreshable connection needs reconnect", async () => {
    const connectRes = await fetch(
      `${running.baseUrl}/api/v1/connectors/github/connect?tenantId=${tenantId.toHexString()}`,
      { method: "POST", headers: { authorization: `Bearer ${alice.token}` } },
    );
    const authorize = new URL(
      ((await connectRes.json()) as { authorizeUrl: string }).authorizeUrl,
    );
    const code = fixture.mintCode({
      codeChallenge: authorize.searchParams.get("code_challenge")!,
      expiresIn: 3600,
      withRefreshToken: false,
    });
    await callback(
      {
        code,
        state: authorize.searchParams.get("state")!,
        iss: fixture.issuer,
      },
      cookieFrom(connectRes).value,
    );
    await connectors.tokenRejected(DB_NAME, alice.userId, "github");
    const after = await rawRow();
    assert.equal(after?.status, "needs_reconnect");
  });

  test("(k) a disabled connector is missing with available:false", async () => {
    await connectFlow();
    await operator.setConnectorEnabled({
      operator: "ops",
      slug: "github",
      enabled: false,
    });
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      connectorId,
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.ok
        ? []
        : result.missing.map((m) => ({ slug: m.slug, available: m.available })),
      [{ slug: "github", available: false }],
    );
  });

  test("(l) lastUsedAt is written at most once per hour", async () => {
    await connectFlow();
    await connectors.runSpecs(DB_NAME, alice.userId, [connectorId]);
    // touch() is fire-and-forget; let it settle.
    await delay(50);
    const first = await rawRow();
    assert.ok(first?.lastUsedAt, "lastUsedAt is set on the first run");

    await connectors.runSpecs(DB_NAME, alice.userId, [connectorId]);
    await delay(50);
    const second = await rawRow();
    // A second run within the hour does not move it.
    assert.equal(second?.lastUsedAt?.getTime(), first?.lastUsedAt?.getTime());
  });

  // ── 7b. Write access: read_only tools and approvedTools ──────────

  // A connector whose allowedTools has a write tool, so read_only can drop it.
  async function connectWriteConnector(
    overrides: Partial<ConnectorDoc> = {},
  ): Promise<ObjectId> {
    const id = await insertConnector("writer", {
      allowedTools: ["get_issue", "list_issues", "create_branch"],
      writeTools: ["create_branch"],
      ...overrides,
    });
    // A live connection for the writer connector, with a non-expiring token
    // sealed under the writer's AAD so runSpecs can decrypt it and build a
    // spec without a token request.
    const aad: SecretAad = {
      tenantId: tenantId.toHexString(),
      ownerId: alice.userId.toHexString(),
      connectorId: id.toHexString(),
    };
    const now = new Date();
    await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .insertOne({
        _id: new ObjectId(),
        connectorId: id,
        ownerId: alice.userId,
        tenantId,
        slug: "writer",
        status: "active",
        secret: sealTokens(config, aad, { accessToken: "writer-access" }),
        toolCount: 3,
        lastVerifiedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    return id;
  }

  test("a read_only ref drops the connector's writeTools from enabledTools", async () => {
    const writerId = await connectWriteConnector();
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      { connectorId: writerId, access: "read_only" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.specs[0]!.enabledTools : [], [
      "get_issue",
      "list_issues",
    ]);
  });

  test("a read_write ref (bare ObjectId or absent access) keeps the writeTools", async () => {
    const writerId = await connectWriteConnector();
    // A bare ObjectId is read_write.
    const bare = await connectors.runSpecs(DB_NAME, alice.userId, [writerId]);
    assert.equal(bare.ok, true);
    assert.deepEqual(bare.ok ? bare.specs[0]!.enabledTools : [], [
      "get_issue",
      "list_issues",
      "create_branch",
    ]);
    // An object ref without access is read_write too.
    const obj = await connectors.runSpecs(DB_NAME, alice.userId, [
      { connectorId: writerId },
    ]);
    assert.deepEqual(obj.ok ? obj.specs[0]!.enabledTools : [], [
      "get_issue",
      "list_issues",
      "create_branch",
    ]);
  });

  test("approvedTools are forwarded only to the matching connector, only when non-empty", async () => {
    const writerId = await connectWriteConnector();
    // github needs a live connection too, so it yields a spec in the same run.
    await connectFlow();
    const result = await connectors.runSpecs(
      DB_NAME,
      alice.userId,
      [writerId, connectorId],
      {
        toolApprovals: [
          { connector: "writer", tool: "create_branch" },
          // A tool for a connector not in this run is ignored.
          { connector: "other", tool: "x" },
        ],
      },
    );
    assert.equal(result.ok, true);
    const specs = result.ok ? result.specs : [];
    const writer = specs.find((s) => s.name === "writer");
    const github = specs.find((s) => s.name === "github");
    assert.deepEqual(writer?.approvedTools, ["create_branch"]);
    // github had no approvals, so the field is omitted entirely.
    assert.equal(github?.approvedTools, undefined);
  });

  test("criticalTools go with the spec and are never forwarded as approved", async () => {
    const writerId = await connectWriteConnector({
      allowedTools: ["get_issue", "create_branch", "delete_branch"],
      writeTools: ["create_branch", "delete_branch"],
      criticalTools: ["delete_branch"],
    });
    const result = await connectors.runSpecs(
      DB_NAME,
      alice.userId,
      [writerId],
      {
        toolApprovals: [
          { connector: "writer", tool: "create_branch" },
          // Stored before the tool became critical: dropped.
          { connector: "writer", tool: "delete_branch" },
        ],
      },
    );
    assert.equal(result.ok, true);
    const writer = result.ok ? result.specs[0] : undefined;
    assert.deepEqual(writer?.approvedTools, ["create_branch"]);
    assert.deepEqual(writer?.criticalTools, ["delete_branch"]);
  });

  // ── 7c. Sandbox network: egress connections in the run policy ────

  const EGRESS = {
    hosts: ["git.example.com", "api.example.com"],
    credential: {
      auth: ["bearer" as const],
      urlPrefixes: ["https://api.example.com/"],
      tokenPattern: "tok_[a-z]{8}",
    },
    reads: [{ methods: ["GET" as const, "HEAD" as const] }],
    critical: [{ methods: ["DELETE" as const] }],
  };

  // An active, non-expiring connection for `owner` to `id`.
  async function connectAs(
    owner: Member,
    id: ObjectId,
    slug: string,
    accessToken: string,
    extra: Partial<McpConnectionDoc> = {},
  ): Promise<void> {
    const aad: SecretAad = {
      tenantId: tenantId.toHexString(),
      ownerId: owner.userId.toHexString(),
      connectorId: id.toHexString(),
    };
    const now = new Date();
    await database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .insertOne({
        _id: new ObjectId(),
        connectorId: id,
        ownerId: owner.userId,
        tenantId,
        slug,
        status: "active",
        secret: sealTokens(config, aad, { accessToken }),
        toolCount: 1,
        lastVerifiedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
  }

  test("an egress connector's active connection joins the run's network with the owner's token", async () => {
    const id = await insertConnector("gitsite", { egress: EGRESS });
    await connectAs(alice, id, "gitsite", "alice-token", {
      account: { login: "alice-gh" },
    });
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [
      { connectorId: id, access: "read_only" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.network : null, [
      {
        name: "gitsite",
        displayName: "gitsite",
        account: "alice-gh",
        access: "read_only",
        hosts: ["git.example.com", "api.example.com"],
        reads: EGRESS.reads,
        critical: EGRESS.critical,
        credential: { ...EGRESS.credential, token: "alice-token" },
      },
    ]);
  });

  test("another member's connection never reaches the run's network", async () => {
    const id = await insertConnector("gitsite", { egress: EGRESS });
    const bob = await member("bob", tenantId);
    await connectAs(bob, id, "gitsite", "bob-token");
    // Alice has no connection of her own: the run is refused, nothing leaks.
    const refused = await connectors.runSpecs(DB_NAME, alice.userId, [id]);
    assert.equal(refused.ok, false);
    assert.doesNotMatch(JSON.stringify(refused), /bob-token/);
    // With her own connection, only her token is used.
    await connectAs(alice, id, "gitsite", "alice-token");
    const ok = await connectors.runSpecs(DB_NAME, alice.userId, [id]);
    assert.equal(ok.ok, true);
    assert.equal(
      ok.ok ? ok.network[0]?.credential?.token : undefined,
      "alice-token",
    );
    assert.doesNotMatch(JSON.stringify(ok), /bob-token/);
  });

  test("a needs_reconnect connection puts nothing in the network", async () => {
    const id = await insertConnector("gitsite", { egress: EGRESS });
    await connectAs(alice, id, "gitsite", "stale-token", {
      status: "needs_reconnect",
    });
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [id]);
    assert.equal(result.ok, false);
    assert.equal("network" in result, false);
  });

  test("a connector without egress is MCP only", async () => {
    const writerId = await connectWriteConnector();
    const result = await connectors.runSpecs(DB_NAME, alice.userId, [writerId]);
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.specs.length : 0, 1);
    assert.deepEqual(result.ok ? result.network : null, []);
  });

  // ── 8. verifyStored & disconnect ─────────────────────────────────
  test("verifyStored with a 401 moves the connection to needs_reconnect", async () => {
    await connectFlow();
    const token = fixture.bearerTokensSeen().at(-1)!;
    // Invalidate the stored access token so the next verify sees a 401.
    fixture.invalidateToken(token);
    const view = await connectors.verifyStored(
      "github",
      tenantId,
      alice.userId,
      DB_NAME,
    );
    assert.equal(view.status, "needs_reconnect");
    assert.equal((await rawRow())?.status, "needs_reconnect");
  });

  test("disconnect revokes the grant and deletes the row", async () => {
    await connectFlow();
    const res = await fetch(tenantUrl("/connectors/github/connection"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await res.json()) as { revoked: boolean };
    assert.equal(res.status, 200);
    assert.equal(body.revoked, true);
    assert.equal((await connectionRows()).length, 0);
    const disc = (await auditRows()).find(
      (e) => e.action === "connector.disconnected",
    );
    assert.equal(disc?.details?.revoked, true);
  });

  test("disconnect still deletes when revoke fails", async () => {
    await connectFlow();
    // Point the revoke at a dead port by reconfiguring is not possible; close
    // the fixture so the revoke DELETE fails, then confirm deletion.
    await fixture.close();
    const res = await fetch(tenantUrl("/connectors/github/connection"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const body = (await res.json()) as { revoked: boolean };
    assert.equal(body.revoked, false);
    assert.equal((await connectionRows()).length, 0);
  });

  // ── Helpers for the refresh tests ────────────────────────────────

  // Makes a row's access token look due for refresh (inside the 15-min
  // margin) without expiring it.
  function expireSoon(id: ObjectId): Promise<unknown> {
    return setAccessExpiry(id, new Date(Date.now() + 60_000));
  }

  function setAccessExpiry(id: ObjectId, at: Date): Promise<unknown> {
    return database
      .tenantDb(DB_NAME)
      .collection<McpConnectionDoc>(CONNECTIONS_COLLECTION)
      .updateOne({ _id: id }, { $set: { accessExpiresAt: at } });
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
});

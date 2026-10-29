import assert from "node:assert/strict";
import { createEgress, EgressBlockedError } from "../src/egress";
import { after, before, beforeEach, describe, test } from "node:test";
import { ObjectId } from "mongodb";
import { RefreshRefusedError } from "../src/credentials";
import {
  createRefreshGrant,
  type ConnectorRecord,
  type RefreshGrantOptions,
} from "../src/refresh-grant";
import { AuthFixture } from "./support/auth-fixture";

// The refresh call the gateway makes at the connector's token endpoint. The
// endpoint is discovered from the MCP server URL the same way platform-next
// does it (oauth-discovery.ts), and the request is platform-next's
// refreshGrant (oauth-exchange.ts), so both services refresh identically.

const auth = new AuthFixture();
const connectorId = new ObjectId();
const SECRET_ENV = "MCP_GATEWAY_TEST_CLIENT_SECRET";
let connector: ConnectorRecord;

function grant(overrides: Partial<RefreshGrantOptions> = {}) {
  return createRefreshGrant({
    findConnector: async (id) => (id.equals(connectorId) ? connector : null),
    resolveSecret: async (ref) => {
      const value = "env" in ref ? process.env[ref.env] : undefined;
      if (!value) throw new Error("secret unavailable");
      return value;
    },
    egress: createEgress({ allowLoopback: true }),
    ...overrides,
  });
}

const request = {
  connectorId,
  slug: "fixture",
  refreshToken: "stored-refresh",
};

describe("refresh grant at the discovered token endpoint", () => {
  before(async () => {
    await auth.start();
    process.env[SECRET_ENV] = "client-secret-value";
  });

  after(async () => {
    delete process.env[SECRET_ENV];
    await auth.close();
  });

  beforeEach(() => {
    auth.reset();
    auth.resource = `${auth.url}/mcp`;
    connector = {
      _id: connectorId,
      url: `${auth.url}/mcp`,
      revision: 1,
      auth: { clientId: "client-id-1", clientSecret: { env: SECRET_ENV } },
    };
  });

  test("posts the refresh grant with the client credentials and parses the reply", async () => {
    const result = await grant()(request);
    assert.deepEqual(result, {
      tokens: {
        accessToken: "refreshed-access-1",
        refreshToken: "refreshed-refresh-1",
      },
      accessExpiresInSec: 3600,
    });
    assert.equal(auth.tokenRequests.length, 1);
    assert.deepEqual(Object.fromEntries(auth.tokenRequests[0]!), {
      grant_type: "refresh_token",
      refresh_token: "stored-refresh",
      client_id: "client-id-1",
      client_secret: "client-secret-value",
      // RFC 8707: the MCP server the token is for, as the metadata names it.
      resource: `${auth.url}/mcp`,
    });
    // Discovery followed the 401's resource_metadata.
    assert.deepEqual(auth.metadataRequests, [
      "/prm",
      "/.well-known/oauth-authorization-server",
    ]);
  });

  test("a form-encoded reply (GitHub) is parsed, with both lifetimes", async () => {
    auth.behaviour = "ok-form";
    assert.deepEqual(await grant()(request), {
      tokens: {
        accessToken: "refreshed-access-1",
        refreshToken: "refreshed-refresh-1",
      },
      accessExpiresInSec: 28800,
      refreshExpiresInSec: 15897600,
    });
  });

  test("sendResource: false sends no resource", async () => {
    connector = {
      ...connector,
      auth: { ...connector.auth, sendResource: false },
    };
    await grant()(request);
    assert.equal(auth.tokenRequests.length, 1);
    assert.equal(auth.tokenRequests[0]!.has("resource"), false);
  });

  test("an unsafe resource in the metadata is an outage, and nothing is sent", async () => {
    for (const resource of [
      "http://mcp.example.test/mcp",
      `${auth.url}/mcp#part`,
      "not a url",
    ]) {
      auth.reset();
      auth.resource = resource;
      await assert.rejects(grant()(request), notRefused(resource));
    }
    assert.equal(auth.tokenRequests.length, 0);
  });

  test("discovery is cached per connector revision", async () => {
    const refresh = grant();
    await refresh(request);
    await refresh(request);
    assert.equal(auth.tokenRequests.length, 2);
    assert.equal(auth.metadataRequests.length, 2, "discovered once");
    connector = { ...connector, revision: 2 };
    await refresh(request);
    assert.equal(auth.metadataRequests.length, 4, "a new revision rediscovers");
  });

  test("a probe that isn't a 401 falls back to the RFC 9728 well-known URL", async () => {
    auth.probe = "200";
    await grant()(request);
    assert.equal(
      auth.metadataRequests[0],
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  test("a refusal is RefreshRefusedError, including GitHub's error in a 200", async () => {
    for (const behaviour of ["refuse", "refuse-200"] as const) {
      auth.reset();
      auth.behaviour = behaviour;
      await assert.rejects(grant()(request), RefreshRefusedError, behaviour);
    }
  });

  test("anything else is an outage, never a refusal (the member stays signed in)", async () => {
    auth.behaviour = "down";
    await assert.rejects(grant()(request), notRefused("5xx"));
    auth.reset();
    await assert.rejects(
      grant({
        resolveSecret: async () => {
          throw new Error("no secret");
        },
      })(request),
      notRefused("secret"),
    );
    await assert.rejects(
      grant()({ ...request, connectorId: new ObjectId() }),
      notRefused("unknown connector"),
    );
    // Every endpoint here is loopback http, so strict mode refuses it.
    await assert.rejects(
      grant({ egress: createEgress() })(request),
      notRefused("not https"),
    );
    assert.equal(auth.tokenRequests.length, 0, "no token request was made");
  });

  test("every discovery and token request goes through the egress check", async () => {
    await assert.rejects(
      grant({
        egress: {
          allowLoopback: true,
          fetch: async () => {
            throw new EgressBlockedError("address");
          },
        },
      })(request),
      notRefused("egress blocked"),
    );
    assert.equal(auth.tokenRequests.length, 0, "no token request was made");
  });

  test("a failed discovery is not cached", async () => {
    const refresh = grant();
    connector = { ...connector, url: "http://127.0.0.1:1/mcp" };
    await assert.rejects(refresh(request), notRefused("unreachable"));
    connector = { ...connector, url: `${auth.url}/mcp` };
    await refresh(request);
    assert.equal(auth.tokenRequests.length, 1);
  });

  test("errors never carry the refresh token or the client secret", async () => {
    auth.behaviour = "refuse";
    const error = await grant()(request).catch((e: unknown) => e);
    const text = `${(error as Error).message} ${String((error as Error).stack)}`;
    assert.ok(!text.includes("stored-refresh"));
    assert.ok(!text.includes("client-secret-value"));
  });
});

function notRefused(label: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error, label);
    assert.ok(
      !(error instanceof RefreshRefusedError),
      `${label}: not a refusal`,
    );
    return true;
  };
}

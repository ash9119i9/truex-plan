import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/common/domain-error";
import { parseConnectorSpec } from "../../src/modules/connectors/connector";
import {
  verifyConnection,
  VerifyFailedError,
  VerifyUnauthorizedError,
} from "../../src/modules/connectors/mcp-verify";
import {
  discoverEndpoints,
  DiscoveryError,
  DiscoveryUnavailableError,
} from "../../src/modules/connectors/oauth-discovery";
import {
  exchangeCode,
  revokeGrant,
} from "../../src/modules/connectors/oauth-exchange";

// The shapes a second directory connector (Google's Gmail MCP) needs from the
// generic connector code, driven with a fetch stub that answers the way the
// live servers did when probed on 2026-10-20: initialize and tools/list work
// without a token (no 401 to read WWW-Authenticate from), the protected-
// resource metadata lists "https://accounts.google.com/" with a trailing slash
// while the authorization-server metadata's issuer has none, and the
// authorization server advertises a userinfo endpoint.

const MCP = "https://mail.example.test/mcp/v1";
const AS = "https://accounts.example.test";

type Route = (init: RequestInit) => Response | Promise<Response>;

function stub(routes: Record<string, Route>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(init) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PRM = {
  resource: MCP,
  authorization_servers: [`${AS}/`],
};

const AS_META = {
  issuer: AS,
  authorization_endpoint: `${AS}/o/oauth2/v2/auth`,
  token_endpoint: `${AS}/token`,
  revocation_endpoint: `${AS}/revoke`,
  userinfo_endpoint: `${AS}/v1/userinfo`,
  code_challenge_methods_supported: ["plain", "S256"],
  authorization_response_iss_parameter_supported: true,
};

function googleRoutes(
  overrides: Record<string, Route> = {},
): Record<string, Route> {
  return {
    [MCP]: () => json({ jsonrpc: "2.0", id: 1, result: {} }),
    "https://mail.example.test/.well-known/oauth-protected-resource/mcp/v1":
      () => json(PRM),
    [`${AS}/.well-known/oauth-authorization-server`]: () => json(AS_META),
    ...overrides,
  };
}

describe("discovery when the server does not 401 up front", () => {
  test("falls back to the well-known protected-resource URL", async () => {
    const { fetchImpl } = stub(googleRoutes());
    const endpoints = await discoverEndpoints({
      connectorUrl: MCP,
      allowLoopback: false,
      fetchImpl,
    });
    assert.equal(endpoints.authorizationEndpoint, `${AS}/o/oauth2/v2/auth`);
    assert.equal(endpoints.tokenEndpoint, `${AS}/token`);
    assert.equal(endpoints.revocationEndpoint, `${AS}/revoke`);
    assert.equal(endpoints.userinfoEndpoint, `${AS}/v1/userinfo`);
    assert.equal(endpoints.issParameterSupported, true);
  });

  // RFC 9207 compares iss by string. URL normalisation would turn the
  // metadata's "https://accounts.example.test" into ".../" and every real
  // callback (which carries no slash) would be refused as an iss mismatch.
  test("keeps the issuer exactly as the metadata spells it", async () => {
    const { fetchImpl } = stub(googleRoutes());
    const endpoints = await discoverEndpoints({
      connectorUrl: MCP,
      allowLoopback: false,
      fetchImpl,
    });
    assert.equal(endpoints.issuer, AS);
  });

  test("a 5xx probe is unavailable, not a misconfiguration", async () => {
    const { fetchImpl } = stub(
      googleRoutes({ [MCP]: () => new Response("", { status: 503 }) }),
    );
    await assert.rejects(
      discoverEndpoints({ connectorUrl: MCP, allowLoopback: false, fetchImpl }),
      DiscoveryUnavailableError,
    );
  });

  test("a server with no metadata anywhere is still a DiscoveryError", async () => {
    const { fetchImpl } = stub({
      [MCP]: () => json({ jsonrpc: "2.0", id: 1, result: {} }),
    });
    await assert.rejects(
      discoverEndpoints({ connectorUrl: MCP, allowLoopback: false, fetchImpl }),
      DiscoveryError,
    );
  });

  test("a non-https userinfo endpoint is refused", async () => {
    const { fetchImpl } = stub(
      googleRoutes({
        [`${AS}/.well-known/oauth-authorization-server`]: () =>
          json({ ...AS_META, userinfo_endpoint: "http://evil.test/userinfo" }),
      }),
    );
    await assert.rejects(
      discoverEndpoints({ connectorUrl: MCP, allowLoopback: false, fetchImpl }),
      DiscoveryError,
    );
  });
});

describe("verify with a userinfo account", () => {
  function mcpRoutes(userinfo: Route): Record<string, Route> {
    return {
      [MCP]: (init) => {
        const body = JSON.parse(String(init.body)) as {
          id?: number;
          method: string;
        };
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "tools/list")
          return json({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "search_threads" }] },
          });
        return json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
      [`${AS}/v1/userinfo`]: userinfo,
    };
  }

  test("names the account from the userinfo claim, sending the bearer", async () => {
    const { fetchImpl, calls } = stub(
      mcpRoutes(() => json({ sub: "1", email: "ada@example.test" })),
    );
    const result = await verifyConnection({
      url: MCP,
      accessToken: "ya29.token",
      fixedHeaders: {},
      userinfo: { url: `${AS}/v1/userinfo`, field: "email" },
      fetchImpl,
    });
    assert.deepEqual(result, {
      toolCount: 1,
      account: { login: "ada@example.test" },
    });
    const userinfoCall = calls.find((c) => c.url.endsWith("/userinfo"))!;
    assert.equal(
      (userinfoCall.init.headers as Record<string, string>).authorization,
      "Bearer ya29.token",
    );
  });

  // tools/list answers without a token on this server, so userinfo is the
  // only proof the token works: its 401 must stop the connect.
  test("a userinfo 401 is unauthorized even though tools/list worked", async () => {
    const { fetchImpl } = stub(
      mcpRoutes(() => new Response("", { status: 401 })),
    );
    await assert.rejects(
      verifyConnection({
        url: MCP,
        accessToken: "bad",
        fixedHeaders: {},
        userinfo: { url: `${AS}/v1/userinfo`, field: "email" },
        fetchImpl,
      }),
      VerifyUnauthorizedError,
    );
  });

  test("a userinfo 5xx fails verify", async () => {
    const { fetchImpl } = stub(
      mcpRoutes(() => new Response("", { status: 500 })),
    );
    await assert.rejects(
      verifyConnection({
        url: MCP,
        accessToken: "t",
        fixedHeaders: {},
        userinfo: { url: `${AS}/v1/userinfo`, field: "email" },
        fetchImpl,
      }),
      VerifyFailedError,
    );
  });

  test("a missing claim leaves the account unnamed", async () => {
    const { fetchImpl } = stub(mcpRoutes(() => json({ sub: "1" })));
    const result = await verifyConnection({
      url: MCP,
      accessToken: "t",
      fixedHeaders: {},
      userinfo: { url: `${AS}/v1/userinfo`, field: "email" },
      fetchImpl,
    });
    assert.equal(result.account, undefined);
  });
});

describe("token exchange reports granted scopes", () => {
  async function exchangeWith(body: Record<string, unknown>) {
    const { fetchImpl } = stub({ [`${AS}/token`]: () => json(body) });
    return exchangeCode({
      tokenEndpoint: `${AS}/token`,
      code: "c",
      codeVerifier: "v",
      clientId: "id",
      clientSecret: "s",
      redirectUri: "https://app.test/cb",
      fetchImpl,
    });
  }

  test("space-separated (RFC 6749)", async () => {
    const grant = await exchangeWith({
      access_token: "a",
      expires_in: 3599,
      scope: "openid https://x.test/auth/gmail.readonly",
    });
    assert.deepEqual(grant.grantedScopes, [
      "openid",
      "https://x.test/auth/gmail.readonly",
    ]);
    assert.equal(grant.accessExpiresInSec, 3599);
  });

  test("comma-separated (GitHub)", async () => {
    const grant = await exchangeWith({ access_token: "a", scope: "repo,gist" });
    assert.deepEqual(grant.grantedScopes, ["repo", "gist"]);
  });

  test("absent scope means granted as requested", async () => {
    const grant = await exchangeWith({ access_token: "a" });
    assert.equal(grant.grantedScopes, undefined);
  });
});

describe("rfc7009 revoke", () => {
  async function revokeWith(refreshToken?: string, status = 200) {
    const { fetchImpl, calls } = stub({
      [`${AS}/revoke`]: () => new Response("", { status }),
    });
    const revoked = await revokeGrant({
      revoke: { kind: "rfc7009", url: `${AS}/revoke` },
      accessToken: "access",
      ...(refreshToken ? { refreshToken } : {}),
      clientId: "id",
      clientSecret: "s",
      fetchImpl,
    });
    return {
      revoked,
      form: new URLSearchParams(String(calls[0]!.init.body)),
      method: calls[0]!.init.method,
    };
  }

  // Revoking the refresh token ends the whole grant and still works after the
  // one-hour access token has expired.
  test("revokes the refresh token when there is one", async () => {
    const { revoked, form, method } = await revokeWith("refresh");
    assert.equal(revoked, true);
    assert.equal(method, "POST");
    assert.equal(form.get("token"), "refresh");
    assert.equal(form.get("token_type_hint"), "refresh_token");
  });

  test("falls back to the access token", async () => {
    const { form } = await revokeWith();
    assert.equal(form.get("token"), "access");
    assert.equal(form.get("token_type_hint"), "access_token");
  });

  // Google answers 400 invalid_token for a token it no longer knows; that
  // cannot prove the grant is gone.
  test("a 400 is not counted as revoked", async () => {
    const { revoked } = await revokeWith("refresh", 400);
    assert.equal(revoked, false);
  });
});

describe("catalog fields for a Google-shaped connector", () => {
  // The shape of the Gmail record the product team applies with the operator
  // CLI (the real one carries the dev client id and lives outside the repo).
  const gmail = {
    slug: "gmail",
    displayName: "Gmail",
    description:
      "Search and read your email, and draft replies with your approval.",
    icon: "gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    fixedHeaders: {},
    auth: {
      type: "oauth_user",
      registration: "preregistered",
      clientId: "123-abc.apps.googleusercontent.com",
      clientSecret: { env: "GMAIL_OAUTH_CLIENT_SECRET" },
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      discovery: "protected_resource_metadata",
      revoke: { kind: "rfc7009", url: "https://oauth2.googleapis.com/revoke" },
      accountUserinfo: { field: "email" },
      authorizeParams: { access_type: "offline", prompt: "consent" },
    },
    allowedTools: [
      "search_threads",
      "get_thread",
      "get_message",
      "list_drafts",
      "get_draft",
      "list_labels",
      "create_draft",
    ],
    writeTools: ["create_draft"],
    toolTimeoutSec: 60,
    startupTimeoutSec: 15,
    sortOrder: 20,
  };

  function rejects(input: unknown, pattern: RegExp): void {
    assert.throws(
      () => parseConnectorSpec(input),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVALID_INPUT" &&
        pattern.test(error.message),
    );
  }

  test("the gmail record parses with no code specific to it", () => {
    const spec = parseConnectorSpec(gmail);
    assert.equal(spec.slug, "gmail");
    assert.deepEqual(spec.auth.authorizeParams, {
      access_type: "offline",
      prompt: "consent",
    });
    assert.deepEqual(spec.auth.accountUserinfo, { field: "email" });
    assert.equal(spec.auth.revoke?.kind, "rfc7009");
    // Drafts only: nothing that sends, trashes or relabels mail.
    assert.deepEqual(spec.writeTools, ["create_draft"]);
    for (const tool of spec.allowedTools ?? [])
      assert.doesNotMatch(tool, /send|trash|spam|label_|unlabel/);
  });

  test("authorizeParams refuses a non-allowlisted name", () => {
    rejects(
      {
        ...gmail,
        auth: { ...gmail.auth, authorizeParams: { redirect_uri: "x" } },
      },
      /authorizeParams may set only/,
    );
    rejects(
      {
        ...gmail,
        auth: { ...gmail.auth, authorizeParams: { client_id: "x" } },
      },
      /authorizeParams may set only/,
    );
  });

  test("authorizeParams refuses a value outside the fixed set", () => {
    rejects(
      {
        ...gmail,
        auth: { ...gmail.auth, authorizeParams: { access_type: "always" } },
      },
      /access_type/,
    );
    rejects(
      {
        ...gmail,
        auth: { ...gmail.auth, authorizeParams: { prompt: "none consent" } },
      },
      /prompt/,
    );
    rejects(
      { ...gmail, auth: { ...gmail.auth, authorizeParams: { prompt: 1 } } },
      /prompt/,
    );
  });

  test("prompt accepts a space-separated set of its values", () => {
    const spec = parseConnectorSpec({
      ...gmail,
      auth: {
        ...gmail.auth,
        authorizeParams: { prompt: "consent select_account" },
      },
    });
    assert.equal(spec.auth.authorizeParams?.prompt, "consent select_account");
  });

  test("accountTool and accountUserinfo are exclusive", () => {
    rejects(
      {
        ...gmail,
        auth: {
          ...gmail.auth,
          accountTool: { name: "get_me", field: "login" },
        },
      },
      /not both/,
    );
  });
});

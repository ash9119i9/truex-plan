import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  connectorView,
  parseConnectorSpec,
  type ConnectorDoc,
  type ConnectorSpec,
} from "../../src/modules/connectors/connector";
import { parseOperatorCommand, UsageError } from "../../src/cli/operator";
import { DomainError } from "../../src/common/domain-error";
import { revokeGrant } from "../../src/modules/connectors/oauth-exchange";

// A valid definition the product team could submit; tests clone and break it
// field by field to prove each rule.
function definition(overrides: Record<string, unknown> = {}): unknown {
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
      clientId: "Iv1.abc123",
      clientSecret: { env: "GITHUB_CONNECTOR_SECRET" },
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

function rejects(input: unknown, pattern?: RegExp): void {
  assert.throws(
    () => parseConnectorSpec(input),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "INVALID_INPUT" &&
      (!pattern || pattern.test(error.message)),
  );
}

describe("parseConnectorSpec", () => {
  test("accepts a complete valid definition and normalises the url", () => {
    const spec = parseConnectorSpec(
      definition({ url: "https://api.githubcopilot.com/mcp/readonly/" }),
    );
    assert.equal(spec.slug, "github");
    // The trailing slash is trimmed, matching the models/chat base-url rule.
    assert.equal(spec.url, "https://api.githubcopilot.com/mcp/readonly");
    assert.equal(spec.auth.type, "oauth_user");
    assert.deepEqual(spec.fixedHeaders, { "X-MCP-Toolsets": "repos,issues" });
    assert.equal(spec.auth.revoke?.kind, "github_app_grant");
  });

  test("defaults the optional timeouts and sortOrder", () => {
    const raw = definition();
    delete (raw as Record<string, unknown>).toolTimeoutSec;
    delete (raw as Record<string, unknown>).startupTimeoutSec;
    delete (raw as Record<string, unknown>).sortOrder;
    const spec = parseConnectorSpec(raw);
    assert.equal(spec.toolTimeoutSec, 60);
    assert.equal(spec.startupTimeoutSec, 15);
    assert.equal(spec.sortOrder, 100);
  });

  test("rejects a non-https url", () => {
    rejects(definition({ url: "http://api.githubcopilot.com/mcp" }), /https/);
  });

  test("rejects a url with credentials, a query or a fragment", () => {
    rejects(definition({ url: "https://u:p@host.test/mcp" }));
    rejects(definition({ url: "https://host.test/mcp?x=1" }));
    rejects(definition({ url: "https://host.test/mcp#frag" }));
  });

  test("rejects a bad slug", () => {
    for (const slug of ["GitHub", "g", "1github", "has-dash", "x".repeat(40)])
      rejects(definition({ slug }), /slug/);
  });

  test("rejects an unknown auth.type and registration", () => {
    rejects(definition({ auth: { ...authOf(), type: "api_key" } }), /type/);
    rejects(
      definition({ auth: { ...authOf(), registration: "dcr" } }),
      /registration/,
    );
  });

  test("rejects an unknown discovery mode", () => {
    rejects(definition({ auth: { ...authOf(), discovery: "hardcoded" } }));
  });

  test("rejects an Authorization header in fixedHeaders", () => {
    rejects(
      definition({ fixedHeaders: { Authorization: "Bearer x" } }),
      /Authorization/,
    );
    // Case-insensitive, and the other credential headers too.
    rejects(definition({ fixedHeaders: { cookie: "a=b" } }));
    rejects(definition({ fixedHeaders: { "Proxy-Authorization": "Basic x" } }));
  });

  test("rejects a token-like value in a fixedHeader without echoing it", () => {
    const secret = "ghp_" + "a".repeat(36);
    assert.throws(
      () =>
        parseConnectorSpec(definition({ fixedHeaders: { "X-Token": secret } })),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        // The field is named, but the secret value never appears.
        assert.match(error.message, /X-Token/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
    // A bearer/basic scheme prefix is refused too.
    rejects(definition({ fixedHeaders: { "X-Auth": "Bearer abc" } }));
  });

  test("rejects an unknown top-level field", () => {
    rejects(definition({ extra: true }), /Unknown field/);
  });

  test("rejects an unknown field inside auth", () => {
    rejects(
      definition({ auth: { ...authOf(), surprise: 1 } }),
      /Unknown field/,
    );
  });

  test("rejects a client secret that sets neither or both of arn and env", () => {
    rejects(definition({ auth: { ...authOf(), clientSecret: {} } }));
    rejects(
      definition({
        auth: {
          ...authOf(),
          clientSecret: { arn: secretArn(), env: "X_SECRET" },
        },
      }),
    );
  });

  test("accepts writeTools that are a subset of allowedTools", () => {
    const spec = parseConnectorSpec(
      definition({
        allowedTools: ["get_issue", "list_issues", "create_branch"],
        writeTools: ["create_branch"],
      }),
    );
    assert.deepEqual(spec.writeTools, ["create_branch"]);
  });

  test("absent writeTools stays absent (every allowed tool is read-only)", () => {
    const spec = parseConnectorSpec(
      definition({ allowedTools: ["get_issue"] }),
    );
    assert.equal(spec.writeTools, undefined);
  });

  test("rejects writeTools without allowedTools (nothing to subtract from)", () => {
    const raw = definition({ writeTools: ["create_branch"] }) as Record<
      string,
      unknown
    >;
    delete raw.allowedTools;
    rejects(raw, /writeTools needs allowedTools/);
  });

  test("rejects a writeTool that is not one of allowedTools", () => {
    rejects(
      definition({
        allowedTools: ["get_issue"],
        writeTools: ["create_branch"],
      }),
      /must be one of allowedTools/,
    );
  });

  test("rejects more than 50 writeTools", () => {
    const allowed = Array.from({ length: 51 }, (_, i) => `t_${i}`);
    rejects(
      definition({ allowedTools: allowed, writeTools: allowed }),
      /at most 50/,
    );
  });
});

describe("connectorView", () => {
  test("exposes no url, client id or auth secrets", () => {
    const spec = parseConnectorSpec(definition()) as ConnectorSpec;
    const doc: ConnectorDoc = {
      _id: fakeId(),
      ...spec,
      enabled: true,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: "ops",
    };
    const view = connectorView(doc);
    const serialised = JSON.stringify(view);
    assert.doesNotMatch(serialised, /githubcopilot|Iv1\.abc123|clientSecret/);
    assert.equal(view.slug, "github");
    assert.equal("url" in view, false);
    assert.equal("auth" in view, false);
  });

  test("carries toolTokenEstimate and adminHelp when present", () => {
    const spec = parseConnectorSpec(
      definition({
        toolTokenEstimate: 7900,
        auth: {
          ...authOf(),
          adminHelp: { text: "Ask your admin", url: "https://help.test/x" },
        },
      }),
    ) as ConnectorSpec;
    const view = connectorView({
      _id: fakeId(),
      ...spec,
      enabled: true,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: "ops",
    });
    assert.equal(view.toolTokenEstimate, 7900);
    assert.equal(view.adminHelp?.url, "https://help.test/x");
  });

  test("exposes writeTools, always as an array ([] when none)", () => {
    const withWrites = parseConnectorSpec(
      definition({
        allowedTools: ["get_issue", "create_branch"],
        writeTools: ["create_branch"],
      }),
    ) as ConnectorSpec;
    const base = {
      _id: fakeId(),
      enabled: true,
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: "ops",
    };
    assert.deepEqual(connectorView({ ...base, ...withWrites }).writeTools, [
      "create_branch",
    ]);
    const noWrites = parseConnectorSpec(definition()) as ConnectorSpec;
    assert.deepEqual(connectorView({ ...base, ...noWrites }).writeTools, []);
  });
});

describe("parseOperatorCommand (connectors)", () => {
  test("parses connector-put with a file", () => {
    assert.deepEqual(
      parseOperatorCommand([
        "connector-put",
        "--operator",
        "ops",
        "--file",
        "c.json",
      ]),
      { command: "connector-put", operator: "ops", file: "c.json" },
    );
  });

  test("parses connector-enable and connector-disable", () => {
    assert.deepEqual(
      parseOperatorCommand([
        "connector-enable",
        "--operator",
        "ops",
        "--slug",
        "github",
      ]),
      {
        command: "connector-set-enabled",
        operator: "ops",
        slug: "github",
        enabled: true,
      },
    );
    assert.deepEqual(
      parseOperatorCommand([
        "connector-disable",
        "--operator",
        "ops",
        "--slug",
        "github",
      ]),
      {
        command: "connector-set-enabled",
        operator: "ops",
        slug: "github",
        enabled: false,
      },
    );
  });

  test("parses connector-list", () => {
    assert.deepEqual(
      parseOperatorCommand(["connector-list", "--operator", "ops"]),
      { command: "connector-list", operator: "ops" },
    );
  });

  test("refuses connector-put without a file and connector-enable without a slug", () => {
    assert.throws(
      () => parseOperatorCommand(["connector-put", "--operator", "ops"]),
      UsageError,
    );
    assert.throws(
      () => parseOperatorCommand(["connector-enable", "--operator", "ops"]),
      UsageError,
    );
  });
});

function authOf(): Record<string, unknown> {
  return (definition() as { auth: Record<string, unknown> }).auth;
}

function secretArn(): string {
  return "arn:aws:secretsmanager:us-east-1:123456789012:secret:truex/test-AbC123";
}

function fakeId() {
  // A real ObjectId without importing mongodb into this pure-parse test.
  return {
    toHexString: () => "0".repeat(24),
  } as unknown as ConnectorDoc["_id"];
}

// Regression: the catalog stores the revoke URL normalised, so its
// {client_id} placeholder arrives percent-encoded. GitHub answers 404 for the
// literal path, which revokeGrant counts as "already revoked", so the grant
// silently stayed live after a disconnect.
describe("revokeGrant on a catalog-normalised URL", () => {
  test("substitutes the client id and hits the real grant path", async () => {
    const spec = parseConnectorSpec(definition());
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const revoked = await revokeGrant({
      revoke: spec.auth.revoke!,
      accessToken: "token",
      clientId: spec.auth.clientId,
      clientSecret: "secret",
      fetchImpl,
    });
    assert.equal(revoked, true);
    assert.deepEqual(calls, [
      "https://api.github.com/applications/Iv1.abc123/grant",
    ]);
  });
});

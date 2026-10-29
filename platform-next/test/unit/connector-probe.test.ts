import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  parseOperatorCommand,
  readTokenFile,
  runConnectorProbe,
  UsageError,
} from "../../src/cli/operator";
import {
  probeConnector,
  reviewedDefinition,
  toolHash,
  type ProbeOptions,
  type ProbeReport,
} from "../../src/modules/connectors/connector-probe";
import {
  verifyConnection,
  VerifyFailedError,
  VerifyUnauthorizedError,
} from "../../src/modules/connectors/mcp-verify";
import {
  startConnectorFixture,
  type ConnectorFixture,
} from "../support/connector-fixtures";

// Task 9: the operator's connector probe. It reports what an MCP server
// supports and drafts the catalog's tool fields for a person to review.

const GET_ISSUE = {
  name: "get_issue",
  description: "Read one issue.",
  inputSchema: { type: "object", properties: { number: { type: "integer" } } },
  annotations: { readOnlyHint: true },
};
const CREATE_ISSUE = {
  name: "create_issue",
  description: "Create an issue.",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
  annotations: { readOnlyHint: false },
};
const LIST_UNLABELLED = {
  name: "list_unlabelled",
  description: "No annotations at all.",
  inputSchema: { type: "object" },
};
// A hint that only looks like read-only: not the boolean true.
const CLAIMS_READ_ONLY = {
  name: "claims_read_only",
  description: "Says it is read-only, as a string.",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: "true" },
};

describe("tool definition hash (identical to the gateway's)", () => {
  test("pinned vector shared with mcp-gateway/test/policy.test.ts", () => {
    assert.equal(
      toolHash(GET_ISSUE),
      "af4a7bc52f1711eae0f514c3a4f38374c37a3923f5f3e95066522c6de3fd6937",
    );
  });

  test("key order is ignored and only the reviewed fields count", () => {
    const reordered = {
      annotations: { readOnlyHint: true },
      inputSchema: {
        properties: { number: { type: "integer" } },
        type: "object",
      },
      description: "Read one issue.",
      name: "get_issue",
      _meta: { vendor: "ignored" },
    };
    assert.equal(toolHash(reordered), toolHash(GET_ISSUE));
    assert.deepEqual(Object.keys(reviewedDefinition(reordered)).sort(), [
      "annotations",
      "description",
      "inputSchema",
      "name",
    ]);
    assert.notEqual(
      toolHash({ ...GET_ISSUE, description: "Read one issue!" }),
      toolHash(GET_ISSUE),
    );
  });
});

describe("connector probe against the fixture", () => {
  let fixture: ConnectorFixture;

  before(async () => {
    fixture = await startConnectorFixture();
  });

  after(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    fixture.setTools(undefined);
    fixture.setMetadataExtras({});
  });

  test("reports each discovery fact; only pre-registration when nothing else is advertised", async () => {
    const report = await probeConnector({
      url: fixture.mcpUrl,
      allowLoopback: true,
    });
    assert.equal(report.url, fixture.mcpUrl);
    assert.deepEqual(report.discovery, {
      resource: fixture.mcpUrl,
      resourceMatchesUrl: true,
      issuer: fixture.issuer,
      authorizationEndpoint: `${fixture.origin}/login/oauth/authorize`,
      tokenEndpoint: `${fixture.origin}/login/oauth/access_token`,
      revocationEndpoint: `${fixture.origin}/login/oauth/revoke`,
      pkceS256: true,
      issParameterSupported: true,
    });
    assert.deepEqual(report.registration, {
      supported: ["preregistered"],
      recommended: "preregistered",
    });
    assert.equal(report.tools, undefined, "no token, no tool list");
    assert.match(report.reminder, /--token/);
  });

  test("detects CIMD and DCR, in the order to use them", async () => {
    fixture.setMetadataExtras({
      authorizationServer: {
        client_id_metadata_document_supported: true,
        registration_endpoint: `${fixture.origin}/register`,
      },
    });
    const report = await probeConnector({
      url: fixture.mcpUrl,
      allowLoopback: true,
    });
    assert.deepEqual(report.registration, {
      supported: ["cimd", "dcr", "preregistered"],
      recommended: "cimd",
    });
    assert.equal(
      report.discovery.registrationEndpoint,
      `${fixture.origin}/register`,
    );
  });

  test("an unsafe registration endpoint isn't offered as DCR", async () => {
    fixture.setMetadataExtras({
      authorizationServer: {
        registration_endpoint: "http://registry.example.test/register",
      },
    });
    const report = await probeConnector({
      url: fixture.mcpUrl,
      allowLoopback: true,
    });
    assert.deepEqual(report.registration.supported, ["preregistered"]);
    assert.equal(report.discovery.registrationEndpoint, undefined);
  });

  test("flags protected-resource metadata that names another server (RFC 9728)", async () => {
    fixture.setMetadataExtras({
      protectedResource: { resource: `${fixture.origin}/other` },
    });
    const report = await probeConnector({
      url: fixture.mcpUrl,
      allowLoopback: true,
    });
    assert.equal(report.discovery.resource, `${fixture.origin}/other`);
    assert.equal(report.discovery.resourceMatchesUrl, false);
  });

  test("drafts every listed tool; anything not marked read-only is a write candidate", async () => {
    // Paged two at a time, so nextCursor must be followed.
    fixture.setTools(
      [GET_ISSUE, CREATE_ISSUE, LIST_UNLABELLED, CLAIMS_READ_ONLY],
      2,
    );
    const token = fixture.issueAccessToken();
    const report = await probeConnector({
      url: fixture.mcpUrl,
      accessToken: token,
      allowLoopback: true,
    });
    assert.equal(report.tools?.listed, 4);
    assert.deepEqual(report.tools?.draft, {
      allowedTools: [
        "get_issue",
        "create_issue",
        "list_unlabelled",
        "claims_read_only",
      ],
      writeTools: ["create_issue", "list_unlabelled", "claims_read_only"],
      toolHashes: {
        get_issue: toolHash(GET_ISSUE),
        create_issue: toolHash(CREATE_ISSUE),
        list_unlabelled: toolHash(LIST_UNLABELLED),
        claims_read_only: toolHash(CLAIMS_READ_ONLY),
      },
    });
    assert.deepEqual(report.tools?.markedReadOnly, ["get_issue"]);
    assert.deepEqual(report.tools?.skipped, []);
    assert.match(report.reminder, /person must classify/i);
    assert.match(report.reminder, /readOnlyHint/);
    assert.ok(
      !JSON.stringify(report).includes(token),
      "the token is never echoed",
    );
  });

  test("with an existing definition, drafts only its allowedTools and names the gaps", async () => {
    fixture.setTools([
      GET_ISSUE,
      CREATE_ISSUE,
      LIST_UNLABELLED,
      CLAIMS_READ_ONLY,
    ]);
    const report = await probeConnector({
      url: fixture.mcpUrl,
      accessToken: fixture.issueAccessToken(),
      allowedTools: ["create_issue", "get_issue", "gone_tool"],
      allowLoopback: true,
    });
    assert.deepEqual(report.tools?.draft.allowedTools, [
      "get_issue",
      "create_issue",
    ]);
    assert.deepEqual(Object.keys(report.tools?.draft.toolHashes ?? {}), [
      "get_issue",
      "create_issue",
    ]);
    assert.deepEqual(report.tools?.missing, ["gone_tool"]);
    assert.deepEqual(report.tools?.notAllowed, [
      "list_unlabelled",
      "claims_read_only",
    ]);
  });

  test("tools with an invalid or repeated name are skipped, not drafted", async () => {
    fixture.setTools([
      GET_ISSUE,
      { ...CREATE_ISSUE, name: "create issue" },
      { description: "no name" },
      { ...GET_ISSUE, description: "a second get_issue" },
    ]);
    const report = await probeConnector({
      url: fixture.mcpUrl,
      accessToken: fixture.issueAccessToken(),
      allowLoopback: true,
    });
    assert.deepEqual(report.tools?.draft.allowedTools, ["get_issue"]);
    assert.equal(report.tools?.draft.toolHashes.get_issue, toolHash(GET_ISSUE));
    assert.deepEqual(report.tools?.skipped, [
      { name: "create issue", reason: "invalid_name" },
      { name: "(none)", reason: "invalid_name" },
      { name: "get_issue", reason: "duplicate" },
    ]);
  });

  test("a token the server rejects stops the probe", async () => {
    await assert.rejects(
      probeConnector({
        url: fixture.mcpUrl,
        accessToken: "not-a-real-token",
        allowLoopback: true,
      }),
      VerifyUnauthorizedError,
    );
  });
});

describe("operator connector-probe", () => {
  test("parses the url, token file, definition and loopback flag", () => {
    assert.deepEqual(
      parseOperatorCommand([
        "connector-probe",
        "--operator",
        "ops",
        "--url",
        "https://api.githubcopilot.com/mcp/",
        "--token",
        "token.txt",
        "--file",
        "github.json",
        "--allow-loopback",
      ]),
      {
        command: "connector-probe",
        operator: "ops",
        url: "https://api.githubcopilot.com/mcp/",
        tokenFile: "token.txt",
        definitionFile: "github.json",
        allowLoopback: true,
      },
    );
    assert.deepEqual(
      parseOperatorCommand([
        "connector-probe",
        "--operator",
        "ops",
        "--url",
        "https://mcp.example.test/mcp",
      ]),
      {
        command: "connector-probe",
        operator: "ops",
        url: "https://mcp.example.test/mcp",
        tokenFile: null,
        definitionFile: null,
        allowLoopback: false,
      },
    );
  });

  test("requires --url", () => {
    assert.throws(
      () => parseOperatorCommand(["connector-probe", "--operator", "ops"]),
      (error: unknown) =>
        error instanceof UsageError && /--url is required/.test(error.message),
    );
  });

  test("reads a token file without ever echoing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-probe-"));
    const good = join(dir, "good.txt");
    writeFileSync(good, "  ghu_probe_token_123\n");
    assert.equal(readTokenFile(good), "ghu_probe_token_123");

    for (const [name, content] of [
      ["empty.txt", "\n"],
      ["two.txt", "ghu_first ghu_secret_second"],
      ["big.txt", `ghu_${"x".repeat(20_000)}`],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, content);
      assert.throws(
        () => readTokenFile(file),
        (error: unknown) =>
          error instanceof UsageError &&
          !error.message.includes("ghu_secret_second") &&
          !error.message.includes("xxxx"),
        name,
      );
    }
    assert.throws(() => readTokenFile(join(dir, "missing.txt")), UsageError);
  });
});

describe("tools/list paging (listTools)", () => {
  // A server whose tools/list never ends: the same cursor every time, or a
  // new one every time. It gives up after 500 pages so a missing guard
  // fails the test instead of exhausting memory.
  function loopingServer(
    cursorFor: (page: number) => string = () => "again",
    seen: { pages: number } = { pages: 0 },
  ): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "tools/list" && ++seen.pages > 500)
        throw new Error("the client never stopped paging");
      const result =
        body.method === "tools/list"
          ? { tools: [GET_ISSUE], nextCursor: cursorFor(seen.pages) }
          : { protocolVersion: "2025-06-18", capabilities: {} };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
  }

  test("a server that repeats a cursor is refused instead of looping", async () => {
    const seen = { pages: 0 };
    await assert.rejects(
      verifyConnection({
        url: "https://mcp.example.test/mcp",
        accessToken: "t",
        fixedHeaders: {},
        listTools: true,
        fetchImpl: loopingServer(() => "again", seen),
      }),
      (error: unknown) =>
        error instanceof VerifyFailedError &&
        /paging did not end/.test(error.message),
    );
    // Refused as soon as the cursor comes back, not at the page cap.
    assert.equal(seen.pages, 2);
  });

  test("a server with a new cursor on every page is stopped at 50 pages", async () => {
    const seen = { pages: 0 };
    await assert.rejects(
      verifyConnection({
        url: "https://mcp.example.test/mcp",
        accessToken: "t",
        fixedHeaders: {},
        listTools: true,
        fetchImpl: loopingServer((page) => `page-${page}`, seen),
      }),
      (error: unknown) =>
        error instanceof VerifyFailedError &&
        /paging did not end/.test(error.message),
    );
    assert.equal(seen.pages, 50, "50 tools/list requests, then refused");
  });

  test("connect still reads only the first page", async () => {
    const result = await verifyConnection({
      url: "https://mcp.example.test/mcp",
      accessToken: "t",
      fixedHeaders: {},
      fetchImpl: loopingServer(),
    });
    assert.deepEqual(result, { toolCount: 1 });
  });
});

describe("runConnectorProbe with a definition", () => {
  // The catalog refuses non-https URLs, so a definition can't name the
  // loopback fixture. These tests record what reaches the probe instead; the
  // allowedTools filtering itself is tested against the fixture above.
  const URL_ = "https://mcp.example.test/mcp";
  const command = (url: string) => ({
    command: "connector-probe" as const,
    operator: "ops",
    url,
    tokenFile: "token.txt",
    definitionFile: "def.json",
    allowLoopback: false,
  });

  test("refuses a --url that isn't the definition's url, before any request", async () => {
    let tokenRead = false;
    let probed = false;
    await assert.rejects(
      runConnectorProbe(
        command(URL_),
        () => definitionFor("https://other.example.test/mcp", ["get_issue"]),
        () => {
          tokenRead = true;
          return "unused";
        },
        async () => {
          probed = true;
          throw new Error("must not probe");
        },
      ),
      (error: unknown) =>
        error instanceof UsageError && /definition's url/.test(error.message),
    );
    assert.equal(tokenRead, false, "the token file isn't even read");
    assert.equal(probed, false);
  });

  test("passes the definition's allowedTools, fixed headers and the token", async () => {
    let seen: ProbeOptions | undefined;
    const report = { url: URL_ } as unknown as ProbeReport;
    const result = await runConnectorProbe(
      command(URL_),
      () => definitionFor(URL_, ["get_issue"]),
      () => "ghu_from_file",
      async (options) => {
        seen = options;
        return report;
      },
    );
    assert.equal(result, report);
    assert.deepEqual(seen, {
      url: URL_,
      allowLoopback: false,
      accessToken: "ghu_from_file",
      allowedTools: ["get_issue"],
      fixedHeaders: { "X-MCP-Toolsets": "repos" },
    });
  });

  function definitionFor(url: string, allowedTools: string[]): unknown {
    return {
      slug: "fixture",
      displayName: "Fixture",
      description: "A probed server.",
      icon: "github",
      url,
      fixedHeaders: { "X-MCP-Toolsets": "repos" },
      auth: {
        type: "oauth_user",
        registration: "preregistered",
        clientId: "fixture-client",
        clientSecret: { env: "FIXTURE_CONNECTOR_SECRET" },
        scopes: [],
        discovery: "protected_resource_metadata",
      },
      allowedTools,
      toolTimeoutSec: 60,
      startupTimeoutSec: 15,
      sortOrder: 1,
    };
  }
});

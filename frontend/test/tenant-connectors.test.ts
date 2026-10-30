import { signInForTest, TENANT_ID } from "./auth-fixture.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ApiRequestError } from "../lib/api.ts";
import {
  approvalOutcomeLabel,
  approvalRaceOutcome,
  callbackErrorMessage,
  connectCardText,
  connectionDetail,
  connectionRequired,
  connectorBanner,
  connectorName,
  disconnect,
  fetchConnectors,
  humanizeToolName,
  isNotConfigured,
  joinNames,
  MAX_APPROVAL_PARAMS,
  MAX_APPROVAL_PARAM_CHARS,
  MAX_CONNECTORS,
  parseApprovalEvent,
  parseApprovalParams,
  parseConnector,
  parseConnectorRef,
  parseConnectorEvent,
  parseSavedTool,
  parseToolEvent,
  postApproval,
  readCallback,
  savedApprovalLabel,
  startConnect,
  statusView,
  tokenEstimateHint,
  toolCardLabel,
  toolDuration,
  verifyConnection,
  type ToolCall,
} from "../lib/tenant-connectors.ts";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(
  t: { after: (fn: () => void) => void },
  reply: unknown,
  init: ResponseInit = {},
) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, request: RequestInit = {}) => {
    sent.push({
      url,
      method: request.method ?? "GET",
      body: request.body ? JSON.parse(String(request.body)) : undefined,
    });
    return Response.json(reply, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

beforeEach(() => signInForTest());

// ---- Wire parsers ----

test("parseConnector keeps a well-formed connector and its connection", () => {
  const parsed = parseConnector({
    slug: "github",
    displayName: "GitHub",
    description: "Read-only access to your repositories.",
    icon: "plug",
    toolTokenEstimate: 7900,
    adminHelp: { text: "Ask your admin", url: "https://example.test/admin" },
    connection: {
      status: "active",
      account: { login: "octocat" },
      toolCount: 29,
      lastVerifiedAt: "2026-10-20T10:00:00.000Z",
    },
  });
  assert.equal(parsed?.slug, "github");
  assert.equal(parsed?.toolTokenEstimate, 7900);
  assert.equal(parsed?.connection.status, "active");
  assert.equal(parsed?.connection.account?.login, "octocat");
  assert.equal(parsed?.connection.toolCount, 29);
});

test("parseConnector drops malformed entries and defaults a missing connection", () => {
  assert.equal(parseConnector(null), null);
  assert.equal(parseConnector({ slug: "GitHub", displayName: "x" }), null); // bad slug
  assert.equal(parseConnector({ slug: "github" }), null); // no displayName
  const minimal = parseConnector({ slug: "github", displayName: "GitHub" });
  assert.equal(minimal?.connection.status, "not_connected");
  assert.equal(minimal?.connection.account, null);
  assert.equal(minimal?.toolTokenEstimate, null);
  assert.equal(minimal?.adminHelp, null);
  assert.equal(minimal?.icon, "plug");
});

test("parseConnector ignores an unknown status and a partial adminHelp", () => {
  const parsed = parseConnector({
    slug: "github",
    displayName: "GitHub",
    adminHelp: { text: "only text" },
    connection: { status: "exploded" },
  });
  assert.equal(parsed?.connection.status, "not_connected");
  assert.equal(parsed?.adminHelp, null);
});

test("parseConnectorRef reads available as a strict boolean", () => {
  assert.equal(
    parseConnectorRef({
      slug: "github",
      displayName: "GitHub",
      available: true,
    })?.available,
    true,
  );
  // Missing or non-true available is unavailable.
  assert.equal(
    parseConnectorRef({ slug: "github", displayName: "GitHub" })?.available,
    false,
  );
  assert.equal(
    parseConnectorRef({
      slug: "github",
      displayName: "GitHub",
      available: "yes",
    })?.available,
    false,
  );
  assert.equal(parseConnectorRef({ slug: "GitHub", displayName: "x" }), null);
});

// ---- Callback error messages ----

test("callbackErrorMessage maps every safe code to a human sentence", () => {
  const name = "GitHub";
  for (const code of [
    "cancelled",
    "state_invalid",
    "expired",
    "not_member",
    "exchange_failed",
    "verify_failed",
    "permissions_missing",
    "unavailable",
  ]) {
    const message = callbackErrorMessage(code, name);
    assert.match(message, /GitHub/);
    // No raw snake_case code leaks into the sentence (plain English words
    // like "cancelled" or "expired" are fine).
    if (code.includes("_")) assert.doesNotMatch(message, new RegExp(code));
  }
});

test("callbackErrorMessage falls back for an unknown code and a missing name", () => {
  assert.match(callbackErrorMessage("weird_thing"), /the connector/);
  assert.match(callbackErrorMessage("cancelled"), /the connector/);
});

test("readCallback reads success, error and none", () => {
  assert.deepEqual(readCallback("?connected=github"), {
    kind: "connected",
    slug: "github",
  });
  assert.deepEqual(readCallback("?error=cancelled&connector=github"), {
    kind: "error",
    code: "cancelled",
    slug: "github",
  });
  // Non-tenant fallback: a code with no connector.
  assert.deepEqual(readCallback("?error=state_invalid"), {
    kind: "error",
    code: "state_invalid",
    slug: null,
  });
  assert.deepEqual(readCallback(""), { kind: "none" });
  // A bogus connected slug is not accepted as a success.
  assert.equal(readCallback("?connected=NotASlug").kind, "none");
});

// ---- 409 CONNECTION_REQUIRED ----

test("connectionRequired parses the 409 details and keeps order", () => {
  const error = new ApiRequestError(
    "Connect GitHub to use this agent.",
    409,
    "CONNECTION_REQUIRED",
    {
      details: {
        connectors: [
          { slug: "github", displayName: "GitHub", available: true },
          { slug: "jira", displayName: "Jira", available: false },
        ],
      },
    },
  );
  const parsed = connectionRequired(error);
  assert.equal(parsed?.message, "Connect GitHub to use this agent.");
  assert.deepEqual(
    parsed?.connectors.map((c) => [c.slug, c.available]),
    [
      ["github", true],
      ["jira", false],
    ],
  );
});

test("connectionRequired ignores other failures and empty details", () => {
  assert.equal(connectionRequired(new Error("plain")), null);
  assert.equal(
    connectionRequired(
      new ApiRequestError("x", 400, "BAD_REQUEST", { details: {} }),
    ),
    null,
  );
  // Right code, but no readable connectors → fall back to the generic error.
  assert.equal(
    connectionRequired(
      new ApiRequestError("x", 409, "CONNECTION_REQUIRED", {
        details: { connectors: [{ slug: "X" }] },
      }),
    ),
    null,
  );
});

test("connectCardText and joinNames read as a sentence", () => {
  assert.equal(joinNames(["GitHub"]), "GitHub");
  assert.equal(joinNames(["GitHub", "Jira"]), "GitHub and Jira");
  assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
  assert.equal(
    connectCardText([
      {
        slug: "github",
        displayName: "GitHub",
        icon: "plug",
        available: true,
        access: "read_write",
      },
    ]),
    "This agent uses GitHub. Connect to continue.",
  );
});

// ---- Tool labels ----

test("humanizeToolName turns snake_case and camelCase into words", () => {
  assert.equal(humanizeToolName("list_issues"), "list issues");
  assert.equal(humanizeToolName("pull_request_read"), "pull request read");
  assert.equal(humanizeToolName("getMe"), "get me");
  assert.equal(humanizeToolName("search-issues"), "search issues");
  assert.equal(humanizeToolName("get_issue"), "get issue");
});

test("toolDuration formats like the transcript's usage line", () => {
  assert.equal(toolDuration(1200), "1.2 s");
  assert.equal(toolDuration(400), "0.4 s");
  assert.equal(toolDuration(12_000), "12 s");
  assert.equal(toolDuration(null), "");
  assert.equal(toolDuration(-5), "");
});

test("toolCardLabel speaks each status in the connector's voice", () => {
  const base: ToolCall = {
    connector: "GitHub",
    tool: "list_issues",
    status: "inProgress",
    durationMs: null,
    errorCode: null,
  };
  assert.equal(toolCardLabel(base), "Using GitHub · list issues");
  assert.equal(
    toolCardLabel({ ...base, status: "completed", durationMs: 1200 }),
    "Used GitHub · list issues · 1.2 s",
  );
  // Done with no duration omits it.
  assert.equal(
    toolCardLabel({ ...base, status: "completed" }),
    "Used GitHub · list issues",
  );
  assert.equal(
    toolCardLabel({
      ...base,
      tool: "search_issues",
      status: "failed",
      errorCode: "REFUSED",
    }),
    "GitHub · search issues wasn't allowed",
  );
  assert.equal(
    toolCardLabel({ ...base, status: "failed", errorCode: "TIMEOUT" }),
    "GitHub · list issues took too long",
  );
  assert.equal(
    toolCardLabel({ ...base, status: "failed", errorCode: "TOOL_ERROR" }),
    "GitHub · list issues didn't work",
  );
});

// ---- Connector banners ----

test("connectorBanner maps auth and unreachable, ignores ready/starting", () => {
  const auth = connectorBanner("failed", "auth", "GitHub");
  assert.equal(auth?.reconnect, true);
  assert.match(auth!.message, /reconnect/);
  const unreachable = connectorBanner("failed", "unreachable", "GitHub");
  assert.equal(unreachable?.reconnect, false);
  assert.match(unreachable!.message, /couldn't be reached/);
  assert.equal(connectorBanner("ready", "auth", "GitHub"), null);
  assert.equal(connectorBanner("starting", "unknown", "GitHub"), null);
});

// ---- Stream / saved parsing ----

test("parseToolEvent and parseConnectorEvent normalise the wire", () => {
  assert.deepEqual(
    parseToolEvent({
      itemId: "i1",
      connector: "github",
      tool: "get_issue",
      status: "inProgress",
    }),
    {
      itemId: "i1",
      connector: "github",
      tool: "get_issue",
      status: "inProgress",
      durationMs: null,
      errorCode: null,
    },
  );
  assert.equal(parseToolEvent({ itemId: "i1", connector: "GitHub" }), null);
  assert.deepEqual(
    parseConnectorEvent({
      connector: "github",
      status: "failed",
      reason: "auth",
    }),
    { connector: "github", status: "failed", reason: "auth" },
  );
  // A missing reason defaults to unknown.
  assert.equal(
    parseConnectorEvent({ connector: "github", status: "failed" })?.reason,
    "unknown",
  );
  assert.equal(parseConnectorEvent({ status: "failed" }), null);
});

test("parseSavedTool reads a settled tool message", () => {
  assert.deepEqual(
    parseSavedTool({
      connector: "github",
      name: "list_issues",
      status: "completed",
      durationMs: 1200,
    }),
    {
      connector: "github",
      name: "list_issues",
      status: "completed",
      durationMs: 1200,
      errorCode: null,
    },
  );
  // An in-progress saved tool is not valid; only completed/failed.
  assert.equal(
    parseSavedTool({ connector: "github", name: "x", status: "inProgress" }),
    null,
  );
});

test("connectorName resolves a slug to a display name, else capitalises", () => {
  const known = [{ slug: "github", displayName: "GitHub" }];
  assert.equal(connectorName("github", known), "GitHub");
  assert.equal(connectorName("jira", known), "Jira");
});

// ---- API wrappers ----

test("fetchConnectors lists for this tab's tenant", async (t) => {
  const sent = mockFetch(t, {
    connectors: [
      {
        slug: "github",
        displayName: "GitHub",
        connection: { status: "active" },
      },
    ],
  });
  const result = await fetchConnectors();
  assert.equal(result.kind, "list");
  assert.equal(sent[0]?.url, `/api/v1/connectors?tenantId=${TENANT_ID}`);
  if (result.kind === "list") assert.equal(result.connectors.length, 1);
});

test("fetchConnectors reads 503 CONNECTORS_NOT_CONFIGURED as not configured", async (t) => {
  mockFetch(
    t,
    { error: { code: "CONNECTORS_NOT_CONFIGURED", message: "off" } },
    { status: 503 },
  );
  const result = await fetchConnectors();
  assert.equal(result.kind, "not_configured");
});

test("isNotConfigured only matches the feature-off code", () => {
  assert.equal(
    isNotConfigured(new ApiRequestError("x", 503, "CONNECTORS_NOT_CONFIGURED")),
    true,
  );
  assert.equal(isNotConfigured(new ApiRequestError("x", 503, "OTHER")), false);
  assert.equal(isNotConfigured(new Error("x")), false);
});

test("startConnect posts and returns the authorize URL", async (t) => {
  const sent = mockFetch(t, {
    authorizeUrl: "https://github.test/login/oauth/authorize?x=1",
  });
  const url = await startConnect("github");
  assert.equal(sent[0]?.method, "POST");
  assert.equal(
    sent[0]?.url,
    `/api/v1/connectors/github/connect?tenantId=${TENANT_ID}`,
  );
  assert.equal(url, "https://github.test/login/oauth/authorize?x=1");
});

test("verifyConnection posts and returns the fresh connection", async (t) => {
  const sent = mockFetch(t, {
    connection: { status: "active", account: { login: "octocat" } },
  });
  const connection = await verifyConnection("github");
  assert.equal(sent[0]?.method, "POST");
  assert.equal(
    sent[0]?.url,
    `/api/v1/connectors/github/connection/verify?tenantId=${TENANT_ID}`,
  );
  assert.equal(connection.status, "active");
});

test("disconnect sends DELETE and reads revoked", async (t) => {
  const sent = mockFetch(t, { revoked: false });
  const result = await disconnect("github");
  assert.equal(sent[0]?.method, "DELETE");
  assert.equal(
    sent[0]?.url,
    `/api/v1/connectors/github/connection?tenantId=${TENANT_ID}`,
  );
  assert.equal(result.revoked, false);
});

test("the connector cap is three", () => {
  assert.equal(MAX_CONNECTORS, 3);
});

// ---- Status presentation ----

test("statusView maps each status to label, tone and action", () => {
  assert.deepEqual(
    statusView({
      status: "active",
      account: null,
      toolCount: null,
      lastVerifiedAt: null,
    }),
    {
      label: "Connected",
      tone: "good",
      action: "manage",
    },
  );
  assert.deepEqual(
    statusView({
      status: "needs_reconnect",
      account: null,
      toolCount: null,
      lastVerifiedAt: null,
    }),
    { label: "Reconnect needed", tone: "warn", action: "reconnect" },
  );
  assert.deepEqual(
    statusView({
      status: "needs_admin_approval",
      account: null,
      toolCount: null,
      lastVerifiedAt: null,
    }),
    { label: "Needs admin approval", tone: "warn", action: "admin" },
  );
  assert.deepEqual(
    statusView({
      status: "not_connected",
      account: null,
      toolCount: null,
      lastVerifiedAt: null,
    }),
    { label: "Not connected", tone: "neutral", action: "connect" },
  );
});

test("connectionDetail lists the account and tool count", () => {
  assert.equal(
    connectionDetail({
      status: "active",
      account: { login: "octocat" },
      toolCount: 29,
      lastVerifiedAt: null,
    }),
    "Connected as @octocat · 29 tools",
  );
  assert.equal(
    connectionDetail({
      status: "active",
      account: { login: "octocat" },
      toolCount: 1,
      lastVerifiedAt: null,
    }),
    "Connected as @octocat · 1 tool",
  );
  assert.equal(
    connectionDetail({
      status: "not_connected",
      account: null,
      toolCount: null,
      lastVerifiedAt: null,
    }),
    "",
  );
});

test("tokenEstimateHint reads as rounded guidance", () => {
  assert.equal(tokenEstimateHint(7900), "~8k tokens per message");
  assert.equal(tokenEstimateHint(1200), "~1k tokens per message");
  assert.equal(tokenEstimateHint(300), "~300 tokens per message");
  assert.equal(tokenEstimateHint(null), "");
  assert.equal(tokenEstimateHint(0), "");
});

test("only a same-origin path is accepted as the return link", async () => {
  const { safeReturnPath } = await import("../lib/tenant-connectors.ts");
  assert.equal(safeReturnPath("/t/abc/chat?c=1"), "/t/abc/chat?c=1");
  for (const bad of [
    null,
    "",
    "javascript:alert(1)",
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example/x",
    "/t/a\nb",
  ])
    assert.equal(safeReturnPath(bad), null, String(bad));
});

// ---- Write access: catalog writeTools and connector-ref access ----

test("parseConnector reads writeTools and drops bad names", () => {
  const parsed = parseConnector({
    slug: "github",
    displayName: "GitHub",
    writeTools: ["create_branch", "bad name!", 42, "merge-pr"],
  });
  assert.deepEqual(parsed?.writeTools, ["create_branch", "merge-pr"]);
  // Missing writeTools defaults to [].
  assert.deepEqual(
    parseConnector({ slug: "github", displayName: "GitHub" })?.writeTools,
    [],
  );
});

test("parseConnectorRef reads access, defaulting to read_write", () => {
  assert.equal(
    parseConnectorRef({
      slug: "github",
      displayName: "GitHub",
      available: true,
      access: "read_only",
    })?.access,
    "read_only",
  );
  // Absent or unknown access is the read_write default.
  assert.equal(
    parseConnectorRef({ slug: "github", displayName: "GitHub" })?.access,
    "read_write",
  );
  assert.equal(
    parseConnectorRef({
      slug: "github",
      displayName: "GitHub",
      access: "write_everything",
    })?.access,
    "read_write",
  );
});

// ---- Approval event parsing ----

test("parseApprovalEvent keeps a pending event and defaults a bad status", () => {
  const parsed = parseApprovalEvent({
    approvalId: "ap1",
    itemId: "t1",
    connector: "github",
    tool: "create_branch",
    params: [{ name: "repo", value: "octo/widgets" }],
    status: "pending",
    expiresAt: "2026-10-20T10:05:00.000Z",
  });
  assert.equal(parsed?.status, "pending");
  assert.equal(parsed?.auto, false);
  assert.deepEqual(parsed?.params, [{ name: "repo", value: "octo/widgets" }]);
  // An unknown status falls back to pending so a half-formed event never
  // silently settles a card.
  assert.equal(
    parseApprovalEvent({
      approvalId: "ap1",
      itemId: "t1",
      connector: "github",
      tool: "x",
      status: "exploded",
    })?.status,
    "pending",
  );
  // A settled event keeps its decision and auto flag.
  assert.deepEqual(
    [
      parseApprovalEvent({
        approvalId: "ap1",
        itemId: "t1",
        connector: "github",
        tool: "x",
        status: "allow_for_chat",
        auto: true,
      })?.status,
      parseApprovalEvent({
        approvalId: "ap1",
        itemId: "t1",
        connector: "github",
        tool: "x",
        status: "allow_for_chat",
        auto: true,
      })?.auto,
    ],
    ["allow_for_chat", true],
  );
  // A missing id/connector/tool drops the event.
  assert.equal(parseApprovalEvent({ itemId: "t1" }), null);
  assert.equal(
    parseApprovalEvent({
      approvalId: "ap1",
      itemId: "t1",
      connector: "GitHub",
    }),
    null,
  );
});

test("parseApprovalParams stringifies, caps the count and cuts long values", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    name: `p${i}`,
    value: i,
  }));
  const params = parseApprovalParams(many);
  assert.equal(params.length, MAX_APPROVAL_PARAMS);
  // A number value is stringified (never "[object Object]").
  assert.equal(params[0]?.value, "0");
  // A long value is cut to the cap.
  const long = parseApprovalParams([{ name: "body", value: "x".repeat(900) }]);
  assert.equal(long[0]?.value.length, MAX_APPROVAL_PARAM_CHARS);
  // A nameless param is dropped; an object value is JSON-stringified.
  const mixed = parseApprovalParams([
    { value: "no name" },
    { name: "obj", value: { a: 1 } },
  ]);
  assert.deepEqual(mixed, [{ name: "obj", value: '{"a":1}' }]);
  assert.deepEqual(parseApprovalParams("nope"), []);
});

// ---- Approval presentation ----

test("approvalOutcomeLabel maps each decision, none for pending", () => {
  assert.equal(approvalOutcomeLabel("allow"), "Allowed");
  assert.equal(approvalOutcomeLabel("allow_for_chat"), "Allowed for this chat");
  assert.equal(approvalOutcomeLabel("deny"), "Denied");
  assert.equal(approvalOutcomeLabel("expired"), "Expired — not run");
  assert.equal(approvalOutcomeLabel("cancelled"), "Cancelled");
  assert.equal(approvalOutcomeLabel("pending"), null);
});

test("savedApprovalLabel reads not-run for a refused call", () => {
  assert.equal(savedApprovalLabel("allow"), "Allowed");
  assert.equal(savedApprovalLabel("allow_for_chat"), "Allowed for this chat");
  assert.equal(savedApprovalLabel("deny"), "Not run");
  assert.equal(savedApprovalLabel("expired"), "Not run");
  assert.equal(savedApprovalLabel("cancelled"), "Not run");
});

test("parseSavedTool carries the approval decision when present", () => {
  const parsed = parseSavedTool({
    connector: "github",
    name: "create_branch",
    status: "completed",
    durationMs: 800,
    approval: "allow",
  });
  assert.equal(parsed?.approval, "allow");
  // A read-only call carries no approval.
  assert.equal(
    parseSavedTool({
      connector: "github",
      name: "list_issues",
      status: "completed",
    })?.approval,
    undefined,
  );
  // A bogus approval value is dropped.
  assert.equal(
    parseSavedTool({
      connector: "github",
      name: "x",
      status: "failed",
      approval: "maybe",
    })?.approval,
    undefined,
  );
});

// ---- postApproval API wrapper + first-answer races ----

function mockApproval(
  t: { after: (fn: () => void) => void },
  reply: unknown,
  init: ResponseInit = {},
) {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, request: RequestInit = {}) => {
    sent.push({
      url,
      method: request.method ?? "GET",
      body: request.body ? JSON.parse(String(request.body)) : undefined,
    });
    return Response.json(reply, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

test("postApproval posts the decision to the chat run's approval route", async (t) => {
  const sent = mockApproval(t, { decision: "allow" });
  const result = await postApproval(
    "64b7f0c2a1b2c3d4e5f60c01",
    "64b7f0c2a1b2c3d4e5f60d01",
    "ap1",
    "allow",
  );
  assert.equal(sent[0]?.method, "POST");
  assert.equal(
    sent[0]?.url,
    `/api/v1/chats/64b7f0c2a1b2c3d4e5f60c01/runs/64b7f0c2a1b2c3d4e5f60d01/approvals/ap1?tenantId=${TENANT_ID}`,
  );
  assert.deepEqual(sent[0]?.body, { decision: "allow" });
  assert.deepEqual(result, { kind: "ok", decision: "allow" });
});

test("postApproval falls back to the posted decision on a terse 200", async (t) => {
  mockApproval(t, {});
  const result = await postApproval(
    "64b7f0c2a1b2c3d4e5f60c01",
    "64b7f0c2a1b2c3d4e5f60d01",
    "ap1",
    "allow_for_chat",
  );
  assert.deepEqual(result, { kind: "ok", decision: "allow_for_chat" });
});

test("postApproval reads 409 APPROVAL_RESOLVED and 404 APPROVAL_NOT_FOUND", async (t) => {
  mockApproval(
    t,
    {
      error: {
        code: "APPROVAL_RESOLVED",
        message: "This request was already answered.",
      },
    },
    { status: 409 },
  );
  assert.deepEqual(
    await postApproval(
      "64b7f0c2a1b2c3d4e5f60c01",
      "64b7f0c2a1b2c3d4e5f60d01",
      "ap1",
      "deny",
    ),
    { kind: "resolved" },
  );
});

test("postApproval reads 404 APPROVAL_NOT_FOUND", async (t) => {
  mockApproval(
    t,
    {
      error: {
        code: "APPROVAL_NOT_FOUND",
        message: "This request has expired or the reply has finished.",
      },
    },
    { status: 404 },
  );
  assert.deepEqual(
    await postApproval(
      "64b7f0c2a1b2c3d4e5f60c01",
      "64b7f0c2a1b2c3d4e5f60d01",
      "ap1",
      "deny",
    ),
    { kind: "not_found" },
  );
});

test("postApproval returns a retryable failure for anything else", async (t) => {
  mockApproval(
    t,
    {
      error: { code: "UNAVAILABLE", message: "The assistant is unreachable." },
    },
    { status: 503 },
  );
  const result = await postApproval(
    "64b7f0c2a1b2c3d4e5f60c01",
    "64b7f0c2a1b2c3d4e5f60d01",
    "ap1",
    "allow",
  );
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.match(result.message, /unreachable/);
});

test("approvalRaceOutcome only matches the two race codes", () => {
  assert.equal(
    approvalRaceOutcome(new ApiRequestError("x", 409, "APPROVAL_RESOLVED")),
    "resolved",
  );
  assert.equal(
    approvalRaceOutcome(new ApiRequestError("x", 404, "APPROVAL_NOT_FOUND")),
    "not_found",
  );
  assert.equal(
    approvalRaceOutcome(new ApiRequestError("x", 500, "SERVER_ERROR")),
    null,
  );
  assert.equal(approvalRaceOutcome(new Error("x")), null);
});

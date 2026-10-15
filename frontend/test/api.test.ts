import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  addressed,
  api,
  ApiRequestError,
  errorRef,
  userMessage,
} from "../lib/api.ts";
import { onUnauthenticated, setIdentityScope } from "../lib/identity.ts";
import {
  refreshed,
  signInForTest,
  TENANT_ID,
  USER_ID,
} from "./auth-fixture.ts";

beforeEach(() => signInForTest());

test("cold runtime requests can finish after 45 seconds without resubmitting", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("timeout", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  const fetched = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, options?: RequestInit) => {
      const signal = options?.signal;
      assert.ok(signal);
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        setTimeout(() => resolve(new Response('{"ok":true}')), 60_000);
      });
    },
  );
  for (const [path, body] of [
    ["/api/sessions", {}],
    ["/api/sessions/s1", undefined],
    ["/api/sessions/s1/messages", { text: "hello", clientId: "c1" }],
    ["/healthz", undefined],
  ] as const) {
    const response = api(path, body);
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(60_000);
    assert.deepEqual(await response, { ok: true });
  }
  assert.equal(fetched.mock.callCount(), 4);

  const catalog = api("/api/agents");
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(45_000);
  await assert.rejects(catalog, { code: "REQUEST_TIMEOUT" });
  assert.equal(fetched.mock.callCount(), 5);
});

test("runtime timeouts retain the server reference without retrying the mutation", async (t) => {
  t.mock.method(console, "error", () => {});
  const fetched = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: "The assistant service timed out.",
          code: "OWNER_TIMEOUT",
          requestId: "req-timeout",
        }),
        { status: 504 },
      ),
  );
  await assert.rejects(api("/api/sessions", {}), {
    status: 504,
    code: "OWNER_TIMEOUT",
    requestId: "req-timeout",
  });
  assert.equal(fetched.mock.callCount(), 1);
});

test("API errors retain server detail and metadata", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: "A model profile is required",
          code: "MODEL_CONFIGURATION",
        }),
        { status: 422 },
      ),
  );
  await assert.rejects(api("/api/sessions", {}), {
    message: "A model profile is required",
    code: "MODEL_CONFIGURATION",
    status: 422,
  });
});

test("HTML, empty, and malformed error bodies produce status-specific messages", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch");
  for (const body of [
    "<html>secret proxy details</html>",
    "",
    "null",
    '{"error":{}}',
  ]) {
    mocked.mock.mockImplementation(
      async () => new Response(body, { status: 503 }),
    );
    await assert.rejects(api("/api/agents"), {
      message: "The service is temporarily unavailable. Try again later.",
      status: 503,
      code: "HTTP_503",
    });
  }
  mocked.mock.mockImplementation(
    async () => new Response("invalid", { status: 200 }),
  );
  await assert.rejects(api("/api/agents"), { code: "INVALID_RESPONSE" });
});

test("connection and timeout errors explain uncertain delivery; success is unchanged", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(api("/api/sessions", {}), { code: "NETWORK_ERROR" });
  mocked.mock.mockImplementation(async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  await assert.rejects(api("/api/sessions", {}), { code: "REQUEST_TIMEOUT" });
  mocked.mock.mockImplementation(async () => new Response('{"ok":true}'));
  assert.deepEqual(await api("/healthz"), { ok: true });
});

test("API errors carry the request id from the body, else the header", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          error: "Conflict",
          code: "CONFLICT",
          requestId: "req-body",
        }),
        { status: 409, headers: { "x-request-id": "req-header" } },
      ),
  );
  await assert.rejects(api("/api/sessions/s1/interrupt", {}), {
    status: 409,
    code: "CONFLICT",
    requestId: "req-body",
  });
  mocked.mock.mockImplementation(
    async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "x-request-id": "req-header" },
      }),
  );
  await assert.rejects(api("/api/agents"), {
    code: "HTTP_502",
    requestId: "req-header",
  });
});

test("network failures keep the original error as the cause and are logged", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const original = new TypeError("fetch failed");
  t.mock.method(globalThis, "fetch", async () => {
    throw original;
  });
  const error = await api("/api/sessions", {}).catch((e) => e);
  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.cause, original);
  assert.equal(error.requestId, undefined);
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0].arguments[1], {
    method: "POST",
    path: "/api/sessions",
    status: 0,
    code: "NETWORK_ERROR",
    requestId: undefined,
  });
});

test("userMessage shows API messages and hides unexpected errors", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const apiError = new ApiRequestError(
    "Not found here",
    404,
    "SESSION_NOT_FOUND",
    {
      requestId: "r1",
    },
  );
  assert.equal(userMessage(apiError), "Not found here");
  assert.equal(logged.mock.callCount(), 0);
  const bug = new TypeError("Cannot read properties of undefined");
  assert.doesNotMatch(userMessage(bug), /Cannot read/);
  assert.equal(userMessage(bug, "Fallback"), "Fallback");
  assert.equal(logged.mock.callCount(), 2);
  assert.deepEqual(errorRef(apiError), {
    code: "SESSION_NOT_FOUND",
    requestId: "r1",
  });
  assert.equal(errorRef(bug), null);
});

test("tenant requests name exactly the tab's tenant; account reads name none", async (t) => {
  assert.equal(addressed("/api/v1/me", TENANT_ID), "/api/v1/me");
  assert.equal(
    addressed("/api/v1/me/tenants", TENANT_ID),
    "/api/v1/me/tenants",
  );
  assert.equal(
    addressed("/api/v1/tenant", TENANT_ID),
    `/api/v1/tenant?tenantId=${TENANT_ID}`,
  );
  assert.equal(
    addressed("/api/v1/chats?cursor=a%26b", TENANT_ID),
    `/api/v1/chats?cursor=a%26b&tenantId=${TENANT_ID}`,
  );
  // The tenant only ever comes from the tab, never from the caller's path.
  for (const path of [
    "/api/v1/tenant?tenantId=x",
    "/api/v1/me?tenantId=x",
    "/api/v1/tenant?a=1&tenantId=",
  ])
    assert.equal(
      (addressed(path, TENANT_ID) as ApiRequestError).code,
      "TENANT_IN_PATH",
      path,
    );
  for (const tenant of [
    null,
    "",
    "default",
    TENANT_ID.toUpperCase(),
    `${TENANT_ID}&role=admin`,
  ])
    assert.equal(
      (addressed("/api/v1/tenant", tenant) as ApiRequestError).code,
      "NO_TENANT",
      String(tenant),
    );
  // The account reads need no tenant at all.
  assert.equal(addressed("/api/v1/me", null), "/api/v1/me");

  t.mock.method(console, "warn", () => {});
  const fetched = t.mock.method(globalThis, "fetch", async () =>
    Response.json({}),
  );
  setIdentityScope(USER_ID, "not-a-tenant");
  await assert.rejects(api("/api/v1/tenant"), { code: "NO_TENANT" });
  assert.equal(fetched.mock.callCount(), 0, "nothing is sent without a tenant");
});

test("requests carry the access token in a header, never in the URL", async (t) => {
  const seen: { url: string; authorization: string | null }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ tenant: { id: TENANT_ID } });
    },
  );
  await api("/api/v1/tenant");
  await api("/api/v1/me");
  assert.deepEqual(seen, [
    {
      url: `/api/v1/tenant?tenantId=${TENANT_ID}`,
      authorization: "Bearer token-1",
    },
    { url: "/api/v1/me", authorization: "Bearer token-1" },
  ]);
});

test("an expired token is renewed once and the request repeated; a second refusal is a sign-out", async (t) => {
  t.mock.method(console, "warn", () => {});
  let notified = 0;
  t.after(onUnauthenticated(() => notified++));
  const calls: string[] = [];
  let valid = "token-2";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push(`${url} ${authorization ?? ""}`.trim());
      if (url === "/api/v1/auth/refresh") return refreshed(valid);
      return authorization === `Bearer ${valid}`
        ? Response.json({ ok: true })
        : Response.json(
            { error: { code: "UNAUTHENTICATED", message: "x" } },
            { status: 401 },
          );
    },
  );
  assert.deepEqual(await api("/api/v1/me"), { ok: true });
  assert.deepEqual(calls, [
    "/api/v1/me Bearer token-1",
    "/api/v1/auth/refresh",
    "/api/v1/me Bearer token-2",
  ]);
  assert.equal(notified, 0);
  // The account is gone: even a fresh token is refused.
  valid = "token-3";
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "/api/v1/auth/refresh"
      ? refreshed("token-4")
      : Response.json(
          { error: { code: "UNAUTHENTICATED", message: "Sign in again." } },
          { status: 401 },
        ),
  );
  await assert.rejects(api("/api/v1/me"), {
    status: 401,
    code: "UNAUTHENTICATED",
  });
  assert.equal(notified, 1);
});

test("a refresh that cannot reach the platform is an outage, not a sign-out", async (t) => {
  t.mock.method(console, "error", () => {});
  let notified = 0;
  t.after(onUnauthenticated(() => notified++));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/v1/auth/refresh") throw new TypeError("fetch failed");
    return Response.json(
      { error: { code: "UNAUTHENTICATED", message: "x" } },
      { status: 401 },
    );
  });
  await assert.rejects(api("/api/v1/me"), {
    status: 503,
    code: "SESSION_UNAVAILABLE",
  });
  assert.equal(notified, 0);
});

test("platform-next's nested error envelope keeps its code and message", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "You don't have access to this workspace.",
        },
        requestId: "req-9",
      },
      { status: 403 },
    ),
  );
  await assert.rejects(api("/api/v1/tenant"), {
    status: 403,
    code: "FORBIDDEN",
    message: "You don't have access to this workspace.",
    requestId: "req-9",
  });
});

test("a response body arriving after tenant navigation is discarded", async (t) => {
  t.mock.method(console, "error", () => {});
  let finish!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((r) => {
    started = r;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: () =>
          new Promise((resolve) => {
            finish = () => resolve({ private: "old tenant" });
            started();
          }),
      }) as Response,
  );
  const pending = api("/api/v1/tenant");
  await reading;
  setIdentityScope(USER_ID, "64b7f0c2a1b2c3d4e5f60720");
  finish();
  await assert.rejects(pending, { code: "STALE_IDENTITY" });
});

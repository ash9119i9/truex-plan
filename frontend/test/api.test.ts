import { test } from "node:test";
import assert from "node:assert/strict";
import { api, ApiRequestError, errorRef, userMessage } from "../lib/api.ts";

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
    t.mock.timers.tick(60_000);
    assert.deepEqual(await response, { ok: true });
  }
  assert.equal(fetched.mock.callCount(), 4);

  const catalog = api("/api/agents");
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

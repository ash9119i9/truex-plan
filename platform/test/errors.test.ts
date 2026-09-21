import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/errors";
import { httpError, runtimeError } from "../../shared/errors";
import { publicEvent } from "../src/public";
import { PlatformService } from "../src/service";

test("expected errors preserve actionable detail at both HTTP boundaries", () => {
  for (const layer of ["platform", "agent-core"] as const) {
    assert.deepEqual(
      httpError(
        new ApiError(
          422,
          "Agent requires a model profile with an API key",
          "MODEL_CONFIGURATION",
        ),
        layer,
      ),
      {
        status: 422,
        error: "Agent requires a model profile with an API key",
        code: "MODEL_CONFIGURATION",
      },
    );
    const hidden = httpError(
      new Error("password=secret /internal/host"),
      layer,
    );
    assert.doesNotMatch(JSON.stringify(hidden), /secret|internal\/host/);
    assert.equal(
      httpError({ type: "entity.parse.failed" }, layer).code,
      "INVALID_JSON",
    );
    assert.equal(httpError({ type: "entity.too.large" }, layer).status, 413);
    assert.equal(
      httpError({ name: "MongoServerSelectionError" }, layer).code,
      "STORAGE_UNAVAILABLE",
    );
  }
  const redacted = httpError(
    new ApiError(
      400,
      "Failed at https://user:password@host/path?token=secret apiKey=hidden Bearer abc sk-secret",
    ),
    "platform",
  );
  assert.doesNotMatch(
    redacted.error,
    /password|hidden|abc|sk-secret|token=secret/,
  );
});

test("runtime and failed completion errors identify causes without provider diagnostics", () => {
  for (const [info, code] of [
    ["unauthorized", "PROVIDER_AUTH_FAILED"],
    ["contextWindowExceeded", "CONTEXT_LIMIT"],
    ["sessionBudgetExceeded", "SESSION_BUDGET_EXCEEDED"],
    ["serverOverloaded", "PROVIDER_UNAVAILABLE"],
    ["badRequest", "PROVIDER_INVALID_REQUEST"],
    [{ httpConnectionFailed: { httpStatusCode: 403 } }, "PROVIDER_AUTH_FAILED"],
    [
      { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      "PROVIDER_UNAVAILABLE",
    ],
    [
      { responseStreamDisconnected: { httpStatusCode: null } },
      "PROVIDER_CONNECTION_FAILED",
    ],
  ]) {
    const error = {
      codexErrorInfo: info,
      message: "private diagnostics",
      additionalDetails: "password=secret",
    };
    assert.equal(runtimeError({ error }).code, code);
    const event = publicEvent({
      type: "turn.completed",
      data: { turn: { status: "failed", error } },
    });
    assert.equal(event.data.turn.error.code, code);
    assert.doesNotMatch(JSON.stringify(event), /private|secret/);
  }
  assert.equal(
    runtimeError({ code: "RUNTIME_UNAVAILABLE" }).code,
    "RUNTIME_UNAVAILABLE",
  );
});

test("upstream errors preserve details and classify invalid responses and connection failures", async (t) => {
  const service = new PlatformService({} as any, ["http://core"]);
  const fetchMock = t.mock.method(globalThis, "fetch");
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: "A turn is already running",
          code: "TURN_BUSY",
        }),
        { status: 409 },
      ),
  );
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 409,
    message: "A turn is already running",
    code: "TURN_BUSY",
  });
  fetchMock.mock.mockImplementation(
    async () => new Response("<html>proxy error</html>", { status: 502 }),
  );
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 502,
    code: "INVALID_UPSTREAM_RESPONSE",
  });
  fetchMock.mock.mockImplementation(async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 504,
    code: "OWNER_TIMEOUT",
  });
  fetchMock.mock.mockImplementation(async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(service.call("http://core", "/threads"), {
    status: 503,
    code: "OWNER_UNAVAILABLE",
  });
});

test("unsupported commands are validation failures before database access", async () => {
  const service = new PlatformService({} as any);
  await assert.rejects(
    service.command(
      "session",
      "unsupported",
      {},
      { clientId: "command-1", text: "/unsupported" },
    ),
    { status: 403, code: "CAPABILITY_DENIED" },
  );
});

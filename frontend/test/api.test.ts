import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../lib/api.ts";

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

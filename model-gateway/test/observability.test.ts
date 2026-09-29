import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { createGateway, drain, type GatewayOptions } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";

const secret = "s".repeat(32);
const profile = {
  _id: "chat",
  baseUrl: "https://provider.example/v1",
  modelName: "llama-4",
  wireApi: "chat",
  apiKey: "provider-secret",
};
const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
  "data: [DONE]\n\n";

async function start(extra: Partial<GatewayOptions> = {}) {
  const logs: string[] = [];
  const server = createGateway({
    secret,
    findProfile: async (id) => (id === "chat" ? profile : null),
    log: (line) => logs.push(line),
    ...extra,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { server, base, logs, stop };
}

const token = signGatewayToken("chat", secret);
const post = (base: string, auth: string | null, headers = {}) =>
  fetch(`${base}/p/chat/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "secret prompt text" }],
        },
      ],
    }),
  });
const access = async (logs: string[]) => {
  for (let i = 0; i < 50 && !logs.some((l) => l.includes('"access"')); i++)
    await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(logs.find((l) => l.includes('"access"'))!);
};

test("access log: completed stream records model, usage and timings, no secrets", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        sse([
          { choices: [{ delta: { content: "hello" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
          },
        ]),
      )) as typeof fetch,
  });
  try {
    const res = await post(g.base, token, { "x-request-id": "req-abc.1" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "req-abc.1");
    await res.text();
    const line = await access(g.logs);
    assert.equal(line.requestId, "req-abc.1");
    assert.equal(line.profileId, "chat");
    assert.ok(!("tenantId" in line), "no tenant in the token, none logged");
    assert.equal(line.wireApi, "chat");
    assert.equal(line.model, "llama-4");
    assert.equal(line.status, 200);
    assert.equal(line.outcome, "completed");
    assert.deepEqual(line.usage, {
      input_tokens: 7,
      output_tokens: 2,
      total_tokens: 9,
    });
    assert.ok(line.durationMs >= 0 && line.ttfbMs >= 0);
    assert.ok(line.ttfbMs <= line.durationMs);
    const all = g.logs.join("\n");
    for (const leak of [
      "provider-secret",
      token,
      "secret prompt text",
      "hello",
    ])
      assert.ok(!all.includes(leak), `log leaked ${leak.slice(0, 12)}`);
  } finally {
    await g.stop();
  }
});

test("access log: records the token's tenant, which grants nothing", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
      )) as typeof fetch,
  });
  try {
    const tenantToken = signGatewayToken("chat", secret, "acme");
    const res = await post(g.base, tenantToken);
    assert.equal(res.status, 200);
    await res.text();
    const line = await access(g.logs);
    assert.equal(line.profileId, "chat");
    assert.equal(line.tenantId, "acme");
    assert.ok(!g.logs.join("\n").includes(tenantToken));
  } finally {
    await g.stop();
  }
});

test("access log: failed stream records error code", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        sse([
          {
            error: {
              message: "prompt too long",
              code: "context_length_exceeded",
            },
          },
        ]),
      )) as typeof fetch,
  });
  try {
    await (await post(g.base, token)).text();
    const line = await access(g.logs);
    assert.equal(line.outcome, "failed");
    assert.equal(line.errorCode, "context_length_exceeded");
    assert.equal(line.usage, undefined);
  } finally {
    await g.stop();
  }
});

test("access log: 401 is logged without the token; bad request ids are replaced", async () => {
  const g = await start();
  try {
    const res = await post(g.base, "forged-token-value", {
      "x-request-id": "bad id with spaces",
    });
    assert.equal(res.status, 401);
    const id = res.headers.get("x-request-id")!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    const line = await access(g.logs);
    assert.equal(line.requestId, id);
    assert.equal(line.status, 401);
    assert.equal(line.outcome, "invalid_api_key");
    assert.equal(line.errorCode, "invalid_api_key");
    assert.ok(!g.logs.join("\n").includes("forged-token-value"));
  } finally {
    await g.stop();
  }
});

test("server timeouts suit long streams behind a load balancer", async () => {
  const g = await start();
  try {
    assert.equal(g.server.keepAliveTimeout, 75_000);
    assert.ok(g.server.headersTimeout > g.server.keepAliveTimeout);
    assert.equal(g.server.requestTimeout, 0);
  } finally {
    await g.stop();
  }
});

test("/ready reflects the readiness check and drain; /health stays up", async () => {
  let ok: boolean | "throw" = true;
  const g = await start({
    ready: async () => {
      if (ok === "throw") throw new Error("db down");
      return ok;
    },
  });
  const status = async (path: string) =>
    (await fetch(g.base + path, { headers: { Connection: "close" } })).status;
  try {
    assert.equal(await status("/ready"), 200);
    ok = false;
    assert.equal(await status("/ready"), 503);
    ok = "throw";
    assert.equal(await status("/ready"), 503);
    assert.equal(await status("/health"), 200);
  } finally {
    await g.stop();
  }
});

test("drain: /ready turns 503, in-flight stream finishes, then the server closes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = await start({
    fetch: (async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          const enc = new TextEncoder();
          c.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: { content: "a" } }] }]).replace(
                "data: [DONE]\n\n",
                "",
              ),
            ),
          );
          await gate;
          c.enqueue(
            enc.encode(
              sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
            ),
          );
          c.close();
        },
      });
      return new Response(body);
    }) as typeof fetch,
  });
  const res = await post(g.base, token);
  assert.equal(res.status, 200);
  const reading = res.text();
  let closed = false;
  const drained = drain(g.server, 5_000).then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(closed, false, "drain waits for the in-flight stream");
  release();
  const text = await reading;
  assert.match(text, /response.completed/);
  await drained;
  assert.equal(closed, true);
  const line = await access(g.logs);
  assert.equal(line.outcome, "completed");
});

test("drain: /ready is 503 while draining", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = await start({
    fetch: (async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            await gate;
            c.close();
          },
        }),
      )) as typeof fetch,
  });
  // Hold a keep-alive connection open, then drain and probe /ready on it.
  const agentRes = post(g.base, token);
  await new Promise((r) => setTimeout(r, 100));
  const drained = drain(g.server, 5_000);
  // New connections are refused once listening stops, so deliver the /ready
  // probe to the server directly.
  const probe = await new Promise<number>((resolve) => {
    const socket = new PassThrough() as any;
    const req = new IncomingMessage(socket);
    req.method = "GET";
    req.url = "/ready";
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on("finish", () => resolve(res.statusCode));
    g.server.emit("request", req, res);
  });
  assert.equal(probe, 503);
  release();
  await (await agentRes).text().catch(() => "");
  await drained;
});

test("drain: force-closes streams still open after the grace period", async () => {
  const g = await start({
    fetch: (async (_url: unknown, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
              ),
            );
            init.signal?.addEventListener("abort", () =>
              c.error(new Error("aborted")),
            );
          },
        }),
      )) as unknown as typeof fetch,
  });
  const res = await post(g.base, token);
  assert.equal(res.status, 200);
  const reading = res.text().catch(() => "cut");
  const started = Date.now();
  await drain(g.server, 300);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 250 && elapsed < 3000, `drain took ${elapsed}ms`);
  await reading;
  const line = await access(g.logs);
  assert.equal(line.outcome, "client_closed");
});

test("access log: records provider rate-limit headers, never bodies or keys", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        sse([
          { choices: [{ delta: { content: "rate limited reply" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
        {
          headers: {
            "x-ratelimit-limit-requests": "500",
            "x-ratelimit-remaining-requests": "499",
            "x-ratelimit-limit-tokens": "30000",
            "x-ratelimit-remaining-tokens": "29000",
            "x-ratelimit-reset-requests": "120ms",
            "x-ratelimit-reset-tokens": "6m0s",
            "x-unrelated": "provider-secret",
          },
        },
      )) as typeof fetch,
  });
  try {
    await (await post(g.base, token)).text();
    const line = await access(g.logs);
    assert.deepEqual(line.rateLimit, {
      limitRequests: 500,
      remainingRequests: 499,
      limitTokens: 30000,
      remainingTokens: 29000,
      resetRequests: "120ms",
      resetTokens: "6m0s",
    });
    const all = g.logs.join("\n");
    for (const leak of [
      "provider-secret",
      token,
      "secret prompt text",
      "rate limited reply",
    ])
      assert.ok(!all.includes(leak), `log leaked ${leak.slice(0, 12)}`);
  } finally {
    await g.stop();
  }
});

test("access log: 429 keeps retry-after and anthropic-style limits", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        JSON.stringify({ error: { message: "secret prompt text too fast" } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "retry-after": "7",
            "anthropic-ratelimit-requests-limit": "50",
            "anthropic-ratelimit-requests-remaining": "0",
            "anthropic-ratelimit-requests-reset": "2026-09-28T00:00:07Z",
            "anthropic-ratelimit-input-tokens-remaining": "0",
          },
        },
      )) as typeof fetch,
  });
  try {
    const res = await post(g.base, token);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    await res.text();
    const line = await access(g.logs);
    assert.deepEqual(line.rateLimit, {
      retryAfter: 7,
      anthropicRequestsLimit: 50,
      anthropicRequestsRemaining: 0,
      anthropicRequestsReset: "2026-09-28T00:00:07Z",
      anthropicInputTokensRemaining: 0,
    });
    const all = g.logs.join("\n");
    assert.ok(!all.includes("secret prompt text"));
    assert.ok(!all.includes("provider-secret"));
  } finally {
    await g.stop();
  }
});

test("access log: no rateLimit field when the provider sends none", async () => {
  const g = await start({
    fetch: (async () =>
      new Response(
        sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
      )) as typeof fetch,
  });
  try {
    await (await post(g.base, token)).text();
    assert.equal((await access(g.logs)).rateLimit, undefined);
  } finally {
    await g.stop();
  }
});

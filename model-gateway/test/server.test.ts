import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createGateway, type GatewayProfile } from "../src/server";
import { signGatewayToken } from "../../shared/gateway-token";

const secret = "s".repeat(32);

async function withGateway(
  profiles: Record<string, GatewayProfile>,
  upstream: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (
    base: string,
    calls: { url: string; init: RequestInit }[],
  ) => Promise<void>,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const server = createGateway({
    secret,
    findProfile: async (id) => profiles[id] ?? null,
    fetch: (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return upstream(String(url), init);
    }) as typeof fetch,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      calls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const chat: GatewayProfile = {
  _id: "chat",
  baseUrl: "https://provider.example/v1/",
  modelName: "llama-4",
  wireApi: "chat",
  apiKey: "provider-secret",
};

function post(
  base: string,
  profile: string,
  token: string | null,
  body: unknown = { input: [] },
) {
  return fetch(`${base}/p/${profile}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("gateway: token must be valid and bound to the requested profile", async () => {
  await withGateway(
    { chat, other: { ...chat, _id: "other" } },
    () => new Response(""),
    async (base, calls) => {
      assert.equal((await post(base, "chat", null)).status, 401);
      assert.equal((await post(base, "chat", "bad.token")).status, 401);
      assert.equal(
        (await post(base, "chat", signGatewayToken("chat", "wrong".repeat(8))))
          .status,
        401,
      );
      assert.equal(
        (await post(base, "chat", signGatewayToken("other", secret))).status,
        401,
      );
      assert.equal(
        (await post(base, "missing", signGatewayToken("missing", secret)))
          .status,
        404,
      );
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal(
        calls.length,
        0,
        "Rejected requests never reach the provider",
      );
    },
  );
});

// Tokens signed before tenancy: `{ p }` or `{ p, exp }`, signed the same way.
function legacyToken(claims: object) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

test("gateway: old tokens and tenant tokens both verify; profile still binds", async () => {
  await withGateway(
    { chat, other: { ...chat, _id: "other" } },
    () => new Response(""),
    async (base) => {
      for (const token of [
        legacyToken({ p: "chat" }),
        legacyToken({ p: "chat", exp: Math.floor(Date.now() / 1000) - 60 }),
        signGatewayToken("chat", secret),
        signGatewayToken("chat", secret, "acme"),
      ])
        assert.notEqual((await post(base, "chat", token)).status, 401);
      // The tenant grants nothing: another profile's token is still refused.
      assert.equal(
        (await post(base, "chat", signGatewayToken("other", secret, "acme")))
          .status,
        401,
      );
      assert.equal(
        (await post(base, "chat", legacyToken({ t: "acme" }))).status,
        401,
      );
    },
  );
});

test("gateway: forwards to chat/completions with the real key and streams Responses SSE", async () => {
  await withGateway(
    { chat },
    () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    async (base, calls) => {
      const res = await post(base, "chat", signGatewayToken("chat", secret), {
        instructions: "Be brief",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hello" }],
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
      const text = await res.text();
      assert.match(text, /event: response.output_text.delta/);
      assert.match(text, /event: response.completed/);
      assert.doesNotMatch(text, /provider-secret/);
      assert.equal(
        calls[0].url,
        "https://provider.example/v1/chat/completions",
      );
      assert.equal(
        (calls[0].init.headers as any).Authorization,
        "Bearer provider-secret",
      );
      const sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.model, "llama-4");
      assert.deepEqual(sent.messages[0], {
        role: "system",
        content: "Be brief",
      });
    },
  );
});

test("gateway: upstream errors keep their status; context overflow becomes a failed stream", async () => {
  const responses = [
    new Response(
      JSON.stringify({ error: { message: "Slow down", type: "rate_limit" } }),
      {
        status: 429,
        headers: { "Retry-After": "7" },
      },
    ),
    new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
    }),
    new Response("upstream down", { status: 503 }),
    new Response(
      JSON.stringify({
        error: {
          message: "This model's maximum context length is 8192 tokens",
        },
      }),
      { status: 400 },
    ),
  ];
  await withGateway(
    { chat },
    () => responses.shift()!,
    async (base) => {
      const token = signGatewayToken("chat", secret);
      const limited = await post(base, "chat", token);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "7");
      assert.equal((await limited.json()).error.message, "Slow down");
      assert.equal((await post(base, "chat", token)).status, 401);
      assert.equal((await post(base, "chat", token)).status, 503);
      const overflow = await post(base, "chat", token);
      assert.equal(overflow.status, 200);
      assert.match(await overflow.text(), /"code":"context_length_exceeded"/);
    },
  );
});

test("gateway: wire APIs without an adapter are refused clearly", async () => {
  await withGateway(
    { a: { ...chat, _id: "a", wireApi: "bogus" } },
    () => new Response(""),
    async (base) => {
      const res = await post(base, "a", signGatewayToken("a", secret));
      assert.equal(res.status, 501);
      assert.match(
        (await res.json()).error.message,
        /no adapter for wireApi "bogus"/,
      );
    },
  );
});

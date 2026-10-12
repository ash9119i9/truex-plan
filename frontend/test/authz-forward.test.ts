import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forward, type Prefix } from "../lib/forward.ts";

// A real upstream that records every request that reaches it.
async function upstream() {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const call = (
  up: { url: string },
  prefix: Prefix,
  path: string[],
  init: RequestInit = {},
) =>
  forward(new Request(`http://app.test${prefix}/${path.join("/")}`, init), {
    prefix,
    path,
    env: { PLATFORM_INTERNAL_URL: up.url },
  });

test("an Authorization header is refused before any upstream call, never dropped in favour of the cookie", async (t) => {
  const up = await upstream();
  t.after(up.close);
  for (const prefix of ["/api", "/auth"] as const)
    for (const method of ["GET", "POST"]) {
      const res = await call(up, prefix, ["x"], {
        method,
        headers: {
          authorization: "Bearer anything",
          cookie: "truex_session=valid",
          origin: "http://app.test",
          "content-type": "application/json",
        },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(res.status, 401, `${prefix} ${method}`);
      assert.equal((await res.json()).code, "BEARER_NOT_SUPPORTED");
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  // Even an empty value is a presented credential.
  assert.equal(
    (await call(up, "/api", ["x"], { headers: { authorization: "" } })).status,
    401,
  );
  assert.equal(up.seen.length, 0, "nothing reached the platform");
  // Cookie-only requests are unchanged.
  assert.equal(
    (await call(up, "/api", ["x"], { headers: { cookie: "a=b" } })).status,
    200,
  );
  assert.equal(up.seen.length, 1);
});

test("OIDC callback forwarding preserves flow cookie, query, redirect and no-store", async () => {
  const response = await forward(
    new Request(
      "https://app.test/auth/oidc/callback?code=opaque%2Bcode&state=flow-state",
      {
        headers: {
          cookie: "__Host-truex_oidc_flow=flow-token",
          origin: "https://app.test",
        },
      },
    ),
    {
      prefix: "/auth",
      path: ["oidc", "callback"],
      env: { PLATFORM_INTERNAL_URL: "http://platform.fixture.invalid" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        assert.equal(
          String(url),
          "http://platform.fixture.invalid/auth/oidc/callback?code=opaque%2Bcode&state=flow-state",
        );
        assert.equal(init?.redirect, "manual");
        assert.equal(
          new Headers(init?.headers).get("cookie"),
          "__Host-truex_oidc_flow=flow-token",
        );
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://app.test/select-tenant",
            "cache-control": "no-store",
            "set-cookie":
              "__Host-truex_session=opaque; Path=/; HttpOnly; SameSite=Lax; Secure",
          },
        });
      }) as typeof fetch,
    },
  );
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://app.test/select-tenant",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("set-cookie"),
    "__Host-truex_session=opaque; Path=/; HttpOnly; SameSite=Lax; Secure",
  );
});

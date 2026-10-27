import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMe, meKey, toMe, signOut } from "../lib/session.ts";
import { createAuth } from "../lib/auth.ts";
import {
  signInForTest,
  refreshed,
  USER_ID,
  TENANT_ID,
} from "./auth-fixture.ts";
import {
  PRIVATE_LOCAL_PREFIXES,
  bumpIdentityGeneration,
  clearPrivateBrowserState,
  enterIdentity,
  identityGeneration,
  identityScope,
  notifyUnauthenticated,
  onUnauthenticated,
  SCOPE_KEY,
} from "../lib/identity.ts";
import { loginNotice, GOOGLE_START } from "../lib/login.ts";
import { api, ApiRequestError, base } from "../lib/api.ts";

const user = { id: USER_ID, email: "a@example.invalid", name: "Ada" };
const tenant = { id: TENANT_ID, name: "Demo", role: "user" };
const discovery = {
  tenants: [tenant],
  entry: { outcome: "enterTenant", tenantId: TENANT_ID },
};
const reply = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : Response.json(body, { status });

test("discovery accepts valid identity and rejects malformed account data", () => {
  const result = toMe({ user }, discovery);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok")
    assert.equal(meKey(result.me), `${USER_ID}:${TENANT_ID}`);
  for (const bad of [
    null,
    {},
    { user: { ...user, id: "bad" } },
    { user: { ...user, email: null } },
  ])
    assert.equal(toMe(bad, discovery).kind, "unavailable");
  for (const bad of [
    null,
    {},
    { ...discovery, tenants: [{ ...tenant, role: "owner" }] },
  ])
    assert.equal(toMe({ user }, bad).kind, "unavailable");
  for (const outcome of ["chooseTenant", "noTenant"])
    assert.equal(
      toMe({ user }, { ...discovery, entry: { outcome } }).kind,
      "blocked",
    );
});

test("only an authenticated 401 is sign-out; network and platform failures are outages", async () => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    const auth = createAuth({
      channel: null,
      locks: null,
      fetch: async () => reply(status),
    });
    assert.equal(
      (await fetchMe({ auth })).kind,
      status === 401 ? "signedOut" : "unavailable",
    );
  }
  for (const error of [
    new TypeError("offline"),
    new DOMException("timeout", "TimeoutError"),
  ]) {
    const auth = createAuth({
      channel: null,
      locks: null,
      fetch: async () => {
        throw error;
      },
    });
    assert.equal((await fetchMe({ auth })).kind, "unavailable");
  }
});

test("account discovery makes only unscoped, authenticated, uncached calls", async () => {
  const paths: string[] = [];
  const auth = createAuth({
    channel: null,
    locks: null,
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/auth/refresh")) return refreshed();
      paths.push(url);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer token-1",
      );
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.credentials, "same-origin");
      return Response.json(url.endsWith("/tenants") ? discovery : { user });
    }) as typeof fetch,
  });
  assert.equal((await fetchMe({ auth })).kind, "ok");
  assert.deepEqual(paths.sort(), ["/api/v1/me", "/api/v1/me/tenants"]);
});

test("sign-out reports honestly whether the server confirmed it", async () => {
  for (const status of [204, 401, 403, 503]) {
    const auth = createAuth({
      channel: null,
      locks: null,
      fetch: async (url, init) => {
        assert.equal(url, "/api/v1/auth/logout");
        assert.equal(init?.method, "POST");
        return reply(status);
      },
    });
    assert.deepEqual(await signOut(auth), { confirmed: status === 204 });
  }
});

// ---- private browser state -------------------------------------------------

class MemoryStore {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

test("clearing removes conversation data and keeps preferences", () => {
  const session = new MemoryStore(),
    local = new MemoryStore();
  session.setItem("cursor:u1.t1:s1", "g:4");
  session.setItem("unrelated", "x");
  local.setItem("truex-visualization:u1.t1:s1:v1", "{}");
  local.setItem("truex-theme", "dark");
  local.setItem("truex-developer-mode", "1");
  clearPrivateBrowserState({ session, local });
  assert.deepEqual([...session.data.keys()], ["unrelated"]);
  assert.deepEqual([...local.data.keys()].sort(), [
    "truex-developer-mode",
    "truex-theme",
  ]);
  assert.ok(PRIVATE_LOCAL_PREFIXES.every((p) => p.startsWith("truex-")));
  // Storage that throws is not an error.
  clearPrivateBrowserState({
    session: {
      length: 1,
      key() {
        throw new Error("denied");
      },
      removeItem() {},
    },
  });
});

test("entering a different identity clears what the last one left; the same one keeps it", () => {
  const session = new MemoryStore(),
    local = new MemoryStore();
  enterIdentity("u1", "t1", local, { session, local });
  assert.equal(identityScope(), "u1.t1");
  session.setItem("cursor:u1.t1:s1", "g:4");
  local.setItem("truex-visualization:u1.t1:s1:v1", "{}");
  enterIdentity("u1", "t1", local, { session, local });
  assert.equal(session.length, 1, "same person, same workspace: kept");
  enterIdentity("u2", "t1", local, { session, local });
  assert.equal(session.length, 0, "another person: cleared");
  assert.equal(local.getItem(SCOPE_KEY), "u2.t1");
  assert.equal(local.getItem("truex-visualization:u1.t1:s1:v1"), null);
  session.setItem("cursor:u2.t1:s9", "g:1");
  enterIdentity("u2", "t2", local, { session, local });
  assert.equal(session.length, 0, "another workspace: cleared");
});

test("a response that arrives after the person changed is dropped", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  await signInForTest();
  assert.equal(base, "", "the browser talks to its own origin");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /^\/api\//, "same-origin path, no platform address");
    await gate;
    return reply(200, { private: "alice's data" });
  });
  const pending = api("/api/sessions");
  bumpIdentityGeneration();
  release();
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof ApiRequestError && e.code === "STALE_IDENTITY",
  );
  // A request made in the new generation is fine.
  release();
  assert.deepEqual(await api("/api/sessions"), { private: "alice's data" });
  assert.ok(identityGeneration() > 0);
});

test("a 401 asks the session gate to check; 403 and 5xx never do", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  await signInForTest();
  let notified = 0;
  const stop = onUnauthenticated(() => notified++);
  const answer = (status: number) =>
    t.mock.method(globalThis, "fetch", async (url: string) =>
      url.startsWith("/api/v1/auth/refresh")
        ? refreshed()
        : reply(status, { error: "x", code: "C" }),
    );
  for (const [status, expected] of [
    [401, 1],
    [403, 0],
    [404, 0],
    [429, 0],
    [500, 0],
    [503, 0],
  ] as const) {
    notified = 0;
    const mocked = answer(status);
    await assert.rejects(
      api("/api/sessions"),
      (e: unknown) => e instanceof ApiRequestError && e.status === status,
    );
    assert.equal(notified, expected, String(status));
    mocked.mock.restore();
  }
  stop();
  notifyUnauthenticated();
  assert.equal(notified, 0, "unsubscribed listeners hear nothing");
});

test("sign-in messages: every server code reads as a sentence, unknown ones generically", () => {
  assert.equal(GOOGLE_START, "/api/v1/auth/google");
  assert.equal(loginNotice(null), null);
  assert.equal(loginNotice(""), null);
  for (const code of [
    "expired",
    "rejected",
    "cancelled",
    "account_disabled",
    "email_in_use",
    "signup_unavailable",
    "unavailable",
    "logout_failed",
  ]) {
    const n = loginNotice(code)!;
    assert.equal(n.tone, "warn", code);
    assert.ok(n.lead.endsWith("."), code);
    assert.ok(n.lead.length > 10 && !n.lead.includes("_"), code);
  }
  assert.equal(loginNotice("signed_out")!.tone, "info");
  assert.equal(loginNotice("session_ended")!.tone, "info");
  assert.notEqual(loginNotice("session_ended"), loginNotice("session_expired"));
  for (const unknown of [
    "__proto__",
    "constructor",
    "toString",
    "brand_new_code",
    "<img src=x>",
  ])
    assert.equal(loginNotice(unknown), loginNotice("anything-else"), unknown);
  assert.match(loginNotice("logout_failed")!.rest!, /may still be active/);
  assert.match(loginNotice("account_disabled")!.lead, /disabled/);
});

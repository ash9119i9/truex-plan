import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchMe, fetchTenants, meKey, parseMe, signOut, switchWorkspace } from "../lib/session.ts";
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

const ME = {
  user: { id: "u_1", email: "a@gmail.com", name: "Ada" },
  tenant: { id: "demo", name: "Demo", isUserSpecific: true },
  role: "user",
  tenants: [{ id: "demo", name: "Demo", role: "user" }],
  auth: "google",
};
const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const asFetch = (fn: (url: string, init?: RequestInit) => Promise<Response>) =>
  fn as unknown as typeof fetch;

test("parseMe accepts the platform's answer and rejects anything malformed", () => {
  const me = parseMe(ME)!;
  assert.equal(me.user.id, "u_1");
  assert.equal(me.tenant.isUserSpecific, true);
  assert.equal(me.auth, "google");
  assert.equal(meKey(me), "u_1:demo");
  assert.equal(parseMe({ ...ME, auth: "something" })!.auth, "dev");
  for (const bad of [
    null,
    "x",
    {},
    { ...ME, role: "owner" },
    { ...ME, user: { ...ME.user, id: "" } },
    { ...ME, user: { ...ME.user, email: undefined } },
    { ...ME, tenant: { name: "x" } },
    { ...ME, user: { ...ME.user, id: "x".repeat(200) } },
  ])
    assert.equal(parseMe(bad), null, JSON.stringify(bad));
  // A bad entry in the workspace list is dropped, not fatal.
  assert.deepEqual(parseMe({ ...ME, tenants: [{ id: "a", role: "user" }, { id: "b", role: "root" }, null] })!.tenants, [
    { id: "a", name: "a", role: "user" },
  ]);
});

test("only a real 401 is a sign-out; outages, timeouts and 5xx are not", async () => {
  const check = (fn: (url: string) => Promise<Response>) => fetchMe(asFetch(fn));
  assert.equal((await check(async () => reply(200, ME))).kind, "ok");
  assert.equal((await check(async () => reply(401, { code: "UNAUTHENTICATED" }))).kind, "signedOut");
  // The admin console's cookie is not a session for this app.
  assert.equal((await check(async () => reply(403, { code: "WRONG_APP" }))).kind, "signedOut");
  const disabled = await check(async () => reply(403, { code: "TENANT_DISABLED" }));
  assert.equal(disabled.kind, "blocked");
  if (disabled.kind === "blocked") assert.match(disabled.message, /disabled/);
  for (const status of [500, 502, 503, 504, 429, 404])
    assert.equal((await check(async () => reply(status, { code: "X" }))).kind, "unavailable", String(status));
  assert.equal((await check(async () => { throw new TypeError("fetch failed"); })).kind, "unavailable");
  assert.equal((await check(async () => { throw new DOMException("t", "TimeoutError"); })).kind, "unavailable");
  assert.equal((await check(async () => reply(200, { nonsense: true }))).kind, "unavailable");
  assert.equal((await check(async () => new Response("<html>", { status: 200 }))).kind, "unavailable");
  // It asks the app's own origin, with credentials, and never caches.
  let seen: { url: string; init?: RequestInit } | undefined;
  await fetchMe(asFetch(async (url, init) => ((seen = { url, init }), reply(200, ME))));
  assert.equal(seen!.url, "/api/me");
  assert.equal(seen!.init!.cache, "no-store");
  assert.equal(seen!.init!.credentials, "same-origin");
  assert.ok(seen!.init!.signal);
});

test("sign-out reports honestly whether the server confirmed it", async () => {
  assert.deepEqual(await signOut(asFetch(async () => new Response(null, { status: 204 }))), { confirmed: true });
  assert.deepEqual(await signOut(asFetch(async () => reply(401))), { confirmed: true }, "no session left to end");
  assert.deepEqual(await signOut(asFetch(async () => reply(503))), { confirmed: false });
  assert.deepEqual(await signOut(asFetch(async () => reply(403, { code: "CSRF_ORIGIN" }))), { confirmed: false });
  assert.deepEqual(await signOut(asFetch(async () => { throw new TypeError("offline"); })), { confirmed: false });
  let call: { url: string; init?: RequestInit } | undefined;
  await signOut(asFetch(async (url, init) => ((call = { url, init }), new Response(null, { status: 204 }))));
  assert.equal(call!.url, "/auth/logout");
  assert.equal(call!.init!.method, "POST");
});

test("switching workspace distinguishes denied, signed out and unavailable", async () => {
  assert.deepEqual(await switchWorkspace("acme", asFetch(async () => reply(200, { tenant: { id: "acme" } }))), { ok: true });
  const denied = await switchWorkspace("acme", asFetch(async () => reply(403, { code: "NOT_A_MEMBER" })));
  assert.deepEqual({ ...denied, message: "" }, { ok: false, signedOut: false, message: "" });
  assert.match((denied as { message: string }).message, /not a member/);
  assert.equal(((await switchWorkspace("acme", asFetch(async () => reply(403, { code: "TENANT_DISABLED" })))) as { message: string }).message, "That workspace is currently disabled.");
  assert.equal(((await switchWorkspace("acme", asFetch(async () => reply(401)))) as { signedOut: boolean }).signedOut, true);
  assert.equal(((await switchWorkspace("acme", asFetch(async () => reply(503)))) as { signedOut: boolean }).signedOut, false);
  let body = "";
  await switchWorkspace("acme", asFetch(async (_u, init) => ((body = String(init!.body)), reply(200, {}))));
  assert.equal(body, '{"tenantId":"acme"}');
});

test("the workspace list comes from the server and bad entries are dropped", async () => {
  const list = await fetchTenants(asFetch(async () => reply(200, { tenants: [{ id: "a", name: "A", role: "admin" }, { id: "", role: "user" }, { id: "b", role: "root" }] })));
  assert.deepEqual(list, { kind: "ok", tenants: [{ id: "a", name: "A", role: "admin" }] });
  assert.equal((await fetchTenants(asFetch(async () => reply(401)))).kind, "signedOut");
  assert.equal((await fetchTenants(asFetch(async () => reply(500)))).kind, "unavailable");
});

// ---- private browser state -------------------------------------------------

class MemoryStore {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

test("clearing removes conversation data and keeps preferences", () => {
  const session = new MemoryStore(), local = new MemoryStore();
  session.setItem("cursor:u1.t1:s1", "g:4");
  session.setItem("unrelated", "x");
  local.setItem("truex-visualization:u1.t1:s1:v1", "{}");
  local.setItem("truex-theme", "dark");
  local.setItem("truex-developer-mode", "1");
  clearPrivateBrowserState({ session, local });
  assert.deepEqual([...session.data.keys()], ["unrelated"]);
  assert.deepEqual([...local.data.keys()].sort(), ["truex-developer-mode", "truex-theme"]);
  assert.ok(PRIVATE_LOCAL_PREFIXES.every((p) => p.startsWith("truex-")));
  // Storage that throws is not an error.
  clearPrivateBrowserState({ session: { length: 1, key() { throw new Error("denied"); }, removeItem() {} } });
});

test("entering a different identity clears what the last one left; the same one keeps it", () => {
  const session = new MemoryStore(), local = new MemoryStore();
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
  await assert.rejects(pending, (e: unknown) => e instanceof ApiRequestError && e.code === "STALE_IDENTITY");
  // A request made in the new generation is fine.
  release();
  assert.deepEqual(await api("/api/sessions"), { private: "alice's data" });
  assert.ok(identityGeneration() > 0);
});

test("a 401 asks the session gate to check; 403 and 5xx never do", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  let notified = 0;
  const stop = onUnauthenticated(() => notified++);
  const answer = (status: number) => t.mock.method(globalThis, "fetch", async () => reply(status, { error: "x", code: "C" }));
  for (const [status, expected] of [[401, 1], [403, 0], [404, 0], [429, 0], [500, 0], [503, 0]] as const) {
    notified = 0;
    const mocked = answer(status);
    await assert.rejects(api("/api/sessions"), (e: unknown) => e instanceof ApiRequestError && e.status === status);
    assert.equal(notified, expected, String(status));
    mocked.mock.restore();
  }
  stop();
  notifyUnauthenticated();
  assert.equal(notified, 0, "unsubscribed listeners hear nothing");
});

test("sign-in messages: every server code reads as a sentence, unknown ones generically", () => {
  assert.equal(GOOGLE_START, "/auth/google/start");
  assert.equal(loginNotice(null), null);
  assert.equal(loginNotice(""), null);
  for (const code of [
    "session_expired", "google_failed", "email_unverified", "not_invited", "no_tenant",
    "account_conflict", "account_disabled", "access_removed", "tenant_disabled",
    "demo_unavailable", "signup_limit", "unavailable", "logout_failed",
  ]) {
    const n = loginNotice(code)!;
    assert.equal(n.tone, "warn", code);
    assert.ok(n.lead.endsWith("."), code);
    assert.ok(n.lead.length > 10 && !n.lead.includes("_"), code);
  }
  assert.equal(loginNotice("signed_out")!.tone, "info");
  assert.equal(loginNotice("session_ended")!.tone, "info");
  assert.notEqual(loginNotice("session_ended"), loginNotice("session_expired"));
  for (const unknown of ["__proto__", "constructor", "toString", "brand_new_code", "<img src=x>"])
    assert.equal(loginNotice(unknown), loginNotice("anything-else"), unknown);
  assert.match(loginNotice("logout_failed")!.rest!, /may still be active/);
  assert.match(loginNotice("access_removed")!.lead, /ended/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "../lib/auth.ts";
import { refreshed, TENANT_ID } from "./auth-fixture.ts";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const make = (fetch: typeof globalThis.fetch) =>
  createAuth({ fetch, locks: null, channel: null });

test("parallel callers share a refresh and reuse the in-memory token", async () => {
  let requests = 0;
  const auth = make(async () => {
    requests++;
    return refreshed();
  });
  const tokens = await Promise.all(
    Array.from({ length: 20 }, () => auth.accessToken()),
  );
  assert.ok(tokens.every((t) => t.kind === "ok"));
  await auth.accessToken();
  assert.equal(requests, 1);
});

test("a refresh race retries within bounds, without treating outages as logout", async () => {
  let requests = 0;
  const auth = createAuth({
    locks: null,
    channel: null,
    sleep: async () => {},
    fetch: async () => {
      requests++;
      return new Response(null, { status: 409 });
    },
  });
  assert.equal((await auth.accessToken()).kind, "unavailable");
  assert.equal(requests, 4);
  for (const status of [403, 500, 503]) {
    assert.equal(
      (await make(async () => new Response(null, { status })).accessToken())
        .kind,
      "unavailable",
    );
  }
  assert.equal(
    (await make(async () => new Response(null, { status: 401 })).accessToken())
      .kind,
    "signedOut",
  );
});

test("refresh pending during logout cannot resurrect credentials or refresh again", async () => {
  const response = deferred<Response>();
  let requests = 0;
  const auth = make(async (path) => {
    requests++;
    return path === "/api/v1/auth/logout"
      ? new Response(null, { status: 204 })
      : response.promise;
  });
  const pending = auth.accessToken();
  assert.deepEqual(await auth.signOut(), { confirmed: true });
  response.resolve(refreshed());
  assert.equal((await pending).kind, "signedOut");
  assert.equal((await auth.accessToken()).kind, "signedOut");
  assert.equal(requests, 2);
});

test("logout invalidates an authorized request already in flight", async () => {
  const response = deferred<Response>();
  const sent = deferred<void>();
  const auth = make(async (path) => {
    if (path === "/api/v1/auth/refresh") return refreshed();
    if (path === "/api/v1/auth/logout")
      return new Response(null, { status: 204 });
    sent.resolve();
    return response.promise;
  });
  const pending = auth.request("/api/v1/me");
  await sent.promise;
  await auth.signOut();
  response.resolve(Response.json({ private: true }));
  assert.equal((await pending).kind, "signedOut");
});

test("a logout received from another tab immediately invalidates local credentials", async () => {
  const channel = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage() {},
    close() {},
  };
  let notified = 0;
  const auth = createAuth({
    locks: null,
    channel,
    fetch: async () => refreshed(),
    onSignedOutElsewhere: () => notified++,
  });
  await auth.accessToken();
  channel.onmessage!({ data: { type: "logout" } } as MessageEvent);
  assert.equal((await auth.accessToken()).kind, "signedOut");
  assert.equal(notified, 1);
});

test("failed logout is reported honestly and still drops this tab's credentials", async () => {
  const auth = make(async () => new Response(null, { status: 503 }));
  assert.deepEqual(await auth.signOut(), { confirmed: false });
  assert.equal((await auth.accessToken()).kind, "signedOut");
});

test("refreshing to another account never replays a mutation under that account", async () => {
  let refreshes = 0;
  let mutations = 0;
  let changed = 0;
  const auth = createAuth({
    channel: null,
    locks: null,
    onAccountChanged: () => changed++,
    fetch: async (path) => {
      if (path === "/api/v1/auth/refresh")
        return refreshed(
          `token-${++refreshes}`,
          refreshes === 1
            ? "64b7f0c2a1b2c3d4e5f60718"
            : "64b7f0c2a1b2c3d4e5f60720",
        );
      mutations++;
      return new Response(null, { status: 401 });
    },
  });
  assert.equal(
    (await auth.request("/api/v1/example", { method: "POST" })).kind,
    "signedOut",
  );
  assert.equal(mutations, 1);
  assert.equal(changed, 1);
});

test("a tenant request gets a token for its tenant, reused until it is old", async () => {
  const refreshes: string[] = [];
  const sent: string[] = [];
  let n = 0;
  const auth = make(async (url, init) => {
    const path = String(url);
    if (path.startsWith("/api/v1/auth/refresh")) {
      refreshes.push(path);
      return refreshed(`token-${++n}`);
    }
    sent.push(`${path} ${new Headers(init?.headers).get("authorization")}`);
    return Response.json({});
  });
  const tenant = `/api/v1/chats?tenantId=${TENANT_ID}`;
  await Promise.all([auth.request(tenant), auth.request(tenant)]);
  await auth.request("/api/v1/me");
  assert.deepEqual(refreshes, [`/api/v1/auth/refresh?tenantId=${TENANT_ID}`]);
  assert.deepEqual(sent, [
    `${tenant} Bearer token-1`,
    `${tenant} Bearer token-1`,
    "/api/v1/me Bearer token-1",
  ]);
});

test("an account request shares the tenant's refresh instead of starting its own", async () => {
  const refreshes: string[] = [];
  const auth = make(async (url) => {
    const path = String(url);
    if (path.startsWith("/api/v1/auth/refresh")) refreshes.push(path);
    return path.startsWith("/api/v1/auth/refresh")
      ? refreshed()
      : Response.json({});
  });
  await Promise.all([
    auth.request(`/api/v1/tenant?tenantId=${TENANT_ID}`),
    auth.request("/api/v1/me"),
  ]);
  assert.deepEqual(refreshes, [`/api/v1/auth/refresh?tenantId=${TENANT_ID}`]);
});

test("switching tenant costs one refresh; a tenant the platform left out is not asked for again", async () => {
  const OTHER = "64b7f0c2a1b2c3d4e5f60799";
  const refreshes: string[] = [];
  let n = 0;
  const auth = make(async (url) => {
    const path = String(url);
    if (!path.startsWith("/api/v1/auth/refresh")) return Response.json({});
    refreshes.push(path);
    return refreshed(`token-${++n}`);
  });
  await auth.request(`/api/v1/chats?tenantId=${TENANT_ID}`);
  // Not a member there: the platform's token carries no tenant, and that
  // tenant's routes answer 403 from the catalog. Asking again changes nothing.
  await auth.request(`/api/v1/chats?tenantId=${OTHER}`);
  await auth.request(`/api/v1/chats?tenantId=${OTHER}`);
  // Account requests keep the tab's current tenant.
  await auth.request("/api/v1/me");
  assert.deepEqual(refreshes, [
    `/api/v1/auth/refresh?tenantId=${TENANT_ID}`,
    `/api/v1/auth/refresh?tenantId=${OTHER}`,
  ]);
});

test("an old token is renewed for the tab's tenant, even by an account request", async () => {
  let clock = 1_000_000;
  const refreshes: string[] = [];
  const auth = createAuth({
    locks: null,
    channel: null,
    now: () => clock,
    fetch: async (url) => {
      const path = String(url);
      if (!path.startsWith("/api/v1/auth/refresh")) return Response.json({});
      refreshes.push(path);
      return refreshed();
    },
  });
  await auth.request(`/api/v1/chats?tenantId=${TENANT_ID}`);
  // Past any lifetime the tab believes.
  clock += 15 * 60_000;
  await auth.request("/api/v1/me");
  assert.deepEqual(refreshes, [
    `/api/v1/auth/refresh?tenantId=${TENANT_ID}`,
    `/api/v1/auth/refresh?tenantId=${TENANT_ID}`,
  ]);
});

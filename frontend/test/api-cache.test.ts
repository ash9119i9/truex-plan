import { test } from "node:test";
import assert from "node:assert/strict";
import { api, clearApiCache, apiIdentityScope } from "../lib/api.ts";

test("enabled API metadata cache verifies current identity and rejects stale results", async (t) => {
  const oldFlag = process.env.NEXT_PUBLIC_CLIENT_CACHE;
  process.env.NEXT_PUBLIC_CLIENT_CACHE = "on";
  class Channel {
    static current: Channel;
    onmessage?: (event: { data: unknown }) => void;
    posted: unknown[] = [];
    closed = false;
    constructor() {
      Channel.current = this;
    }
    postMessage(data: unknown) {
      this.posted.push(data);
    }
    close() {
      this.closed = true;
    }
  }
  const listeners = new Map<string, () => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      BroadcastChannel: Channel,
      addEventListener(name: string, listener: () => void) {
        listeners.set(name, listener);
      },
    },
  });
  t.after(() => {
    clearApiCache(false);
    if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_CLIENT_CACHE;
    else process.env.NEXT_PUBLIC_CLIENT_CACHE = oldFlag;
    delete (globalThis as any).window;
  });
  t.mock.method(console, "warn", () => {});
  let principal = "alice",
    role = "user",
    denied = false;
  const calls: { path: string; method: string }[] = [];
  let deferMetadata: ((value: Response) => void) | undefined;
  let holdMetadata = false;
  let holdIdentity = false;
  let deferIdentity: ((value: Response) => void) | undefined;
  let holdVisualization = false;
  let deferVisualization: ((value: Response) => void) | undefined;
  let heldListPath: string | undefined;
  let deferList: ((value: Response) => void) | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: options?.method || "GET" });
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.credentials, "include");
      if (heldListPath === path)
        return new Promise<Response>((resolve) => {
          deferList = resolve;
        });
      if (holdVisualization && path === "/api/sessions/s1/visualizations/v1")
        return new Promise<Response>((resolve) => {
          deferVisualization = resolve;
        });
      if (path === "/api/me" && holdIdentity)
        return new Promise<Response>((resolve) => {
          deferIdentity = resolve;
        });
      if (path === "/api/me")
        return denied
          ? Response.json(
              { error: "Sign in", code: "UNAUTHENTICATED" },
              { status: 401 },
            )
          : Response.json({
              user: { id: principal },
              tenant: { id: "acme" },
              role,
            });
      if (
        holdMetadata &&
        options?.method === "GET" &&
        path === "/api/agents/a/mcp"
      )
        return new Promise<Response>((resolve) => {
          deferMetadata = resolve;
        });
      return Response.json({
        owner: principal,
        role,
        profiles: [{ id: "m1", name: "SAP" }],
      });
    },
  );
  const count = (path: string, method = "GET") =>
    calls.filter((c) => c.path === path && c.method === method).length;
  await t.test(
    "three MCP consumers share identity check and GET, but every later warm read verifies /me",
    async () => {
      const values = await Promise.all(
        Array.from({ length: 3 }, () => api("/api/agents/a/mcp")),
      );
      assert.equal(count("/api/me"), 1);
      assert.equal(count("/api/agents/a/mcp"), 1);
      values[0].profiles[0].name = "mutated";
      assert.equal(values[1].profiles[0].name, "SAP");
      assert.equal((await api("/api/agents/a/mcp")).profiles[0].name, "SAP");
      assert.equal(count("/api/me"), 2);
      assert.equal(count("/api/agents/a/mcp"), 1);
    },
  );
  await t.test(
    "same-tenant user change and role change cannot reuse previous metadata",
    async () => {
      principal = "bob";
      assert.equal((await api("/api/agents/a/mcp")).owner, "bob");
      role = "admin";
      assert.equal((await api("/api/agents/a/mcp")).role, "admin");
      assert.equal(count("/api/agents/a/mcp"), 3);
      assert.match(apiIdentityScope()!, /bob/);
    },
  );
  await t.test("warm cache cannot bypass revoked membership", async () => {
    denied = true;
    await assert.rejects(api("/api/agents/a/mcp"), {
      status: 401,
      code: "UNAUTHENTICATED",
    });
    assert.equal(count("/api/agents/a/mcp"), 3);
    assert.equal(apiIdentityScope(), undefined);
    denied = false;
  });
  await t.test(
    "mutations and cross-tab messages evict metadata without response replay",
    async () => {
      await api("/api/agents/a/mcp");
      await api("/api/agents/a/mcp", { profileIds: [] });
      await api("/api/agents/a/mcp");
      assert.equal(count("/api/agents/a/mcp", "POST"), 1);
      const before = count("/api/agents/a/mcp");
      Channel.current.onmessage!({ data: "metadata" });
      await api("/api/agents/a/mcp");
      assert.equal(count("/api/agents/a/mcp"), before + 1);
      Channel.current.onmessage!({ data: "identity" });
      assert.equal(apiIdentityScope(), undefined);
    },
  );
  await t.test(
    "history/live context/document reads are never cached",
    async () => {
      for (const path of [
        "/api/sessions/s1",
        "/api/sessions/s1/documents",
        "/api/sessions/s1/turns/t1/context",
      ]) {
        await api(path);
        await api(path);
        assert.equal(count(path), 2);
      }
    },
  );
  await t.test(
    "logout rejects a late metadata response and never repopulates it",
    async () => {
      clearApiCache(false);
      holdMetadata = true;
      const old = api("/api/agents/a/mcp");
      while (!deferMetadata)
        await new Promise((resolve) => setImmediate(resolve));
      clearApiCache();
      deferMetadata!(Response.json({ old: true }));
      await assert.rejects(old, { code: "CACHE_INVALIDATED" });
      holdMetadata = false;
      principal = "carol";
      assert.equal((await api("/api/agents/a/mcp")).owner, "carol");
    },
  );
  await t.test(
    "logout cannot start unbounded identity checks or accept a late bootstrap",
    async () => {
      clearApiCache(false);
      holdIdentity = true;
      const before = count("/api/me");
      const old = api("/api/agents");
      while (!deferIdentity)
        await new Promise((resolve) => setImmediate(resolve));
      clearApiCache(false);
      const next = api("/api/agents");
      assert.equal(count("/api/me"), before + 1);
      deferIdentity!(
        Response.json({
          user: { id: "old" },
          tenant: { id: "acme" },
          role: "user",
        }),
      );
      await assert.rejects(old, { code: "CACHE_INVALIDATED" });
      await assert.rejects(next, { code: "CACHE_INVALIDATED" });
      assert.equal(apiIdentityScope(), undefined);
      holdIdentity = false;
      await api("/api/agents");
      assert.match(apiIdentityScope()!, /carol/);
    },
  );
  await t.test(
    "BFCache restoration reconnects cross-tab invalidation",
    async () => {
      const previousChannel = Channel.current;
      listeners.get("pagehide")!();
      assert.ok(previousChannel.closed);
      listeners.get("pageshow")!();
      assert.notEqual(Channel.current, previousChannel);
      await api("/api/agents/a/mcp");
      const before = count("/api/agents/a/mcp");
      Channel.current.onmessage!({ data: "metadata" });
      await api("/api/agents/a/mcp");
      assert.equal(count("/api/agents/a/mcp"), before + 1);
    },
  );
  await t.test("slow identity bootstrap has bounded subscribers", async () => {
    clearApiCache(false);
    holdIdentity = true;
    const before = count("/api/me");
    const pending = Array.from({ length: 256 }, () => api("/api/agents"));
    const settled = Promise.allSettled(pending);
    await assert.rejects(api("/api/agents"), { code: "CACHE_BUSY" });
    assert.equal(count("/api/me"), before + 1);
    clearApiCache(false);
    deferIdentity!(
      Response.json({
        user: { id: "old" },
        tenant: { id: "acme" },
        role: "user",
      }),
    );
    for (const result of await settled) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected")
        assert.equal(result.reason.code, "CACHE_INVALIDATED");
    }
    holdIdentity = false;
  });
  await t.test(
    "late uncached visualization GET cannot populate another account's view",
    async () => {
      holdVisualization = true;
      const old = api("/api/sessions/s1/visualizations/v1");
      while (!deferVisualization)
        await new Promise((resolve) => setImmediate(resolve));
      principal = "new-user";
      await api("/api/me");
      deferVisualization!(Response.json({ html: "old private content" }));
      await assert.rejects(old, { code: "CACHE_INVALIDATED" });
      holdVisualization = false;
    },
  );
  await t.test(
    "bare session and filtered project lists reject late account responses",
    async () => {
      for (const path of ["/api/sessions", "/api/projects?status=active"]) {
        heldListPath = new URL(path, "http://test").pathname;
        deferList = undefined;
        const old = api(path);
        while (!deferList)
          await new Promise((resolve) => setImmediate(resolve));
        principal += "-next";
        await api("/api/me");
        (deferList as (value: Response) => void)(
          Response.json([{ title: "private previous account" }]),
        );
        await assert.rejects(old, { code: "CACHE_INVALIDATED" });
        heldListPath = undefined;
      }
    },
  );
  await t.test(
    "switching away and back still rejects an earlier private response",
    async () => {
      principal = "cycle-alice";
      await api("/api/me");
      heldListPath = "/api/sessions";
      deferList = undefined;
      const old = api("/api/sessions");
      while (!deferList) await new Promise((resolve) => setImmediate(resolve));
      principal = "cycle-bob";
      await api("/api/me");
      principal = "cycle-alice";
      await api("/api/me");
      (deferList as (value: Response) => void)(
        Response.json([{ title: "stale previous account lifecycle" }]),
      );
      await assert.rejects(old, { code: "CACHE_INVALIDATED" });
      heldListPath = undefined;
    },
  );
  await t.test("flag off bypasses identity bootstrap and cache", async () => {
    process.env.NEXT_PUBLIC_CLIENT_CACHE = "off";
    const before = count("/api/me"),
      gets = count("/api/agents");
    await api("/api/agents");
    await api("/api/agents");
    assert.equal(count("/api/me"), before);
    assert.equal(count("/api/agents"), gets + 2);
  });
});

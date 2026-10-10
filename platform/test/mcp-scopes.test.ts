import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { tenantDbName, type TenantRef } from "../src/tenant";
import type { UserRef } from "../src/user";
import { admin, ashok, asUser, dharun, insertFixtures } from "./fixtures";

function tenantDoc(id: string) {
  const now = new Date().toISOString();
  return {
    _id: id,
    name: id.toUpperCase(),
    dbName: tenantDbName(id),
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
}
const servers = (body: any) =>
  Object.keys(body.config)
    .filter((k) => k.startsWith("mcp_servers."))
    .map((k) => k.slice("mcp_servers.".length))
    .sort();
const noSecrets = (value: unknown) =>
  assert.doesNotMatch(
    JSON.stringify(value),
    /apiKeyEnc|apiKey|apikey|-key-value|"iv"|"tag"/,
  );

test(
  "MCP scopes: tenant and user MCPs, ownership, name rules, owner-based session build",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(
      mongo.getUri(),
      "scopes_default",
      "scopes_catalog",
    ).connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await store.tenantRegistry.insertMany([tenantDoc("t1"), tenantDoc("t2")]);
    const t1 = await store.resolveTenant("t1");
    const t2 = await store.resolveTenant("t2");
    for (const tenant of [t1, t2])
      await store.withTenant(tenant, () => insertFixtures(store));

    const service = new PlatformService(store, ["http://core"]);
    const calls: { path: string; body?: any }[] = [];
    let threads = 0;
    service.call = async (_host, path, _method, body) => {
      calls.push({ path, body });
      if (path === "/threads") return { threadId: "th" + ++threads };
      if (path.endsWith("/turns")) return { turnId: "turn_1", steer: false };
      return {};
    };
    const responses: unknown[] = [];
    const as = <T>(user: UserRef, fn: () => Promise<T>, tenant: TenantRef = t1) =>
      store.withTenant(tenant, () =>
        asUser(user, async () => {
          const result = await fn();
          responses.push(result);
          return result;
        }),
      );
    // Internal callers (polling, cold resume) run with a tenant but no user.
    const background = <T>(fn: () => Promise<T>) => store.withTenant(t1, fn);
    const lastThreadStart = () =>
      calls.filter((c) => c.path === "/threads").at(-1)!.body;
    const lastResume = () =>
      calls.filter((c) => c.path.endsWith("/resume")).at(-1)!.body;

    // --- Tenant MCP: Admin creates and attaches it. -----------------------
    const notion = await as(admin, () =>
      service.createTenantMcp({
        name: "notion",
        url: "https://example.com/notion",
        auth: { kind: "bearer" },
        apiKey: "notion-key-value",
      }),
    );
    assert.equal(notion.scope, "tenant");
    assert.equal(notion.urlHost, "example.com");
    assert.equal(notion.hasKey, true);
    assert.equal(notion.shadowedUserMcps, 0);
    await as(admin, () => service.setAgentTenantMcp("assistant", [notion.id]));

    // --- User MCPs: Ashok's own, attached to the same agent. --------------
    const github = await as(ashok, () =>
      service.createMcp({
        name: "github",
        url: "https://example.com/github",
        auth: { kind: "bearer" },
        apiKey: "ashok-key-value",
      }),
    );
    assert.equal(github.scope, "user");
    const stored = await store.withTenant(t1, () => store.findMcp(github.id));
    assert.equal(stored?.ownerId, "ashok");
    assert.equal(stored?.apiKey, "ashok-key-value");
    assert.equal(stored?.apiKeyEnc, undefined);
    await as(ashok, () => service.setAgentMcp("assistant", [github.id]));

    // A tenant MCP loads in both users' chats; a user MCP only in its owner's.
    const ashokChat = await as(ashok, () => service.create("assistant"));
    assert.deepEqual(servers(lastThreadStart()), ["github", "notion"]);
    assert.equal(
      lastThreadStart().config["mcp_servers.github"].http_headers.Authorization,
      "Bearer ashok-key-value",
    );
    const dharunChat = await as(dharun, () => service.create("assistant"));
    assert.deepEqual(servers(lastThreadStart()), ["notion"]);
    // Only for the attached agent.
    await as(ashok, () => service.create("developer"));
    assert.deepEqual(servers(lastThreadStart()), []);

    // --- Dharun gets 404 on Ashok's MCP everywhere. -----------------------
    const hidden = { status: 404, code: "MCP_NOT_FOUND" };
    await assert.rejects(
      as(dharun, () => service.updateMcp(github.id, { name: "mine" })),
      hidden,
    );
    await assert.rejects(
      as(dharun, () => service.deleteMcp(github.id)),
      hidden,
    );
    await assert.rejects(
      as(dharun, () => service.setAgentMcp("assistant", [github.id])),
      hidden,
    );
    // ...including from a tenant admin: user MCPs are the owner's only.
    await assert.rejects(
      as(admin, () => service.updateMcp(github.id, { name: "mine" })),
      hidden,
    );
    const dharunList = await as(dharun, () => service.listMcp());
    assert.deepEqual(dharunList.userProfiles, []);
    assert.deepEqual(
      dharunList.tenantProfiles.map((p) => [p.name, p.urlHost, p.agentIds]),
      [["notion", "example.com", ["assistant"]]],
    );
    assert.equal(dharunList.tenantProfiles[0].editable, false);
    const dharunAgent = await as(dharun, () => service.agentMcp("assistant"));
    assert.deepEqual(dharunAgent.profiles, []);
    assert.deepEqual(dharunAgent.profileIds, []);
    assert.deepEqual(
      dharunAgent.tenantProfiles.map((p) => p.name),
      ["notion"],
    );
    assert.equal(
      (await store.withTenant(t1, () => store.findMcp(github.id)))?.name,
      "github",
    );

    // --- A user gets 403 on every tenant admin operation. -----------------
    const forbidden = { status: 403, code: "TENANT_ADMIN_REQUIRED" };
    for (const call of [
      () => service.listTenantMcp(),
      () =>
        service.createTenantMcp({
          name: "sneaky",
          url: "https://example.com/x",
        }),
      () => service.updateTenantMcp(notion.id, { enabled: false }),
      () => service.deleteTenantMcp(notion.id),
      () => service.agentTenantMcp("assistant"),
      () => service.setAgentTenantMcp("assistant", []),
    ])
      await assert.rejects(as(ashok, call), forbidden);
    assert.equal(
      (await store.withTenant(t1, () => store.findMcp(notion.id)))?.enabled,
      true,
    );

    // --- LEGACY(frontend-v1): the single-list MCP settings form. ----------
    // A user's form lists only their own MCPs; a tenant id is not theirs.
    const ashokAgent = await as(ashok, () => service.agentMcp("assistant"));
    assert.deepEqual(
      ashokAgent.profiles.map((p) => [p.name, p.attached]),
      [["github", true]],
    );
    assert.deepEqual(ashokAgent.profileIds, [github.id]);
    await assert.rejects(
      as(ashok, () => service.setAgentMcp("assistant", [github.id, notion.id])),
      hidden,
    );
    // An admin's form lists their own and the tenant's, and one POST sets both.
    const adminOwn = await as(admin, () =>
      service.createMcp({ name: "admin-tools", url: "https://example.com/a" }),
    );
    let adminAgent = await as(admin, () => service.agentMcp("assistant"));
    assert.deepEqual(
      adminAgent.profiles.map((p) => [p.name, p.scope, p.attached]),
      [
        ["admin-tools", "user", false],
        ["notion", "tenant", true],
      ],
    );
    assert.deepEqual(adminAgent.profileIds, [notion.id]);
    adminAgent = await as(admin, () =>
      service.setAgentMcp("assistant", [adminOwn.id]),
    );
    assert.deepEqual(adminAgent.profileIds, [adminOwn.id]);
    assert.deepEqual(
      (await as(admin, () => service.agentTenantMcp("assistant"))).profileIds,
      [],
    );
    adminAgent = await as(admin, () =>
      service.setAgentMcp("assistant", [adminOwn.id, notion.id]),
    );
    assert.deepEqual(adminAgent.profileIds.sort(), [adminOwn.id, notion.id].sort());
    // Ashok's attachment was never touched by the admin's saves.
    assert.deepEqual(
      (await as(ashok, () => service.agentMcp("assistant"))).profileIds,
      [github.id],
    );

    // --- Name rules. --------------------------------------------------------
    const reserved = { status: 409, code: "MCP_NAME_RESERVED" };
    await assert.rejects(
      as(ashok, () =>
        service.createMcp({ name: "notion", url: "https://example.com/n" }),
      ),
      reserved,
    );
    await assert.rejects(
      as(ashok, () => service.updateMcp(github.id, { name: "notion" })),
      reserved,
    );
    // One owner cannot have two of a name; two owners can.
    await assert.rejects(
      as(ashok, () =>
        service.createMcp({ name: "github", url: "https://example.com/g2" }),
      ),
      { status: 409, code: "MCP_NAME_TAKEN" },
    );
    await as(dharun, () =>
      service.createMcp({ name: "github", url: "https://example.com/g3" }),
    );
    // "__" would break mcp__<server>__<tool>.
    for (const name of ["a__b", "__x", "x.y"])
      await assert.rejects(
        as(ashok, () => service.createMcp({ name, url: "https://example.com/x" })),
        { status: 422 },
      );
    await assert.rejects(
      as(admin, () =>
        service.createTenantMcp({ name: "a__b", url: "https://example.com/x" }),
      ),
      { status: 422 },
    );

    // An existing clash: Dharun's "jira" predates the tenant's "jira".
    const jira = await as(dharun, () =>
      service.createMcp({ name: "jira", url: "https://example.com/jira" }),
    );
    await as(dharun, () =>
      service.setAgentMcp("assistant", [jira.id]),
    );
    const tenantJira = await as(admin, () =>
      service.createTenantMcp({ name: "jira", url: "https://example.com/tj" }),
    );
    assert.equal(tenantJira.shadowedUserMcps, 1);
    assert.match(tenantJira.warnings!.join(), /1 user MCP server uses the name jira/);
    const shadowed = (await as(dharun, () => service.listMcp())).userProfiles.find(
      (p) => p.id === jira.id,
    )!;
    assert.equal(shadowed.shadowed, true);
    assert.match(shadowed.warnings!.join(), /tenant server and skip this one/);
    // The chat still starts, without the user copy (the tenant jira is not
    // attached to this agent, so no jira at all).
    await as(dharun, () => service.create("assistant"));
    assert.deepEqual(servers(lastThreadStart()), ["notion"]);
    // Once attached, the tenant server is the one that loads.
    await as(admin, () =>
      service.setAgentTenantMcp("assistant", [notion.id, tenantJira.id]),
    );
    await as(dharun, () => service.create("assistant"));
    assert.equal(
      lastThreadStart().config["mcp_servers.jira"].url,
      "https://example.com/tj",
    );

    // --- The owner's MCPs, never the caller's. ------------------------------
    // Cold resume or background work: no user in context.
    const session = await background(() => service.session(ashokChat._id));
    await background(() => service.resume(session));
    assert.deepEqual(servers(lastResume()), ["github", "jira", "notion"]);
    // An admin reading Ashok's chat resumes it with Ashok's MCPs, not their
    // own admin-tools (attached to the same agent above).
    await as(admin, () =>
      service.capability(ashokChat._id, "thread/goal/get", {}),
    );
    assert.deepEqual(servers(lastResume()), ["github", "jira", "notion"]);
    // An admin reader cannot send a message at all (only the owner writes).
    const before = calls.length;
    await assert.rejects(
      as(admin, () => service.message(ashokChat._id, "hi", "admin-1")),
      { status: 403, code: "NOT_SESSION_OWNER" },
    );
    assert.equal(calls.length, before);
    // Dharun's chat never gets Ashok's MCP, whoever resumes it.
    const dharunSession = await background(() =>
      service.session(dharunChat._id),
    );
    await background(() => service.resume(dharunSession));
    assert.deepEqual(servers(lastResume()), ["jira", "notion"]);

    // --- Detach or rotate: a new fingerprint on the next turn. -------------
    await as(ashok, () => service.message(ashokChat._id, "one", "c-1"));
    const first = lastResume().mcpFingerprint;
    await as(ashok, () => service.message(ashokChat._id, "two", "c-2"));
    assert.equal(lastResume().mcpFingerprint, first);
    await as(ashok, () => service.setAgentMcp("assistant", []));
    await as(ashok, () => service.message(ashokChat._id, "three", "c-3"));
    assert.deepEqual(servers(lastResume()), ["jira", "notion"]);
    const detached = lastResume().mcpFingerprint;
    assert.notEqual(detached, first);
    await as(admin, () =>
      service.updateTenantMcp(notion.id, { apiKey: "rotated-key-value" }),
    );
    await as(ashok, () => service.message(ashokChat._id, "four", "c-4"));
    assert.notEqual(lastResume().mcpFingerprint, detached);
    assert.equal(
      lastResume().config["mcp_servers.notion"].http_headers.Authorization,
      "Bearer rotated-key-value",
    );
    assert.equal(
      (await background(() => service.session(ashokChat._id))).mcpFingerprint,
      lastResume().mcpFingerprint,
    );

    // --- Offboarding: only that user's MCPs, only in this tenant. ----------
    await as(
      ashok,
      () => service.createMcp({ name: "github", url: "https://example.com/t2" }),
      t2,
    );
    assert.deepEqual(
      await background(() => service.deleteUserMcps("ashok")),
      { deleted: 1 },
    );
    const left = await background(() =>
      store.mcp.find({}, { projection: { name: 1, scope: 1, ownerId: 1 } }).toArray(),
    );
    assert.deepEqual(
      left.map((p) => `${p.scope}:${p.ownerId ?? ""}:${p.name}`).sort(),
      [
        "tenant::jira",
        "tenant::notion",
        "user:admin:admin-tools",
        "user:dharun:github",
        "user:dharun:jira",
      ],
    );
    assert.equal(
      await store.withTenant(t2, () =>
        store.mcp.countDocuments({ ownerId: "ashok" }),
      ),
      1,
    );
    await assert.rejects(
      background(() => service.deleteUserMcps("../bad")),
      { status: 400 },
    );

    // No response carried a key, its ciphertext or a URL path.
    noSecrets(responses);
    assert.doesNotMatch(JSON.stringify(responses), /\/notion|\/github/);
  },
);

test(
  "a user MCP renamed or created into a tenant name in a race is undone",
  { timeout: 60000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "race_test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);
    const own = await asUser(ashok, () =>
      service.createMcp({ name: "wiki", url: "https://example.com/w" }),
    );
    // The tenant name appears between the service's first check and its
    // write: the second check after the write catches it.
    // store.mcp is a getter returning a fresh collection, so one instance is
    // pinned on the store for the duration and its findOne wrapped.
    const racing = (name: string) => {
      const mcp = store.mcp;
      const original = mcp.findOne.bind(mcp);
      Object.defineProperty(store, "mcp", { get: () => mcp, configurable: true });
      let checks = 0;
      (mcp as any).findOne = async (filter: any, ...rest: any[]) => {
        if (filter?.scope === "tenant" && filter.name === name && ++checks === 1) {
          const miss = await original(filter, ...rest);
          await mcp.insertOne({
            _id: "mcp_tenant_" + name,
            name,
            scope: "tenant",
            agentIds: [],
            url: "https://example.com/t",
            transport: "http",
          });
          return miss;
        }
        return original(filter, ...rest);
      };
      return () => {
        (mcp as any).findOne = original;
        delete (store as any).mcp;
      };
    };
    let restore = racing("docs");
    await assert.rejects(
      asUser(ashok, () =>
        service.createMcp({ name: "docs", url: "https://example.com/d" }),
      ),
      { status: 409, code: "MCP_NAME_RESERVED" },
    );
    restore();
    assert.equal(
      await store.mcp.countDocuments({ scope: "user", name: "docs" }),
      0,
    );
    restore = racing("notes");
    await assert.rejects(
      asUser(ashok, () => service.updateMcp(own.id, { name: "notes" })),
      { status: 409, code: "MCP_NAME_RESERVED" },
    );
    restore();
    assert.equal((await store.findMcp(own.id))?.name, "wiki");
  },
);

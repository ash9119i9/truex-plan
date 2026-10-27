import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  TenantGuard,
  type TenantContext,
} from "../../src/common/access/tenant.guard";
import { DatabaseService } from "../../src/database/database.service";
import {
  MEMBERSHIPS_COLLECTION,
  type MembershipDoc,
} from "../../src/modules/memberships/membership";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../src/modules/sessions/session-policy";
import {
  InvalidSessionError,
  SessionsService,
} from "../../src/modules/sessions/sessions.service";
import {
  DEFAULT_TENANT_DB_NAME,
  TENANTS_COLLECTION,
  organizationDbName,
  type TenantDoc,
} from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import { resetOwnedData } from "../support/reset";
import { TEST_ORIGIN } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

interface ErrorBody {
  error: { code: string; message: string };
  requestId: string;
}

interface TenantBody {
  tenant: { id: string; name: string; role: string };
}

describe("tenant-scoped requests (?tenantId=)", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let users: UsersService;
  let memberships: MembershipsService;
  let sessions: SessionsService;
  let operator: OperatorService;
  let defaultTenantId: ObjectId;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
    database = running.app.get(DatabaseService);
    users = running.app.get(UsersService);
    memberships = running.app.get(MembershipsService);
    sessions = running.app.get(SessionsService);
    operator = running.app.get(OperatorService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await resetOwnedData(database);
    defaultTenantId = await provision("Truex", "default");
  });

  async function provision(
    name: string,
    kind: "default" | "organization",
  ): Promise<ObjectId> {
    const tenantId = new ObjectId();
    await operator.provisionTenant({ operator: "ops", tenantId, name, kind });
    return tenantId;
  }

  // A synthetic signed-up user in the default tenant, with an access token.
  async function member(
    subject: string,
  ): Promise<{ userId: ObjectId; token: string; refresh: string }> {
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: `User ${subject}`,
    });
    await memberships.join({
      userId: user._id,
      tenantId: defaultTenantId,
      joinedVia: "signup",
    });
    const issued = await sessions.create(user._id);
    return {
      userId: user._id,
      token: issued.accessToken,
      refresh: issued.refreshCredential,
    };
  }

  async function makeAdmin(userId: ObjectId, tenantId: ObjectId) {
    await operator.assignRole({
      operator: "ops",
      user: userId.toHexString(),
      tenantId,
      role: "admin",
    });
  }

  // An access token for one tenant, from a refresh that names it. Rotates
  // the member's refresh credential.
  async function tenantToken(
    who: { refresh: string },
    tenantId: ObjectId,
  ): Promise<string> {
    const issued = await sessions.refresh(who.refresh, new Date(), tenantId);
    who.refresh = issued.refreshCredential;
    return issued.accessToken;
  }

  function getTenant(
    query: string,
    token?: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${running.baseUrl}/api/v1/tenant${query}`, {
      headers: token ? { authorization: `Bearer ${token}`, ...headers } : {},
    });
  }

  async function assertError(
    res: Response,
    status: number,
    code: string,
  ): Promise<ErrorBody> {
    assert.equal(res.status, status);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.error.code, code);
    assert.ok(body.requestId);
    return body;
  }

  async function tenantOf(query: string, token: string): Promise<TenantBody> {
    const res = await getTenant(query, token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return (await res.json()) as TenantBody;
  }

  describe("authentication comes first", () => {
    test("no or bad token is a 401 whatever the tenantId", async () => {
      for (const query of ["", `?tenantId=${defaultTenantId}`, "?tenantId=x"])
        for (const token of [undefined, "not-a-token"]) {
          const res = await getTenant(query, token);
          await assertError(res, 401, "UNAUTHENTICATED");
          assert.equal(
            res.headers.get("www-authenticate"),
            'Bearer realm="truex"',
          );
        }
    });

    // Tenant routes check the token by signature alone, so a logged-out
    // session's token reaches them until it expires. The account routes the
    // app opens with, and refresh, refuse it at once.
    test("a logged-out session's token works on tenant routes only until it expires", async () => {
      const a = await member("a");
      const query = `?tenantId=${defaultTenantId}`;
      await sessions.logout(a.refresh);
      assert.equal((await getTenant(query, a.token)).status, 200);
      const me = await fetch(`${running.baseUrl}/api/v1/me`, {
        headers: { authorization: `Bearer ${a.token}` },
      });
      await assertError(me, 401, "UNAUTHENTICATED");
      await assert.rejects(sessions.refresh(a.refresh), InvalidSessionError);
      const expired = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
      assert.throws(
        () => sessions.verifyToken(a.token, expired),
        InvalidSessionError,
      );
    });
  });

  describe("the tenantId parameter", () => {
    test("must be exactly one canonical ID", async () => {
      const a = await member("a");
      const id = defaultTenantId.toHexString();
      for (const query of [
        "",
        "?",
        "?tenantId=",
        "?tenantId",
        `?tenantId=${id}&tenantId=${id}`,
        `?tenantId=${id}&tenantId=${new ObjectId().toHexString()}`,
        `?tenantId=${id.toUpperCase()}`,
        `?tenantId=${id.slice(1)}`,
        `?tenantId=${id}0`,
        `?tenantId=%20${id}`,
        `?tenantId=${"z".repeat(24)}`,
        `?tenantId[]=${id}`,
        `?tenantId[$ne]=${id}`,
        `?tenantId[id]=${id}`,
        `?tenantId=${id}&tenantId[x]=1`,
        `?tenantid=${id}`,
      ]) {
        const res = await getTenant(query, a.token);
        await assertError(res, 400, "BAD_REQUEST");
      }
    });

    test("a percent-encoded name and value are the same parameter", async () => {
      const a = await member("a");
      const encoded = encodeURIComponent(defaultTenantId.toHexString());
      const { tenant } = await tenantOf(`?tenant%49d=${encoded}`, a.token);
      assert.equal(tenant.id, defaultTenantId.toHexString());
    });
  });

  describe("GET /tenant", () => {
    test("returns the tenant and the caller's role there", async () => {
      const a = await member("a");
      assert.deepEqual(
        await tenantOf(`?tenantId=${defaultTenantId}`, a.token),
        {
          tenant: {
            id: defaultTenantId.toHexString(),
            name: "Truex",
            role: "user",
          },
        },
      );
    });

    test("the same person can be a user in one tenant and an admin in another", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const home = await tenantOf(`?tenantId=${defaultTenantId}`, a.token);
      const org = await tenantOf(`?tenantId=${orgId}`, a.token);
      assert.equal(home.tenant.role, "user");
      assert.deepEqual(org.tenant, {
        id: orgId.toHexString(),
        name: "Acme",
        role: "admin",
      });
    });

    test("never exposes storage details", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      for (const tenantId of [defaultTenantId, orgId]) {
        const raw = await (
          await getTenant(`?tenantId=${tenantId}`, a.token)
        ).text();
        assert.equal(raw.includes("truex_next_"), false);
        assert.equal(raw.includes("dbName"), false);
      }
    });

    test("role and tenant cannot be forged by headers or extra parameters", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      const res = await getTenant(
        `?tenantId=${defaultTenantId}&role=admin&dbName=${organizationDbName(orgId)}`,
        a.token,
        {
          "x-role": "admin",
          "x-user-role": "admin",
          "x-tenant-id": orgId.toHexString(),
        },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(((await res.json()) as TenantBody).tenant, {
        id: defaultTenantId.toHexString(),
        name: "Truex",
        role: "user",
      });
    });
  });

  describe("tenants the caller cannot use", () => {
    // Every case gets an identical answer, so nothing reveals whether the
    // tenant exists, is disabled or simply belongs to other people.
    test("unknown, foreign, removed, disabled and pending tenants all get the same 403", async () => {
      const a = await member("a");
      const b = await member("b");
      const catalog = database.catalog();
      const tenantsCol = catalog.collection<TenantDoc>(TENANTS_COLLECTION);
      const membershipsCol = catalog.collection<MembershipDoc>(
        MEMBERSHIPS_COLLECTION,
      );

      const foreignOrg = await provision("Foreign", "organization");
      await makeAdmin(b.userId, foreignOrg);

      const removedOrg = await provision("Removed", "organization");
      await makeAdmin(a.userId, removedOrg);
      await membershipsCol.updateOne(
        { userId: a.userId, tenantId: removedOrg },
        { $set: { status: "removed" } },
      );

      const disabledOrg = await provision("Disabled", "organization");
      await makeAdmin(a.userId, disabledOrg);
      await tenantsCol.updateOne(
        { _id: disabledOrg },
        { $set: { status: "disabled" } },
      );

      const pendingOrg = new ObjectId();
      const now = new Date();
      await tenantsCol.insertOne({
        _id: pendingOrg,
        name: "Pending",
        dbName: organizationDbName(pendingOrg),
        kind: "organization",
        status: "active",
        provisioningStatus: "pending",
        createdAt: now,
        updatedAt: now,
      });
      await membershipsCol.insertOne({
        _id: new ObjectId(),
        userId: a.userId,
        tenantId: pendingOrg,
        role: "admin",
        status: "active",
        joinedVia: "operator",
        createdAt: now,
        updatedAt: now,
      });

      const messages = new Set<string>();
      for (const tenantId of [
        new ObjectId(),
        foreignOrg,
        removedOrg,
        disabledOrg,
        pendingOrg,
      ]) {
        const res = await getTenant(`?tenantId=${tenantId}`, a.token);
        const body = await assertError(res, 403, "FORBIDDEN");
        messages.add(body.error.message);
        assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
      }
      assert.equal(messages.size, 1);
      // The other member still gets in where they belong.
      assert.equal(
        (await getTenant(`?tenantId=${foreignOrg}`, b.token)).status,
        200,
      );
    });

    test("removal and disabling take effect on the next request", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const query = `?tenantId=${orgId}`;
      assert.equal((await getTenant(query, a.token)).status, 200);

      const catalog = database.catalog();
      await catalog
        .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
        .updateOne(
          { userId: a.userId, tenantId: orgId },
          { $set: { status: "removed" } },
        );
      await assertError(await getTenant(query, a.token), 403, "FORBIDDEN");

      const home = `?tenantId=${defaultTenantId}`;
      assert.equal((await getTenant(home, a.token)).status, 200);
      await catalog
        .collection<TenantDoc>(TENANTS_COLLECTION)
        .updateOne({ _id: defaultTenantId }, { $set: { status: "disabled" } });
      await assertError(await getTenant(home, a.token), 403, "FORBIDDEN");
    });

    test("a role change is seen on the next request", async () => {
      const a = await member("a");
      const query = `?tenantId=${defaultTenantId}`;
      assert.equal((await tenantOf(query, a.token)).tenant.role, "user");
      await makeAdmin(a.userId, defaultTenantId);
      assert.equal((await tenantOf(query, a.token)).tenant.role, "admin");
    });
  });

  describe("tenant tokens", () => {
    // Database calls per Server-Timing step of one response: `auth` and
    // `access` are the guard's, so these count exactly what access cost.
    function dbCalls(res: Response): Map<string, number> {
      const steps = new Map<string, number>();
      for (const entry of (res.headers.get("server-timing") ?? "").split(
        ", ",
      )) {
        const name = entry.split(";")[0]!;
        const calls = /\((\d+) db calls?\)/.exec(entry)?.[1];
        steps.set(name, calls ? Number(calls) : 0);
      }
      return steps;
    }

    function chats(tenantId: ObjectId, token: string): Promise<Response> {
      return fetch(`${running.baseUrl}/api/v1/chats?tenantId=${tenantId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    }

    test("a token for the tenant reaches its routes with no auth or access database call", async () => {
      const a = await member("a");
      const res = await chats(
        defaultTenantId,
        await tenantToken(a, defaultTenantId),
      );
      assert.equal(res.status, 200);
      const steps = dbCalls(res);
      assert.equal(steps.get("auth"), 0);
      assert.equal(steps.has("access"), false);
    });

    test("a token without a tenant, or for another one, is checked against the catalog", async () => {
      const a = await member("a");
      const b = await member("b");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const foreign = await provision("Foreign", "organization");
      await makeAdmin(b.userId, foreign);

      for (const token of [a.token, await tenantToken(a, orgId)]) {
        const res = await chats(defaultTenantId, token);
        assert.equal(res.status, 200);
        assert.equal(dbCalls(res).get("access"), 2);
      }
      // A token for a tenant opens nothing else.
      const home = await tenantToken(a, defaultTenantId);
      await assertError(await chats(foreign, home), 403, "FORBIDDEN");
      await assertError(
        await getTenant(`?tenantId=${foreign}`, home),
        403,
        "FORBIDDEN",
      );
    });

    test("refresh for a tenant the caller cannot use issues a token without one", async () => {
      const a = await member("a");
      const b = await member("b");
      const catalog = database.catalog();
      const foreign = await provision("Foreign", "organization");
      await makeAdmin(b.userId, foreign);
      const removed = await provision("Removed", "organization");
      await makeAdmin(a.userId, removed);
      await catalog
        .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
        .updateOne(
          { userId: a.userId, tenantId: removed },
          { $set: { status: "removed" } },
        );
      const disabled = await provision("Disabled", "organization");
      await makeAdmin(a.userId, disabled);
      await catalog
        .collection<TenantDoc>(TENANTS_COLLECTION)
        .updateOne({ _id: disabled }, { $set: { status: "disabled" } });

      for (const tenantId of [new ObjectId(), foreign, removed, disabled]) {
        const issued = await sessions.refresh(a.refresh, new Date(), tenantId);
        a.refresh = issued.refreshCredential;
        assert.equal(issued.tenant, undefined);
        assert.equal(
          sessions.verifyToken(issued.accessToken).tenant,
          undefined,
        );
        await assertError(
          await chats(tenantId, issued.accessToken),
          403,
          "FORBIDDEN",
        );
        // Still signed in: the default tenant opens through the catalog.
        assert.equal(
          (await chats(defaultTenantId, issued.accessToken)).status,
          200,
        );
      }
    });

    test("a tenant whose database does not match its kind is kept out of tokens", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      await database
        .catalog()
        .collection<TenantDoc>(TENANTS_COLLECTION)
        .updateOne({ _id: orgId }, { $set: { dbName: "truex_next_t_other" } });
      const issued = await sessions.refresh(a.refresh, new Date(), orgId);
      assert.equal(issued.tenant, undefined);
    });

    // The trade-off of token checks, bounded by the token lifetime: entering
    // the tenant (GET /tenant) and the next refresh see the change at once.
    test("a removal or role change reaches tenant routes at the next refresh", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const token = await tenantToken(a, orgId);
      assert.equal(sessions.verifyToken(token).tenant?.role, "admin");

      await operator.assignRole({
        operator: "ops",
        user: a.userId.toHexString(),
        tenantId: orgId,
        role: "user",
      });
      assert.equal(
        (await tenantOf(`?tenantId=${orgId}`, token)).tenant.role,
        "user",
      );
      const demoted = await tenantToken(a, orgId);
      assert.equal(sessions.verifyToken(demoted).tenant?.role, "user");

      await database
        .catalog()
        .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
        .updateOne(
          { userId: a.userId, tenantId: orgId },
          { $set: { status: "removed" } },
        );
      assert.equal((await chats(orgId, demoted)).status, 200);
      await assertError(
        await getTenant(`?tenantId=${orgId}`, demoted),
        403,
        "FORBIDDEN",
      );
      await assertError(
        await chats(orgId, await tenantToken(a, orgId)),
        403,
        "FORBIDDEN",
      );
    });

    test("refresh over HTTP names the tenant it granted", async () => {
      const a = await member("a");
      const refresh = (query: string) =>
        fetch(`${running.baseUrl}/api/v1/auth/refresh${query}`, {
          method: "POST",
          headers: {
            origin: TEST_ORIGIN,
            cookie: `truex_refresh=${a.refresh}`,
          },
        });
      const granted = async (query: string) => {
        const res = await refresh(query);
        assert.equal(res.status, 200);
        const cookie = /^truex_refresh=([^;]+)/.exec(
          res.headers.getSetCookie()[0] ?? "",
        );
        a.refresh = cookie![1]!;
        return ((await res.json()) as { tenantId: string | null }).tenantId;
      };
      assert.equal(await granted(""), null);
      assert.equal(
        await granted(`?tenantId=${defaultTenantId}`),
        defaultTenantId.toHexString(),
      );
      assert.equal(await granted(`?tenantId=${new ObjectId()}`), null);
      const id = defaultTenantId.toHexString();
      for (const query of [
        "?tenantId=",
        "?tenantId=x",
        `?tenantId=${id}&tenantId=${id}`,
        `?tenantId[$ne]=${id}`,
        `?tenantId=${id.toUpperCase()}`,
      ])
        await assertError(await refresh(query), 400, "BAD_REQUEST");
      // A refused query rotated nothing: the cookie still works.
      assert.equal(await granted(`?tenantId=${id}`), id);
    });
  });

  describe("concurrent requests", () => {
    // Two tabs on two tenants with one session: each request keeps its own
    // tenant and role, and nothing is remembered between requests.
    test("interleaved requests to different tenants keep separate context", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const expected = new Map([
        [defaultTenantId.toHexString(), { name: "Truex", role: "user" }],
        [orgId.toHexString(), { name: "Acme", role: "admin" }],
        [new ObjectId().toHexString(), null],
      ]);
      const ids = [...expected.keys()];
      const requests = Array.from(
        { length: 60 },
        (_, i) => ids[i % ids.length]!,
      );
      const results = await Promise.all(
        requests.map(async (id) => {
          const res = await getTenant(`?tenantId=${id}`, a.token);
          return {
            id,
            status: res.status,
            body: (await res.json()) as unknown,
          };
        }),
      );
      for (const { id, status, body } of results) {
        const want = expected.get(id);
        if (!want) {
          assert.equal(status, 403);
          continue;
        }
        assert.equal(status, 200);
        assert.deepEqual(body, { tenant: { id, ...want } });
      }
    });

    test("two users on the same tenant each get their own role", async () => {
      const a = await member("a");
      const b = await member("b");
      await makeAdmin(b.userId, defaultTenantId);
      const query = `?tenantId=${defaultTenantId}`;
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) => {
          const who = i % 2 === 0 ? a : b;
          return tenantOf(query, who.token).then((r) => ({
            want: who === a ? "user" : "admin",
            role: r.tenant.role,
          }));
        }),
      );
      for (const { want, role } of results) assert.equal(role, want);
    });
  });

  describe("the tenant context handed to routes", () => {
    // Drives the real guard with a minimal HTTP context.
    async function contextFor(
      url: string,
      token: string,
    ): Promise<TenantContext> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      const req = {
        originalUrl: url,
        get: (name: string) => headers[name.toLowerCase()],
      } as unknown as ExpressRequest;
      const res = {
        locals: { requestId: "test-request" },
        setHeader: () => undefined,
      } as unknown as ExpressResponse;
      const context = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as unknown as ExecutionContext;
      assert.equal(
        await running.app.get(TenantGuard).canActivate(context),
        true,
      );
      return res.locals.tenantContext as TenantContext;
    }

    test("carries the registry's database, never one from the request", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);

      const home = await contextFor(
        `/api/v1/tenant?tenantId=${defaultTenantId}&dbName=truex_next_t_evil`,
        a.token,
      );
      assert.deepEqual(Object.keys(home).sort(), [
        "dbName",
        "role",
        "tenantId",
        "userId",
      ]);
      assert.ok(home.userId.equals(a.userId));
      assert.ok(home.tenantId.equals(defaultTenantId));
      assert.equal(home.role, "user");
      assert.equal(home.dbName, DEFAULT_TENANT_DB_NAME);

      const org = await contextFor(`/api/v1/tenant?tenantId=${orgId}`, a.token);
      assert.equal(org.role, "admin");
      assert.equal(org.dbName, organizationDbName(orgId));
    });

    test("from a tenant token, carries the same database the catalog would", async () => {
      const a = await member("a");
      const orgId = await provision("Acme", "organization");
      await makeAdmin(a.userId, orgId);
      const home = await contextFor(
        `/api/v1/tenant?tenantId=${defaultTenantId}&dbName=truex_next_t_evil`,
        await tenantToken(a, defaultTenantId),
      );
      assert.equal(home.role, "user");
      assert.equal(home.dbName, DEFAULT_TENANT_DB_NAME);
      const org = await contextFor(
        `/api/v1/tenant?tenantId=${orgId}`,
        await tenantToken(a, orgId),
      );
      assert.equal(org.role, "admin");
      assert.equal(org.dbName, organizationDbName(orgId));
    });

    test("is frozen", async () => {
      const a = await member("a");
      const context = await contextFor(
        `/api/v1/tenant?tenantId=${defaultTenantId}`,
        a.token,
      );
      assert.ok(Object.isFrozen(context));
      assert.throws(() => {
        (context as { role: string }).role = "admin";
      }, TypeError);
    });
  });
});

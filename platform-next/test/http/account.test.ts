import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DatabaseService } from "../../src/database/database.service";
import {
  MEMBERSHIPS_COLLECTION,
  type MembershipDoc,
} from "../../src/modules/memberships/membership";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { signAccessToken } from "../../src/modules/sessions/access-token";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import {
  TENANTS_COLLECTION,
  organizationDbName,
  type TenantDoc,
} from "../../src/modules/tenants/tenant";
import { USERS_COLLECTION } from "../../src/modules/users/user";
import { UsersService } from "../../src/modules/users/users.service";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";
import { testAuthConfig } from "../support/test-auth";

interface ErrorBody {
  error: { code: string; message: string };
  requestId: string;
}

describe("account discovery (/me)", () => {
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

  // Synthetic identities only. Returns the user and a valid access token.
  async function signedIn(
    subject: string,
    picture?: string,
  ): Promise<{ userId: ObjectId; token: string }> {
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: `User ${subject}`,
      ...(picture ? { picture } : {}),
    });
    const issued = await sessions.create(user._id);
    return { userId: user._id, token: issued.accessToken };
  }

  function get(path: string, authorization?: string): Promise<Response> {
    return fetch(`${running.baseUrl}/api/v1/${path}`, {
      headers: authorization ? { authorization } : {},
    });
  }

  async function body<T>(res: Response): Promise<T> {
    return (await res.json()) as T;
  }

  async function assertUnauthenticated(res: Response): Promise<void> {
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="truex"');
    assert.equal(res.headers.get("cache-control"), "no-store");
    const error = await body<ErrorBody>(res);
    assert.equal(error.error.code, "UNAUTHENTICATED");
    assert.ok(error.requestId);
  }

  describe("authentication", () => {
    test("both endpoints refuse a missing or malformed Authorization header", async () => {
      const { token } = await signedIn("a");
      for (const path of ["me", "me/tenants"])
        for (const header of [
          undefined,
          "",
          token,
          `Basic ${token}`,
          `Bearer`,
          `Bearer  ${token}`,
          `Bearer ${token} extra`,
          `Bearer ${token.slice(0, -2)}`,
        ])
          await assertUnauthenticated(await get(path, header));
    });

    test("the bearer scheme is case-insensitive", async () => {
      const { token } = await signedIn("a");
      assert.equal((await get("me", `bearer ${token}`)).status, 200);
      assert.equal((await get("me", `BEARER ${token}`)).status, 200);
    });

    test("a token in the query string is ignored", async () => {
      const { token } = await signedIn("a");
      await assertUnauthenticated(await get(`me?access_token=${token}`));
    });

    test("a token signed by an untrusted key is refused", async () => {
      const { userId } = await signedIn("a");
      const forged = signAccessToken(testAuthConfig(), {
        userId,
        sessionId: new ObjectId(),
      });
      await assertUnauthenticated(await get("me", `Bearer ${forged.token}`));
    });

    test("a logged-out session's access token stops working", async () => {
      const { user } = await users.findOrCreateFromIdentity({
        provider: "google",
        subject: "a",
        email: "a@example.test",
        emailVerified: true,
      });
      const issued = await sessions.create(user._id);
      const auth = `Bearer ${issued.accessToken}`;
      assert.equal((await get("me", auth)).status, 200);
      await sessions.logout(issued.refreshCredential);
      await assertUnauthenticated(await get("me", auth));
    });

    test("a disabled account's access token stops working", async () => {
      const { userId, token } = await signedIn("a");
      await database
        .catalog()
        .collection(USERS_COLLECTION)
        .updateOne({ _id: userId }, { $set: { status: "disabled" } });
      await assertUnauthenticated(await get("me/tenants", `Bearer ${token}`));
    });
  });

  describe("GET /me", () => {
    test("returns only the caller's public profile", async () => {
      const { userId, token } = await signedIn(
        "a",
        "https://lh3.googleusercontent.test/a.png",
      );
      const res = await get("me", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await body(res), {
        user: {
          id: userId.toHexString(),
          email: "a@example.test",
          name: "User a",
          picture: "https://lh3.googleusercontent.test/a.png",
        },
      });
    });

    test("omits a missing picture", async () => {
      const { token } = await signedIn("a");
      const { user } = await body<{ user: Record<string, unknown> }>(
        await get("me", `Bearer ${token}`),
      );
      assert.deepEqual(Object.keys(user).sort(), ["email", "id", "name"]);
    });

    test("ignores a tenantId: user-only endpoints take none", async () => {
      const { token } = await signedIn("a");
      const res = await get(
        `me?tenantId=${new ObjectId().toHexString()}`,
        `Bearer ${token}`,
      );
      assert.equal(res.status, 200);
    });
  });

  describe("GET /me/tenants", () => {
    type Tenants = {
      entry: { outcome: string; tenantId?: string };
      tenants: { id: string; name: string; role: string }[];
    };

    async function tenantsOf(token: string): Promise<Tenants> {
      const res = await get("me/tenants", `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      return body<Tenants>(res);
    }

    test("one usable tenant enters it directly", async () => {
      const { userId, token } = await signedIn("a");
      await memberships.join({
        userId,
        tenantId: defaultTenantId,
        joinedVia: "signup",
      });
      assert.deepEqual(await tenantsOf(token), {
        entry: {
          outcome: "enterTenant",
          tenantId: defaultTenantId.toHexString(),
        },
        tenants: [
          { id: defaultTenantId.toHexString(), name: "Truex", role: "user" },
        ],
      });
    });

    test("no memberships returns noTenant, not an error", async () => {
      const { token } = await signedIn("a");
      assert.deepEqual(await tenantsOf(token), {
        entry: { outcome: "noTenant" },
        tenants: [],
      });
    });

    test("several tenants require a choice and carry per-tenant roles", async () => {
      const { userId, token } = await signedIn("a");
      const orgId = await provision("Acme", "organization");
      await memberships.join({
        userId,
        tenantId: defaultTenantId,
        joinedVia: "signup",
      });
      await operator.assignRole({
        operator: "ops",
        user: userId.toHexString(),
        tenantId: orgId,
        role: "admin",
      });
      const result = await tenantsOf(token);
      assert.deepEqual(result.entry, { outcome: "chooseTenant" });
      assert.deepEqual(result.tenants, [
        { id: defaultTenantId.toHexString(), name: "Truex", role: "user" },
        { id: orgId.toHexString(), name: "Acme", role: "admin" },
      ]);
    });

    test("removed memberships, disabled and unprovisioned tenants are left out", async () => {
      const { userId, token } = await signedIn("a");
      const catalog = database.catalog();
      const removedOrg = await provision("Removed", "organization");
      const disabledOrg = await provision("Disabled", "organization");
      for (const tenantId of [defaultTenantId, removedOrg, disabledOrg])
        await operator.assignRole({
          operator: "ops",
          user: userId.toHexString(),
          tenantId,
          role: "user",
        });
      await catalog
        .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
        .updateOne(
          { userId, tenantId: removedOrg },
          { $set: { status: "removed" } },
        );
      await catalog
        .collection<TenantDoc>(TENANTS_COLLECTION)
        .updateOne({ _id: disabledOrg }, { $set: { status: "disabled" } });

      // A tenant still being provisioned, with a membership written directly.
      const pendingId = new ObjectId();
      const now = new Date();
      await catalog.collection<TenantDoc>(TENANTS_COLLECTION).insertOne({
        _id: pendingId,
        name: "Pending",
        dbName: organizationDbName(pendingId),
        kind: "organization",
        status: "active",
        provisioningStatus: "pending",
        createdAt: now,
        updatedAt: now,
      });
      await catalog
        .collection<MembershipDoc>(MEMBERSHIPS_COLLECTION)
        .insertOne({
          _id: new ObjectId(),
          userId,
          tenantId: pendingId,
          role: "admin",
          status: "active",
          joinedVia: "operator",
          createdAt: now,
          updatedAt: now,
        });

      assert.deepEqual(await tenantsOf(token), {
        entry: {
          outcome: "enterTenant",
          tenantId: defaultTenantId.toHexString(),
        },
        tenants: [
          { id: defaultTenantId.toHexString(), name: "Truex", role: "user" },
        ],
      });
    });

    test("shows only the caller's memberships and no storage details", async () => {
      const a = await signedIn("a");
      const b = await signedIn("b");
      const orgId = await provision("Acme", "organization");
      await memberships.join({
        userId: a.userId,
        tenantId: defaultTenantId,
        joinedVia: "signup",
      });
      await memberships.join({
        userId: b.userId,
        tenantId: defaultTenantId,
        joinedVia: "signup",
      });
      await operator.assignRole({
        operator: "ops",
        user: b.userId.toHexString(),
        tenantId: orgId,
        role: "admin",
      });

      const res = await get("me/tenants", `Bearer ${a.token}`);
      const raw = await res.text();
      assert.equal(raw.includes(orgId.toHexString()), false);
      assert.equal(raw.includes("truex_next_"), false);
      assert.equal(raw.includes(b.userId.toHexString()), false);
      const result = JSON.parse(raw) as Tenants;
      assert.deepEqual(
        result.tenants.map((t) => t.id),
        [defaultTenantId.toHexString()],
      );
    });
  });
});

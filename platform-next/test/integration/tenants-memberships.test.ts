import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DomainError } from "../../src/common/domain-error";
import { DatabaseService } from "../../src/database/database.service";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import {
  DEFAULT_TENANT_DB_NAME,
  normalizeTenantName,
  organizationDbName,
} from "../../src/modules/tenants/tenant";
import { TenantsService } from "../../src/modules/tenants/tenants.service";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

async function rejectsWith(
  promise: Promise<unknown>,
  code: DomainError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof DomainError && error.code === code,
  );
}

describe("tenants and memberships", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let tenants: TenantsService;
  let memberships: MembershipsService;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
    database = running.app.get(DatabaseService);
    tenants = running.app.get(TenantsService);
    memberships = running.app.get(MembershipsService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(() => resetOwnedData(database));

  describe("provisioning", () => {
    test("creates a ready default tenant on the shared default database", async () => {
      const id = new ObjectId();
      const tenant = await tenants.provision({
        tenantId: id,
        name: "  Truex  ",
        kind: "default",
      });
      assert.equal(tenant.name, "Truex");
      assert.equal(tenant.dbName, DEFAULT_TENANT_DB_NAME);
      assert.equal(tenant.status, "active");
      assert.equal(tenant.provisioningStatus, "ready");
    });

    test("gives each organization its own database", async () => {
      const a = new ObjectId();
      const b = new ObjectId();
      const ta = await tenants.provision({
        tenantId: a,
        name: "A",
        kind: "organization",
      });
      const tb = await tenants.provision({
        tenantId: b,
        name: "B",
        kind: "organization",
      });
      assert.equal(ta.dbName, organizationDbName(a));
      assert.notEqual(ta.dbName, tb.dbName);
    });

    test("is repeatable and concurrent runs produce one tenant", async () => {
      const id = new ObjectId();
      const input = {
        tenantId: id,
        name: "Org",
        kind: "organization" as const,
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => tenants.provision(input)),
      );
      for (const r of results) assert.equal(r.provisioningStatus, "ready");
      const count = await database
        .catalog()
        .collection("tenants")
        .countDocuments({ _id: id });
      assert.equal(count, 1);
      assert.equal(
        (await tenants.provision(input)).provisioningStatus,
        "ready",
      );
    });

    test("resumes a tenant left pending by an interrupted run", async () => {
      const id = new ObjectId();
      await tenants.ensureIndexes();
      const now = new Date();
      await database
        .catalog()
        .collection("tenants")
        .insertOne({
          _id: id,
          name: "Half done",
          dbName: organizationDbName(id),
          kind: "organization",
          status: "active",
          provisioningStatus: "pending",
          createdAt: now,
          updatedAt: now,
        });
      assert.equal(await tenants.findUsable(id), null);
      const tenant = await tenants.provision({
        tenantId: id,
        name: "Half done",
        kind: "organization",
      });
      assert.equal(tenant.provisioningStatus, "ready");
      assert.ok(await tenants.findUsable(id));
    });

    test("allows only one default tenant", async () => {
      await tenants.provision({
        tenantId: new ObjectId(),
        name: "Default",
        kind: "default",
      });
      await rejectsWith(
        tenants.provision({
          tenantId: new ObjectId(),
          name: "Second",
          kind: "default",
        }),
        "CONFLICT",
      );
    });

    test("refuses to change the kind of an existing tenant", async () => {
      const id = new ObjectId();
      await tenants.provision({
        tenantId: id,
        name: "Org",
        kind: "organization",
      });
      await rejectsWith(
        tenants.provision({ tenantId: id, name: "Org", kind: "default" }),
        "CONFLICT",
      );
    });

    test("refuses to adopt a database that already holds unowned data", async () => {
      const id = new ObjectId();
      await database
        .tenantDb(organizationDbName(id))
        .collection("stray")
        .insertOne({ x: 1 });
      await rejectsWith(
        tenants.provision({ tenantId: id, name: "Org", kind: "organization" }),
        "CONFLICT",
      );
      const tenant = await tenants.findById(id);
      assert.equal(tenant?.provisioningStatus, "failed");
      assert.equal(await tenants.findUsable(id), null);
    });

    test("refuses a database owned by another tenant", async () => {
      const id = new ObjectId();
      await database
        .tenantDb(organizationDbName(id))
        .collection("_owner")
        .insertOne({
          _id: "owner" as never,
          tenantId: new ObjectId(),
          createdAt: new Date(),
        });
      await rejectsWith(
        tenants.provision({ tenantId: id, name: "Org", kind: "organization" }),
        "CONFLICT",
      );
    });

    test("rejects invalid names before writing anything", async () => {
      const id = new ObjectId();
      for (const name of ["", "   ", "a".repeat(101), "bad\u0000name", "x‮y"])
        await rejectsWith(
          tenants.provision({ tenantId: id, name, kind: "organization" }),
          "INVALID_INPUT",
        );
      assert.equal(await tenants.findById(id), null);
    });
  });

  describe("memberships", () => {
    async function readyTenant(): Promise<ObjectId> {
      const id = new ObjectId();
      await tenants.provision({
        tenantId: id,
        name: "T",
        kind: "organization",
      });
      return id;
    }

    test("joining always creates a user membership", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      const m = await memberships.join({
        userId,
        tenantId,
        joinedVia: "signup",
      });
      assert.equal(m.role, "user");
      assert.equal(m.status, "active");
      assert.equal(m.joinedVia, "signup");
    });

    test("caller-supplied role fields cannot escalate a join", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      const forged = {
        userId,
        tenantId,
        joinedVia: "signup",
        role: "admin",
      } as unknown as Parameters<MembershipsService["join"]>[0];
      assert.equal((await memberships.join(forged)).role, "user");
    });

    test("concurrent joins produce exactly one membership", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          memberships.join({ userId, tenantId, joinedVia: "signup" }),
        ),
      );
      const ids = new Set(results.map((m) => m._id.toHexString()));
      assert.equal(ids.size, 1);
    });

    test("joining inside a transaction commits with it", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      await database.withTransaction((session) =>
        memberships.join({ userId, tenantId, joinedVia: "signup" }, session),
      );
      assert.ok(await memberships.findActive(userId, tenantId));
    });

    test("a tenant that is not ready or is disabled cannot be joined", async () => {
      const userId = new ObjectId();
      await rejectsWith(
        memberships.join({
          userId,
          tenantId: new ObjectId(),
          joinedVia: "signup",
        }),
        "NOT_FOUND",
      );
      const tenantId = await readyTenant();
      await database
        .catalog()
        .collection("tenants")
        .updateOne({ _id: tenantId }, { $set: { status: "disabled" } });
      await rejectsWith(
        memberships.join({ userId, tenantId, joinedVia: "signup" }),
        "NOT_FOUND",
      );
    });

    test("a removed membership is not restored by joining again", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      await memberships.join({ userId, tenantId, joinedVia: "signup" });
      await database
        .catalog()
        .collection("memberships")
        .updateOne({ userId, tenantId }, { $set: { status: "removed" } });
      await rejectsWith(
        memberships.join({ userId, tenantId, joinedVia: "signup" }),
        "FORBIDDEN",
      );
      assert.equal(await memberships.findActive(userId, tenantId), null);
    });

    test("the same person has independent roles per tenant", async () => {
      const a = await readyTenant();
      const b = await readyTenant();
      const userId = new ObjectId();
      await memberships.join({ userId, tenantId: a, joinedVia: "signup" });
      await memberships.join({ userId, tenantId: b, joinedVia: "signup" });
      const { previousRole } = await memberships.assignRoleAsOperator(
        userId,
        a,
        "admin",
      );
      assert.equal(previousRole, "user");
      assert.equal((await memberships.findActive(userId, a))?.role, "admin");
      assert.equal((await memberships.findActive(userId, b))?.role, "user");
      const list = await memberships.listActiveForUser(userId);
      assert.deepEqual(
        list.map((m) => [m.tenantId.toHexString(), m.role]),
        [
          [a.toHexString(), "admin"],
          [b.toHexString(), "user"],
        ],
      );
    });

    test("operator assignment rejects invalid roles and removed memberships", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      for (const role of ["owner", "ADMIN", "", null])
        await rejectsWith(
          memberships.assignRoleAsOperator(userId, tenantId, role as never),
          "INVALID_INPUT",
        );
      await memberships.join({ userId, tenantId, joinedVia: "signup" });
      await database
        .catalog()
        .collection("memberships")
        .updateOne({ userId, tenantId }, { $set: { status: "removed" } });
      await rejectsWith(
        memberships.assignRoleAsOperator(userId, tenantId, "admin"),
        "CONFLICT",
      );
    });

    test("operator assignment can create the membership", async () => {
      const tenantId = await readyTenant();
      const userId = new ObjectId();
      const { membership, previousRole } =
        await memberships.assignRoleAsOperator(userId, tenantId, "admin");
      assert.equal(previousRole, null);
      assert.equal(membership.role, "admin");
      assert.equal(membership.joinedVia, "operator");
    });
  });
});

describe("normalizeTenantName", () => {
  test("trims and NFC-normalizes", () => {
    assert.equal(normalizeTenantName("  Café "), "Café");
  });
  test("rejects non-strings", () => {
    for (const v of [undefined, null, 1, {}, ["a"]])
      assert.equal(normalizeTenantName(v), null);
  });
});

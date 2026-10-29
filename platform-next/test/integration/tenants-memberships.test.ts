import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DomainError } from "../../src/common/domain-error";
import { DatabaseService } from "../../src/database/database.service";
import { parseOperatorCommand, UsageError } from "../../src/cli/operator";
import { AGENT_INDEXES } from "../../src/modules/agents/agent";
import { AUDIT_COLLECTION } from "../../src/modules/audit/audit";
import { CHAT_INDEXES } from "../../src/modules/chats/chat";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import {
  DEFAULT_TENANT_DB_NAME,
  normalizeTenantName,
  organizationDbName,
} from "../../src/modules/tenants/tenant";
import { TENANT_INDEX_VERSION } from "../../src/modules/tenants/tenant-indexes";
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

  describe("tenant indexes", () => {
    const expected = { ...CHAT_INDEXES, ...AGENT_INDEXES };

    // Index names per collection of a tenant database, _id_ left out.
    async function indexNames(dbName: string) {
      const db = database.tenantDb(dbName);
      const names: Record<string, string[]> = {};
      for (const collection of Object.keys(expected))
        names[collection] = (await db.collection(collection).indexes())
          .map((index) => String(index.name))
          .filter((name) => name !== "_id_")
          .sort();
      return names;
    }

    const expectedNames = Object.fromEntries(
      Object.entries(expected).map(([collection, indexes]) => [
        collection,
        indexes.map((index) => String(index.name)).sort(),
      ]),
    );

    test("provisioning builds every tenant index before the tenant is ready", async () => {
      const tenant = await tenants.provision({
        tenantId: new ObjectId(),
        name: "Org",
        kind: "organization",
      });
      assert.equal(tenant.provisioningStatus, "ready");
      assert.equal(tenant.indexVersion, TENANT_INDEX_VERSION);
      assert.deepEqual(await indexNames(tenant.dbName), expectedNames);
      assert.equal(await tenants.countStaleIndexes(), 0);
    });

    test("ensure-tenant-indexes brings an older tenant up to date, once", async () => {
      const operator = running.app.get(OperatorService);
      const fresh = await tenants.provision({
        tenantId: new ObjectId(),
        name: "Fresh",
        kind: "organization",
      });
      // Provisioned before indexes were built at provisioning.
      const legacy = await tenants.provision({
        tenantId: new ObjectId(),
        name: "Legacy",
        kind: "default",
      });
      const db = database.tenantDb(legacy.dbName);
      for (const collection of Object.keys(expected))
        await db.collection(collection).dropIndexes();
      await database
        .catalog()
        .collection("tenants")
        .updateOne({ _id: legacy._id }, { $unset: { indexVersion: "" } });
      assert.equal(await tenants.countStaleIndexes(), 1);

      const done = await operator.ensureTenantIndexes({ operator: "ops" });
      assert.deepEqual(
        done.map((t) => [t._id.toHexString(), t.indexVersion]),
        [[legacy._id.toHexString(), TENANT_INDEX_VERSION]],
      );
      assert.deepEqual(await indexNames(legacy.dbName), expectedNames);
      assert.equal(await tenants.countStaleIndexes(), 0);
      assert.equal(
        await database.catalog().collection(AUDIT_COLLECTION).countDocuments({
          action: "tenant.ensure_indexes",
          tenantId: legacy._id,
          result: "success",
        }),
        1,
      );
      // Nothing is behind now; a named tenant can still be rebuilt.
      assert.deepEqual(
        await operator.ensureTenantIndexes({ operator: "ops" }),
        [],
      );
      const again = await operator.ensureTenantIndexes({
        operator: "ops",
        tenantId: fresh._id,
      });
      assert.equal(again[0]?.indexVersion, TENANT_INDEX_VERSION);
    });

    test("never lowers a newer release's version and refuses unprovisioned tenants", async () => {
      const tenant = await tenants.provision({
        tenantId: new ObjectId(),
        name: "Org",
        kind: "organization",
      });
      await database
        .catalog()
        .collection("tenants")
        .updateOne(
          { _id: tenant._id },
          { $set: { indexVersion: TENANT_INDEX_VERSION + 5 } },
        );
      assert.equal(
        (await tenants.ensureIndexesOf(tenant._id)).indexVersion,
        TENANT_INDEX_VERSION + 5,
      );
      await rejectsWith(tenants.ensureIndexesOf(new ObjectId()), "NOT_FOUND");
    });

    test("the command takes one tenant or --all", () => {
      const id = new ObjectId();
      const base = ["ensure-tenant-indexes", "--operator", "ops"];
      assert.deepEqual(
        parseOperatorCommand([...base, "--tenant", id.toHexString()]),
        { command: "ensure-tenant-indexes", operator: "ops", tenantId: id },
      );
      assert.deepEqual(parseOperatorCommand([...base, "--all"]), {
        command: "ensure-tenant-indexes",
        operator: "ops",
      });
      assert.throws(() => parseOperatorCommand(base), UsageError);
      assert.throws(
        () =>
          parseOperatorCommand([
            ...base,
            "--all",
            "--tenant",
            id.toHexString(),
          ]),
        UsageError,
      );
    });
  });

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

  describe("goal settings", () => {
    const valid = {
      presets: [100_000, 300_000, 1_000_000],
      maxTokenBudget: 3_000_000,
      maxActive: 10,
    };
    const goalAudit = (action: string, result: string) =>
      database
        .catalog()
        .collection(AUDIT_COLLECTION)
        .find({ action, result })
        .sort({ at: 1, _id: 1 })
        .toArray();
    const readyTenant = async () =>
      (
        await tenants.provision({
          tenantId: new ObjectId(),
          name: "Org",
          kind: "organization",
        })
      )._id;

    test("an operator sets, replaces and removes a tenant's goal settings, each audited", async () => {
      const operator = running.app.get(OperatorService);
      const tenantId = await readyTenant();
      assert.equal((await tenants.findById(tenantId))?.goals, undefined);

      const set = await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: valid,
      });
      assert.deepEqual(set, { goals: valid, changed: true });
      assert.deepEqual((await tenants.findById(tenantId))?.goals, valid);
      assert.deepEqual(
        (
          await operator.setTenantGoals({
            operator: "ops",
            tenantId,
            goals: valid,
          })
        ).changed,
        false,
      );
      const replaced = { ...valid, maxTokenBudget: 5_000_000, maxActive: 4 };
      await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: replaced,
      });
      assert.deepEqual((await tenants.findById(tenantId))?.goals, replaced);
      const sets = await goalAudit("tenant.goals.set", "success");
      assert.deepEqual(
        sets.map((event) => event.details),
        [
          {
            presets: "100000,300000,1000000",
            maxTokenBudget: 3_000_000,
            maxActive: 10,
            changed: true,
          },
          {
            presets: "100000,300000,1000000",
            maxTokenBudget: 3_000_000,
            maxActive: 10,
            changed: false,
          },
          {
            presets: "100000,300000,1000000",
            maxTokenBudget: 5_000_000,
            maxActive: 4,
            changed: true,
          },
        ],
      );
      assert.ok(sets.every((event) => event.tenantId.equals(tenantId)));

      assert.deepEqual(
        await operator.removeTenantGoals({ operator: "ops", tenantId }),
        { goals: null, changed: true },
      );
      const removed = await tenants.findById(tenantId);
      assert.equal(removed ? "goals" in removed : true, false);
      assert.equal(
        (await operator.removeTenantGoals({ operator: "ops", tenantId }))
          .changed,
        false,
      );
      assert.deepEqual(
        (await goalAudit("tenant.goals.remove", "success")).map(
          (event) => event.details,
        ),
        [{ changed: true }, { changed: false }],
      );
    });

    test("refuses unordered, duplicate, non-integer or out-of-range values and audits each refusal", async () => {
      const operator = running.app.get(OperatorService);
      const tenantId = await readyTenant();
      await operator.setTenantGoals({
        operator: "ops",
        tenantId,
        goals: valid,
      });
      const refused: unknown[] = [
        // Unordered and duplicate presets.
        { ...valid, presets: [300_000, 100_000, 1_000_000] },
        { ...valid, presets: [100_000, 100_000, 1_000_000] },
        // Not three.
        { ...valid, presets: [100_000, 300_000] },
        { ...valid, presets: [1, 2, 3, 4] },
        { ...valid, presets: "100000,300000,1000000" },
        // Not whole numbers.
        { ...valid, presets: [100_000.5, 300_000, 1_000_000] },
        { ...valid, presets: ["100000", 300_000, 1_000_000] },
        { ...valid, maxTokenBudget: Number.NaN },
        { ...valid, maxActive: 2.5 },
        // Out of range: a preset at or above the maximum, zero or negative
        // values, a maximum above the adapter's cap.
        { ...valid, presets: [100_000, 300_000, 3_000_000] },
        { ...valid, presets: [0, 300_000, 1_000_000] },
        { ...valid, presets: [-1, 300_000, 1_000_000] },
        { ...valid, maxTokenBudget: 1_000_000_001 },
        { ...valid, maxActive: 0 },
        { ...valid, maxActive: 10_001 },
        // Missing or unknown fields.
        { presets: valid.presets, maxTokenBudget: valid.maxTokenBudget },
        { ...valid, perUser: 3 },
        null,
      ];
      for (const goals of refused)
        await rejectsWith(
          operator.setTenantGoals({ operator: "ops", tenantId, goals }),
          "INVALID_INPUT",
        );
      assert.deepEqual((await tenants.findById(tenantId))?.goals, valid);
      const denied = await goalAudit("tenant.goals.set", "denied");
      assert.equal(denied.length, refused.length);
      assert.ok(denied.every((event) => event.tenantId.equals(tenantId)));
    });

    test("refuses a tenant that does not exist, audited", async () => {
      const operator = running.app.get(OperatorService);
      const tenantId = new ObjectId();
      await rejectsWith(
        operator.setTenantGoals({ operator: "ops", tenantId, goals: valid }),
        "NOT_FOUND",
      );
      await rejectsWith(
        operator.removeTenantGoals({ operator: "ops", tenantId }),
        "NOT_FOUND",
      );
      assert.equal((await goalAudit("tenant.goals.set", "denied")).length, 1);
      assert.equal(
        (await goalAudit("tenant.goals.remove", "denied")).length,
        1,
      );
    });

    test("the commands parse into set and remove", () => {
      const id = new ObjectId();
      const set = [
        "tenant-goals-set",
        "--operator",
        "ops",
        "--tenant",
        id.toHexString(),
      ];
      const values = [
        "--presets",
        "100000,300000,1000000",
        "--max-budget",
        "3000000",
        "--max-active",
        "10",
      ];
      assert.deepEqual(parseOperatorCommand([...set, ...values]), {
        command: "tenant-goals-set",
        operator: "ops",
        tenantId: id,
        goals: valid,
      });
      // Values are passed on as given; the service decides what is valid,
      // so a refusal is audited.
      assert.deepEqual(
        (
          parseOperatorCommand([
            ...set,
            "--presets",
            "1.5, x",
            "--max-budget",
            "3000000",
            "--max-active",
            "10",
          ]) as { goals: { presets: number[] } }
        ).goals.presets,
        [1.5, Number.NaN],
      );
      assert.throws(() => parseOperatorCommand(set), UsageError);
      assert.throws(
        () => parseOperatorCommand([...set, ...values.slice(0, 4)]),
        UsageError,
      );
      assert.deepEqual(
        parseOperatorCommand([
          "tenant-goals-remove",
          "--operator",
          "ops",
          "--tenant",
          id.toHexString(),
        ]),
        { command: "tenant-goals-remove", operator: "ops", tenantId: id },
      );
      assert.throws(
        () =>
          parseOperatorCommand(["tenant-goals-remove", "--operator", "ops"]),
        UsageError,
      );
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

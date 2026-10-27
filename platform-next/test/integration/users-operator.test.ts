import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { parseOperatorCommand, UsageError } from "../../src/cli/operator";
import { DomainError } from "../../src/common/domain-error";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import type { VerifiedIdentity } from "../../src/modules/users/user";
import { UsersService } from "../../src/modules/users/users.service";
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

// Synthetic identities only; no real Google accounts.
function google(
  subject: string,
  overrides: Partial<VerifiedIdentity> = {},
): VerifiedIdentity {
  return {
    provider: "google",
    subject,
    email: `${subject}@example.test`,
    emailVerified: true,
    name: `User ${subject}`,
    ...overrides,
  };
}

describe("users and operator commands", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let users: UsersService;
  let memberships: MembershipsService;
  let operator: OperatorService;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
    database = running.app.get(DatabaseService);
    users = running.app.get(UsersService);
    memberships = running.app.get(MembershipsService);
    operator = running.app.get(OperatorService);
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  beforeEach(() => resetOwnedData(database));

  function auditEvents(): Promise<AuditDoc[]> {
    return database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({})
      .sort({ at: 1, _id: 1 })
      .toArray();
  }

  async function readyTenant(): Promise<ObjectId> {
    const tenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Org",
      kind: "organization",
    });
    return tenantId;
  }

  describe("users", () => {
    test("first sign-in creates an active account with no tenant role", async () => {
      const { user, created } = await users.findOrCreateFromIdentity(
        google("a1", { email: "  Alice@Example.TEST " }),
      );
      assert.equal(created, true);
      assert.equal(user.status, "active");
      assert.equal(user.email, "Alice@Example.TEST");
      assert.equal(user.emailKey, "alice@example.test");
      assert.deepEqual(user.identities, [
        { provider: "google", subject: "a1" },
      ]);
      assert.equal("role" in user, false);
    });

    test("the same identity returns the same account", async () => {
      const first = await users.findOrCreateFromIdentity(google("a1"));
      const again = await users.findOrCreateFromIdentity(google("a1"));
      assert.equal(again.created, false);
      assert.ok(again.user._id.equals(first.user._id));
    });

    test("concurrent first sign-ins create exactly one account", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          users.findOrCreateFromIdentity(google("race")),
        ),
      );
      assert.equal(
        new Set(results.map((r) => r.user._id.toHexString())).size,
        1,
      );
      assert.equal(results.filter((r) => r.created).length, 1);
    });

    test("a different identity with a used email is rejected, not linked", async () => {
      await users.findOrCreateFromIdentity(
        google("a1", { email: "x@example.test" }),
      );
      await rejectsWith(
        users.findOrCreateFromIdentity(
          google("a2", { email: "X@EXAMPLE.test" }),
        ),
        "CONFLICT",
      );
      const count = await database
        .catalog()
        .collection("users")
        .countDocuments();
      assert.equal(count, 1);
    });

    test("an unverified email or malformed identity is refused", async () => {
      await rejectsWith(
        users.findOrCreateFromIdentity(google("a1", { emailVerified: false })),
        "FORBIDDEN",
      );
      for (const bad of [
        google("", {}),
        google("has space"),
        google("a1", { email: "not-an-email" }),
        google("a1", { provider: "github" as never }),
      ])
        await rejectsWith(users.findOrCreateFromIdentity(bad), "INVALID_INPUT");
    });

    test("unsafe names and non-https pictures are cleaned", async () => {
      const { user } = await users.findOrCreateFromIdentity(
        google("a1", {
          email: "pat@example.test",
          name: "x‮y",
          picture: "http://example.test/p.png",
        }),
      );
      assert.equal(user.name, "pat");
      assert.equal(user.picture, undefined);
    });

    test("a disabled account cannot sign in", async () => {
      const { user } = await users.findOrCreateFromIdentity(google("a1"));
      await database
        .catalog()
        .collection("users")
        .updateOne({ _id: user._id }, { $set: { status: "disabled" } });
      await rejectsWith(
        users.findOrCreateFromIdentity(google("a1")),
        "FORBIDDEN",
      );
    });
  });

  describe("assign-role", () => {
    test("grants admin to an existing account in one exact tenant, audited", async () => {
      const a = await readyTenant();
      const b = await readyTenant();
      const { user } = await users.findOrCreateFromIdentity(google("a1"));
      await memberships.join({
        userId: user._id,
        tenantId: b,
        joinedVia: "signup",
      });

      const result = await operator.assignRole({
        operator: "ops",
        user: user.email,
        tenantId: a,
        role: "admin",
      });
      assert.equal(result.membership.role, "admin");
      assert.equal(result.previousRole, null);
      assert.equal((await memberships.findActive(user._id, b))?.role, "user");

      const events = await auditEvents();
      const grant = events.find((e) => e.action === "membership.assign_role");
      assert.equal(grant?.result, "success");
      assert.deepEqual(grant?.actor, { kind: "operator", name: "ops" });
      assert.ok(grant?.tenantId?.equals(a));
      assert.ok(grant?.targetUserId?.equals(user._id));
      assert.deepEqual(grant?.details, { role: "admin", previousRole: null });
    });

    test("is repeatable: a second run changes nothing and is audited again", async () => {
      const tenantId = await readyTenant();
      const { user } = await users.findOrCreateFromIdentity(google("a1"));
      const command = {
        operator: "ops",
        user: user._id.toHexString(),
        tenantId,
        role: "admin" as const,
      };
      await operator.assignRole(command);
      const again = await operator.assignRole(command);
      assert.equal(again.previousRole, "admin");
      const grants = (await auditEvents()).filter(
        (e) => e.action === "membership.assign_role",
      );
      assert.equal(grants.length, 2);
    });

    test("signup alone never makes anyone admin, including the first user", async () => {
      const tenantId = await readyTenant();
      const { user } = await users.findOrCreateFromIdentity(google("first"));
      const m = await memberships.join({
        userId: user._id,
        tenantId,
        joinedVia: "signup",
      });
      assert.equal(m.role, "user");
    });

    test("refusals are audited as denied and change nothing", async () => {
      const tenantId = await readyTenant();
      const { user } = await users.findOrCreateFromIdentity(google("a1"));

      await rejectsWith(
        operator.assignRole({
          operator: "ops",
          user: "nobody@example.test",
          tenantId,
          role: "admin",
        }),
        "NOT_FOUND",
      );
      await rejectsWith(
        operator.assignRole({
          operator: "ops",
          user: user.email,
          tenantId,
          role: "owner" as never,
        }),
        "INVALID_INPUT",
      );
      await rejectsWith(
        operator.assignRole({
          operator: "ops",
          user: user.email,
          tenantId: new ObjectId(),
          role: "admin",
        }),
        "NOT_FOUND",
      );

      assert.equal(await memberships.find(user._id, tenantId), null);
      const denied = (await auditEvents()).filter(
        (e) => e.action === "membership.assign_role",
      );
      assert.equal(denied.length, 3);
      for (const e of denied) assert.equal(e.result, "denied");
    });

    test("a disabled account cannot be granted a role", async () => {
      const tenantId = await readyTenant();
      const { user } = await users.findOrCreateFromIdentity(google("a1"));
      await database
        .catalog()
        .collection("users")
        .updateOne({ _id: user._id }, { $set: { status: "disabled" } });
      await rejectsWith(
        operator.assignRole({
          operator: "ops",
          user: user.email,
          tenantId,
          role: "admin",
        }),
        "FORBIDDEN",
      );
    });

    test("an unsafe operator name is refused before anything runs", async () => {
      const tenantId = await readyTenant();
      await rejectsWith(
        operator.assignRole({
          operator: "ops; drop",
          user: "a@example.test",
          tenantId,
          role: "admin",
        }),
        "INVALID_INPUT",
      );
    });
  });

  test("tenant provisioning is audited", async () => {
    const tenantId = await readyTenant();
    const [event] = await auditEvents();
    assert.equal(event?.action, "tenant.provision");
    assert.equal(event?.result, "success");
    assert.ok(event?.tenantId?.equals(tenantId));
  });
});

describe("parseOperatorCommand", () => {
  const tenant = "65f1a2b3c4d5e6f7a8b9c0d1";

  test("parses assign-role", () => {
    const command = parseOperatorCommand([
      "assign-role",
      "--operator",
      "ops",
      "--user",
      "a@example.test",
      "--tenant",
      tenant,
      "--role",
      "admin",
    ]);
    assert.equal(command.command, "assign-role");
    assert.equal(command.tenantId.toHexString(), tenant);
  });

  test("parses provision-tenant", () => {
    const command = parseOperatorCommand([
      "provision-tenant",
      "--operator=ops",
      `--tenant=${tenant}`,
      "--name=Truex",
      "--kind=default",
    ]);
    assert.equal(command.command, "provision-tenant");
  });

  for (const [label, argv] of [
    ["no command", ["--operator", "ops"]],
    ["unknown command", ["grant-everything", "--operator", "ops"]],
    ["unknown flag", ["assign-role", "--superuser"]],
    [
      "missing operator",
      ["assign-role", "--user", "a", "--tenant", tenant, "--role", "admin"],
    ],
    [
      "bad role",
      [
        "assign-role",
        "--operator",
        "ops",
        "--user",
        "a",
        "--tenant",
        tenant,
        "--role",
        "owner",
      ],
    ],
    [
      "uppercase tenant ID",
      [
        "assign-role",
        "--operator",
        "ops",
        "--user",
        "a",
        "--tenant",
        tenant.toUpperCase(),
        "--role",
        "admin",
      ],
    ],
    [
      "bad kind",
      [
        "provision-tenant",
        "--operator",
        "ops",
        "--tenant",
        tenant,
        "--name",
        "x",
        "--kind",
        "personal",
      ],
    ],
  ] as const)
    test(`rejects ${label}`, () => {
      assert.throws(() => parseOperatorCommand(argv), UsageError);
    });
});

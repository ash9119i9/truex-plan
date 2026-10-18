import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DatabaseService } from "../../src/database/database.service";
import {
  AGENTS_COLLECTION,
  MAX_AGENTS_PER_USER,
  MAX_TENANT_AGENTS,
  type AgentDoc,
} from "../../src/modules/agents/agent";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { MEMBERSHIPS_COLLECTION } from "../../src/modules/memberships/membership";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { DEFAULT_TENANT_DB_NAME } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import {
  builtinDefinition,
  geminiDefinition,
  modelDefinition,
} from "../support/catalog-fixtures";
import { resetOwnedData } from "../support/reset";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

interface Member {
  userId: ObjectId;
  token: string;
  tenantId: ObjectId;
}

interface AgentBody {
  id: string;
  source: string;
  name: string;
  description: string;
  look: number;
  tint: string;
  model: { id: string; displayName: string; shortLabel: string } | null;
  available: boolean;
  revision: number;
  createdByMe: boolean;
  status: string;
  canEdit: boolean;
  canArchive: boolean;
  canPromote: boolean;
}

interface ErrorBody {
  error: { code: string; message: string };
  requestId: string;
}

describe("agents and models API", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let users: UsersService;
  let memberships: MembershipsService;
  let sessions: SessionsService;
  let operator: OperatorService;
  let defaultTenantId: ObjectId;
  let orgTenantId: ObjectId;
  let claudeId: string;
  let geminiId: string;
  let alice: Member;
  let bob: Member;
  let carol: Member; // admin in the default tenant
  let dave: Member; // member of another tenant only
  let nextRequest = 0;

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
    defaultTenantId = new ObjectId();
    orgTenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId: defaultTenantId,
      name: "Truex",
      kind: "default",
    });
    await operator.provisionTenant({
      operator: "ops",
      tenantId: orgTenantId,
      name: "Acme",
      kind: "organization",
    });
    claudeId = (
      await operator.putModel({
        operator: "ops",
        definition: modelDefinition(),
      })
    ).model.id;
    geminiId = (
      await operator.putModel({
        operator: "ops",
        definition: geminiDefinition(),
      })
    ).model.id;
    await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition(),
    });
    alice = await member("alice", defaultTenantId);
    bob = await member("bob", defaultTenantId);
    carol = await member("carol", defaultTenantId);
    await operator.assignRole({
      operator: "ops",
      user: carol.userId.toHexString(),
      tenantId: defaultTenantId,
      role: "admin",
    });
    dave = await member("dave", orgTenantId);
  });

  async function member(subject: string, tenantId: ObjectId): Promise<Member> {
    const { user } = await users.findOrCreateFromIdentity({
      provider: "google",
      subject,
      email: `${subject}@example.test`,
      emailVerified: true,
      name: subject,
    });
    await memberships.join({ userId: user._id, tenantId, joinedVia: "signup" });
    const issued = await sessions.create(user._id);
    return { userId: user._id, token: issued.accessToken, tenantId };
  }

  function call(
    who: Member | null,
    method: string,
    path: string,
    body?: unknown,
    tenantId: ObjectId | null = who?.tenantId ?? defaultTenantId,
  ): Promise<Response> {
    const query = tenantId ? `?tenantId=${tenantId.toHexString()}` : "";
    return fetch(`${running.baseUrl}/api/v1${path}${query}`, {
      method,
      headers: {
        ...(who ? { authorization: `Bearer ${who.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function ok<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text();
    assert.equal(res.status, status, text);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return JSON.parse(text) as T;
  }

  async function fails(
    res: Response,
    status: number,
    code: string,
  ): Promise<ErrorBody> {
    const text = await res.text();
    assert.equal(res.status, status, text);
    const body = JSON.parse(text) as ErrorBody;
    assert.equal(body.error.code, code, text);
    assert.ok(body.requestId);
    return body;
  }

  function createBody(overrides: Record<string, unknown> = {}) {
    return {
      clientRequestId: `req-${++nextRequest}-${Date.now()}`,
      scope: "personal",
      name: "Research Scout",
      description: "Finds and summarizes sources.",
      modelId: claudeId,
      look: 4,
      tint: "mint",
      ...overrides,
    };
  }

  async function create(
    who: Member,
    overrides: Record<string, unknown> = {},
  ): Promise<AgentBody> {
    const { agent } = await ok<{ agent: AgentBody }>(
      await call(who, "POST", "/agents", createBody(overrides)),
      201,
    );
    return agent;
  }

  async function list(who: Member): Promise<AgentBody[]> {
    return (
      await ok<{ agents: AgentBody[] }>(await call(who, "GET", "/agents"))
    ).agents;
  }

  const agentsIn = (dbName: string) =>
    database.tenantDb(dbName).collection<AgentDoc>(AGENTS_COLLECTION);

  const audit = (action: string) =>
    database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({ action })
      .toArray();

  // Inserts agents directly, to reach a limit without many requests.
  async function seed(
    count: number,
    ownerId: ObjectId,
    scope: "personal" | "tenant",
  ) {
    if (count === 0) return;
    const now = new Date();
    await agentsIn(DEFAULT_TENANT_DB_NAME).insertMany(
      Array.from({ length: count }, (_, i) => ({
        _id: new ObjectId(),
        scope,
        ownerId,
        name: `Seeded ${i}`,
        description: "Seeded.",
        modelId: new ObjectId(claudeId),
        look: 0,
        tint: "ice" as const,
        status: "active" as const,
        revision: 1,
        clientRequestId: `seed-${scope}-${ownerId.toHexString()}-${i}`,
        requestHash: "seed",
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  describe("models", () => {
    test("lists enabled models with display fields only", async () => {
      const { models } = await ok<{ models: Record<string, unknown>[] }>(
        await call(alice, "GET", "/models"),
      );
      assert.deepEqual(
        models.map((m) => m.displayName),
        ["Claude Sonnet 4.5", "Gemini 2.5 Pro"],
      );
      for (const model of models)
        assert.deepEqual(Object.keys(model).sort(), [
          "displayName",
          "family",
          "id",
          "shortLabel",
        ]);
      await operator.setModelEnabled({
        operator: "ops",
        slug: "gemini-pro",
        enabled: false,
      });
      const after = await ok<{ models: { id: string }[] }>(
        await call(alice, "GET", "/models"),
      );
      assert.deepEqual(
        after.models.map((m) => m.id),
        [claudeId],
      );
    });

    test("needs a signed-in member of the tenant", async () => {
      await fails(await call(null, "GET", "/models"), 401, "UNAUTHENTICATED");
      await fails(
        await call(alice, "GET", "/models", undefined, null),
        400,
        "BAD_REQUEST",
      );
      await fails(
        await call(alice, "GET", "/models", undefined, orgTenantId),
        403,
        "FORBIDDEN",
      );
    });
  });

  describe("listing", () => {
    test("built-ins come first, read-only, without their instructions", async () => {
      const res = await call(alice, "GET", "/agents");
      const text = await res.clone().text();
      assert.doesNotMatch(
        text,
        /instructions|helpful assistant|secretsmanager/,
      );
      const [general] = await list(alice);
      assert.equal(general?.source, "builtin");
      assert.equal(general?.name, "General Agent");
      assert.equal(general?.available, true);
      assert.equal(general?.model?.id, claudeId);
      assert.equal(general?.canEdit, false);
      assert.equal(general?.canArchive, false);
    });

    test("members see their personal agents and every tenant agent", async () => {
      const mine = await create(alice, { name: "Alice private" });
      const shared = await create(alice, {
        name: "Alice shared",
        scope: "tenant",
      });
      const bobs = await create(bob, { name: "Bob private" });

      const forAlice = (await list(alice)).map((a) => a.id);
      assert.deepEqual(forAlice.slice(1), [mine.id, shared.id]);
      const forBob = await list(bob);
      assert.deepEqual(
        forBob.slice(1).map((a) => a.id),
        [bobs.id, shared.id],
      );
      const sharedForBob = forBob.find((a) => a.id === shared.id)!;
      assert.equal(sharedForBob.createdByMe, false);
      assert.equal(sharedForBob.canEdit, false);
      assert.equal(sharedForBob.canArchive, false);
      assert.equal(sharedForBob.canPromote, false);
      const sharedForCarol = (await list(carol)).find(
        (a) => a.id === shared.id,
      )!;
      assert.equal(sharedForCarol.canArchive, true);
      assert.equal(sharedForCarol.canEdit, false);
    });

    test("another tenant's agents are never visible", async () => {
      const shared = await create(alice, { scope: "tenant" });
      const forDave = await list(dave);
      assert.equal(
        forDave.some((a) => a.id === shared.id),
        false,
      );
      await fails(
        await call(dave, "POST", `/agents/${shared.id}/archive`),
        404,
        "NOT_FOUND",
      );
    });

    test("an agent whose model is disabled shows as unavailable", async () => {
      const agent = await create(alice, { modelId: geminiId });
      await operator.setModelEnabled({
        operator: "ops",
        slug: "gemini-pro",
        enabled: false,
      });
      const listed = (await list(alice)).find((a) => a.id === agent.id)!;
      assert.equal(listed.available, false);
      assert.equal(listed.model, null);
    });

    test("a built-in whose model is disabled shows as unavailable", async () => {
      await operator.setModelEnabled({
        operator: "ops",
        slug: "claude-sonnet",
        enabled: false,
      });
      const [general] = await list(alice);
      assert.equal(general?.available, false);
    });
  });

  describe("creating", () => {
    test("creates a personal agent owned by the caller", async () => {
      const agent = await create(alice);
      assert.equal(agent.source, "personal");
      assert.equal(agent.name, "Research Scout");
      assert.equal(agent.look, 4);
      assert.equal(agent.tint, "mint");
      assert.equal(agent.revision, 1);
      assert.equal(agent.createdByMe, true);
      assert.equal(agent.model?.shortLabel, "sonnet 4.5");
      assert.deepEqual(
        [agent.canEdit, agent.canArchive, agent.canPromote],
        [true, true, true],
      );
      const stored = await agentsIn(DEFAULT_TENANT_DB_NAME).findOne({
        _id: new ObjectId(agent.id),
      });
      assert.ok(stored?.ownerId.equals(alice.userId));
      const [event] = await audit("agent.create");
      assert.equal(event?.details?.agentId, agent.id);
      assert.ok(event?.tenantId?.equals(defaultTenantId));
    });

    test("a retried create returns the same agent; a reused ID with other content is refused", async () => {
      const body = createBody();
      const first = await ok<{ agent: AgentBody }>(
        await call(alice, "POST", "/agents", body),
        201,
      );
      const again = await ok<{ agent: AgentBody }>(
        await call(alice, "POST", "/agents", body),
        200,
      );
      assert.equal(again.agent.id, first.agent.id);
      await fails(
        await call(alice, "POST", "/agents", { ...body, name: "Other" }),
        409,
        "CONFLICT",
      );
      // The same ID from another person is a different request.
      await ok(await call(bob, "POST", "/agents", body), 201);
      assert.equal(
        await agentsIn(DEFAULT_TENANT_DB_NAME).countDocuments({}),
        2,
      );
      assert.equal((await audit("agent.create")).length, 2);
    });

    test("simultaneous retries of one create make one agent", async () => {
      const body = createBody();
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => call(alice, "POST", "/agents", body)),
      );
      const ids = new Set<string>();
      for (const res of responses) {
        assert.ok(res.status === 200 || res.status === 201, String(res.status));
        ids.add(((await res.json()) as { agent: AgentBody }).agent.id);
      }
      assert.equal(ids.size, 1);
      assert.equal(
        await agentsIn(DEFAULT_TENANT_DB_NAME).countDocuments({}),
        1,
      );
    });

    test("refuses invalid bodies with an explanation", async () => {
      const bad = await fails(
        await call(alice, "POST", "/agents", createBody({ name: "" })),
        400,
        "BAD_REQUEST",
      );
      assert.match(bad.error.message, /name/);
      await fails(
        await call(alice, "POST", "/agents", createBody({ instructions: "x" })),
        400,
        "BAD_REQUEST",
      );
      await fails(
        await call(alice, "POST", "/agents", createBody({ scope: "global" })),
        400,
        "BAD_REQUEST",
      );
    });

    test("needs an enabled model", async () => {
      await operator.setModelEnabled({
        operator: "ops",
        slug: "gemini-pro",
        enabled: false,
      });
      await fails(
        await call(alice, "POST", "/agents", createBody({ modelId: geminiId })),
        422,
        "MODEL_UNAVAILABLE",
      );
      await fails(
        await call(
          alice,
          "POST",
          "/agents",
          createBody({ modelId: new ObjectId().toHexString() }),
        ),
        422,
        "MODEL_UNAVAILABLE",
      );
    });

    test(`allows ${MAX_AGENTS_PER_USER} agents per person, even under concurrent creates`, async () => {
      await seed(MAX_AGENTS_PER_USER - 2, alice.userId, "personal");
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          call(alice, "POST", "/agents", createBody()),
        ),
      );
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 201, 409, 409, 409, 409]);
      const refused = responses.find((r) => r.status === 409)!;
      await fails(refused, 409, "LIMIT_REACHED");
      assert.equal(
        await agentsIn(DEFAULT_TENANT_DB_NAME).countDocuments({
          ownerId: alice.userId,
          status: "active",
        }),
        MAX_AGENTS_PER_USER,
      );
      // Archiving frees a place.
      const one = (await list(alice))[1]!;
      await ok(await call(alice, "POST", `/agents/${one.id}/archive`));
      await create(alice);
    });

    test(`allows ${MAX_TENANT_AGENTS} tenant agents per tenant, even under concurrent creates`, async () => {
      // Spread over owners so no one person hits their own limit.
      const owners = Array.from({ length: 4 }, () => new ObjectId());
      for (const [i, owner] of owners.entries())
        await seed(
          i < 3 ? 49 : MAX_TENANT_AGENTS - 2 - 3 * 49,
          owner,
          "tenant",
        );
      const responses = await Promise.all(
        [alice, bob, carol, alice, bob, carol].map((who) =>
          call(who, "POST", "/agents", createBody({ scope: "tenant" })),
        ),
      );
      assert.deepEqual(
        responses.map((r) => r.status).sort(),
        [201, 201, 409, 409, 409, 409],
      );
      assert.equal(
        await agentsIn(DEFAULT_TENANT_DB_NAME).countDocuments({
          scope: "tenant",
          status: "active",
        }),
        MAX_TENANT_AGENTS,
      );
      // Personal agents do not count against the tenant limit.
      await create(alice);
    });
  });

  describe("editing", () => {
    test("the creator edits with the current revision", async () => {
      const agent = await create(alice);
      const { agent: edited } = await ok<{ agent: AgentBody }>(
        await call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 1,
          name: "Research Lead",
          modelId: geminiId,
        }),
      );
      assert.equal(edited.name, "Research Lead");
      assert.equal(edited.model?.id, geminiId);
      assert.equal(edited.revision, 2);
      const [event] = await audit("agent.update");
      assert.equal(event?.details?.fields, "modelId,name");
    });

    test("an out-of-date revision is refused, so two tabs cannot overwrite each other", async () => {
      const agent = await create(alice);
      const [first, second] = await Promise.all([
        call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 1,
          name: "Tab one",
        }),
        call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 1,
          name: "Tab two",
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [200, 409]);
      const loser = first.status === 409 ? first : second;
      await fails(loser, 409, "STALE_REVISION");
      const stored = await agentsIn(DEFAULT_TENANT_DB_NAME).findOne({
        _id: new ObjectId(agent.id),
      });
      assert.equal(stored?.revision, 2);
    });

    test("an edit that changes nothing keeps the revision", async () => {
      const agent = await create(alice);
      const { agent: same } = await ok<{ agent: AgentBody }>(
        await call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 1,
          name: agent.name,
        }),
      );
      assert.equal(same.revision, 1);
      assert.equal((await audit("agent.update")).length, 0);
    });

    test("only the creator edits, even a tenant agent and even an admin", async () => {
      const shared = await create(alice, { scope: "tenant" });
      for (const who of [bob, carol])
        await fails(
          await call(who, "PATCH", `/agents/${shared.id}`, {
            revision: 1,
            name: "Taken over",
          }),
          403,
          "FORBIDDEN",
        );
    });

    test("switching to a disabled model is refused", async () => {
      const agent = await create(alice);
      await operator.setModelEnabled({
        operator: "ops",
        slug: "gemini-pro",
        enabled: false,
      });
      await fails(
        await call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 1,
          modelId: geminiId,
        }),
        422,
        "MODEL_UNAVAILABLE",
      );
    });

    test("an archived agent cannot be edited", async () => {
      const agent = await create(alice);
      await ok(await call(alice, "POST", `/agents/${agent.id}/archive`));
      await fails(
        await call(alice, "PATCH", `/agents/${agent.id}`, {
          revision: 2,
          name: "Back",
        }),
        409,
        "CONFLICT",
      );
    });
  });

  describe("sharing (promote)", () => {
    test("the creator shares a personal agent with the tenant", async () => {
      const agent = await create(alice);
      const { agent: shared } = await ok<{ agent: AgentBody }>(
        await call(alice, "POST", `/agents/${agent.id}/promote`),
      );
      assert.equal(shared.source, "tenant");
      assert.equal(shared.revision, 2);
      assert.equal(shared.canPromote, false);
      assert.ok((await list(bob)).some((a) => a.id === agent.id));
      // Repeating it is safe.
      const again = await ok<{ agent: AgentBody }>(
        await call(alice, "POST", `/agents/${agent.id}/promote`),
      );
      assert.equal(again.agent.revision, 2);
      assert.equal((await audit("agent.promote")).length, 1);
    });

    test("nobody else can share it", async () => {
      const agent = await create(alice);
      await fails(
        await call(bob, "POST", `/agents/${agent.id}/promote`),
        404,
        "NOT_FOUND",
      );
      const shared = await create(alice, { scope: "tenant" });
      await fails(
        await call(carol, "POST", `/agents/${shared.id}/promote`),
        403,
        "FORBIDDEN",
      );
    });

    test("sharing counts against the tenant limit", async () => {
      await seed(49, new ObjectId(), "tenant");
      await seed(49, new ObjectId(), "tenant");
      await seed(49, new ObjectId(), "tenant");
      await seed(MAX_TENANT_AGENTS - 147, new ObjectId(), "tenant");
      const agent = await create(alice);
      await fails(
        await call(alice, "POST", `/agents/${agent.id}/promote`),
        409,
        "LIMIT_REACHED",
      );
    });
  });

  describe("archiving", () => {
    test("the creator archives; it leaves every list and repeating is safe", async () => {
      const agent = await create(alice, { scope: "tenant" });
      const { agent: archived } = await ok<{ agent: AgentBody }>(
        await call(alice, "POST", `/agents/${agent.id}/archive`),
      );
      assert.equal(archived.status, "archived");
      assert.equal(archived.available, false);
      assert.equal(archived.canEdit, false);
      assert.equal(
        (await list(alice)).some((a) => a.id === agent.id),
        false,
      );
      assert.equal(
        (await list(bob)).some((a) => a.id === agent.id),
        false,
      );
      await ok(await call(alice, "POST", `/agents/${agent.id}/archive`));
      assert.equal((await audit("agent.archive")).length, 1);
    });

    test("a tenant admin archives a tenant agent but not a personal one", async () => {
      const shared = await create(alice, { scope: "tenant" });
      await ok(await call(carol, "POST", `/agents/${shared.id}/archive`));
      const [event] = await audit("agent.archive");
      assert.ok(event?.targetUserId?.equals(alice.userId));
      const personal = await create(alice);
      await fails(
        await call(carol, "POST", `/agents/${personal.id}/archive`),
        404,
        "NOT_FOUND",
      );
    });

    // Tenant tokens carry the role for up to their lifetime; an admin-only
    // write reads it now.
    test("an admin demoted after their token was issued cannot archive", async () => {
      const shared = await create(alice, { scope: "tenant" });
      const user = await users.findById(carol.userId);
      const fresh = await sessions.create(user!._id);
      const issued = await sessions.refresh(
        fresh.refreshCredential,
        new Date(),
        defaultTenantId,
      );
      assert.equal(issued.tenant?.role, "admin");
      await operator.assignRole({
        operator: "ops",
        user: carol.userId.toHexString(),
        tenantId: defaultTenantId,
        role: "user",
      });
      const stale = { ...carol, token: issued.accessToken };
      await fails(
        await call(stale, "POST", `/agents/${shared.id}/archive`),
        403,
        "FORBIDDEN",
      );
      // The same token, re-promoted, archives again.
      await operator.assignRole({
        operator: "ops",
        user: carol.userId.toHexString(),
        tenantId: defaultTenantId,
        role: "admin",
      });
      await ok(await call(stale, "POST", `/agents/${shared.id}/archive`));
    });

    test("an ordinary member cannot archive someone else's tenant agent", async () => {
      const shared = await create(alice, { scope: "tenant" });
      await fails(
        await call(bob, "POST", `/agents/${shared.id}/archive`),
        403,
        "FORBIDDEN",
      );
    });
  });

  describe("isolation", () => {
    test("another person's personal agent, a missing ID and a malformed ID look the same", async () => {
      const agent = await create(alice);
      const answers = [];
      for (const id of [agent.id, new ObjectId().toHexString(), "not-an-id"])
        for (const [method, path, body] of [
          ["PATCH", `/agents/${id}`, { revision: 1, name: "X" }],
          ["POST", `/agents/${id}/archive`, undefined],
          ["POST", `/agents/${id}/promote`, undefined],
        ] as const) {
          const res = await call(bob, method, path, body);
          answers.push((await fails(res, 404, "NOT_FOUND")).error.message);
        }
      assert.equal(new Set(answers).size, 1);
      const stored = await agentsIn(DEFAULT_TENANT_DB_NAME).findOne({
        _id: new ObjectId(agent.id),
      });
      assert.equal(stored?.name, "Research Scout");
      assert.equal(stored?.status, "active");
    });

    test("a removed member loses access immediately", async () => {
      await database
        .catalog()
        .collection(MEMBERSHIPS_COLLECTION)
        .updateOne(
          { userId: bob.userId, tenantId: defaultTenantId },
          { $set: { status: "removed" } },
        );
      await fails(await call(bob, "GET", "/agents"), 403, "FORBIDDEN");
      await fails(
        await call(bob, "POST", "/agents", createBody()),
        403,
        "FORBIDDEN",
      );
    });

    test("agents are stored in the caller's tenant database", async () => {
      const mine = await create(dave);
      const org = await operator.listModels().then(() =>
        database
          .tenantDb(`truex_next_t_${orgTenantId.toHexString()}`)
          .collection<AgentDoc>(AGENTS_COLLECTION)
          .findOne({ _id: new ObjectId(mine.id) }),
      );
      assert.ok(org);
      assert.equal(
        await agentsIn(DEFAULT_TENANT_DB_NAME).countDocuments({
          _id: new ObjectId(mine.id),
        }),
        0,
      );
    });
  });
});

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { MemoryFileStore } from "../../src/modules/chats/chat-files";
import { CHATS_COLLECTION, type ChatDoc } from "../../src/modules/chats/chat";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { DEFAULT_TENANT_DB_NAME } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import { modelDefinition } from "../support/catalog-fixtures";
import {
  ADAPTER_TOKEN,
  AdapterProcess,
  FakeGateway,
  GATEWAY_SECRET,
  readStream,
  type StreamEvent,
} from "../support/chat-stack";
import { resetOwnedData } from "../support/reset";
import { testAuthConfig } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

// Skills end to end: operator publish → agent skillIds → chat snapshot →
// archive pushed to the real runtime adapter → the pinned Codex lists the
// skill and reads it → "Used skill" saved on the chat.

describe("skills chat: platform-next → adapter → pinned Codex", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;
  let database: DatabaseService;
  let operator: OperatorService;
  const gateway = new FakeGateway();
  const adapter = new AdapterProcess();
  const store = new MemoryFileStore();
  const root = mkdtempSync(join(tmpdir(), "chat-skills-"));
  let tenantId: ObjectId;
  let modelId: string;
  let member: { userId: ObjectId; token: string };
  let next = 0;

  before(async () => {
    mongo = await startReplicaSet();
    await gateway.start();
    await adapter.start();
    running = await startApp({
      mongodbUri: mongo.getUri(),
      auth: testAuthConfig(),
      chat: {
        adapterUrl: adapter.url,
        adapterToken: ADAPTER_TOKEN,
        gatewayUrl: gateway.url,
        gatewaySecret: GATEWAY_SECRET,
        recoverySweepMs: 0,
      },
      files: { bucket: "test-bucket", region: "us-east-1", prefix: "", store },
    } as Partial<AppConfig> as AppConfig);
    database = running.app.get(DatabaseService);
    operator = running.app.get(OperatorService);
  });

  after(async () => {
    await running?.close();
    await adapter.close();
    await gateway.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    gateway.script.length = 0;
    gateway.requests.length = 0;
    await resetOwnedData(database);
    tenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Truex",
      kind: "default",
    });
    modelId = (
      await operator.putModel({
        operator: "ops",
        definition: modelDefinition(),
      })
    ).model.id;
    const { user } = await running.app
      .get(UsersService)
      .findOrCreateFromIdentity({
        provider: "google",
        subject: "skilled",
        email: "skilled@example.test",
        emailVerified: true,
        name: "Skilled",
      });
    await running.app
      .get(MembershipsService)
      .join({ userId: user._id, tenantId, joinedVia: "signup" });
    const sessions = running.app.get(SessionsService);
    const created = await sessions.create(user._id);
    const issued = await sessions.refresh(
      created.refreshCredential,
      new Date(),
      tenantId,
    );
    member = { userId: user._id, token: issued.accessToken };
  });

  function call(method: string, path: string, body?: unknown) {
    return fetch(
      `${running.baseUrl}/api/v1${path}${path.includes("?") ? "&" : "?"}tenantId=${tenantId.toHexString()}`,
      {
        method,
        headers: {
          authorization: `Bearer ${member.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }

  async function publish(body: string) {
    const folder = join(root, "po-check");
    mkdirSync(join(folder, "references"), { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: po-check\ntitle: PO check\ndescription: Checks purchase orders against policy SKILLDESC.\n---\n${body}\n`,
    );
    writeFileSync(join(folder, "references", "rules.md"), "Rule PO-7.");
    return (
      await operator.putSkill({ operator: "ops", folder, toolchain: new Set() })
    ).skill;
  }

  async function agentWith(skillIds: string[]): Promise<string> {
    const res = await call("POST", "/agents", {
      clientRequestId: `agent-${++next}-${Date.now()}`,
      scope: "personal",
      name: "PO desk",
      description: "Checks POs.",
      modelId,
      skillIds,
    });
    const raw = await res.text();
    assert.equal(res.status, 201, raw);
    return (JSON.parse(raw) as { agent: { id: string } }).agent.id;
  }

  async function send(
    target: { agentId: string } | { chatId: string },
    text: string,
  ): Promise<{ chatId: string; events: StreamEvent[] }> {
    const clientMessageId = `cm-${++next}-${Date.now()}`;
    const res =
      "chatId" in target
        ? await call("POST", `/chats/${target.chatId}/messages`, {
            clientMessageId,
            text,
          })
        : await call("POST", "/chats", {
            agentId: target.agentId,
            clientMessageId,
            text,
          });
    const raw = await res.text();
    assert.ok(res.status === 201 || res.status === 202, raw);
    const receipt = JSON.parse(raw) as {
      chat: { id: string };
      run: { id: string };
    };
    const stream = await call(
      "GET",
      `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stream`,
    );
    return { chatId: receipt.chat.id, events: await readStream(stream) };
  }

  const chatDoc = (chatId: string) =>
    database
      .tenantDb(DEFAULT_TENANT_DB_NAME)
      .collection<ChatDoc>(CHATS_COLLECTION)
      .findOne({ _id: new ObjectId(chatId) });

  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );

  test("a chat snapshots its skill, the runtime gets it, and its use is shown", async () => {
    const skill = await publish("BODY-v1");
    const agentId = await agentWith([skill.id]);

    const first = await send({ agentId }, "Hello");
    assert.equal(
      first.events.find((e) => e.type === "completed")?.data.status,
      "completed",
    );
    const doc = await chatDoc(first.chatId);
    assert.deepEqual(
      doc?.skills?.map((s) => [s.slug, s.sha256, s.displayName]),
      [["po-check", skill.sha256, "PO check"]],
    );
    const skillDir = join(adapter.stateDir, "skills", skill.sha256);
    assert.ok(await exists(join(skillDir, "po-check", "SKILL.md")));
    // The model sees the skill's description, never its body.
    const prompt = JSON.stringify(gateway.requests[0]?.body);
    assert.match(prompt, /SKILLDESC/);
    assert.doesNotMatch(prompt, /BODY-v1/);
    const pkg = /executor package: (e\d+\/po-check)\)/.exec(prompt)?.[1];
    assert.ok(pkg, "the catalog lists po-check");

    // The runtime's storage is reset: the next run is refused as missing a
    // skill, the platform pushes it again and the run goes ahead.
    await rm(join(adapter.stateDir, "skills"), { recursive: true });
    gateway.script.push(
      {
        kind: "call",
        name: "read",
        namespace: "skills",
        args: { package: pkg },
      },
      { kind: "reply", text: "PO-7 applies." },
    );
    const second = await send({ chatId: first.chatId }, "Check PO 12");
    assert.equal(
      second.events.find((e) => e.type === "completed")?.data.status,
      "completed",
    );
    assert.ok(await exists(join(skillDir, "po-check", "SKILL.md")));
    assert.deepEqual(
      second.events.filter((e) => e.type === "skill").map((e) => e.data),
      [{ slug: "po-check", name: "PO check" }],
    );
    // No path or archive name reaches the browser.
    assert.doesNotMatch(JSON.stringify(second.events), /skill:\/\/|\/skills\//);

    const listed = await call("GET", `/chats/${first.chatId}`);
    const listedText = await listed.text();
    assert.equal(listed.status, 200, listedText);
    const { messages } = JSON.parse(listedText) as {
      messages: Array<{ role: string; skill?: unknown; text: string }>;
    };
    const used = messages.filter((m) => m.skill);
    assert.deepEqual(
      used.map((m) => [m.role, m.skill]),
      [["tool", { slug: "po-check", name: "PO check" }]],
    );
  });

  test("a new version reaches new chats only; a disabled skill none", async () => {
    const v1 = await publish("BODY-v1");
    const agentId = await agentWith([v1.id]);
    const old = await send({ agentId }, "Hello");

    const v2 = await publish("BODY-v2");
    assert.notEqual(v2.sha256, v1.sha256);
    const fresh = await send({ agentId }, "Hello");
    assert.equal((await chatDoc(fresh.chatId))?.skills?.[0]?.sha256, v2.sha256);
    assert.equal((await chatDoc(old.chatId))?.skills?.[0]?.sha256, v1.sha256);
    // The old chat keeps working on its version.
    const again = await send({ chatId: old.chatId }, "Again");
    assert.equal(
      again.events.find((e) => e.type === "completed")?.data.status,
      "completed",
    );

    await operator.setSkillEnabled({
      operator: "ops",
      slug: "po-check",
      enabled: false,
    });
    const without = await send({ agentId }, "Hello");
    assert.equal((await chatDoc(without.chatId))?.skills, undefined);
    assert.doesNotMatch(
      JSON.stringify(gateway.requests.at(-1)?.body),
      /SKILLDESC/,
    );
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/persistence/store";
import { insertFixtures } from "./fixtures";
import { PlatformService } from "../src/app/platform-service";
import { publicSession } from "../src/public/conversation";
import { POLICY_VERSION } from "../src/public/policy";
import type { Session } from "../../shared/contracts";

const HOST = "http://core";
const MISSING = "proj_00000000-0000-0000-0000-000000000000";

function session(_id: string, extra: Partial<Session> = {}): Session {
  return {
    _id,
    runtimePolicyVersion: POLICY_VERSION,
    agentId: "assistant",
    threadId: "t-" + _id,
    agentCoreHost: HOST,
    status: "active",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    approvals: [],
    timings: [],
    ...extra,
  };
}

test("publicSession exposes projectId only when set", () => {
  assert.equal("projectId" in publicSession(session("a")), false);
  assert.equal(
    publicSession(session("a", { projectId: MISSING })).projectId,
    MISSING,
  );
});

test(
  "projects: CRUD, validation, membership, filtered list, create and fork",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store, [HOST]);
    const calls: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch");
    fetchMock.mock.mockImplementation(async (url: any, init: any) => {
      const path = String(url).slice(HOST.length);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const body = JSON.parse(init?.body ?? "{}");
      const reply = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 });
      if (path === "/threads") return reply({ threadId: "new-thread" });
      if (path.endsWith("/capabilities") && body.method === "thread/fork")
        return reply({ thread: { id: "forked-thread" } });
      return reply({});
    });

    // Create and validation.
    const invalid = { status: 400, code: "INVALID_PROJECT" };
    await assert.rejects(service.createProject(""), invalid);
    await assert.rejects(service.createProject("   "), invalid);
    await assert.rejects(service.createProject("x".repeat(81)), invalid);
    await assert.rejects(service.createProject(42), invalid);
    const a = await service.createProject("  Alpha  ");
    assert.match(a._id, /^proj_[0-9a-f-]{36}$/);
    assert.equal(a.name, "Alpha");
    assert.equal(a.createdAt, a.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const b = await service.createProject("x".repeat(80));
    assert.equal(b.name.length, 80);

    // List is newest-updated first; rename bumps updatedAt.
    assert.deepEqual(
      (await service.projects()).map((p) => p._id),
      [b._id, a._id],
    );
    await new Promise((r) => setTimeout(r, 5));
    const renamed = await service.renameProject(a._id, "Alpha 2");
    assert.equal(renamed.name, "Alpha 2");
    assert.ok(renamed.updatedAt > a.updatedAt);
    assert.equal(renamed.createdAt, a.createdAt);
    assert.deepEqual(
      (await service.projects()).map((p) => p._id),
      [a._id, b._id],
    );
    await assert.rejects(service.renameProject(a._id, ""), invalid);
    await assert.rejects(service.renameProject(MISSING, "Name"), {
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    await assert.rejects(service.renameProject("nope", "Name"), invalid);

    // Add, move and remove a session.
    await store.sessions.insertMany([session("s1"), session("s2")]);
    await store.messages.insertOne({
      _id: "m1",
      sessionId: "s1",
      role: "user",
      text: "First   question",
      at: new Date().toISOString(),
    } as any);
    const beforeAdd = (await store.projects.findOne({ _id: b._id }))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const added = await service.setSessionProject("s1", b._id);
    assert.equal(added.projectId, b._id);
    assert.equal((await store.sessions.findOne({ _id: "s1" }))?.projectId, b._id);
    assert.ok(
      (await store.projects.findOne({ _id: b._id }))!.updatedAt > beforeAdd,
    );
    const moved = await service.setSessionProject("s1", a._id);
    assert.equal(moved.projectId, a._id);
    const removed = await service.setSessionProject("s1", null);
    assert.equal("projectId" in removed, false);
    assert.equal(
      "projectId" in (await store.sessions.findOne({ _id: "s1" }))!,
      false,
    );
    await assert.rejects(service.setSessionProject("s1", MISSING), {
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    await assert.rejects(service.setSessionProject("s1", "bad"), invalid);
    await assert.rejects(service.setSessionProject("missing", a._id), {
      status: 404,
    });

    // Filtered list keeps derived titles; unfiltered list includes everything.
    await service.setSessionProject("s1", a._id);
    const inA = await service.sessions(a._id);
    assert.deepEqual(
      inA.map((s) => [s._id, s.title, s.projectId]),
      [["s1", "First question", a._id]],
    );
    assert.deepEqual(await service.sessions(b._id), []);
    assert.deepEqual(
      (await service.sessions()).map((s) => s._id).sort(),
      ["s1", "s2"],
    );
    await assert.rejects(service.sessions("bad"), invalid);

    // Creating a session in a missing project never starts a thread.
    await assert.rejects(service.create("assistant", undefined, MISSING), {
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    await assert.rejects(service.create("assistant", undefined, "bad"), invalid);
    assert.equal(calls.filter((c) => c === "POST /threads").length, 0);
    const created = await service.create("assistant", undefined, b._id);
    assert.equal(created.projectId, b._id);
    assert.equal(
      (await store.sessions.findOne({ _id: created._id }))?.projectId,
      b._id,
    );
    const plain = await service.create("assistant");
    assert.equal("projectId" in plain, false);

    // A fork stays in the parent's project.
    const fork = (await service.capability("s1", "thread/fork", {})) as any;
    assert.equal(fork.session.projectId, a._id);
    assert.equal(
      (await store.sessions.findOne({ _id: fork.session._id }))?.projectId,
      a._id,
    );

    // Deleting a project keeps its sessions as normal conversations.
    assert.deepEqual(await service.deleteProject(a._id), { ok: true });
    assert.equal(await store.projects.countDocuments({ _id: a._id }), 0);
    for (const id of ["s1", fork.session._id]) {
      const s = await store.sessions.findOne({ _id: id });
      assert.ok(s);
      assert.equal("projectId" in s, false);
    }
    await assert.rejects(service.deleteProject(a._id), {
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
    const indexes = await store.sessions.indexes();
    assert.ok(indexes.some((i) => i.name === "projectId_1_createdAt_-1"));
  },
);

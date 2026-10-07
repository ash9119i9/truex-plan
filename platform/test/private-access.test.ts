import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startPlatform,
  sleep,
  waitFor,
  type Claims,
  type Platform,
} from "./harness";
import { POLICY_VERSION } from "../src/public";
import { hashToken } from "../src/auth";

const claims = (name: string, extra: Partial<Claims> = {}): Claims => ({
  sub: `sub-${name}`,
  email: `${name}@gmail.com`,
  email_verified: true,
  name,
  ...extra,
});
const agentBody = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: "test agent",
  systemPrompt: "Be brief.",
  modelProfileId: "demo-model",
  ...extra,
});

// Reads an SSE response until it ends or `ms` pass; resolves with what arrived
// and how long the stream stayed open.
async function readStream(
  p: Platform,
  cookie: string,
  sessionId: string,
  controller = new AbortController(),
) {
  const res = await fetch(`${p.base}/api/sessions/${sessionId}/events`, {
    headers: { cookie, "x-forwarded-for": p.nextIp() },
    signal: controller.signal,
  });
  return res;
}
async function drain(res: Response, timeoutMs: number) {
  const began = Date.now();
  const reader = res.body!.getReader();
  let text = "";
  const decoder = new TextDecoder();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch {
    // Cancelled by the timer or the server.
  } finally {
    clearTimeout(timer);
  }
  return { text, ms: Date.now() - began };
}

test(
  "private workspaces: ownership, passive admin reads, revocation, limits over real HTTP",
  { timeout: 360_000 },
  async (t) => {
    const p = await startPlatform({
      env: {
        DEMO_TENANT_ID: "demo",
        DEMO_DAILY_TURNS_PER_USER: "3",
        DEMO_DAILY_TURNS_GLOBAL: "7",
        DEMO_DAILY_SIGNUPS: "50",
        DEMO_CACHE_MS: "100",
        STREAM_REVALIDATE_MS: "300",
        STREAMS_PER_USER_MAX: "3",
        AGENTS_PER_USER_MAX: "6",
        MCP_PER_USER_MAX: "2",
      },
    });
    t.after(() => p.stop());
    const { store, core } = p;
    await p.workspace("demo", "Demo");
    await p.approveDemoModel("demo");
    await store.profiles.insertOne({
      _id: "other-model",
      provider: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      modelName: "unapproved",
      apiKey: "other-key",
    } as never);
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { admissionPolicy: "open" } },
    );
    await p.workspace("acme", "Acme");
    await store.tenantRegistry.insertOne({
      _id: "legacy",
      name: "Legacy",
      dbName: "truex_t_legacy",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.ensureTenantIndexes("truex_t_legacy", false);
    const tenant = async (id: string) =>
      store.resolveTenant(id, { fresh: true });

    const A = await p.session(claims("alice"));
    const B = await p.session(claims("bob"));
    await p.addMember(claims("owner"), "demo", "admin");
    const O = await p.session(claims("owner"));
    const id = async (name: string) =>
      (await store.users.findOne({ googleSub: `sub-${name}` }))!._id;
    const [aliceId, bobId, ownerId] = [
      await id("alice"),
      await id("bob"),
      await id("owner"),
    ];
    const get = (c: string, path: string) => p.request(c, "GET", path);
    const post = (c: string, path: string, body: unknown = {}) =>
      p.request(c, "POST", path, body);
    const audit = (filter: Record<string, unknown>) =>
      store.audit.find(filter).toArray();

    let aliceAgent = "",
      bobAgent = "",
      s1 = "",
      s2 = "";

    await t.test(
      "agents have an immutable creator the client cannot choose",
      async () => {
        for (const forged of [
          { createdBy: bobId },
          { ownerId: bobId },
          { tenantId: "acme" },
          { role: "admin" },
          { builtin: true },
          { scope: "business" },
          { enabled: false },
        ])
          assert.equal(
            (await post(A, "/api/agents", agentBody("Forge", forged))).status,
            400,
            JSON.stringify(forged),
          );
        assert.equal(
          await store.withTenant(await tenant("demo"), () =>
            store.agents.countDocuments(),
          ),
          0,
        );

        const made = await post(A, "/api/agents", agentBody("Helper"));
        assert.equal(made.status, 201, made.text);
        aliceAgent = made.data.id;
        assert.equal(made.data.createdBy, aliceId);
        assert.equal(made.data.canUse, true);
        const stored = await store.withTenant(await tenant("demo"), () =>
          store.agents.findOne({ _id: aliceAgent }),
        );
        assert.equal(stored?.createdBy, aliceId);
        assert.equal(stored?.builtin, false);

        // The same handle is fine for another person, and not for the same one.
        const bobs = await post(B, "/api/agents", agentBody("Helper"));
        assert.equal(bobs.status, 201, bobs.text);
        bobAgent = bobs.data.id;
        assert.equal(bobs.data.createdBy, bobId);
        assert.equal(
          (await post(A, "/api/agents", agentBody("Helper"))).data.code,
          "AGENT_HANDLE_TAKEN",
        );

        // Concurrent creates by one person: exactly one wins, by the database.
        const race = await Promise.all(
          [1, 2, 3, 4, 5].map(() => post(B, "/api/agents", agentBody("Racer"))),
        );
        assert.deepEqual(
          race.map((r) => r.status).sort(),
          [201, 409, 409, 409, 409],
        );
        assert.equal(
          await store.withTenant(await tenant("demo"), () =>
            store.agents.countDocuments({ createdBy: bobId, handle: "racer" }),
          ),
          1,
        );
        // Only the approved model is available.
        assert.equal(
          (
            await post(
              B,
              "/api/agents",
              agentBody("Sneaky", { modelProfileId: "other-model" }),
            )
          ).data.code,
          "MODEL_UNAVAILABLE",
        );
        // A per-person ceiling keeps a creator from filling the workspace.
        const limit = await Promise.all(
          [1, 2, 3, 4, 5, 6, 7].map((i) =>
            post(B, "/api/agents", agentBody(`Many${i}`)),
          ),
        );
        assert.ok(limit.some((r) => r.data.code === "AGENT_LIMIT"));
      },
    );

    await t.test(
      "lists show each person only their own agents; an admin sees all, with creators",
      async () => {
        const mine = (await get(A, "/api/agents")).data as {
          id: string;
          createdBy: string;
        }[];
        assert.deepEqual(
          mine.map((a) => a.id),
          [aliceAgent],
        );
        const theirs = (await get(B, "/api/agents")).data as {
          id: string;
          createdBy: string;
        }[];
        assert.ok(
          theirs.length >= 2 && theirs.every((a) => a.createdBy === bobId),
        );
        assert.ok(!theirs.some((a) => a.id === aliceAgent));
        const all = (await get(O, "/api/agents")).data as {
          id: string;
          handle: string;
          createdBy: string;
          canUse: boolean;
          canWrite: boolean;
        }[];
        const helpers = all.filter((a) => a.handle === "helper");
        assert.equal(
          helpers.length,
          2,
          "both creators' Helper agents are listed",
        );
        assert.notEqual(helpers[0].id, helpers[1].id);
        assert.deepEqual(
          new Set(helpers.map((h) => h.createdBy)),
          new Set([aliceId, bobId]),
        );
        // The admin can tell them apart by name; the creators themselves are not told.
        assert.deepEqual(
          new Set(
            helpers.map((h) => (h as { creatorName?: string }).creatorName),
          ),
          new Set(["alice", "bob"]),
        );
        assert.ok(mine.every((a) => !("creatorName" in a)));
        assert.ok(
          all.every((a) => a.canUse === false && a.canWrite === false),
          "an admin may not use others' agents",
        );
        const rows = await audit({ action: "agent.list", actor: ownerId });
        assert.ok(rows.length >= 1, "reading others' agents is audited");
        assert.equal(JSON.stringify(rows).includes("systemPrompt"), false);
      },
    );

    await t.test(
      "a hidden agent is hidden on every path, and an admin may read but not use it",
      async () => {
        const missing = await get(B, "/api/agents/agent_nope/mcp");
        assert.equal(missing.status, 404);
        for (const [method, path, body] of [
          ["GET", `/api/agents/${aliceAgent}/mcp`, undefined],
          ["POST", `/api/agents/${aliceAgent}/mcp`, { profileIds: [] }],
          ["POST", "/api/sessions", { agentId: aliceAgent }],
        ] as const) {
          const r = await p.request(B, method, path, body);
          assert.equal(r.status, 404, `${method} ${path}`);
          assert.equal(r.data.code, "AGENT_NOT_FOUND");
          assert.equal(
            r.data.error,
            missing.data.error,
            "same answer as for a missing agent",
          );
        }
        const mark = core.mark();
        for (const [method, path, body] of [
          ["POST", "/api/sessions", { agentId: aliceAgent }],
          ["POST", `/api/agents/${aliceAgent}/mcp`, { profileIds: [] }],
          ["POST", `/api/agents/${aliceAgent}/tenant-mcp`, { profileIds: [] }],
        ] as const) {
          const r = await p.request(O, method, path, body);
          assert.equal(r.status, 403, `${method} ${path}: ${r.text}`);
          assert.equal(r.data.code, "NOT_AGENT_OWNER");
        }
        assert.equal(
          (await get(O, `/api/agents/${aliceAgent}/mcp`)).status,
          200,
        );
        assert.equal(
          core.sinceExcludingSync(mark).some((c) => c.method === "POST"),
          false,
          "no thread was started",
        );
      },
    );

    await t.test(
      "conversations: owner-only lists and 404s; admin reads passively and cannot act",
      async () => {
        const first = await post(A, "/api/sessions", { agentId: aliceAgent });
        assert.equal(first.status, 201, first.text);
        s1 = first.data._id;
        assert.equal(first.data.userId, aliceId);
        s2 = (await post(B, "/api/sessions", { agentId: bobAgent })).data._id;
        assert.equal(
          (
            await post(A, `/api/sessions/${s1}/messages`, {
              text: "alice's secret plan",
              clientId: "a1",
            })
          ).status,
          202,
        );
        // The assistant's reply is stored by the background sync; seed what it would.
        await store.withTenant(await tenant("demo"), () =>
          store.messages.insertOne({
            _id: `${s1}:assistant:turn-x:0`,
            sessionId: s1,
            role: "assistant",
            text: "stored reply",
            at: new Date().toISOString(),
          } as never),
        );

        // Lists.
        assert.deepEqual(
          (await get(A, "/api/sessions")).data.map(
            (s: { _id: string }) => s._id,
          ),
          [s1],
        );
        assert.deepEqual(
          (await get(B, "/api/sessions")).data.map(
            (s: { _id: string }) => s._id,
          ),
          [s2],
        );
        assert.deepEqual(
          (await get(O, "/api/sessions")).data
            .map((s: { _id: string }) => s._id)
            .sort(),
          [s1, s2].sort(),
        );
        // Bob cannot see or touch Alice's conversation, and cannot tell it exists.
        const unknown = await get(
          B,
          "/api/sessions/sess_00000000-0000-0000-0000-000000000000",
        );
        const readPaths = [
          `/api/sessions/${s1}`,
          `/api/sessions/${s1}/documents`,
          `/api/sessions/${s1}/documents/f1`,
          `/api/sessions/${s1}/visualizations/v1`,
          `/api/sessions/${s1}/timings`,
          `/api/sessions/${s1}/traces`,
          `/api/sessions/${s1}/turns/t1/context`,
          `/api/sessions/${s1}/agents`,
          `/api/sessions/${s1}/agents/a1`,
          `/api/sessions/${s1}/goal/history`,
          `/api/sessions/${s1}/events`,
        ];
        for (const path of readPaths) {
          const r = await get(B, path);
          assert.equal(r.status, 404, path);
          assert.equal(r.data.code, "SESSION_NOT_FOUND", path);
          assert.equal(r.data.error, unknown.data.error);
        }
        for (const [path, body] of [
          [`/api/sessions/${s1}/messages`, { text: "hi", clientId: "x1" }],
          [`/api/sessions/${s1}/interrupt`, {}],
          [`/api/sessions/${s1}/approvals/r1`, { result: {} }],
          [`/api/sessions/${s1}/approval-mode`, { mode: "auto" }],
          [
            `/api/sessions/${s1}/capabilities`,
            { method: "thread/archive", params: {} },
          ],
          [`/api/sessions/${s1}/project`, { projectId: null }],
          [`/api/sessions/${s1}/documents`, { name: "a.txt", base64: "aGk=" }],
          [`/api/sessions/${s1}/goal/review`, { decision: "accepted" }],
          [`/api/sessions/${s1}/agents/a1/interrupt`, {}],
        ] as const) {
          const r = await post(B, path, body);
          assert.ok(
            [404, 403].includes(r.status) && r.status !== 200,
            `${path}: ${r.status}`,
          );
          if (path.endsWith("/approval-mode")) continue; // feature flag answers first
          assert.equal(r.status, 404, path);
        }

        // The admin reads what is stored, and the owner's runtime is never touched.
        const mark = core.mark();
        const view = await get(O, `/api/sessions/${s1}`);
        assert.equal(view.status, 200, view.text);
        assert.equal(view.data.access, "readOnly");
        assert.equal(view.data.snapshot, null);
        assert.equal(view.data.recoveryError, null);
        assert.ok(
          view.data.messages.some(
            (m: { text: string }) => m.text === "alice's secret plan",
          ),
        );
        assert.ok(
          view.data.messages.some(
            (m: { text: string }) => m.text === "stored reply",
          ),
        );
        assert.equal((await get(O, `/api/sessions/${s1}/timings`)).status, 200);
        assert.equal((await get(O, `/api/sessions/${s1}/traces`)).status, 200);
        assert.equal(
          (await get(O, `/api/sessions/${s1}/goal/history`)).status,
          200,
        );
        const goal = await post(O, `/api/sessions/${s1}/capabilities`, {
          method: "thread/goal/get",
          params: {},
        });
        assert.equal(goal.status, 200, goal.text);
        assert.equal(goal.data.goal, null);
        assert.deepEqual(
          core.sinceExcludingSync(mark),
          [],
          "an admin's view makes no runtime call at all",
        );
        // The remaining read routes ask the runtime to read, never to act: every
        // call is a GET, nothing is acknowledged or resumed on the owner's behalf.
        const mark1 = core.mark();
        for (const path of [
          `/api/sessions/${s1}/documents`,
          `/api/sessions/${s1}/documents/f1`,
          `/api/sessions/${s1}/visualizations/v1`,
          `/api/sessions/${s1}/turns/t1/context`,
          `/api/sessions/${s1}/agents`,
          `/api/sessions/${s1}/agents/a1`,
        ])
          await get(O, path);
        const streamAbort = new AbortController();
        const watch = await readStream(p, O, s1, streamAbort);
        assert.equal(watch.status, 200);
        streamAbort.abort();
        // The platform's own background sync polls every thread's /records on a
        // timer, whoever is looking; it is not the admin's doing, so it is set aside.
        const calls = core
          .since(mark1)
          .filter((c) => !c.path.endsWith("/records"));
        assert.ok(calls.length >= 1);
        assert.deepEqual(
          calls.filter((c) => c.method !== "GET"),
          [],
          "only reads: no resume, no ack, no turn, no write",
        );
        assert.ok(!calls.some((c) => /resume|ack|turns$/.test(c.path)));
        // The owner's own view still syncs with the runtime.
        const ownView = await get(A, `/api/sessions/${s1}`);
        assert.equal(ownView.data.access, "owner");
        assert.ok(core.since(mark).some((c) => c.path.endsWith("/snapshot")));

        // The admin cannot act on it: every write is refused before the runtime.
        const mark2 = core.mark();
        for (const [path, body] of [
          [
            `/api/sessions/${s1}/messages`,
            { text: "I am the admin", clientId: "adm1" },
          ],
          [`/api/sessions/${s1}/interrupt`, {}],
          [`/api/sessions/${s1}/approvals/r1`, { result: {} }],
          [
            `/api/sessions/${s1}/capabilities`,
            { method: "thread/archive", params: {} },
          ],
          [
            `/api/sessions/${s1}/capabilities`,
            { method: "thread/fork", params: {} },
          ],
          [`/api/sessions/${s1}/project`, { projectId: null }],
          [`/api/sessions/${s1}/documents`, { name: "a.txt", base64: "aGk=" }],
          [`/api/sessions/${s1}/goal/review`, { decision: "accepted" }],
          [`/api/sessions/${s1}/agents/a1/interrupt`, {}],
        ] as const) {
          const r = await post(O, path, body);
          assert.equal(r.status, 403, `${path}: ${r.status} ${r.text}`);
          assert.equal(r.data.code, "NOT_SESSION_OWNER");
        }
        assert.deepEqual(core.sinceExcludingSync(mark2), []);
        assert.equal(
          await store.withTenant(await tenant("demo"), () =>
            store.messages.countDocuments({ sessionId: s1, role: "user" }),
          ),
          1,
        );

        // And the reads left an audit trail naming who read whose conversation.
        const reads = await audit({
          action: "session.read",
          actor: ownerId,
          "target.id": s1,
        });
        assert.equal(reads.length >= 1, true);
        assert.equal(reads[0].target?.ownerId, aliceId);
        assert.equal(reads[0].tenantId, "demo");
        assert.equal(
          JSON.stringify(reads).includes("alice's secret plan"),
          false,
          "no content in the audit trail",
        );
        assert.ok(
          (await audit({ action: "session.list", actor: ownerId })).length >= 1,
        );
      },
    );

    await t.test("without an audit record there is no disclosure", async () => {
      await store.catalog.command({
        collMod: "security_audit",
        validator: { neverPresent: { $exists: true } },
        validationAction: "error",
      });
      try {
        const refused = await get(O, `/api/sessions/${s1}`);
        assert.equal(refused.status, 503);
        assert.equal(refused.data.code, "AUDIT_UNAVAILABLE");
        assert.equal(refused.text.includes("alice's secret plan"), false);
        assert.equal((await get(O, "/api/sessions")).status, 503);
        // Owners reading their own content need no audit record.
        assert.equal((await get(A, `/api/sessions/${s1}`)).status, 200);
      } finally {
        await store.catalog.command({
          collMod: "security_audit",
          validator: {},
          validationAction: "error",
        });
      }
      assert.equal((await get(O, `/api/sessions/${s1}`)).status, 200);
    });

    await t.test(
      "connector secrets are never in any response, for owner or admin",
      async () => {
        const secret = "sk-super-secret-connector-key";
        const created = await post(A, "/api/mcp", {
          name: "crm",
          url: "https://example.com/mcp",
          auth: { kind: "bearer" },
          apiKey: secret,
        });
        assert.equal(created.status, 201, created.text);
        const attach = await post(A, `/api/agents/${aliceAgent}/mcp`, {
          profileIds: [created.data.id],
        });
        assert.equal(attach.status, 200, attach.text);
        const seen = [
          created.text,
          attach.text,
          (await get(A, `/api/agents/${aliceAgent}/mcp`)).text,
          (await get(A, "/api/mcp")).text,
          (await get(O, `/api/agents/${aliceAgent}/mcp`)).text,
          (await get(O, "/api/agents")).text,
          (await get(O, `/api/sessions/${s1}`)).text,
          (await get(O, "/api/mcp")).text,
          (await get(O, "/api/me")).text,
        ];
        for (const text of seen) assert.equal(text.includes(secret), false);
        assert.equal(p.logs().includes(secret), false);
        // Another person's connector is unreachable by id, even for an admin.
        assert.equal(
          (
            await p.request(O, "PATCH", `/api/mcp/${created.data.id}`, {
              name: "mine",
            })
          ).status,
          404,
        );
        assert.equal(
          (await p.request(B, "DELETE", `/api/mcp/${created.data.id}`)).status,
          404,
        );
      },
    );

    await t.test(
      "records from before ownership are admin-readable only, and nobody adopts them",
      async () => {
        const ref = await tenant("demo");
        await store.withTenant(ref, async () => {
          await store.agents.insertOne({
            _id: "legacy-agent",
            name: "Legacy",
            handle: "legacy",
            modelProfileId: "demo-model",
            systemPrompt: "x",
            enabled: true,
          } as never);
          await store.sessions.insertOne({
            _id: "sess_ownerless",
            runtimePolicyVersion: POLICY_VERSION,
            agentId: "legacy-agent",
            threadId: "th-ownerless",
            agentCoreHost: core.url,
            status: "active",
            cwd: "/tmp",
            createdAt: new Date().toISOString(),
            approvals: [],
            timings: [],
          } as never);
        });
        for (const c of [A, B]) {
          assert.ok(
            !(await get(c, "/api/agents")).data.some(
              (a: { id: string }) => a.id === "legacy-agent",
            ),
          );
          assert.ok(
            !(await get(c, "/api/sessions")).data.some(
              (s: { _id: string }) => s._id === "sess_ownerless",
            ),
          );
          assert.equal(
            (await get(c, "/api/sessions/sess_ownerless")).status,
            404,
          );
          assert.equal(
            (await post(c, "/api/sessions", { agentId: "legacy-agent" }))
              .status,
            404,
          );
        }
        assert.ok(
          (await get(O, "/api/agents")).data.some(
            (a: { id: string }) => a.id === "legacy-agent",
          ),
        );
        assert.equal(
          (await get(O, "/api/sessions/sess_ownerless")).status,
          200,
        );
        const use = await post(O, "/api/sessions", { agentId: "legacy-agent" });
        assert.equal(use.status, 403);
        assert.equal(use.data.code, "NOT_AGENT_OWNER");
      },
    );

    await t.test("workspaces do not mix under parallel load", async () => {
      await p.addMember(claims("carol"), "acme", "admin");
      const C = await p.session(claims("carol"));
      assert.equal(
        (await post(C, "/api/agents", agentBody("AcmeBot"))).status,
        201,
      );
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          i % 2 ? get(A, "/api/agents") : get(C, "/api/agents"),
        ),
      );
      results.forEach((r, i) => {
        const names = (r.data as { name: string }[]).map((a) => a.name);
        assert.deepEqual(
          names,
          i % 2 ? ["Helper"] : ["AcmeBot"],
          `request ${i}`,
        );
      });

      // A resource id from another workspace is simply not found, even for an
      // admin of this one: workspaces are separate databases.
      const C2 = await p.session(claims("carol"));
      for (const path of [
        `/api/sessions/${s1}`,
        `/api/sessions/${s1}/documents`,
        `/api/agents/${aliceAgent}/mcp`,
      ])
        assert.equal((await get(C2, path)).status, 404, path);
      assert.ok(
        !(await get(C2, "/api/sessions")).data.some(
          (x: { _id: string }) => x._id === s1,
        ),
      );
    });

    await t.test(
      "a shared (legacy) workspace keeps its behaviour: shared reads, owner-only writes",
      async () => {
        await store.withTenant(await tenant("legacy"), () =>
          store.agents.insertOne({
            _id: "shared-agent",
            name: "Shared",
            handle: "shared",
            modelProfileId: "demo-model",
            systemPrompt: "x",
            enabled: true,
          } as never),
        );
        await p.addMember(claims("lena"), "legacy", "user");
        await p.addMember(claims("lars"), "legacy", "user");
        const L = await p.session(claims("lena"));
        const R = await p.session(claims("lars"));
        assert.deepEqual(
          (await get(R, "/api/agents")).data.map((a: { id: string }) => a.id),
          ["shared-agent"],
        );
        const chat = await post(L, "/api/sessions", {
          agentId: "shared-agent",
        });
        assert.equal(chat.status, 201);
        assert.equal(
          chat.data.userId,
          await id("lena"),
          "the caller owns a chat started from a shared agent",
        );
        assert.equal(
          (await get(R, `/api/sessions/${chat.data._id}`)).status,
          200,
        );
        assert.equal(
          (
            await post(R, `/api/sessions/${chat.data._id}/messages`, {
              text: "x",
              clientId: "z1",
            })
          ).status,
          403,
        );
        // Shared reads are not private content: no audit rows for them.
        assert.equal((await audit({ tenantId: "legacy" })).length, 0);
      },
    );

    await t.test(
      "demo turn limits: per person, shared, once per logical turn, returned when refused",
      async () => {
        const q1 = await p.session(claims("quser1"));
        const q2 = await p.session(claims("quser2"));
        const mk = async (c: string) => {
          const a = await post(c, "/api/agents", agentBody("Q"));
          return (await post(c, "/api/sessions", { agentId: a.data.id })).data
            ._id as string;
        };
        const [qs1, qs2] = [await mk(q1), await mk(q2)];
        const day = new Date().toISOString().slice(0, 10);
        const count = async (key: string) =>
          (await store.demoUsage.findOne({ _id: `${day}:demo:${key}` }))
            ?.count ?? 0;
        const send = (c: string, s: string, clientId: string) =>
          post(c, `/api/sessions/${s}/messages`, { text: "hello", clientId });
        // alice already used 1 of the shared 7.
        assert.equal(await count("*"), 1);
        for (const c of ["c1", "c2", "c3"])
          assert.equal((await send(q1, qs1, c)).status, 202, c);
        const mark = core.mark();
        const over = await send(q1, qs1, "c4");
        assert.equal(over.status, 429);
        assert.equal(over.data.code, "DEMO_QUOTA_EXCEEDED");
        assert.match(over.data.error, /Try again after 00:00 UTC/);
        assert.ok(Number(over.headers.get("retry-after")) > 0);
        assert.equal(
          core.since(mark).some((c) => c.path.endsWith("/turns")),
          false,
          "nothing dispatched past the limit",
        );
        assert.equal(await count("*"), 4);
        const quser1 = await id("quser1");
        assert.equal(await count(`u:${quser1}`), 3);
        // A retry of a turn that already ran counts nothing.
        const again = await send(q1, qs1, "c1");
        assert.equal(again.status, 202);
        assert.equal(again.data.duplicate, true);
        assert.equal(await count(`u:${quser1}`), 3);
        // The same clientId from someone else is their own turn.
        assert.equal((await send(q2, qs2, "c1")).status, 202);
        assert.equal((await send(q2, qs2, "c2")).status, 202);
        assert.equal(await count("*"), 6);
        assert.equal((await send(q2, qs2, "c3")).status, 202);
        const quser2 = await id("quser2");
        assert.equal(await count("*"), 7);
        assert.equal(await count(`u:${quser2}`), 3);
        // Past the shared ceiling even someone with turns left gets nothing,
        // and the refusal spends nothing, from them or from the shared total.
        assert.equal(await count(`u:${bobId}`), 0);
        const full = await send(B, s2, "g1");
        assert.equal(full.status, 429);
        assert.match(full.data.error, /demo has reached its limit/);
        assert.equal(
          await count("*"),
          7,
          "the refused attempt was rolled back",
        );
        assert.equal(await count(`u:${bobId}`), 0);
        assert.equal(
          await store.demoTurns.countDocuments({
            userId: bobId,
            clientId: "g1",
          }),
          0,
        );
        assert.equal(
          await store.demoTurns.countDocuments({
            userId: quser2,
            conversationId: qs2,
          }),
          3,
        );

        // The runtime refusing a turn (a 4xx) gives it back; an unclear failure does not.
        await store.demoUsage.updateOne(
          { _id: `${day}:demo:*` },
          { $set: { count: 0 } },
        );
        core.behavior.turnStatus = 422;
        const bobBefore = await count(`u:${bobId}`);
        const refused = await send(B, s2, "r1");
        assert.equal(refused.status, 422);
        assert.equal(
          await count(`u:${bobId}`),
          bobBefore,
          "a refused turn is returned",
        );
        assert.equal(
          (await store.demoTurns.findOne({ userId: bobId, clientId: "r1" }))
            ?.state,
          "released",
        );
        core.behavior.turnStatus = 500;
        const unclear = await send(B, s2, "r2");
        assert.ok(unclear.status >= 500);
        assert.equal(
          await count(`u:${bobId}`),
          bobBefore + 1,
          "an unclear outcome still counts",
        );
        core.behavior.turnStatus = 200;
        assert.equal(core.behavior.turnStatus, 200);
      },
    );

    await t.test(
      "a retried turn sent in parallel counts once; starting a goal costs a turn; connectors are capped",
      async () => {
        const day = new Date().toISOString().slice(0, 10);
        const Q = await p.session(claims("quser3"));
        const qid = await id("quser3");
        const count = async () =>
          (await store.demoUsage.findOne({ _id: `${day}:demo:u:${qid}` }))
            ?.count ?? 0;
        const agent = await post(Q, "/api/agents", agentBody("Q3"));
        const sess = (
          await post(Q, "/api/sessions", { agentId: agent.data.id })
        ).data._id as string;
        // Five copies of one submission at once: one logical turn.
        const sent = await Promise.all(
          [1, 2, 3, 4, 5].map(() =>
            post(Q, `/api/sessions/${sess}/messages`, {
              text: "same",
              clientId: "dup",
            }),
          ),
        );
        assert.ok(
          sent.some((r) => r.status === 202),
          JSON.stringify(sent.map((r) => r.status)),
        );
        assert.ok(
          sent.every((r) => [202, 409].includes(r.status)),
          JSON.stringify(sent.map((r) => r.status)),
        );
        assert.equal(
          await count(),
          1,
          "one turn counted, however many copies arrived",
        );
        assert.equal(
          await store.demoTurns.countDocuments({
            userId: qid,
            clientId: "dup",
          }),
          1,
        );
        // A goal sets the assistant working on its own: it costs a turn.
        const goal = await post(Q, `/api/sessions/${sess}/capabilities`, {
          method: "thread/goal/set",
          params: { objective: "Do the thing" },
        });
        assert.equal(goal.status, 200, goal.text);
        assert.equal(await count(), 2);
        // Reading or clearing a goal is free.
        for (const method of ["thread/goal/get", "thread/goal/clear"])
          assert.equal(
            (
              await post(Q, `/api/sessions/${sess}/capabilities`, {
                method,
                params: {},
              })
            ).status,
            200,
          );
        assert.equal(await count(), 2);
        assert.equal(
          (
            await post(Q, `/api/sessions/${sess}/messages`, {
              text: "third",
              clientId: "t3",
            })
          ).status,
          202,
        );
        const over = await post(Q, `/api/sessions/${sess}/capabilities`, {
          method: "thread/goal/set",
          params: { objective: "One too many" },
        });
        assert.equal(over.status, 429);
        assert.equal(over.data.code, "DEMO_QUOTA_EXCEEDED");
        assert.equal(await count(), 3);

        // Open sign-up: a person's own connected tools are bounded too.
        const mcp = (name: string) =>
          post(Q, "/api/mcp", {
            name,
            url: `https://example.com/${name}`,
            auth: { kind: "none" },
          });
        assert.equal((await mcp("one")).status, 201);
        assert.equal((await mcp("two")).status, 201);
        const third = await mcp("three");
        assert.equal(third.status, 409);
        assert.equal(third.data.code, "MCP_LIMIT");
      },
    );

    await t.test(
      "access withdrawn while a turn waits to start: nothing is dispatched",
      async () => {
        core.behavior.resumeDelayMs = 900;
        const mark = core.mark();
        const pending = post(B, `/api/sessions/${s2}/messages`, {
          text: "queued",
          clientId: "w1",
        });
        await sleep(250);
        await store.memberships.updateOne(
          { userId: bobId, tenantId: "demo" },
          { $set: { status: "removed" } },
        );
        const result = await pending;
        core.behavior.resumeDelayMs = 0;
        assert.equal(result.status, 403, result.text);
        assert.equal(result.data.code, "ACCESS_REVOKED");
        assert.equal(
          core.since(mark).some((c) => c.path.endsWith("/turns")),
          false,
        );
        // The turn that never ran was returned.
        assert.equal(
          (await store.demoTurns.findOne({ userId: bobId, clientId: "w1" }))
            ?.state,
          "released",
        );
        await store.memberships.updateOne(
          { userId: bobId, tenantId: "demo" },
          { $set: { status: "active" } },
        );
      },
    );

    await t.test(
      "streams: capped per person, and ended soon after access is withdrawn",
      async () => {
        const begun = [] as Response[];
        const controllers = [] as AbortController[];
        for (let i = 0; i < 3; i++) {
          const c = new AbortController();
          controllers.push(c);
          const r = await readStream(p, A, s1, c);
          assert.equal(r.status, 200);
          begun.push(r);
        }
        const fourth = await get(A, `/api/sessions/${s1}/events`);
        assert.equal(fourth.status, 429);
        assert.equal(fourth.data.code, "STREAM_LIMIT");
        controllers.forEach((c) => c.abort());
        await waitFor(() => core.openStreams() === 0, {
          what: "streams to close",
        });
        assert.equal(
          (await readStream(p, A, s1)).status,
          200,
          "the cap frees as streams close",
        );
        await waitFor(() => true);

        // Removal ends the person's own stream within the bound.
        const live = await readStream(p, A, s1);
        assert.equal(live.status, 200);
        const reader = drain(live, 15_000);
        await sleep(400);
        const removedAt = Date.now();
        await store.memberships.updateOne(
          { userId: aliceId, tenantId: "demo" },
          { $set: { status: "removed" } },
        );
        const ended = await reader;
        const latency = Date.now() - removedAt;
        assert.match(ended.text, /event: stream\.error/);
        assert.match(ended.text, /ACCESS_REVOKED/);
        assert.ok(latency < 5_000, `closed ${latency} ms after removal`);
        console.log(
          `# stream closed ${latency} ms after membership removal (revalidate every 300 ms)`,
        );
        await store.memberships.updateOne(
          { userId: aliceId, tenantId: "demo" },
          { $set: { status: "active" } },
        );

        // Signing out ends it too.
        const A2 = await p.session(claims("alice"));
        const out = await readStream(p, A2, s1);
        const outRead = drain(out, 15_000);
        await sleep(400);
        const loggedOutAt = Date.now();
        assert.equal((await post(A2, "/auth/logout", undefined)).status, 204);
        const done = await outRead;
        assert.match(done.text, /ACCESS_REVOKED/);
        assert.ok(Date.now() - loggedOutAt < 5_000);
        assert.equal(
          (await get(A2, "/api/me")).status,
          401,
          "a logged-out token is dead",
        );

        // An admin demoted while watching someone's conversation loses it.
        const watch = await readStream(p, O, s1);
        assert.equal(watch.status, 200);
        const watchRead = drain(watch, 15_000);
        await sleep(400);
        await store.memberships.updateOne(
          { userId: ownerId, tenantId: "demo" },
          { $set: { role: "user" } },
        );
        const watched = await watchRead;
        assert.match(watched.text, /ACCESS_REVOKED/);
        // Ending because access was withdrawn is recorded apart from a plain close.
        const [revokedClose] = await waitForAudit({
          action: "session.stream.close",
          actor: ownerId,
          outcome: /^ended:/,
        });
        assert.equal(revokedClose.outcome, "ended:revoked");
        assert.ok(
          (await audit({ action: "session.stream.close", outcome: "closed" }))
            .length >= 1,
          "a stream that simply closed is recorded as closed",
        );
        await store.memberships.updateOne(
          { userId: ownerId, tenantId: "demo" },
          { $set: { role: "admin" } },
        );
      },
    );

    async function waitForAudit(filter: Record<string, unknown>) {
      await waitFor(async () => (await audit(filter)).length > 0, {
        what: `audit ${JSON.stringify(filter)}`,
      });
      return audit(filter);
    }

    await t.test(
      "browser rules: origin, content type, cookies of the wrong app, tab races",
      async () => {
        // State-changing requests need the app's exact Origin and JSON.
        const bare = await fetch(`${p.base}/api/projects`, {
          method: "POST",
          headers: {
            cookie: B,
            "content-type": "application/json",
            "x-forwarded-for": p.nextIp(),
          },
          body: JSON.stringify({ name: "x" }),
        });
        assert.equal(bare.status, 403, "no Origin");
        for (const origin of [
          "null",
          "https://evil.example",
          "http://localhost:3000.evil.example",
          "http://localhost:30000",
        ]) {
          const r = await p.request(
            B,
            "POST",
            "/api/projects",
            { name: "x" },
            { headers: { Origin: origin } },
          );
          assert.equal(r.status, 403, origin);
          assert.equal(r.data.code, "CSRF_ORIGIN");
        }
        const text = await fetch(`${p.base}/api/projects`, {
          method: "POST",
          headers: {
            cookie: B,
            origin: "http://localhost:3000",
            "content-type": "text/plain",
            "x-forwarded-for": p.nextIp(),
          },
          body: "name=x",
        });
        assert.equal(text.status, 415);

        // An admin-app session is not a main-app session, and vice versa.
        const admin = await p.adminCookie();
        const wrongApp = await get(admin, "/api/me");
        assert.equal(wrongApp.status, 403);
        assert.equal(wrongApp.data.code, "WRONG_APP");
        assert.equal((await get(B, "/api/admin/tenants")).status, 403);

        // Switching to a workspace you are not in, or one that is disabled.
        assert.equal(
          (await post(B, "/auth/switch-tenant", { tenantId: "acme" })).status,
          403,
        );
        await p.addMember(claims("bob"), "legacy", "user");
        await store.tenantRegistry.updateOne(
          { _id: "legacy" },
          { $set: { status: "disabled" } },
        );
        store.invalidateTenant("legacy");
        assert.equal(
          (await post(B, "/auth/switch-tenant", { tenantId: "legacy" })).status,
          403,
        );
        await store.tenantRegistry.updateOne(
          { _id: "legacy" },
          { $set: { status: "active" } },
        );

        // Two tabs switching at once with one cookie: one wins, no orphan session remains.
        const before = await store.authSessions.countDocuments({
          userId: bobId,
        });
        const racers = await Promise.all([
          post(B, "/auth/switch-tenant", { tenantId: "legacy" }),
          post(B, "/auth/switch-tenant", { tenantId: "demo" }),
        ]);
        assert.deepEqual(racers.map((r) => r.status).sort(), [200, 401]);
        assert.equal(
          await store.authSessions.countDocuments({ userId: bobId }),
          before,
          "exactly one session replaced the old",
        );
        assert.equal(
          (await get(B, "/api/me")).status,
          401,
          "the rotated-away cookie is dead",
        );
      },
    );

    await t.test(
      "removing a member signs them out and asks the runtime to stop their turns",
      async () => {
        const admin = await p.adminCookie();
        const Bnew = await p.session(claims("bob"));
        assert.equal((await get(Bnew, "/api/me")).status, 200);
        const mark = core.mark();
        const removed = await p.request(
          admin,
          "DELETE",
          `/api/admin/tenants/demo/members/${bobId}`,
        );
        assert.equal(removed.status, 200, removed.text);
        assert.ok(removed.data.sessionsRevoked >= 1);
        assert.equal((await get(Bnew, "/api/me")).status, 401);
        // The stop request is recorded with its honest outcome.
        const [row] = await waitForAudit({
          action: "turns.stop",
          "target.id": bobId,
        });
        assert.ok(row.detail && Number(row.detail.attempted) >= 1);
        assert.equal(
          Number(row.detail.attempted),
          Number(row.detail.stopped) +
            Number(row.detail.idle) +
            Number(row.detail.failed),
        );
        assert.ok(core.since(mark).some((c) => c.path.endsWith("/interrupt")));
        assert.ok((await audit({ action: "member.remove" })).length >= 1);
        // Removal is a tombstone: signing in again does not bring them back to
        // the demo. They still reach any other workspace they belong to.
        const back = await p.signIn(claims("bob"));
        assert.ok(back.cookie);
        assert.equal(
          (await get(back.cookie, "/api/me")).data.tenant.id,
          "legacy",
        );
        assert.equal(
          (await store.memberships.findOne({ userId: bobId, tenantId: "demo" }))
            ?.status,
          "removed",
        );
        // Someone with nowhere else to go is told their access ended.
        const q = await id("quser2");
        await store.memberships.updateOne(
          { userId: q, tenantId: "demo" },
          { $set: { status: "removed" } },
        );
        const only = await p.signIn(claims("quser2"));
        assert.equal(only.cookie, undefined);
        assert.equal(only.location.searchParams.get("error"), "access_removed");
      },
    );

    assert.doesNotMatch(
      p.logs(),
      /sk-super-secret|id_token|eyJ[A-Za-z0-9_-]{10}/,
    );
    void hashToken;
  },
);

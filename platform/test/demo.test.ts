import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Store } from "../src/store";
import { createTenant } from "../src/admin";
import { cacheMs, demoConfig, demoReadiness } from "../src/demo";
import { revalidateMs, streamLimit } from "../src/streams";
import { auditRetentionMs } from "../src/audit";
import { emailKey } from "../src/auth";
import { issueInvite } from "../src/invites";
import { effectivePrivacy } from "../src/tenant";
import { startPlatform, type Claims, FRONTEND } from "./harness";

const claims = (name: string, extra: Partial<Claims> = {}): Claims => ({
  sub: `sub-${name}`,
  email: `${name}@gmail.com`,
  email_verified: true,
  name,
  ...extra,
});

test("demoConfig: disabled without DEMO_TENANT_ID; never the default tenant; no unlimited defaults", () => {
  assert.equal(demoConfig({}), undefined);
  assert.equal(demoConfig({ DEMO_TENANT_ID: "  " }), undefined);
  assert.throws(
    () => demoConfig({ DEMO_TENANT_ID: "default" }),
    /cannot be "default"/,
  );
  assert.throws(
    () => demoConfig({ DEMO_TENANT_ID: "Bad_Id" }),
    /Invalid tenant id/,
  );
  // A database name is not a tenant id.
  assert.throws(
    () => demoConfig({ DEMO_TENANT_ID: "truex_t_demo" }),
    /Invalid tenant id/,
  );
  const config = demoConfig({ DEMO_TENANT_ID: "demo" })!;
  assert.equal(config.tenantId, "demo");
  // 50 turns per person is the declared baseline; the shared ceilings have no
  // default, so an unset one blocks admission instead of meaning "unlimited".
  assert.equal(config.turnsPerUser, 50);
  assert.equal(config.turnsGlobal, undefined);
  assert.equal(config.signupsPerDay, undefined);
  for (const bad of ["0", "-1", "1.5", "many", "99999999999"])
    assert.throws(
      () =>
        demoConfig({ DEMO_TENANT_ID: "demo", DEMO_DAILY_TURNS_GLOBAL: bad }),
      /DEMO_DAILY_TURNS_GLOBAL must be a whole number/,
    );
});

test("a blank line copied from .env.example means the default, for every optional setting", () => {
  // Blank must never become zero, "unlimited" or "no caching".
  assert.equal(cacheMs({ DEMO_CACHE_MS: "" }), 30_000);
  assert.equal(cacheMs({ DEMO_CACHE_MS: "   " }), 30_000);
  assert.equal(cacheMs({}), 30_000);
  assert.equal(cacheMs({ DEMO_CACHE_MS: "500" }), 500);
  assert.equal(
    cacheMs({ DEMO_CACHE_MS: "0" }),
    0,
    "an explicit zero is honoured",
  );
  assert.equal(cacheMs({ DEMO_CACHE_MS: "99999999" }), 300_000);
  assert.equal(cacheMs({ DEMO_CACHE_MS: "soon" }), 30_000);
  const blank = demoConfig({
    DEMO_TENANT_ID: "demo",
    DEMO_DAILY_TURNS_PER_USER: "",
    DEMO_DAILY_TURNS_GLOBAL: "",
    DEMO_DAILY_SIGNUPS: "",
  })!;
  assert.equal(blank.turnsPerUser, 50);
  assert.equal(
    blank.turnsGlobal,
    undefined,
    "blank ceilings block admission; they do not mean unlimited",
  );
  assert.equal(blank.signupsPerDay, undefined);
  assert.equal(demoConfig({ DEMO_TENANT_ID: "" }), undefined);
  assert.equal(revalidateMs({ STREAM_REVALIDATE_MS: "" }), 10_000);
  assert.equal(streamLimit({ STREAMS_PER_USER_MAX: "" }), 10);
  assert.equal(
    auditRetentionMs({ AUDIT_RETENTION_DAYS: "" }),
    365 * 86_400_000,
  );
});

test("privacy: one effective policy; disagreeing or unknown values are invalid, never defaulted", () => {
  assert.deepEqual(effectivePrivacy({}), { invalid: false });
  assert.deepEqual(effectivePrivacy({ chatVisibility: "own" }), {
    isUserSpecific: true,
    invalid: false,
  });
  assert.deepEqual(effectivePrivacy({ chatVisibility: "all" }), {
    isUserSpecific: false,
    invalid: false,
  });
  assert.deepEqual(effectivePrivacy({ isUserSpecific: true }), {
    isUserSpecific: true,
    invalid: false,
  });
  assert.deepEqual(
    effectivePrivacy({ isUserSpecific: false, chatVisibility: "all" }),
    {
      isUserSpecific: false,
      invalid: false,
    },
  );
  for (const doc of [
    { isUserSpecific: true, chatVisibility: "all" },
    { isUserSpecific: false, chatVisibility: "own" },
    { isUserSpecific: "true" },
    { isUserSpecific: null },
    { chatVisibility: "everyone" },
    { chatVisibility: null },
  ])
    assert.equal(
      effectivePrivacy(doc as never).invalid,
      true,
      JSON.stringify(doc),
    );
});

test(
  "demo readiness reports every missing prerequisite, then passes",
  { timeout: 120_000 },
  async (t) => {
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const store = await new Store(mongo.getUri(), "ready", "ready").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    const config = demoConfig({
      DEMO_TENANT_ID: "demo",
      DEMO_DAILY_TURNS_GLOBAL: "100",
      DEMO_DAILY_SIGNUPS: "50",
    })!;
    const check = (requireOpen?: boolean) =>
      demoReadiness(store, config, { authMode: "google", requireOpen });

    assert.deepEqual((await check()).problems.includes("TENANT_MISSING"), true);
    await createTenant(store, { id: "demo", name: "Demo" });
    let r = await check(false);
    assert.equal(r.ready, false);
    assert.ok(r.problems.includes("MODELS_NOT_ALLOW_LISTED"));
    assert.ok(r.problems.includes("SKILLS_NOT_ALLOW_LISTED"));
    // Pre-flight does not need the admission switch; the live check does.
    assert.ok(!r.problems.includes("ADMISSION_NOT_OPEN"));
    assert.ok((await check(true)).problems.includes("ADMISSION_NOT_OPEN"));
    // A model that is allow-listed but not in the catalog is not approved.
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { allowedModelIds: ["ghost"], allowedSkillIds: [] } },
    );
    assert.ok((await check(false)).problems.includes("MODEL_UNAVAILABLE"));
    await store.profiles.insertOne({
      _id: "m1",
      provider: "p",
      baseUrl: "http://x/v1",
      modelName: "m",
      apiKey: "k",
    });
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { allowedModelIds: ["m1"] } },
    );
    r = await check(false);
    assert.deepEqual(r.problems, [], r.problems.join(","));
    assert.equal(r.ready, true);

    // Shared limits unset, a global handle index, and a shared privacy policy
    // each block admission on their own.
    const noLimits = await demoReadiness(
      store,
      demoConfig({ DEMO_TENANT_ID: "demo" })!,
      { authMode: "google", requireOpen: false },
    );
    assert.deepEqual(noLimits.problems.sort(), [
      "DEMO_DAILY_SIGNUPS_UNSET",
      "DEMO_DAILY_TURNS_GLOBAL_UNSET",
    ]);
    assert.ok(
      (
        await demoReadiness(store, config, {
          authMode: "dev",
          requireOpen: false,
        })
      ).problems.includes("AUTH_MODE_NOT_GOOGLE"),
    );
    const db = store.client.db("truex_t_demo");
    await db
      .collection("truex_agents")
      .createIndex({ handle: 1 }, { unique: true, sparse: true });
    assert.ok(
      (await check(false)).problems.includes("GLOBAL_HANDLE_INDEX_PRESENT"),
    );
    await db.collection("truex_agents").dropIndex("handle_1");
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { isUserSpecific: false, chatVisibility: "all" } },
    );
    assert.ok(
      (await check(false)).problems.includes("PRIVACY_NOT_USER_SPECIFIC"),
    );
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { chatVisibility: "own" } },
    );
    assert.ok((await check(false)).problems.includes("PRIVACY_INVALID"));
    // A mapping that is not the generated name, or a disabled tenant, is refused.
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { isUserSpecific: true, chatVisibility: "own" } },
    );
    assert.deepEqual((await check(false)).problems, []);
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { dbName: "some_other_db" } },
    );
    assert.ok((await check(false)).problems.includes("DB_NAME_MISMATCH"));
    // The catalog's own database, or the default tenant's, is never a demo database.
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { dbName: "ready" } },
    );
    assert.ok((await check(false)).problems.includes("DB_SHARED"));
    await store.tenantRegistry.updateOne(
      { _id: "demo" },
      { $set: { dbName: "truex_t_demo", status: "disabled" } },
    );
    assert.ok((await check(false)).problems.includes("TENANT_DISABLED"));
  },
);

test(
  "public demo: sign-up, admission, removal and role rules over real HTTP",
  { timeout: 240_000 },
  async (t) => {
    const p = await startPlatform({
      env: {
        DEMO_TENANT_ID: "demo",
        DEMO_DAILY_TURNS_GLOBAL: "100",
        DEMO_DAILY_SIGNUPS: "6",
        DEMO_CACHE_MS: "100",
      },
    });
    t.after(() => p.stop());
    const { store } = p;
    await p.workspace("demo", "Demo");
    await p.approveDemoModel("demo");
    await p.workspace("acme", "Acme");
    await p.workspace("gone", "Gone");
    await store.tenantRegistry.updateOne(
      { _id: "gone" },
      { $set: { status: "disabled" } },
    );
    const admin = await p.adminCookie();
    const patch = (id: string, body: unknown) =>
      p.request(admin, "PATCH", `/api/admin/tenants/${id}`, body);
    const wait100 = () => new Promise((r) => setTimeout(r, 250));
    const demoMembers = (role?: string) =>
      store.memberships.countDocuments({
        tenantId: "demo",
        ...(role ? { role: role as "user" } : {}),
      });

    await t.test(
      "closed by default: nobody is enrolled while admission is inviteOnly",
      async () => {
        const result = await p.signIn(claims("early"));
        assert.equal(result.cookie, undefined);
        assert.equal(result.location.searchParams.get("error"), "not_invited");
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-early" }),
          0,
        );
        assert.equal(await demoMembers(), 0);
      },
    );

    await t.test(
      "open admission is for the configured demo only, and only when ready",
      async () => {
        assert.equal(
          (await patch("acme", { admissionPolicy: "open" })).data.code,
          "ADMISSION_NOT_ALLOWED",
        );
        assert.equal(
          (await patch("default", { admissionPolicy: "open" })).data.code,
          "ADMISSION_NOT_ALLOWED",
        );
        assert.equal(
          (await patch("demo", { admissionPolicy: "sometimes" })).status,
          400,
        );
        // Not ready: no approved models.
        await store.tenantRegistry.updateOne(
          { _id: "demo" },
          { $unset: { allowedModelIds: "", allowedSkillIds: "" } },
        );
        p.store.invalidateTenant("demo");
        const refused = await patch("demo", { admissionPolicy: "open" });
        assert.equal(refused.status, 409);
        assert.equal(refused.data.code, "DEMO_NOT_READY");
        assert.match(refused.data.error, /MODELS_NOT_ALLOW_LISTED/);
        assert.equal(
          (await store.tenantRegistry.findOne({ _id: "demo" }))
            ?.admissionPolicy,
          "inviteOnly",
        );
        await p.approveDemoModel("demo");
        const report = await p.request(admin, "GET", "/api/admin/demo");
        assert.equal(report.data.enabled, true);
        assert.deepEqual(report.data.problems, ["ADMISSION_NOT_OPEN"]);
        // Privacy cannot be relaxed, and the two spellings must agree.
        assert.equal(
          (await patch("demo", { isUserSpecific: false })).data.code,
          "PRIVACY_LOCKED",
        );
        assert.equal(
          (await patch("demo", { chatVisibility: "all" })).data.code,
          "PRIVACY_LOCKED",
        );
        assert.equal(
          (await patch("demo", { isUserSpecific: true, chatVisibility: "all" }))
            .status,
          400,
        );
        const opened = await patch("demo", { admissionPolicy: "open" });
        assert.equal(opened.status, 200, opened.text);
        assert.equal(opened.data.tenant.admissionPolicy, "open");
        assert.equal(opened.data.tenant.isUserSpecific, true);
        assert.equal(
          (await p.request(admin, "GET", "/api/admin/demo")).data.ready,
          true,
        );
      },
    );

    await t.test(
      "personal Gmail sign-up: a regular user, a session, and nothing client-chosen",
      async () => {
        // Role, workspace and owner are not inputs: every attempt is ignored.
        const forged = await fetch(
          `${p.base}/auth/google/start?role=admin&tenant=acme&tenantId=acme&userId=u_x&dbName=admin`,
          {
            redirect: "manual",
            headers: {
              "x-forwarded-for": p.nextIp(),
              "x-truex-role": "admin",
              "x-truex-tenant": "acme",
            },
          },
        );
        assert.equal(forged.status, 302);
        const alice = await p.signIn(claims("alice"), undefined);
        assert.ok(alice.cookie);
        assert.equal(alice.location.href, `${FRONTEND}/`);
        const user = await store.users.findOne({ googleSub: "sub-alice" });
        assert.ok(user);
        assert.match(user._id, /^u_[0-9a-f-]{36}$/);
        const membership = await store.memberships.findOne({
          userId: user._id,
          tenantId: "demo",
        });
        assert.equal(membership?.role, "user");
        assert.equal(membership?.status, "active");
        const me = await p.request(alice.cookie, "GET", "/api/me", undefined, {
          headers: {
            "x-truex-role": "admin",
            "x-truex-tenant": "acme",
            "x-truex-user": "someone",
          },
        });
        assert.equal(me.status, 200);
        assert.equal(me.data.user.id, user._id);
        assert.equal(me.data.role, "user");
        assert.equal(me.data.tenant.id, "demo");
        assert.equal(me.data.tenant.isUserSpecific, true);
        assert.deepEqual(
          me.data.tenants.map((x: { id: string }) => x.id),
          ["demo"],
        );
        // Every /api and /auth response is private to the person and uncacheable.
        assert.equal(me.headers.get("cache-control"), "no-store");
        assert.match(me.headers.get("vary") ?? "", /Cookie/i);
        assert.equal(JSON.stringify(me.data).includes("dbName"), false);
      },
    );

    await t.test(
      "a Google Workspace account signs up the same way",
      async () => {
        const result = await p.signIn(
          claims("jane", {
            email: "jane.doe@acme.example",
            hd: "acme.example",
          }),
        );
        assert.ok(result.cookie);
        const user = await store.users.findOne({ googleSub: "sub-jane" });
        assert.equal(user?.emailKey, "jane.doe@acme.example");
        assert.equal(
          (await store.memberships.findOne({ userId: user!._id }))?.role,
          "user",
        );
        // Another person whose address differs only by a dot is a different account.
        const other = await p.signIn(
          claims("janedoe", {
            email: "janedoe@acme.example",
            hd: "acme.example",
          }),
        );
        assert.ok(other.cookie);
        assert.notEqual(
          (await store.users.findOne({ googleSub: "sub-janedoe" }))?._id,
          user!._id,
        );
      },
    );

    await t.test(
      "returning user keeps their id and role; nothing is added",
      async () => {
        const before = await store.users.findOne({ googleSub: "sub-alice" });
        const again = await p.signIn(claims("alice"));
        assert.ok(again.cookie);
        const after = await store.users.findOne({ googleSub: "sub-alice" });
        assert.equal(after?._id, before?._id);
        assert.equal(
          await store.memberships.countDocuments({ userId: before!._id }),
          1,
        );
        // The second login ends the first browser session, not other devices'.
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-alice" }),
          1,
        );
      },
    );

    await t.test(
      "parallel first sign-ins of one Google account create one user and one membership",
      async () => {
        const results = await Promise.all(
          [1, 2, 3, 4].map(() => p.signIn(claims("racer"))),
        );
        for (const r of results) assert.ok(r.cookie, String(r.location));
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-racer" }),
          1,
        );
        const user = (await store.users.findOne({ googleSub: "sub-racer" }))!;
        assert.equal(
          await store.memberships.countDocuments({ userId: user._id }),
          1,
        );
        assert.equal(
          (await store.memberships.findOne({ userId: user._id }))?.role,
          "user",
        );
      },
    );

    await t.test(
      "a removed member stays removed, however often they sign in",
      async () => {
        const user = (await store.users.findOne({ googleSub: "sub-alice" }))!;
        await store.memberships.updateOne(
          { userId: user._id, tenantId: "demo" },
          { $set: { status: "removed" } },
        );
        for (let i = 0; i < 2; i++) {
          const result = await p.signIn(claims("alice"));
          assert.equal(result.cookie, undefined);
          assert.equal(
            result.location.searchParams.get("error"),
            "access_removed",
          );
          assert.equal(result.location.pathname, "/login");
        }
        const row = await store.memberships.findOne({
          userId: user._id,
          tenantId: "demo",
        });
        assert.equal(row?.status, "removed");
        assert.equal(
          await store.memberships.countDocuments({ userId: user._id }),
          1,
        );

        // With another valid membership they get that workspace, and demo stays closed to them.
        await p.addMember(claims("alice"), "acme", "user");
        const other = await p.signIn(claims("alice"));
        assert.ok(other.cookie);
        const me = await p.request(other.cookie, "GET", "/api/me");
        assert.equal(me.data.tenant.id, "acme");
        assert.equal(
          (
            await store.memberships.findOne({
              userId: user._id,
              tenantId: "demo",
            })
          )?.status,
          "removed",
        );
        // Only a new, authorized invitation restores them, with the same user id.
        const doc = (await store.tenantRegistry.findOne({ _id: "demo" }))!;
        const invite = await issueInvite(store, {
          tenant: doc,
          email: "alice@gmail.com",
          role: "user",
        });
        const restored = await p.signIn(claims("alice"), invite.token);
        assert.ok(restored.cookie);
        assert.equal(
          (
            await store.memberships.findOne({
              userId: user._id,
              tenantId: "demo",
            })
          )?.status,
          "active",
        );
      },
    );

    await t.test(
      "people with a workspace are not added to the demo; disabled accounts and workspaces get nothing",
      async () => {
        const before = await demoMembers();
        // A customer member signs in to their workspace, with no demo membership.
        await p.addMember(claims("carol"), "acme", "admin");
        const carol = await p.signIn(claims("carol"));
        assert.ok(carol.cookie);
        assert.equal(
          (await p.request(carol.cookie, "GET", "/api/me")).data.tenant.id,
          "acme",
        );
        // A member whose only workspace is disabled is told so, not enrolled elsewhere.
        await p.addMember(claims("gina"), "gone", "user");
        const gina = await p.signIn(claims("gina"));
        assert.equal(gina.cookie, undefined);
        assert.equal(
          gina.location.searchParams.get("error"),
          "tenant_disabled",
        );
        // A disabled account cannot sign in or be enrolled.
        const uid = await p.addMember(claims("dave"), "acme", "user");
        await store.users.updateOne(
          { _id: uid },
          { $set: { status: "disabled" } },
        );
        const dave = await p.signIn(claims("dave"));
        assert.equal(
          dave.location.searchParams.get("error"),
          "account_disabled",
        );
        assert.equal(await demoMembers(), before);
      },
    );

    await t.test(
      "nobody becomes admin by signing up; the product owner is made one explicitly",
      async () => {
        assert.equal(await demoMembers("admin"), 0);
        const doc = (await store.tenantRegistry.findOne({ _id: "demo" }))!;
        // The explicit, trusted operation: an admin invitation for the owner.
        const invite = await issueInvite(store, {
          tenant: doc,
          email: "owner@gmail.com",
          role: "admin",
        });
        const owner = await p.signIn(claims("owner"), invite.token);
        assert.ok(owner.cookie);
        const me = await p.request(owner.cookie, "GET", "/api/me");
        assert.equal(me.data.role, "admin");
        assert.equal(me.data.tenant.id, "demo");
        assert.equal(await demoMembers("admin"), 1);
        // Signing in again, or being enrolled-by-login logic, never changes it.
        const again = await p.signIn(claims("owner"));
        assert.equal(
          (await p.request(again.cookie, "GET", "/api/me")).data.role,
          "admin",
        );
        // The consumed admin invitation cannot restore admin after a demotion.
        const uid = (await store.users.findOne({ googleSub: "sub-owner" }))!
          ._id;
        await store.memberships.updateOne(
          { userId: uid, tenantId: "demo" },
          { $set: { role: "user" } },
        );
        const replay = await p.signIn(claims("owner"), invite.token);
        assert.equal(replay.cookie, undefined);
        assert.equal(replay.location.searchParams.get("error"), "invite_used");
        assert.equal(
          (await store.memberships.findOne({ userId: uid, tenantId: "demo" }))
            ?.role,
          "user",
        );
        await store.memberships.updateOne(
          { userId: uid, tenantId: "demo" },
          { $set: { role: "admin" } },
        );
        // A failed invitation never falls back to demo enrollment.
        const stranger = await p.signIn(claims("stranger"), invite.token);
        assert.equal(stranger.cookie, undefined);
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-stranger" }),
          0,
        );
      },
    );

    await t.test(
      "a different Google account holding the same address is a conflict, not a merge",
      async () => {
        const result = await p.signIn(
          claims("alice2", { email: "A.Lice@gmail.com", sub: "sub-impostor" }),
        );
        assert.equal(result.cookie, undefined);
        assert.equal(
          result.location.searchParams.get("error"),
          "account_conflict",
        );
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-impostor" }),
          0,
        );
        // The same subject changing address keeps the same account.
        const before = (await store.users.findOne({ googleSub: "sub-jane" }))!;
        const moved = await p.signIn(
          claims("jane", { email: "jane.d@acme.example", hd: "acme.example" }),
        );
        assert.ok(moved.cookie);
        const after = (await store.users.findOne({ googleSub: "sub-jane" }))!;
        assert.equal(after._id, before._id);
        assert.equal(after.emailKey, emailKey("jane.d@acme.example"));
        // ...unless that address belongs to someone else: identity kept, address not taken.
        const taken = await p.signIn(
          claims("jane", { email: "janedoe@acme.example", hd: "acme.example" }),
        );
        assert.ok(taken.cookie);
        assert.equal(
          (await store.users.findOne({ googleSub: "sub-jane" }))?.emailKey,
          after.emailKey,
        );
      },
    );

    await t.test(
      "display claims are bounded and cannot carry markup, bidi or credentials",
      async () => {
        const result = await p.signIn(
          claims("mallory", {
            name:
              "\u202e<img src=x onerror=alert(1)>\u0000  Mal\u200blory " +
              "x".repeat(500),
            picture: "https://user:pw@evil.example/a.png",
          }),
        );
        assert.ok(result.cookie);
        const user = (await store.users.findOne({ googleSub: "sub-mallory" }))!;
        assert.ok(user.name && [...user.name].length <= 100);
        assert.doesNotMatch(user.name!, /[\u0000-\u001f\u200b\u202a-\u202e]/);
        assert.equal(user.picture, undefined);
        const ok = await p.signIn(
          claims("maud", {
            picture: "https://lh3.googleusercontent.com/a/photo=s96",
          }),
        );
        assert.ok(ok.cookie);
        assert.equal(
          (await store.users.findOne({ googleSub: "sub-maud" }))?.picture,
          "https://lh3.googleusercontent.com/a/photo=s96",
        );
      },
    );

    await t.test(
      "the daily new-account budget stops sign-ups without spending on a refusal",
      async () => {
        // Budget 6: alice, jane, janedoe, racer, mallory and maud (invitations don't count).
        const used = await store.demoUsage.findOne({
          _id: `${new Date().toISOString().slice(0, 10)}:demo:signups`,
        });
        assert.ok(used && used.count >= 1);
        let refused: string | null = null;
        for (let i = 0; i < 8 && !refused; i++) {
          const r = await p.signIn(claims(`bulk${i}`));
          if (!r.cookie) refused = r.location.searchParams.get("error");
        }
        assert.equal(refused, "signup_limit");
        const created = await store.users.countDocuments({
          googleSub: /^sub-bulk/,
        });
        const counter = await store.demoUsage.findOne({
          _id: `${new Date().toISOString().slice(0, 10)}:demo:signups`,
        });
        // Exactly the admitted accounts were counted; the refused one added
        // neither an account nor a count.
        assert.equal(counter!.count, 6);
        assert.equal(created, 0);
        // Existing members are unaffected by the budget.
        assert.ok((await p.signIn(claims("maud"))).cookie);
      },
    );

    await t.test(
      "a forged or misdirected ID token never signs anyone in",
      async () => {
        const before = await store.users.countDocuments();
        for (const how of [
          "signature",
          "audience",
          "issuer",
          "expired",
          "nonce",
        ] as const) {
          p.idp.tamper(how);
          const result = await p.signIn(claims(`forger-${how}`));
          assert.equal(result.cookie, undefined, how);
          assert.equal(result.location.pathname, "/login", how);
          assert.equal(
            result.location.searchParams.get("error"),
            "google_failed",
            how,
          );
        }
        p.idp.tamper(undefined);
        assert.equal(
          await store.users.countDocuments(),
          before,
          "no account was created",
        );
        assert.ok(
          (await p.signIn(claims("maud"))).cookie,
          "and the same flow works untampered",
        );
      },
    );

    await t.test(
      "closing admission and disabling the demo are separate controls",
      async () => {
        await patch("demo", { admissionPolicy: "inviteOnly" });
        await wait100();
        // Existing demo members still sign in; new people are refused.
        assert.ok((await p.signIn(claims("maud"))).cookie);
        const late = await p.signIn(claims("late"));
        assert.equal(late.location.searchParams.get("error"), "not_invited");
        // Disabled workspace: nobody gets in, and everyone inside is signed out.
        await patch("demo", { admissionPolicy: "open" });
        const live = await p.session(claims("maud"));
        assert.equal((await p.request(live, "GET", "/api/me")).status, 200);
        const off = await patch("demo", { status: "disabled" });
        assert.equal(off.status, 200);
        assert.equal(
          (await p.request(live, "GET", "/api/me")).status,
          401,
          "sessions revoked",
        );
        await wait100();
        const blocked = await p.signIn(claims("newbie"));
        assert.equal(blocked.cookie, undefined);
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-newbie" }),
          0,
        );
        // The disabled demo is not re-enabled by readiness or by signing in.
        assert.equal(
          (await store.tenantRegistry.findOne({ _id: "demo" }))?.status,
          "disabled",
        );
        assert.equal(
          (await p.request(admin, "GET", "/api/admin/demo")).data.ready,
          false,
        );
        await patch("demo", { status: "active" });
      },
    );

    await t.test(
      "a demo that is not ready admits no one and never falls back",
      async () => {
        await store.tenantRegistry.updateOne(
          { _id: "demo" },
          { $unset: { allowedModelIds: "" } },
        );
        p.store.invalidateTenant("demo");
        await wait100();
        const result = await p.signIn(claims("hopeful"));
        assert.equal(result.cookie, undefined);
        assert.equal(
          result.location.searchParams.get("error"),
          "demo_unavailable",
        );
        assert.equal(
          await store.users.countDocuments({ googleSub: "sub-hopeful" }),
          0,
        );
        assert.equal(
          await store.memberships.countDocuments({ tenantId: "default" }),
          0,
          "no implicit-default fallback",
        );
        // /healthz reports the flag, not the reasons.
        const health = await fetch(`${p.base}/healthz`).then((r) => r.json());
        assert.deepEqual(health.demo, { enabled: true, ready: false });
        await p.approveDemoModel("demo");
      },
    );

    assert.doesNotMatch(p.logs(), /id_token|eyJ[A-Za-z0-9_-]{10}/);
  },
);

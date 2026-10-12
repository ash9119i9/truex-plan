import { testEnvironment } from "./environment";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { startPlatform, type Platform } from "./harness";
import { defaultSignupSettings } from "../src/google";
import { workspaceInviteView } from "../src/workspaces";
import { issueInvite } from "../src/invites";

const exec = promisify(execFile);
async function provision(p: Platform, args: string[] = []) {
  return exec(
    process.execPath,
    [resolve("../scripts/tenant.mjs"), "provision-default", ...args],
    {
      env: testEnvironment({
        MONGO_URI: p.mongo.getUri(),
        MONGO_DB: p.store.database,
        CATALOG_MONGO_DB: p.store.catalogDatabase,
        DEFAULT_SIGNUP_TENANT_ID: "default-tenant",
      }),
    },
  );
}

test("default signup settings validate explicit operator configuration", () => {
  assert.deepEqual(defaultSignupSettings({}), {
    enabled: true,
    tenantId: "default-tenant",
  });
  assert.equal(
    defaultSignupSettings({ DEFAULT_TENANT_SIGNUP: "off" }).enabled,
    false,
  );
  assert.equal(
    defaultSignupSettings({ DEFAULT_SIGNUP_TENANT_ID: "public" }).tenantId,
    "public",
  );
  assert.throws(() =>
    defaultSignupSettings({ DEFAULT_TENANT_SIGNUP: "invalid" }),
  );
  for (const id of ["../team", "UPPER", "x".repeat(33)])
    assert.throws(() =>
      defaultSignupSettings({ DEFAULT_SIGNUP_TENANT_ID: id }),
    );
  const failed = workspaceInviteView({
    id: "inv_test",
    tenantId: "team",
    email: "member@gmail.com",
    role: "user",
    status: "pending",
    delivery: "not sent",
    createdAt: "now",
    expiresAt: "later",
    sendError: "private provider detail",
  });
  assert.ok(!failed.sendError?.includes("private provider detail"));
});

test(
  "operator-only tenants, default signup and existing invitation flows",
  { timeout: 180_000 },
  async (t) => {
    const p = await startPlatform({ env: { SELF_SERVICE_WORKSPACES: "on" } });
    t.after(() => p.stop());
    const who = (id: string) => ({ sub: id, email: `${id}@gmail.com` });

    await t.test(
      "unprovisioned signup fails without creating a tenant, account or membership",
      async () => {
        const result = await p.signIn(who("missing-default"));
        assert.equal(result.cookie, undefined);
        assert.equal(
          result.location.searchParams.get("error"),
          "default_unavailable",
        );
        assert.equal(await p.store.tenantRegistry.countDocuments(), 0);
        assert.equal(await p.store.users.countDocuments(), 0);
        assert.equal(await p.store.memberships.countDocuments(), 0);
      },
    );
    await t.test("operator script is dry-run safe and repeatable", async () => {
      await provision(p, ["--dry-run"]);
      assert.equal(await p.store.tenantRegistry.countDocuments(), 0);
      await provision(p);
      await provision(p);
      const tenant = (await p.store.tenantRegistry.findOne({
        _id: "default-tenant",
      }))!;
      assert.equal(tenant.name, "Default tenant");
      assert.equal(tenant.provisioningStatus, "ready");
      assert.equal(tenant.isUserSpecific, true);
      assert.equal(tenant.dbName, "truex_t_default_tenant");
      assert.equal(await p.store.tenantRegistry.countDocuments(), 1);
      assert.equal(await p.store.memberships.countDocuments(), 0);
      assert.equal(
        await p.store.client
          .db(tenant.dbName)
          .collection("truex_agents")
          .countDocuments(),
        0,
      );
      await assert.rejects(provision(p, ["default"]));
    });
    const owner = who("independent");
    const first = await p.signIn(owner);
    assert.equal(first.location.pathname, "/");
    assert.ok(first.cookie);
    let cookie = first.cookie!;
    const user = (await p.store.users.findOne({ googleSub: owner.sub }))!;

    await t.test(
      "independent signup enters Default tenant as a member, with no personal tenant",
      async () => {
        const me = await p.request(cookie, "GET", "/api/me");
        assert.equal(me.status, 200);
        assert.equal(me.data.tenant.id, "default-tenant");
        assert.equal(me.data.tenant.name, "Default tenant");
        assert.equal(me.data.tenant.isUserSpecific, true);
        assert.equal(me.data.role, "user");
        assert.equal(me.data.selfService, false);
        assert.equal(me.data.showWorkspaces, false);
        const account = await p.request(cookie, "GET", "/auth/account");
        assert.equal(account.data.canCreate, false);
        assert.equal(account.data.canManageInvites, true);
        assert.equal(account.data.showWorkspaces, false);
        assert.deepEqual(account.data.pendingWorkspaces, []);
        assert.equal(await p.store.tenantRegistry.countDocuments(), 1);
        assert.equal(
          (await p.store.users.findOne({ _id: user._id }))?.lastTenantId,
          "default-tenant",
        );
      },
    );
    await t.test(
      "simultaneous repeated signups produce one account and one membership",
      async () => {
        const identity = who("concurrent");
        const replies = await Promise.all(
          Array.from({ length: 8 }, () => p.signIn(identity)),
        );
        assert.ok(
          replies.every((r) => r.cookie && r.location.pathname === "/"),
          JSON.stringify(
            replies.map((r) => ({
              path: r.location.pathname,
              error: r.location.searchParams.get("error"),
            })),
          ),
        );
        const account = (await p.store.users.findOne({
          googleSub: identity.sub,
        }))!;
        assert.equal(
          await p.store.users.countDocuments({ googleSub: identity.sub }),
          1,
        );
        assert.equal(
          await p.store.memberships.countDocuments({ userId: account._id }),
          1,
        );
        assert.equal(await p.store.tenantRegistry.countDocuments(), 1);
      },
    );
    await t.test(
      "ordinary members cannot create tenants or send invitations",
      async () => {
        for (const input of [
          { kind: "personal" },
          { kind: "team", name: "Team", tenantId: "other", role: "admin" },
          {},
        ]) {
          const denied = await p.request(
            cookie,
            "POST",
            "/auth/workspaces",
            input,
          );
          assert.equal(denied.status, 403);
          assert.equal(denied.data.code, "TENANT_CREATION_OPERATOR_ONLY");
        }
        assert.equal(
          (await p.request(undefined, "POST", "/auth/workspaces", {})).status,
          401,
        );
        assert.equal(
          (
            await p.request(
              cookie,
              "POST",
              "/auth/workspaces",
              {},
              { headers: { Origin: "https://evil.example" } },
            )
          ).data.code,
          "CSRF_ORIGIN",
        );
        assert.equal(
          (
            await p.request(
              cookie,
              "POST",
              "/auth/workspaces/default-tenant/invites",
              { email: "outsider@gmail.com", role: "admin" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await p.request(cookie, "POST", "/api/admin/tenants", {
              id: "intruder",
              name: "Intruder",
            })
          ).status,
          403,
        );
        assert.equal(await p.store.tenantRegistry.countDocuments(), 1);
      },
    );
    await t.test(
      "platform operator creates tenants; tenant admins only manage invitations",
      async () => {
        const admin = await p.adminCookie();
        const created = await p.request(admin, "POST", "/api/admin/tenants", {
          id: "team",
          name: "Operator team",
        });
        assert.equal(created.status, 201);
        const teamAdmin = who("teamadmin");
        await p.addMember(teamAdmin, "team", "admin");
        const teamCookie = await p.session(teamAdmin);
        assert.equal(
          (await p.request(teamCookie, "GET", "/api/me")).data.showWorkspaces,
          true,
        );
        assert.equal(
          (await p.request(teamCookie, "GET", "/auth/account")).data
            .showWorkspaces,
          true,
        );
        assert.equal(
          (
            await p.request(teamCookie, "POST", "/auth/workspaces", {
              kind: "team",
              name: "Escalation",
            })
          ).data.code,
          "TENANT_CREATION_OPERATOR_ONLY",
        );
        const sent = await p.request(
          teamCookie,
          "POST",
          "/auth/workspaces/team/invites",
          { email: "invited@gmail.com", role: "user" },
        );
        assert.equal(sent.status, 201);
        const saved = (await p.store.invites.findOne({
          _id: sent.data.invite.id,
        }))!;
        const inv = await issueInvite(p.store, {
          tenant: (await p.store.tenantRegistry.findOne({ _id: "team" }))!,
          email: "freshinvite@gmail.com",
          role: "user",
        });
        const invited = await p.signIn(who("freshinvite"), inv.token);
        assert.equal(invited.location.pathname, `/invite/${inv.token}`);
        const invitedUser = (await p.store.users.findOne({
          googleSub: "freshinvite",
        }))!;
        assert.equal(
          await p.store.memberships.countDocuments({
            userId: invitedUser._id,
            tenantId: "default-tenant",
          }),
          0,
        );
        assert.equal(
          (await p.request(invited.cookie, "GET", "/api/me")).data.tenant.id,
          "team",
        );
        assert.equal(
          (
            await p.request(
              teamCookie,
              "POST",
              `/auth/workspaces/team/invites/${saved._id}/resend`,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await p.request(
              teamCookie,
              "DELETE",
              `/auth/workspaces/team/invites/${saved._id}`,
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "ordinary login does not accept a pending team invitation",
      async () => {
        const inv = await issueInvite(p.store, {
          tenant: (await p.store.tenantRegistry.findOne({ _id: "team" }))!,
          email: "pending@gmail.com",
          role: "user",
        });
        const identity = who("pending");
        const login = await p.signIn(identity);
        assert.equal(
          (await p.request(login.cookie, "GET", "/api/me")).data.tenant.id,
          "default-tenant",
        );
        assert.equal(
          (await p.store.invites.findOne({ _id: inv.doc._id }))?.status,
          "pending",
        );
        const accepted = await p.signIn(identity, inv.token);
        assert.equal(
          (await p.request(accepted.cookie, "GET", "/api/me")).data.tenant.id,
          "team",
        );
        assert.equal(
          (await p.request(accepted.cookie, "GET", "/api/me")).data
            .showWorkspaces,
          true,
        );
        assert.equal(
          (await p.request(await p.session(identity), "GET", "/api/me")).data
            .tenant.id,
          "team",
        );
      },
    );
    await t.test(
      "switching validates membership and remembers the selected tenant",
      async () => {
        await p.addMember(owner, "team");
        assert.equal(
          (await p.request(cookie, "GET", "/api/me")).data.showWorkspaces,
          false,
        );
        assert.equal(
          (await p.request(cookie, "GET", "/auth/account")).data.showWorkspaces,
          false,
        );
        const selected = await p.request(
          cookie,
          "POST",
          "/auth/switch-tenant",
          { tenantId: "team" },
        );
        assert.equal(selected.status, 200);
        cookie = `truex_session=${p.cookieOf(new Response(null, { headers: selected.headers }), "truex_session")}`;
        assert.equal(
          (await p.request(cookie, "GET", "/api/me")).data.showWorkspaces,
          true,
        );
        assert.equal(
          (await p.request(cookie, "GET", "/auth/account")).data.showWorkspaces,
          true,
        );
        assert.equal(
          (await p.request(cookie, "GET", "/api/me")).data.tenant.id,
          "team",
        );
        assert.equal(
          (await p.request(await p.session(owner), "GET", "/api/me")).data
            .tenant.id,
          "team",
        );
        assert.equal(
          (
            await p.request(cookie, "POST", "/auth/switch-tenant", {
              tenantId: "unregistered",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "default users cannot read each other's private agents",
      async () => {
        await p.approveDemoModel("default-tenant");
        const a = await p.session(who("alice-default"));
        const b = await p.session(who("bob-default"));
        const made = await p.request(a, "POST", "/api/agents", {
          name: "Private agent",
          description: "test",
          systemPrompt: "Be brief",
          modelProfileId: "demo-model",
        });
        assert.equal(made.status, 201);
        const id = made.data.id ?? made.data.agent?.id ?? made.data._id;
        assert.ok(id);
        const hidden = await p.request(b, "GET", `/api/agents/${id}`);
        assert.ok(hidden.status === 403 || hidden.status === 404);
        const listed = await p.request(b, "GET", "/api/agents");
        assert.ok(!JSON.stringify(listed.data).includes(id));
      },
    );
    await t.test(
      "removed default membership and disabled accounts cannot self-enroll again",
      async () => {
        const identity = who("removed-default");
        await p.session(identity);
        const person = (await p.store.users.findOne({
          googleSub: identity.sub,
        }))!;
        await p.store.memberships.updateOne(
          { userId: person._id, tenantId: "default-tenant" },
          { $set: { status: "removed" } },
        );
        assert.equal(
          (await p.signIn(identity)).location.searchParams.get("error"),
          "access_removed",
        );
        assert.equal(
          (await p.store.memberships.findOne({ userId: person._id }))?.status,
          "removed",
        );
        await p.store.users.updateOne(
          { _id: person._id },
          { $set: { status: "disabled" } },
        );
        assert.equal(
          (await p.signIn(identity)).location.searchParams.get("error"),
          "account_disabled",
        );
      },
    );
    await t.test(
      "unsafe, disabled or pending default tenants grant no new access",
      async () => {
        const original = (await p.store.tenantRegistry.findOne({
          _id: "default-tenant",
        }))!;
        for (const [index, fields] of [
          { status: "disabled" },
          { provisioningStatus: "pending" },
          { isUserSpecific: false, chatVisibility: "all" },
          { chatVisibility: "all" },
          { dbName: p.store.database },
          { kind: "personal" },
          { createdBy: user._id },
        ].entries()) {
          await p.store.tenantRegistry.replaceOne({ _id: original._id }, {
            ...original,
            ...fields,
          } as typeof original);
          const identity = who(`unsafe-${index}`);
          const login = await p.signIn(identity);
          assert.equal(login.cookie, undefined);
          assert.equal(
            login.location.searchParams.get("error"),
            "default_unavailable",
          );
          assert.equal(
            await p.store.users.countDocuments({ googleSub: identity.sub }),
            0,
          );
        }
        await p.store.tenantRegistry.replaceOne(
          { _id: original._id },
          original,
        );
        await p.store.client
          .db(original.dbName)
          .collection("truex_agents")
          .dropIndex("agent_creator_handle");
        assert.equal(
          (await p.signIn(who("missing-index"))).location.searchParams.get(
            "error",
          ),
          "default_unavailable",
        );
        await p.store.ensureTenantIndexes(original.dbName, true);
      },
    );
  },
);

test(
  "disabling public signup retains invitations and existing membership",
  { timeout: 60_000 },
  async (t) => {
    const p = await startPlatform({ env: { DEFAULT_TENANT_SIGNUP: "off" } });
    t.after(() => p.stop());
    await provision(p);
    assert.equal(
      (
        await p.signIn({ sub: "closed-new", email: "closednew@gmail.com" })
      ).location.searchParams.get("error"),
      "not_invited",
    );
    await p.workspace("team");
    const identity = { sub: "existing", email: "existing@gmail.com" };
    await p.addMember(identity, "team", "admin");
    const cookie = await p.session(identity);
    assert.equal(
      (await p.request(cookie, "GET", "/api/me")).data.tenant.id,
      "team",
    );
    const invite = await issueInvite(p.store, {
      tenant: (await p.store.tenantRegistry.findOne({ _id: "team" }))!,
      email: "offinvite@gmail.com",
      role: "user",
    });
    assert.ok(
      (
        await p.signIn(
          { sub: "offinvite", email: "offinvite@gmail.com" },
          invite.token,
        )
      ).cookie,
    );
    assert.equal(
      (await p.request(cookie, "POST", "/auth/workspaces", {})).data.code,
      "TENANT_CREATION_OPERATOR_ONLY",
    );
    assert.equal(
      (await p.request(cookie, "GET", "/auth/workspaces/team/invites")).status,
      200,
    );
  },
);
test(
  "workspace presentation follows the configured default tenant, including admins and multiple memberships",
  { timeout: 60_000 },
  async (t) => {
    const p = await startPlatform({
      env: {
        DEFAULT_SIGNUP_TENANT_ID: "public",
        DEFAULT_TENANT_SIGNUP: "off",
      },
    });
    t.after(() => p.stop());
    await p.workspace("public", "Public account");
    // A team's display name must never decide whether its controls are hidden.
    await p.workspace("team", "Default tenant");
    const identity = { sub: "visibility", email: "visibility@gmail.com" };
    await p.addMember(identity, "public", "admin");
    await p.addMember(identity, "team", "admin");
    let cookie = await p.session(identity);
    for (const path of ["/api/me", "/auth/account"]) {
      const response = await p.request(cookie, "GET", path);
      assert.equal(response.status, 200);
      assert.equal(response.data.showWorkspaces, false);
      assert.equal(response.data.tenants.length, 2);
    }
    const selected = await p.request(cookie, "POST", "/auth/switch-tenant", {
      tenantId: "team",
    });
    assert.equal(selected.status, 200);
    cookie = `truex_session=${p.cookieOf(new Response(null, { headers: selected.headers }), "truex_session")}`;
    for (const path of ["/api/me", "/auth/account"])
      assert.equal(
        (await p.request(cookie, "GET", path)).data.showWorkspaces,
        true,
      );
    assert.equal(
      (await p.request(cookie, "GET", "/auth/workspaces/team/invites")).status,
      200,
    );
  },
);

test(
  "Google entry remembers invitations and automatic entry, without remembering an unchosen picker default",
  { timeout: 60_000 },
  async (t) => {
    const p = await startPlatform();
    t.after(() => p.stop());
    await p.workspace("first");
    await p.workspace("second");
    const claims = { sub: "remember-entry", email: "remember@gmail.com" };
    const userId = await p.addMember(claims, "first");
    assert.equal((await p.signIn(claims)).location.pathname, "/");
    assert.equal(
      (await p.store.users.findOne({ _id: userId }))?.lastTenantId,
      "first",
    );
    const invite = await issueInvite(p.store, {
      tenant: (await p.store.tenantRegistry.findOne({ _id: "second" }))!,
      email: claims.email,
      role: "user",
    });
    assert.equal(
      (await p.signIn(claims, invite.token)).location.pathname,
      `/invite/${invite.token}`,
    );
    assert.equal(
      (await p.store.users.findOne({ _id: userId }))?.lastTenantId,
      "second",
    );
    const returning = await p.signIn(claims);
    assert.equal(
      (await p.request(returning.cookie, "GET", "/api/me")).data.tenant.id,
      "second",
    );
    await p.store.users.updateOne(
      { _id: userId },
      { $unset: { lastTenantId: "" } },
    );
    assert.equal((await p.signIn(claims)).location.pathname, "/select-tenant");
    assert.equal(
      (await p.store.users.findOne({ _id: userId }))?.lastTenantId,
      undefined,
    );
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import { fetchMe, parseMe } from "../lib/session.ts";
import {
  fetchAccount,
  fetchWorkspaceInvites,
  parseAccount,
  parseWorkspace,
  sendWorkspaceInvite,
} from "../lib/workspaces.ts";

const workspace = {
  id: "w-abcd",
  name: "Dhaya Labs",
  role: "admin",
  kind: "team",
};
const account = {
  user: { id: "u_1", email: "dhaya@gmail.com" },
  tenantId: null,
  tenants: [workspace],
  canCreate: false,
  canManageInvites: true,
};
const reply = (status: number, body: unknown) =>
  Response.json(body, { status });
const asFetch = (fn: (path: string, init?: RequestInit) => Promise<Response>) =>
  fn as unknown as typeof fetch;

const { UserMenu } = component("v2/user-menu.tsx");
test("the account menu exposes one workspace destination with the other actions intact", () => {
  const html = renderToStaticMarkup(
    createElement(UserMenu, {
      name: "Dhaya",
      email: "dhaya@gmail.com",
      workspace: "Dhaya Labs",
      role: "admin",
      onSettings() {},
      onWorkspaces() {},
      // A stale caller must not reintroduce the retired second entry.
      onSwitchWorkspace() {},
      onSignOut() {},
    }),
  );
  assert.equal((html.match(/Manage workspaces/g) ?? []).length, 1);
  assert.ok(!html.includes("Switch workspace"));
  for (const label of ["Dhaya Labs", "Settings", "Sign out", "Dark mode"])
    assert.ok(html.includes(label));
});
test("the account menu hides workspace navigation when it is unavailable", () => {
  const html = renderToStaticMarkup(createElement(UserMenu, { name: "Dhaya" }));
  assert.ok(!html.includes("Manage workspaces"));
  assert.ok(!html.includes("Sign out"));
  assert.ok(html.includes("Dark mode"));
});

test("default tenant users see their account actions without workspace controls", () => {
  for (const role of ["user", "admin"]) {
    const html = renderToStaticMarkup(
      createElement(UserMenu, {
        name: "Dhaya",
        email: "dhaya@gmail.com",
        workspace: "Default tenant",
        showWorkspaces: false,
        role,
        onSettings() {},
        onWorkspaces() {},
        onSignOut() {},
      }),
    );
    for (const label of [
      "Default tenant",
      "Manage workspaces",
      "Switch workspace",
    ])
      assert.ok(!html.includes(label));
    for (const label of [
      "Dhaya",
      "dhaya@gmail.com",
      "Settings",
      "Sign out",
      "Dark mode",
    ])
      assert.ok(html.includes(label));
  }
});

test("workspace visibility survives account and session parsing", () => {
  const data = {
    user: account.user,
    tenant: { id: "default-tenant", name: "Default tenant" },
    role: "user",
    tenants: account.tenants,
    auth: "google",
  };
  for (const showWorkspaces of [false, true]) {
    assert.equal(
      parseMe({ ...data, showWorkspaces })?.showWorkspaces,
      showWorkspaces,
    );
    assert.equal(
      parseAccount({ ...account, showWorkspaces })?.showWorkspaces,
      showWorkspaces,
    );
  }
  assert.equal(parseMe(data)?.showWorkspaces, undefined);
  assert.equal(parseAccount(account)?.showWorkspaces, undefined);
  assert.equal(parseAccount({ ...account, showWorkspaces: "false" }), null);
});

test("account and workspace responses validate identity and permissions", () => {
  assert.equal(parseAccount({ ...account, canManageInvites: "yes" }), null);
  assert.deepEqual(parseAccount(account), account);
  assert.deepEqual(parseWorkspace(workspace), workspace);
  for (const bad of [
    null,
    {},
    { ...account, user: null },
    { ...account, canCreate: "yes" },
    { ...account, tenantId: undefined },
    { ...account, tenants: [null] },
    { ...account, tenants: [{ ...workspace, role: "owner" }] },
  ])
    assert.equal(parseAccount(bad), null);
  for (const id of ["", "../other", "UPPER", "x".repeat(33)])
    assert.equal(parseWorkspace({ ...workspace, id }), null);
});
test("onboarding is distinct from logout, blocked access, and outages", async () => {
  assert.deepEqual(
    await fetchMe(
      asFetch(async () => reply(409, { code: "ONBOARDING_REQUIRED" })),
    ),
    { kind: "onboarding" },
  );
  assert.equal(
    (await fetchMe(asFetch(async () => reply(409, { code: "OTHER" })))).kind,
    "unavailable",
  );
  const authenticated = await fetchAccount(
    asFetch(async () => reply(200, account)),
  );
  assert.equal(authenticated.ok, true);
  for (const status of [500, 502, 503]) {
    const result = await fetchAccount(asFetch(async () => reply(status, {})));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.signedOut, false);
      assert.equal(result.retryable, true);
    }
  }
  const expired = await fetchAccount(asFetch(async () => reply(401, {})));
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.signedOut, true);
});
test("invitation management reports unknown errors without exposing internals", async () => {
  for (const code of ["__proto__", "constructor", "unknown", "<script>"]) {
    const result = await sendWorkspaceInvite(
      "team",
      "member@gmail.com",
      "user",
      asFetch(async () => reply(400, { code, error: "secret" })),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(typeof result.message, "string");
      assert.ok(!result.message.includes("secret"));
    }
  }
});
test("expired invitations remain usable in the list; delivery errors never expose internals", async () => {
  const invite = {
    id: "inv_00000000-0000-4000-8000-000000000001",
    email: "member@gmail.com",
    role: "user",
    status: "expired",
    expiresAt: "2026-10-01T00:00:00.000Z",
    sendError: "secret API key",
  };
  const result = await fetchWorkspaceInvites(
    "team",
    asFetch(async () => reply(200, { invites: [invite] })),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value[0].status, "expired");
    assert.ok(!result.value[0].sendError?.includes("secret"));
  }
  const denied = await sendWorkspaceInvite(
    "team",
    "member@gmail.com",
    "user",
    asFetch(async () => reply(403, { code: "NOT_A_MEMBER" })),
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.signedOut, false);
});

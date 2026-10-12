import test from "node:test";
import assert from "node:assert/strict";
import { fetchLoginMethod, parseLoginMethod } from "../lib/login.ts";
import { fetchMe, parseMe } from "../lib/session.ts";

const transport = (status: number, body?: unknown) =>
  (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
test("login descriptor accepts only the server's fixed same-origin login routes", async () => {
  assert.deepEqual(
    parseLoginMethod({
      kind: "oidc",
      href: "/auth/oidc/start",
      clientSecret: "ignored",
    }),
    { kind: "oidc", href: "/auth/oidc/start" },
  );
  for (const value of [
    null,
    {},
    { kind: "oidc", href: "https://attacker.invalid" },
    { kind: "oidc", href: "/auth/google/start" },
    { kind: "google", href: "//attacker.invalid" },
  ])
    assert.equal(parseLoginMethod(value), null);
  assert.deepEqual(await fetchLoginMethod(transport(404)), {
    kind: "google",
    href: "/auth/google/start",
  });
  assert.equal(
    await fetchLoginMethod(transport(503)),
    null,
    "an outage never chooses a different provider",
  );
  assert.deepEqual(
    await fetchLoginMethod(
      transport(200, { kind: "oidc", href: "/auth/oidc/start" }),
    ),
    { kind: "oidc", href: "/auth/oidc/start" },
  );
});
test("tenant selection and revocation retain the account session instead of starting onboarding", async () => {
  assert.deepEqual(
    await fetchMe(transport(409, { code: "TENANT_SELECTION_REQUIRED" })),
    { kind: "selectTenant" },
  );
  assert.deepEqual(
    await fetchMe(transport(403, { code: "TENANT_ACCESS_REVOKED" })),
    { kind: "selectTenant" },
  );
  assert.deepEqual(
    await fetchMe(transport(409, { code: "ONBOARDING_REQUIRED" })),
    { kind: "onboarding" },
  );
  assert.equal((await fetchMe(transport(503))).kind, "unavailable");
  const me = parseMe({
    user: { id: "human", email: "", name: "No Email" },
    tenant: { id: "tenant", name: "Tenant" },
    role: "user",
    auth: "oidc",
    tenants: [],
  });
  assert.ok(me);
  assert.equal(me.auth, "oidc");
  assert.equal(me.user.email, "");
});

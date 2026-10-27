import test from "node:test";
import assert from "node:assert/strict";
import { fetchMe } from "../lib/session.ts";
import { createAuth } from "../lib/auth.ts";
import { refreshed, USER_ID, TENANT_ID } from "./auth-fixture.ts";

const OTHER = "64b7f0c2a1b2c3d4e5f60720";
const user = { id: USER_ID, email: "ada@example.invalid", name: "Ada" };
const tenant = { id: TENANT_ID, name: "Workspace", role: "user" };
function fixture(
  tenantReply: () => Response = () => Response.json({ tenant }),
) {
  const paths: string[] = [];
  const auth = createAuth({
    channel: null,
    locks: null,
    fetch: (async (path: string) => {
      paths.push(path);
      if (path.startsWith("/api/v1/auth/refresh")) return refreshed();
      if (path === "/api/v1/me") return Response.json({ user });
      if (path.startsWith("/api/v1/tenant?")) return tenantReply();
      return Response.json({
        tenants: [tenant, { ...tenant, id: OTHER }],
        entry: { outcome: "chooseTenant" },
      });
    }) as typeof fetch,
  });
  return { auth, paths };
}

test("an explicit tenant route is authorized independently of discovery and other tabs", async () => {
  const { auth, paths } = fixture();
  const result = await fetchMe({ auth, tenantId: TENANT_ID });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.me.tenant.id, TENANT_ID);
  assert.ok(paths.includes(`/api/v1/tenant?tenantId=${TENANT_ID}`));
  assert.ok(!paths.includes("/api/v1/me/tenants"));
});

test("missing membership hides the tenant while dependency failures preserve the session", async () => {
  for (const [status, expected] of [
    [403, "blocked"],
    [401, "signedOut"],
    [503, "unavailable"],
  ] as const) {
    const { auth } = fixture(() => new Response(null, { status }));
    assert.equal((await fetchMe({ auth, tenantId: TENANT_ID })).kind, expected);
  }
});

test("malformed tenant routes fail before sending any request", async () => {
  for (const tenantId of [
    "",
    "../me",
    "x",
    TENANT_ID.toUpperCase(),
    `${TENANT_ID}&role=admin`,
  ]) {
    const { auth, paths } = fixture();
    assert.equal((await fetchMe({ auth, tenantId })).kind, "blocked");
    assert.deepEqual(paths, []);
  }
});

test("a tenant response cannot substitute another tenant or forge a role", async () => {
  for (const bad of [
    { ...tenant, id: OTHER },
    { ...tenant, role: "owner" },
    null,
  ]) {
    const { auth } = fixture(() => Response.json({ tenant: bad }));
    assert.equal(
      (await fetchMe({ auth, tenantId: TENANT_ID })).kind,
      "unavailable",
    );
  }
});

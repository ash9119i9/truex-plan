import assert from "node:assert/strict";
import test from "node:test";
import { IdentityStore, identityBindingId } from "../src/identity";
import type { Store } from "../src/store";
const actor = {
  kind: "human",
  id: "operator",
  generation: "operator-g1",
} as const;

test("identity keys distinguish tenant and delimiter-bearing components", () => {
  assert.notEqual(identityBindingId("a", "b"), identityBindingId("b", "a"));
  assert.notEqual(identityBindingId("a:b", "c"), identityBindingId("a", "b:c"));
  assert.equal(identityBindingId("a", "b"), identityBindingId("a", "b"));
});
test("invalid identity input cannot reach storage or configure caller-selected issuer URLs", async () => {
  const s = new IdentityStore({} as Store);
  for (const value of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?x=1",
    "https://example.com#x",
    "https://example.com\n",
    { $ne: null },
    null,
  ]) {
    await assert.rejects(
      s.registerConnection(
        { _id: "conn", kind: "oidc", issuer: value as string },
        actor,
      ),
      { status: 400 },
    );
  }
  await assert.rejects(
    s.registerConnection(
      { _id: "conn", kind: "google", issuer: "https://evil.example" },
      actor,
    ),
    { status: 400 },
  );
  await assert.rejects(
    s.createPrincipal("service", {
      kind: "workload",
      id: "worker",
      generation: "g1",
      purpose: "cleanup",
    }),
    { status: 400 },
  );
  await assert.rejects(
    s.linkExternal(
      {
        connectionId: "conn",
        subject: { $exists: true } as any,
        principal: actor,
      },
      actor,
    ),
    { status: 400 },
  );
  await assert.rejects(
    s.validateCredential({
      connectionId: "conn",
      verifiedIssuer: "https://example.com",
      principal: actor,
      tenantId: "tenant",
      bindingId: "binding",
      cohort: {} as any,
    }),
    { status: 401 },
  );
});

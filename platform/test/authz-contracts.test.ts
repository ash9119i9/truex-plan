import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONS,
  AUTHORIZATION_VERSION,
  contextFailure,
  isAuthorizationContext,
  isPrincipal,
  isResource,
  WORKLOAD_ACTIONS,
  type AuthorizationContext,
  type ResourceRef,
  type WorkloadPurpose,
} from "../../shared/authorization";

const now = 1_000_000;
const resource: ResourceRef = {
  tenantId: "acme",
  type: "conversation",
  id: "conversation-1",
  generation: "generation-1",
};
const context = (): AuthorizationContext => ({
  version: AUTHORIZATION_VERSION,
  principal: { kind: "human", id: "person-1", generation: "generation-1" },
  tenant: { id: "acme", generation: "generation-1" },
  binding: { id: "membership-1", generation: "generation-1" },
  credential: {
    kind: "session",
    id: "session-1",
    issuedAtMs: now - 1000,
    expiresAtMs: now + 1000,
    scopes: [...ACTIONS],
  },
  requestId: "request.1:browser",
});

test("shape invariants fail closed without treating valid shape as permission", () => {
  assert.equal(
    contextFailure(undefined, "conversation.read", resource, now),
    "missing_context",
  );
  assert.equal(
    contextFailure(null, "conversation.read", resource, now),
    "missing_context",
  );
  assert.equal(
    contextFailure({}, "conversation.read", resource, now),
    "invalid_context",
  );
  assert.equal(
    contextFailure(context(), "conversation.typo", resource, now),
    "invalid_action",
  );
  assert.equal(
    contextFailure(context(), "conversation.read", {}, now),
    "invalid_resource",
  );
  assert.equal(
    contextFailure(
      context(),
      "conversation.read",
      { ...resource, tenantId: "other" },
      now,
    ),
    "tenant_mismatch",
  );
  assert.equal(
    contextFailure(context(), "conversation.read", resource, now),
    undefined,
  );
  // undefined means only that the context is usable for a live check, never allow.
  assert.notEqual(
    contextFailure(context(), "conversation.read", resource, now),
    true,
  );
});

test("human and service credentials cannot acquire mechanical worker authority", () => {
  for (const principal of [
    context().principal,
    { kind: "service" as const, id: "service-1", generation: "generation-1" },
  ]) {
    const actor = context();
    actor.principal = principal;
    actor.credential.kind =
      principal.kind === "service" ? "access_token" : "session";
    assert.ok(isAuthorizationContext(actor));
    for (const action of ACTIONS.filter((a) => a.startsWith("worker.")))
      assert.equal(
        contextFailure(actor, action, resource, now),
        "scope_denied",
        action,
      );
  }
});

test("boundary validation rejects malformed identities, lifetimes, scopes and delegation", () => {
  for (const field of [
    "principal",
    "tenant",
    "binding",
    "credential",
    "requestId",
  ])
    assert.equal(
      isAuthorizationContext({ ...context(), [field]: undefined }),
      false,
      field,
    );
  for (const value of ["", "../escape", "a:b", "a/b", "☃", "x".repeat(129)]) {
    assert.equal(
      isPrincipal({ kind: "human", id: value, generation: "g1" }),
      false,
    );
    assert.equal(isResource({ ...resource, generation: value }), false);
  }
  for (const credential of [
    { ...context().credential, kind: "unknown" },
    { ...context().credential, kind: { toString: () => "session" } },
    { ...context().credential, id: "" },
    { ...context().credential, issuedAtMs: Number.NaN },
    { ...context().credential, expiresAtMs: now - 1000 },
    { ...context().credential, scopes: ["*"] },
    {
      ...context().credential,
      scopes: ["conversation.read", "conversation.read"],
    },
    { ...context().credential, scopes: null },
  ])
    assert.equal(isAuthorizationContext({ ...context(), credential }), false);
  assert.equal(isAuthorizationContext({ ...context(), version: 2 }), false);
  assert.equal(
    isAuthorizationContext({
      ...context(),
      effectivePrincipal: context().principal,
    }),
    false,
  );
  assert.equal(
    isAuthorizationContext({ ...context(), executionGrantId: "grant-1" }),
    false,
  );
  const service = {
    ...context(),
    principal: { kind: "service", id: "client-1", generation: "g1" },
  };
  assert.equal(
    isAuthorizationContext(service),
    false,
    "a service cannot borrow a human session",
  );
  assert.equal(
    isAuthorizationContext({
      ...service,
      credential: { ...context().credential, kind: "access_token" },
    }),
    true,
  );
});

test("expiry is exclusive and scope is an independent ceiling", () => {
  const c = context();
  assert.equal(
    contextFailure(c, "conversation.read", resource, c.credential.expiresAtMs),
    "credential_expired",
  );
  assert.equal(
    contextFailure(
      c,
      "conversation.read",
      resource,
      c.credential.issuedAtMs - 1,
    ),
    "credential_expired",
  );
  assert.equal(
    contextFailure(c, "conversation.read", resource, c.credential.issuedAtMs),
    undefined,
  );
  c.credential.scopes = [];
  assert.equal(
    contextFailure(c, "conversation.read", resource, now),
    "scope_denied",
  );
});

test("workload ceilings cannot be expanded by caller-provided scopes", () => {
  for (const purpose of Object.keys(WORKLOAD_ACTIONS) as WorkloadPurpose[]) {
    const delegated = ["runtime", "broker", "gateway"].includes(purpose);
    const c: AuthorizationContext = {
      ...context(),
      principal: {
        kind: "workload",
        purpose,
        id: "worker-1",
        generation: "g1",
      },
      credential: { ...context().credential, kind: "workload" },
      ...(delegated
        ? {
            effectivePrincipal: {
              kind: "human" as const,
              id: "person-1",
              generation: "g1",
            },
            executionGrantId: "grant-1",
          }
        : {}),
    };
    assert.equal(isAuthorizationContext(c), true, purpose);
    for (const action of ACTIONS)
      assert.equal(
        contextFailure(c, action, resource, now),
        WORKLOAD_ACTIONS[purpose].includes(action) ? undefined : "scope_denied",
        `${purpose} ${action}`,
      );
    if (delegated) {
      assert.equal(
        isAuthorizationContext({ ...c, effectivePrincipal: undefined }),
        false,
      );
      assert.equal(
        isAuthorizationContext({ ...c, executionGrantId: undefined }),
        false,
      );
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentAuthorizationContext,
  requireActionContext,
  requireAuthorizationContext,
  withAuthorizationContext,
} from "../src/authorization-context";
import { route } from "../src/http";
import { currentTenant } from "../src/tenant";
import { currentUser } from "../src/user";
import type {
  AuthorizationContext,
  ResourceRef,
} from "../../shared/authorization";
import type { Request, Response, NextFunction } from "express";

function context(id = "human"): AuthorizationContext {
  return {
    version: 1,
    principal: { kind: "human", id, generation: "principal-g1" },
    tenant: { id: "acme", generation: "tenant-g1" },
    binding: { id: "binding", generation: "binding-g1" },
    credential: {
      kind: "session",
      id: "credential",
      issuedAtMs: Date.now() - 1000,
      expiresAtMs: Date.now() + 60000,
      scopes: ["conversation.read"],
    },
    requestId: "request-authz",
  };
}
const resource: ResourceRef = {
  tenantId: "acme",
  type: "conversation",
  id: "chat",
  generation: "resource-g1",
};
test("explicit context stays isolated across concurrent awaits and cannot be mutated through its source", async () => {
  assert.equal(currentAuthorizationContext(), undefined);
  assert.throws(requireAuthorizationContext, {
    code: "AUTHORIZATION_CONTEXT_REQUIRED",
  });
  const first = context("first");
  await Promise.all([
    withAuthorizationContext(first, async () => {
      first.principal.id = "spoofed";
      await delay(15);
      const captured = requireAuthorizationContext();
      assert.equal(captured.principal.id, "first");
      assert.equal(Reflect.set(captured.tenant, "id", "foreign"), false);
      assert.equal(captured.tenant.id, "acme");
      assert.throws(() => {
        (captured.credential.scopes as string[]).push("conversation.send");
      }, TypeError);
      assert.equal(
        requireActionContext("conversation.read", resource).principal.id,
        "first",
      );
      assert.throws(() => requireActionContext("conversation.send", resource), {
        code: "AUTHORIZATION_CONTEXT_DENIED",
      });
      assert.throws(
        () =>
          requireActionContext("conversation.read", {
            ...resource,
            tenantId: "foreign",
          }),
        { code: "AUTHORIZATION_CONTEXT_DENIED" },
      );
    }),
    withAuthorizationContext(context("second"), async () => {
      await delay(5);
      assert.equal(requireAuthorizationContext().principal.id, "second");
    }),
  ]);
  assert.equal(currentAuthorizationContext(), undefined);
});
test("credential expiry is checked again after awaits and workload scopes never become human authority", async () => {
  const expiring = context();
  expiring.credential.expiresAtMs = Date.now() + 20;
  await withAuthorizationContext(expiring, async () => {
    await delay(40);
    assert.throws(requireAuthorizationContext, {
      code: "AUTHORIZATION_CREDENTIAL_EXPIRED",
    });
  });
  const workload = context();
  workload.principal = {
    kind: "workload",
    id: "ingestion",
    generation: "workload-g1",
    purpose: "ingestion",
  };
  workload.credential.kind = "workload";
  workload.credential.scopes = ["worker.records.persist", "conversation.send"];
  withAuthorizationContext(workload, () => {
    assert.equal(
      requireActionContext("worker.records.persist", resource).principal.kind,
      "workload",
    );
    assert.throws(() => requireActionContext("conversation.send", resource), {
      code: "AUTHORIZATION_CONTEXT_DENIED",
    });
  });
});
test("enterprise HTTP wrappers require matching verified principal and tenant generation, including uppercase API paths", async () => {
  const prior = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "oidc";
  try {
    const authorization = context();
    const valid = {
      user: { id: "human", email: "human@corp.example", role: "user" },
      tenant: {
        id: "acme",
        dbName: "db_acme",
        authorizationGeneration: "tenant-g1",
      },
      authorization,
      requestId: "request-http",
    };
    async function invoke(locals: Record<string, unknown>, fn: () => void) {
      let failure: unknown;
      const req = {
        originalUrl: "/API/secret",
        path: "/API/secret",
        method: "GET",
        params: {},
      } as Request;
      const res = { locals } as Response;
      await route(fn)(req, res, ((error: unknown) => {
        failure = error;
      }) as NextFunction);
      if (failure) throw failure;
    }
    let called = 0;
    for (const locals of [
      {},
      { ...valid, authorization: undefined },
      { ...valid, user: { ...valid.user, id: "other" } },
      { ...valid, tenant: { ...valid.tenant, authorizationGeneration: "old" } },
      { admin: true },
    ])
      await assert.rejects(
        invoke(locals, () => {
          called++;
        }),
        { code: "CONTEXT_MISSING" },
      );
    assert.equal(called, 0);
    await invoke(valid, () => {
      called++;
      assert.equal(requireAuthorizationContext().principal.id, "human");
      assert.equal(requireAuthorizationContext().requestId, "request-http");
      assert.equal(currentUser()?.id, "human");
      assert.equal(currentTenant()?.id, "acme");
    });
    assert.equal(called, 1);
    assert.equal(currentAuthorizationContext(), undefined);
  } finally {
    if (prior === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = prior;
  }
});

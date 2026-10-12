import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { Store } from "./store";
import type { AuthSessionDocument, MembershipDocument } from "./auth";
import { IdentityStore, matchesIdentityCohort } from "./identity";
import { ApiError } from "./errors";
import {
  ACTIONS,
  isAuthorizationContext,
  type AuthorizationContext,
} from "../../shared/authorization";

export const BROWSER_COHORT_CLAIM = "https://truex.dev/browser-authz";
export const MAX_BROWSER_TENANTS = 100;
export interface BrowserBindingCohort {
  tenantId: string;
  tenantGeneration: string;
  bindingId: string;
  bindingGeneration: string;
  credentialGeneration: string;
}
export interface BrowserSessionAuthorization {
  version: 1;
  principalGeneration: string;
  connectionId: string;
  connectionGeneration: string;
  externalBindingId: string;
  issuedAtMs: number;
  authenticatedAtMs: number;
  bindings: BrowserBindingCohort[];
  authentication?: { amr?: string[]; acr?: string };
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const expired = () =>
  new ApiError(401, "Sign in again to continue", "UNAUTHENTICATED");
export const BROWSER_SCOPES = ACTIONS.filter(
  (a) => !a.startsWith("worker.") && !a.startsWith("platform."),
);
export function isBrowserAuthorization(
  value: unknown,
): value is BrowserSessionAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as BrowserSessionAuthorization;
  if (
    Object.keys(a).some(
      (k) =>
        ![
          "version",
          "principalGeneration",
          "connectionId",
          "connectionGeneration",
          "externalBindingId",
          "issuedAtMs",
          "authenticatedAtMs",
          "bindings",
          "authentication",
        ].includes(k),
    ) ||
    (a.authentication !== undefined &&
      (!a.authentication ||
        typeof a.authentication !== "object" ||
        Array.isArray(a.authentication) ||
        Object.keys(a.authentication).some(
          (k) => !["amr", "acr"].includes(k),
        ) ||
        (a.authentication.amr !== undefined &&
          (!Array.isArray(a.authentication.amr) ||
            a.authentication.amr.length > 10 ||
            !a.authentication.amr.every(
              (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v),
            ))) ||
        (a.authentication.acr !== undefined &&
          (typeof a.authentication.acr !== "string" ||
            a.authentication.acr.length > 128 ||
            /[\p{Cc}\p{Cf}]/u.test(a.authentication.acr))))) ||
    a.version !== 1 ||
    ![
      a.principalGeneration,
      a.connectionId,
      a.connectionGeneration,
      a.externalBindingId,
    ].every(id) ||
    !Number.isSafeInteger(a.issuedAtMs) ||
    a.issuedAtMs < 0 ||
    !Number.isSafeInteger(a.authenticatedAtMs) ||
    a.authenticatedAtMs < 0 ||
    !Array.isArray(a.bindings) ||
    a.bindings.length < 1 ||
    a.bindings.length > MAX_BROWSER_TENANTS
  )
    return false;
  const seen = new Set<string>();
  return a.bindings.every((b) => {
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      Object.keys(b).some(
        (k) =>
          ![
            "tenantId",
            "tenantGeneration",
            "bindingId",
            "bindingGeneration",
            "credentialGeneration",
          ].includes(k),
      ) ||
      typeof b.tenantId !== "string" ||
      !TENANT.test(b.tenantId) ||
      seen.has(b.tenantId) ||
      ![
        b.tenantGeneration,
        b.bindingId,
        b.bindingGeneration,
        b.credentialGeneration,
      ].every(id)
    )
      return false;
    seen.add(b.tenantId);
    return true;
  });
}
export async function browserAccount(
  store: Store,
  session: AuthSessionDocument,
  tx?: ClientSession,
) {
  const a = session.authorization;
  if (
    !session.userId ||
    !id(session.userId) ||
    !isBrowserAuthorization(a) ||
    a.issuedAtMs > Date.now() ||
    a.authenticatedAtMs > a.issuedAtMs ||
    session.idleExpiresAt.getTime() <= Date.now() ||
    session.absoluteExpiresAt.getTime() <= Date.now()
  )
    throw expired();
  const s = new IdentityStore(store);
  const human = await s.resolveBoundHuman(
    {
      connectionId: a.connectionId,
      connectionGeneration: a.connectionGeneration,
      externalBindingId: a.externalBindingId,
      principalId: session.userId,
      principalGeneration: a.principalGeneration,
    },
    tx,
  );
  const legacy =
    human.principal.legacySource === "google"
      ? await store.users.findOne(
          {
            _id: session.userId,
            status: "active",
            authorizationGeneration: a.principalGeneration,
          },
          { session: tx },
        )
      : undefined;
  const p = legacy ?? human.principal.profile;
  const clean = (v: unknown, max: number) =>
    typeof v === "string" && v.length <= max
      ? v.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()
      : undefined;
  const email = clean(p?.email, 254) ?? "";
  const name = clean(p?.name, 100);
  const picture = clean(p?.picture, 512);
  return {
    human,
    user: {
      _id: session.userId,
      email,
      ...(name ? { name } : {}),
      ...(picture?.startsWith("https://") ? { picture } : {}),
      status: "active" as const,
    },
    authorization: a,
  };
}
export async function browserContext(
  store: Store,
  session: AuthSessionDocument,
  target = session.tenantId,
  tx?: ClientSession,
): Promise<AuthorizationContext> {
  const { human, authorization: a } = await browserAccount(store, session, tx);
  const snapshot = a.bindings.find((b) => b.tenantId === target);
  if (!snapshot) throw expired();
  const verified = await new IdentityStore(store).validateCredential(
    {
      connectionId: a.connectionId,
      verifiedIssuer: human.connection.issuer,
      principal: {
        kind: "human",
        id: session.userId!,
        generation: a.principalGeneration,
      },
      tenantId: snapshot.tenantId,
      bindingId: snapshot.bindingId,
      cohort: {
        principalGeneration: a.principalGeneration,
        bindingGeneration: snapshot.bindingGeneration,
        credentialGeneration: snapshot.credentialGeneration,
        tenantGeneration: snapshot.tenantGeneration,
        connectionGeneration: a.connectionGeneration,
        externalBindingId: a.externalBindingId,
        issuedAtMs: a.issuedAtMs,
        expiresAtMs: session.absoluteExpiresAt.getTime(),
      },
    },
    { session: tx },
  );
  const context: AuthorizationContext = {
    version: 1,
    principal: verified.principal,
    tenant: verified.tenant,
    binding: verified.binding,
    credential: {
      kind: "session",
      id: session._id,
      issuedAtMs: session.createdAt.getTime(),
      expiresAtMs: Math.min(
        session.idleExpiresAt.getTime(),
        session.absoluteExpiresAt.getTime(),
      ),
      scopes: [...BROWSER_SCOPES],
    },
    requestId: randomUUID(),
  };
  if (
    !isAuthorizationContext(context) ||
    context.credential.expiresAtMs <= Date.now()
  )
    throw expired();
  return context;
}
/** Compatibility projection only. It grants no fine-grained role permissions. */
export async function identityMembership(
  store: Store,
  context: AuthorizationContext,
  tx?: ClientSession,
): Promise<MembershipDocument> {
  const identity = new IdentityStore(store);
  const binding = await identity.tenantBindings.findOne(
    {
      _id: context.binding.id,
      generation: context.binding.generation,
      tenantId: context.tenant.id,
      status: "active",
    },
    { session: tx },
  );
  if (!binding) throw expired();
  if (binding.legacyMembershipId) {
    const legacy = await store.memberships.findOne(
      {
        _id: binding.legacyMembershipId,
        userId: context.principal.id,
        tenantId: context.tenant.id,
        authorizationGeneration: binding.generation,
        status: "active",
      },
      { session: tx },
    );
    if (!legacy) throw expired();
    return legacy;
  }
  return {
    _id: binding._id,
    userId: context.principal.id,
    tenantId: context.tenant.id,
    role: "user",
    status: "active",
    createdAt: binding.createdAt.toISOString(),
    authorizationGeneration: binding.generation,
  };
}
export async function browserTenants(
  store: Store,
  session: AuthSessionDocument,
  tx?: ClientSession,
) {
  const { authorization: a, human } = await browserAccount(store, session, tx);
  const identity = new IdentityStore(store);
  // Two bounded batches plus one legacy batch, independent of tenant count.
  // Sequential inside Mongo transactions, which do not support parallel operations.
  const bindings = await identity.tenantBindings
    .find({ _id: { $in: a.bindings.map((b) => b.bindingId) } }, { session: tx })
    .toArray();
  const tenants = await store.tenantRegistry
    .find({ _id: { $in: a.bindings.map((b) => b.tenantId) } }, { session: tx })
    .toArray();
  const legacyIds = bindings.flatMap((b) =>
    b.legacyMembershipId ? [b.legacyMembershipId] : [],
  );
  const legacy = legacyIds.length
    ? await store.memberships
        .find({ _id: { $in: legacyIds }, status: "active" }, { session: tx })
        .toArray()
    : [];
  const byBinding = new Map(bindings.map((b) => [b._id, b]));
  const byTenant = new Map(tenants.map((t) => [t._id, t]));
  const byLegacy = new Map(legacy.map((m) => [m._id, m]));
  return a.bindings.flatMap((snapshot) => {
    const b = byBinding.get(snapshot.bindingId);
    const t = byTenant.get(snapshot.tenantId);
    const principal = {
      kind: "human",
      id: session.userId!,
      generation: a.principalGeneration,
    } as const;
    if (
      (human.connection.tenantId &&
        human.connection.tenantId !== snapshot.tenantId) ||
      !matchesIdentityCohort(b, t, principal, {
        principalGeneration: a.principalGeneration,
        bindingGeneration: snapshot.bindingGeneration,
        credentialGeneration: snapshot.credentialGeneration,
        tenantGeneration: snapshot.tenantGeneration,
        connectionGeneration: a.connectionGeneration,
        issuedAtMs: a.issuedAtMs,
        expiresAtMs: session.absoluteExpiresAt.getTime(),
      })
    )
      return [];
    const m = b.legacyMembershipId
      ? byLegacy.get(b.legacyMembershipId)
      : undefined;
    if (
      b.legacyMembershipId &&
      (!m ||
        m.userId !== principal.id ||
        m.tenantId !== snapshot.tenantId ||
        m.authorizationGeneration !== b.generation)
    )
      return [];
    return [
      {
        id: t!._id,
        name: t!.name,
        role: m?.role ?? ("user" as const),
        ...(t!.kind ? { kind: t!.kind } : {}),
      },
    ];
  });
}

import { createHash, randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { Store } from "./store";
import { ApiError } from "./errors";
import { tenantId } from "./tenant";
import { isPrincipal, type PrincipalRef } from "../../shared/authorization";

// Canonical enterprise identities are separate from the legacy Google users
// table. Human IDs survive migration; service accounts never need googleSub or
// an email. These records are additive, and do not enable enterprise routes.
export interface IdentityPrincipal {
  _id: string;
  kind: "human" | "service";
  generation: string;
  status: "active" | "disabled";
  createdAt: Date;
  legacySource?: "google";
  profile?: { email?: string; name?: string; picture?: string };
}
export interface IdentityConnection {
  _id: string;
  kind: "google" | "oidc";
  issuer: string;
  generation: string;
  status: "active" | "disabled";
  /** Optional restriction for a tenant-specific federation connection. */
  tenantId?: string;
  createdAt: Date;
}
export interface ExternalIdentityBinding {
  _id: string;
  connectionId: string;
  connectionGeneration: string;
  issuer: string;
  subject: string;
  principal: Extract<PrincipalRef, { kind: "human" | "service" }>;
  status: "active" | "revoked";
  createdAt: Date;
}
export interface IdentityTenantBinding {
  _id: string;
  tenantId: string;
  tenantGeneration: string;
  principal: ExternalIdentityBinding["principal"];
  generation: string;
  credentialGeneration: string;
  /** Issuance time alone is insufficient: credentials also need exact generations. */
  notBeforeMs: number;
  status: "active" | "removed";
  /** No roles here: roles are independent engine-backed permission bundles. */
  epoch: number;
  createdAt: Date;
  removedAt?: Date;
  legacyMembershipId?: string;
}
export interface RegisteredIdentityClient {
  _id: string;
  connectionId: string;
  connectionGeneration: string;
  issuer: string;
  clientId: string;
  tenantId: string;
  bindingId: string;
  principal: ExternalIdentityBinding["principal"];
  generation: string;
  status: "active" | "revoked";
  createdAt: Date;
}
export interface IdentityAudit {
  _id: string;
  action: string;
  actor: PrincipalRef;
  targetId: string;
  tenantId?: string;
  generation: string;
  at: Date;
}
export interface IdentityTombstone {
  _id: string;
  bindingId: string;
  generation: string;
  credentialGeneration: string;
  tenantId: string;
  at: Date;
}
/** Server-stored browser cohort or verified provider generation claims.
 * JWT crypto/purpose verification belongs in api-auth, not this data module.
 * A token lacking these attestations cannot inherit the current generation.
 */
export interface CredentialCohort {
  principalGeneration: string;
  bindingGeneration: string;
  credentialGeneration: string;
  tenantGeneration: string;
  connectionGeneration: string;
  clientGeneration?: string;
  externalBindingId?: string;
  issuedAtMs: number;
  expiresAtMs: number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const bounded = (x: unknown): x is string =>
  typeof x === "string" && ID.test(x);
const opaque = (x: unknown): x is string =>
  typeof x === "string" &&
  x.length > 0 &&
  x.length <= 255 &&
  !/[\p{Cc}\p{Cf}]/u.test(x);
const invalid = () =>
  new ApiError(400, "Invalid identity record", "INVALID_IDENTITY");
const denied = () =>
  new ApiError(401, "Sign in again to continue", "IDENTITY_INACTIVE");
const conflict = () =>
  new ApiError(
    409,
    "Identity binding conflicts with existing state",
    "IDENTITY_CONFLICT",
  );
const ref = (p: IdentityPrincipal): ExternalIdentityBinding["principal"] => ({
  kind: p.kind,
  id: p._id,
  generation: p.generation,
});
const same = (
  a: ExternalIdentityBinding["principal"],
  b: ExternalIdentityBinding["principal"],
) => a.kind === b.kind && a.id === b.id && a.generation === b.generation;
const key = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const identityBindingId = (principalId: string, tenant: string) =>
  key("tenant", principalId, tenant);
function requireActor(actor: PrincipalRef) {
  if (!isPrincipal(actor) || actor.kind === "workload") throw invalid();
}
function issuer(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) throw invalid();
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      /[\p{Cc}\p{Cf}\s]/u.test(value)
    )
      throw invalid();
    // Keep the configured issuer exact. OAuth issuer trailing slashes matter.
    return value;
  } catch {
    throw invalid();
  }
}
function validCohort(c: CredentialCohort, now: number): boolean {
  return (
    !!c &&
    typeof c === "object" &&
    [
      c.principalGeneration,
      c.bindingGeneration,
      c.credentialGeneration,
      c.tenantGeneration,
      c.connectionGeneration,
    ].every(bounded) &&
    (c.clientGeneration === undefined || bounded(c.clientGeneration)) &&
    (c.externalBindingId === undefined || bounded(c.externalBindingId)) &&
    Number.isSafeInteger(c.issuedAtMs) &&
    c.issuedAtMs >= 0 &&
    c.issuedAtMs <= now &&
    Number.isSafeInteger(c.expiresAtMs) &&
    c.expiresAtMs > now &&
    c.expiresAtMs > c.issuedAtMs
  );
}

/** Shared live cohort predicate for single checks and bounded batch account lists. */
export function matchesIdentityCohort(
  binding: IdentityTenantBinding | null | undefined,
  tenant:
    | {
        _id: string;
        status: string;
        provisioningStatus?: string;
        authorizationGeneration?: string;
      }
    | null
    | undefined,
  principal: ExternalIdentityBinding["principal"],
  cohort: CredentialCohort,
  now = Date.now(),
): binding is IdentityTenantBinding {
  return (
    !!binding &&
    !!tenant &&
    validCohort(cohort, now) &&
    binding.status === "active" &&
    tenant.status === "active" &&
    binding.tenantId === tenant._id &&
    tenant.provisioningStatus !== "pending" &&
    bounded(tenant.authorizationGeneration) &&
    same(binding.principal, principal) &&
    Number.isSafeInteger(binding.epoch) &&
    binding.epoch >= 1 &&
    Number.isSafeInteger(binding.notBeforeMs) &&
    binding.notBeforeMs >= 0 &&
    binding.tenantGeneration === tenant.authorizationGeneration &&
    cohort.tenantGeneration === binding.tenantGeneration &&
    cohort.principalGeneration === binding.principal.generation &&
    cohort.bindingGeneration === binding.generation &&
    cohort.credentialGeneration === binding.credentialGeneration &&
    cohort.issuedAtMs >= binding.notBeforeMs
  );
}

/** Trusted catalog primitives. Public callers cannot register connections,
 * link subjects or mint cohort claims. A07/A13 must combine lifecycle writes
 * with the authoritative policy fence before enterprise enforcement is enabled.
 */
export class IdentityStore {
  constructor(readonly store: Store) {}
  get principals() {
    return this.store.catalog.collection<IdentityPrincipal>(
      "identity_principals",
    );
  }
  get connections() {
    return this.store.catalog.collection<IdentityConnection>(
      "identity_connections",
    );
  }
  get externalBindings() {
    return this.store.catalog.collection<ExternalIdentityBinding>(
      "identity_external_bindings",
    );
  }
  get tenantBindings() {
    return this.store.catalog.collection<IdentityTenantBinding>(
      "identity_tenant_bindings",
    );
  }
  get clients() {
    return this.store.catalog.collection<RegisteredIdentityClient>(
      "identity_clients",
    );
  }
  get audit() {
    return this.store.catalog.collection<IdentityAudit>("identity_audit");
  }
  get tombstones() {
    return this.store.catalog.collection<IdentityTombstone>(
      "identity_tombstones",
    );
  }
  async ensureIndexes() {
    await Promise.all([
      this.externalBindings.createIndex(
        { connectionId: 1, issuer: 1, subject: 1 },
        { unique: true },
      ),
      this.tenantBindings.createIndex(
        { tenantId: 1, "principal.id": 1 },
        { unique: true },
      ),
      this.clients.createIndex(
        { connectionId: 1, issuer: 1, clientId: 1, tenantId: 1 },
        { unique: true },
      ),
      this.audit.createIndex({ tenantId: 1, at: -1 }),
      this.tombstones.createIndex(
        { bindingId: 1, generation: 1 },
        { unique: true },
      ),
    ]);
  }
  private async event(
    action: string,
    actor: PrincipalRef,
    targetId: string,
    generation: string,
    session: ClientSession,
    tenant?: string,
  ) {
    await this.audit.insertOne(
      {
        _id: randomUUID(),
        action,
        actor,
        targetId,
        generation,
        ...(tenant ? { tenantId: tenant } : {}),
        at: new Date(),
      },
      { session },
    );
  }
  async registerConnection(
    input: Omit<IdentityConnection, "generation" | "status" | "createdAt">,
    actor: PrincipalRef,
  ) {
    input = structuredClone(input);
    actor = structuredClone(actor);
    requireActor(actor);
    if (!bounded(input._id) || !["google", "oidc"].includes(input.kind))
      throw invalid();
    issuer(input.issuer);
    if (input.tenantId !== undefined) tenantId(input.tenantId);
    if (
      input.kind === "google" &&
      (input.issuer !== "https://accounts.google.com" ||
        input.tenantId !== undefined)
    )
      throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const old = await this.connections.findOne(
        { _id: input._id },
        { session },
      );
      if (old) {
        if (
          old.issuer !== input.issuer ||
          old.kind !== input.kind ||
          old.tenantId !== input.tenantId ||
          old.status !== "active"
        )
          throw conflict();
        return old;
      }
      const next: IdentityConnection = {
        ...input,
        generation: randomUUID(),
        status: "active",
        createdAt: new Date(),
      };
      await this.connections.insertOne(next, { session });
      await this.event(
        "connection.register",
        actor,
        next._id,
        next.generation,
        session,
        next.tenantId,
      );
      return next;
    });
  }
  async createPrincipal(
    kind: IdentityPrincipal["kind"],
    actor: PrincipalRef,
    id: string = randomUUID(),
  ): Promise<IdentityPrincipal> {
    requireActor(actor);
    actor = structuredClone(actor);
    if (!bounded(id) || (kind !== "human" && kind !== "service"))
      throw invalid();
    const next: IdentityPrincipal = {
      _id: id,
      kind,
      generation: randomUUID(),
      status: "active",
      createdAt: new Date(),
    };
    return this.store.withCatalogTransaction(async (session) => {
      if (
        (await this.principals.findOne({ _id: id }, { session })) ||
        (await this.store.users.findOne({ _id: id }, { session }))
      )
        throw conflict();
      await this.principals.insertOne(next, { session });
      await this.event("principal.create", actor, id, next.generation, session);
      return next;
    });
  }
  async disablePrincipal(id: string, generation: string, actor: PrincipalRef) {
    actor = structuredClone(actor);
    requireActor(actor);
    if (!bounded(id) || !bounded(generation)) throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const old = await this.principals.findOne({ _id: id }, { session });
      if (!old || old.generation !== generation) throw conflict();
      if (old.status === "disabled") return old;
      const next = await this.principals.findOneAndUpdate(
        { _id: id, generation, status: "active" },
        { $set: { status: "disabled" } },
        { session, returnDocument: "after" },
      );
      if (!next) throw conflict();
      if (old.legacySource === "google") {
        const legacy = await this.store.users.updateOne(
          { _id: id, authorizationGeneration: generation },
          { $set: { status: "disabled" } },
          { session },
        );
        if (legacy.matchedCount !== 1) throw conflict();
      }
      await this.event("principal.disable", actor, id, generation, session);
      return next;
    });
  }
  async disableConnection(id: string, generation: string, actor: PrincipalRef) {
    actor = structuredClone(actor);
    requireActor(actor);
    if (!bounded(id) || !bounded(generation)) throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const old = await this.connections.findOne({ _id: id }, { session });
      if (!old || old.generation !== generation) throw conflict();
      if (old.status === "disabled") return old;
      const next = await this.connections.findOneAndUpdate(
        { _id: id, generation, status: "active" },
        { $set: { status: "disabled" } },
        { session, returnDocument: "after" },
      );
      if (!next) throw conflict();
      await this.event(
        "connection.disable",
        actor,
        id,
        generation,
        session,
        old.tenantId,
      );
      return next;
    });
  }
  private async liveConnection(id: string, session?: ClientSession) {
    const c = await this.connections.findOne(
      { _id: id, status: "active" },
      { session },
    );
    if (!c || !bounded(c.generation) || !["google", "oidc"].includes(c.kind))
      throw denied();
    issuer(c.issuer);
    if (
      c.kind === "google" &&
      (c.issuer !== "https://accounts.google.com" || c.tenantId !== undefined)
    )
      throw denied();
    if (c.tenantId !== undefined) tenantId(c.tenantId);
    return c;
  }
  private async livePrincipal(
    p: ExternalIdentityBinding["principal"],
    session?: ClientSession,
  ) {
    if (!isPrincipal(p) || (p as PrincipalRef).kind === "workload")
      throw denied();
    const found = await this.principals.findOne(
      { _id: p.id, kind: p.kind, generation: p.generation, status: "active" },
      { session },
    );
    if (!found) throw denied();
    if (
      found.legacySource === "google" &&
      !(await this.store.users.findOne(
        {
          _id: found._id,
          authorizationGeneration: found.generation,
          status: "active",
        },
        { session },
      ))
    )
      throw denied();
    return found;
  }
  async linkExternal(
    input: {
      connectionId: string;
      subject: string;
      principal: ExternalIdentityBinding["principal"];
    },
    actor: PrincipalRef,
  ) {
    input = structuredClone(input);
    actor = structuredClone(actor);
    requireActor(actor);
    if (!bounded(input.connectionId) || !opaque(input.subject)) throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const c = await this.liveConnection(input.connectionId, session);
      const p = await this.livePrincipal(input.principal, session);
      if (p.kind !== "human") throw invalid();
      const id = key("external", c._id, c.issuer, input.subject);
      const old = await this.externalBindings.findOne({ _id: id }, { session });
      if (old) {
        if (
          old.status !== "active" ||
          !same(old.principal, input.principal) ||
          old.connectionGeneration !== c.generation
        )
          throw conflict();
        return old;
      }
      const next: ExternalIdentityBinding = {
        _id: id,
        connectionId: c._id,
        connectionGeneration: c.generation,
        issuer: c.issuer,
        subject: input.subject,
        principal: input.principal,
        status: "active",
        createdAt: new Date(),
      };
      await this.externalBindings.insertOne(next, { session });
      await this.event(
        "identity.link",
        actor,
        id,
        p.generation,
        session,
        c.tenantId,
      );
      return next;
    });
  }
  /** A rehire is an explicit fresh binding and credential cohort, not revival. */
  async bindTenant(
    principal: ExternalIdentityBinding["principal"],
    tenant: string,
    actor: PrincipalRef,
  ) {
    principal = structuredClone(principal);
    actor = structuredClone(actor);
    requireActor(actor);
    tenantId(tenant);
    return this.store.withCatalogTransaction(async (session) => {
      await this.livePrincipal(principal, session);
      const t = await this.store.tenantRegistry.findOne(
        { _id: tenant, status: "active" },
        { session },
      );
      if (
        !t ||
        !bounded(t.authorizationGeneration) ||
        t.provisioningStatus === "pending"
      )
        throw denied();
      const id = identityBindingId(principal.id, tenant);
      const old = await this.tenantBindings.findOne({ _id: id }, { session });
      if (
        old &&
        (!Number.isSafeInteger(old.epoch) ||
          old.epoch < 1 ||
          old.epoch >= Number.MAX_SAFE_INTEGER)
      )
        throw conflict();
      if (old?.status === "active") {
        if (
          !same(old.principal, principal) ||
          old.tenantGeneration !== t.authorizationGeneration
        )
          throw conflict();
        return old;
      }
      const next: IdentityTenantBinding = {
        _id: id,
        tenantId: tenant,
        tenantGeneration: t.authorizationGeneration,
        principal,
        generation: randomUUID(),
        credentialGeneration: randomUUID(),
        notBeforeMs: Date.now(),
        status: "active",
        epoch: (old?.epoch ?? 0) + 1,
        createdAt: new Date(),
        ...(old?.legacyMembershipId
          ? { legacyMembershipId: old.legacyMembershipId }
          : {}),
      };
      if (old) {
        const replaced = await this.tenantBindings.replaceOne(
          { _id: id, epoch: old.epoch, status: "removed" },
          next,
          { session },
        );
        if (replaced.matchedCount !== 1) throw conflict();
      } else await this.tenantBindings.insertOne(next, { session });
      if (old?.legacyMembershipId) {
        const legacy = await this.store.memberships.updateOne(
          {
            _id: old.legacyMembershipId,
            userId: principal.id,
            tenantId: tenant,
            authorizationGeneration: old.generation,
            status: "removed",
          },
          {
            $set: {
              status: "active",
              authorizationGeneration: next.generation,
            },
          },
          { session },
        );
        if (legacy.matchedCount !== 1) throw conflict();
      }
      await this.event(
        old ? "binding.rehire" : "binding.create",
        actor,
        id,
        next.generation,
        session,
        tenant,
      );
      return next;
    });
  }
  async removeBinding(id: string, generation: string, actor: PrincipalRef) {
    actor = structuredClone(actor);
    requireActor(actor);
    if (!bounded(id) || !bounded(generation)) throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const old = await this.tenantBindings.findOne({ _id: id }, { session });
      if (!old || old.generation !== generation) throw conflict();
      if (old.status === "removed") return old;
      if (
        !Number.isSafeInteger(old.epoch) ||
        old.epoch < 1 ||
        old.epoch >= Number.MAX_SAFE_INTEGER
      )
        throw conflict();
      const result = await this.tenantBindings.findOneAndUpdate(
        { _id: id, generation, status: "active", epoch: old.epoch },
        {
          $set: { status: "removed", removedAt: new Date() },
          $inc: { epoch: 1 },
        },
        { session, returnDocument: "after" },
      );
      if (!result) throw conflict();
      if (old.legacyMembershipId) {
        const legacy = await this.store.memberships.updateOne(
          {
            _id: old.legacyMembershipId,
            userId: old.principal.id,
            tenantId: old.tenantId,
            authorizationGeneration: generation,
            status: "active",
          },
          { $set: { status: "removed" } },
          { session },
        );
        if (legacy.matchedCount !== 1) throw conflict();
      }
      await this.tombstones.insertOne(
        {
          _id: key("removed", id, generation),
          bindingId: id,
          generation,
          credentialGeneration: old.credentialGeneration,
          tenantId: old.tenantId,
          at: new Date(),
        },
        { session },
      );
      await this.event(
        "binding.remove",
        actor,
        id,
        generation,
        session,
        old.tenantId,
      );
      return result;
    });
  }
  async registerClient(
    input: { connectionId: string; clientId: string; bindingId: string },
    actor: PrincipalRef,
  ) {
    input = structuredClone(input);
    actor = structuredClone(actor);
    requireActor(actor);
    if (
      !bounded(input.connectionId) ||
      !opaque(input.clientId) ||
      !bounded(input.bindingId)
    )
      throw invalid();
    return this.store.withCatalogTransaction(async (session) => {
      const c = await this.liveConnection(input.connectionId, session);
      const b = await this.tenantBindings.findOne(
        { _id: input.bindingId, status: "active" },
        { session },
      );
      if (
        !b ||
        b.principal.kind !== "service" ||
        (c.tenantId && c.tenantId !== b.tenantId)
      )
        throw denied();
      await this.livePrincipal(b.principal, session);
      const id = key("client", c._id, c.issuer, input.clientId, b.tenantId);
      const old = await this.clients.findOne({ _id: id }, { session });
      if (old) {
        if (
          old.status !== "active" ||
          old.connectionGeneration !== c.generation ||
          old.bindingId !== b._id ||
          !same(old.principal, b.principal)
        )
          throw conflict();
        return old;
      }
      const next: RegisteredIdentityClient = {
        _id: id,
        connectionId: c._id,
        connectionGeneration: c.generation,
        issuer: c.issuer,
        clientId: input.clientId,
        tenantId: b.tenantId,
        bindingId: b._id,
        principal: b.principal,
        generation: randomUUID(),
        status: "active",
        createdAt: new Date(),
      };
      await this.clients.insertOne(next, { session });
      await this.event(
        "client.register",
        actor,
        id,
        next.generation,
        session,
        b.tenantId,
      );
      return next;
    });
  }
  /** Claims have already passed trusted signature/issuer/purpose verification. */
  async resolveHuman(
    connectionId: string,
    verifiedIssuer: string,
    subject: string,
  ) {
    if (!bounded(connectionId) || !opaque(subject)) throw denied();
    const c = await this.liveConnection(connectionId);
    if (c.issuer !== verifiedIssuer) throw denied();
    const binding = await this.externalBindings.findOne({
      connectionId,
      connectionGeneration: c.generation,
      issuer: c.issuer,
      subject,
      status: "active",
    });
    if (!binding || binding.principal.kind !== "human") throw denied();
    await this.livePrincipal(binding.principal);
    return {
      principal: binding.principal,
      connection: c,
      externalBindingId: binding._id,
    };
  }
  async resolveBoundHuman(
    input: {
      connectionId: string;
      connectionGeneration: string;
      externalBindingId: string;
      principalId: string;
      principalGeneration: string;
    },
    session?: ClientSession,
  ) {
    input = structuredClone(input);
    if (!Object.values(input).every(bounded)) throw denied();
    const connection = await this.liveConnection(input.connectionId, session);
    if (connection.generation !== input.connectionGeneration) throw denied();
    const principal = {
      kind: "human",
      id: input.principalId,
      generation: input.principalGeneration,
    } as const;
    const external = await this.externalBindings.findOne(
      {
        _id: input.externalBindingId,
        connectionId: connection._id,
        connectionGeneration: connection.generation,
        issuer: connection.issuer,
        status: "active",
        "principal.kind": "human",
        "principal.id": principal.id,
        "principal.generation": principal.generation,
      },
      { session },
    );
    if (!external) throw denied();
    return {
      connection,
      principal: await this.livePrincipal(principal, session),
      externalBindingId: external._id,
    };
  }
  /** Registered OAuth client for a verified issuer + client_id in one tenant. */
  async resolveClient(
    connectionId: string,
    verifiedIssuer: string,
    clientId: string,
    tenant: string,
  ) {
    if (!bounded(connectionId) || !opaque(clientId)) throw denied();
    tenantId(tenant);
    const c = await this.liveConnection(connectionId);
    if (c.issuer !== verifiedIssuer) throw denied();
    const client = await this.clients.findOne({
      connectionId,
      connectionGeneration: c.generation,
      issuer: c.issuer,
      clientId,
      tenantId: tenant,
      status: "active",
    });
    if (!client || client.principal.kind !== "service") throw denied();
    return client;
  }
  async validateCredential(
    input: {
      connectionId: string;
      verifiedIssuer: string;
      principal: ExternalIdentityBinding["principal"];
      tenantId: string;
      bindingId: string;
      cohort: CredentialCohort;
      clientId?: string;
    },
    options: { session?: ClientSession } = {},
  ) {
    input = structuredClone(input);
    const now = Date.now();
    if (
      !bounded(input.connectionId) ||
      !bounded(input.bindingId) ||
      !validCohort(input.cohort, now)
    )
      throw denied();
    tenantId(input.tenantId);
    const c = await this.liveConnection(input.connectionId, options.session);
    if (
      c.issuer !== input.verifiedIssuer ||
      c.generation !== input.cohort.connectionGeneration ||
      (c.tenantId && c.tenantId !== input.tenantId)
    )
      throw denied();
    await this.livePrincipal(input.principal, options.session);
    const b = await this.tenantBindings.findOne(
      {
        _id: input.bindingId,
        tenantId: input.tenantId,
        status: "active",
      },
      { session: options.session },
    );
    const t = await this.store.tenantRegistry.findOne(
      {
        _id: input.tenantId,
        status: "active",
      },
      { session: options.session },
    );
    if (!matchesIdentityCohort(b, t, input.principal, input.cohort))
      throw denied();
    if (
      b.legacyMembershipId &&
      !(await this.store.memberships.findOne(
        {
          _id: b.legacyMembershipId,
          userId: b.principal.id,
          tenantId: b.tenantId,
          authorizationGeneration: b.generation,
          status: "active",
        },
        { session: options.session },
      ))
    )
      throw denied();
    if (input.principal.kind === "service") {
      if (input.cohort.externalBindingId !== undefined) throw denied();
      if (!opaque(input.clientId) || !bounded(input.cohort.clientGeneration))
        throw denied();
      const client = await this.clients.findOne(
        {
          connectionId: c._id,
          connectionGeneration: c.generation,
          issuer: c.issuer,
          clientId: input.clientId,
          tenantId: b.tenantId,
          bindingId: b._id,
          generation: input.cohort.clientGeneration,
          status: "active",
        },
        { session: options.session },
      );
      if (!client || !same(client.principal, b.principal)) throw denied();
    } else {
      if (
        input.clientId !== undefined ||
        input.cohort.clientGeneration !== undefined ||
        !bounded(input.cohort.externalBindingId)
      )
        throw denied();
      const external = await this.externalBindings.findOne(
        {
          _id: input.cohort.externalBindingId,
          connectionId: c._id,
          connectionGeneration: c.generation,
          issuer: c.issuer,
          status: "active",
        },
        { session: options.session },
      );
      if (!external || !same(external.principal, b.principal)) throw denied();
    }
    if (Date.now() >= input.cohort.expiresAtMs) throw denied();
    return {
      principal: b.principal,
      tenant: { id: b.tenantId, generation: b.tenantGeneration },
      binding: { id: b._id, generation: b.generation },
      connection: c,
    };
  }
}

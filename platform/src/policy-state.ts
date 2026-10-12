import { createHash, randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { Store } from "./store";
import { ApiError } from "./errors";
import {
  AUTHORIZATION_VERSION,
  contextFailure,
  isAction,
  isPrincipal,
  isPolicyRevision,
  isAdmissionReceipt,
  isResource,
  type Action,
  type AdmissionReceipt,
  type AuthorizationContext,
  type PolicyRevision,
  type PrincipalRef,
  type ResourceRef,
  type ResourceType,
} from "../../shared/authorization";

export interface TenantPolicyState {
  _id: string;
  generation: string;
  epoch: number;
  desired: PolicyRevision;
  active?: PolicyRevision;
  fence: "pending" | "revoked" | "restore" | null;
  status: "active" | "disabled";
}
export type EntityKind = "principal" | "binding" | ResourceType;
export interface PolicyEntity {
  tenantId: string;
  kind: EntityKind;
  id: string;
  generation: string;
  status: "pending" | "active" | "revoked";
  revision: number;
  subject?: PrincipalRef;
}
interface EntityDocument extends PolicyEntity {
  _id: string;
}
export interface EntityChange {
  kind: "create" | "revoke" | "replace";
  entity: Omit<PolicyEntity, "status" | "revision">;
}
export interface PolicyOperation {
  tenantId: string;
  tenantGeneration: string;
  operationId: string;
  payloadDigest: string;
  actor: PrincipalRef;
  action: Action;
  requestId: string;
}
export interface PolicyMutation extends PolicyOperation {
  changes: readonly EntityChange[];
  // Revoke and other privilege-reducing changes deny before projection.
  fence: "pending" | "revoked";
}
interface MutationReceipt {
  _id: string;
  payloadDigest: string;
  actor: PrincipalRef;
  tenantGeneration: string;
  action: Action;
  revision: PolicyRevision;
}
export interface PolicyOutbox {
  _id: string;
  tenantId: string;
  epoch: number;
  revision: PolicyRevision;
  state: "pending" | "published";
  at: Date;
}
export interface PolicyAudit {
  _id: string;
  tenantId: string;
  actor: PrincipalRef;
  action: string;
  requestId: string;
  operationId: string;
  outcome: string;
  revision: PolicyRevision;
  at: Date;
  targets?: readonly {
    kind: EntityKind;
    id: string;
    generation: string;
    operation: EntityChange["kind"];
  }[];
}
interface StoredAdmission extends AdmissionReceipt {
  _id: string;
  state: "admitted" | "consumed";
}

// Implemented by the selected engine adapter. Callers never supply an allow
// result in an HTTP request. This interface is also used by the ordering POC.
export interface PolicyChecker {
  check(input: {
    context: AuthorizationContext;
    action: Action;
    resource: ResourceRef;
    policy: PolicyRevision;
    signal: AbortSignal;
  }): Promise<boolean>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const operationKey = (tenant: string, operation: string) =>
  `${tenant}:${operation}`;
const entityKey = (e: Pick<PolicyEntity, "tenantId" | "kind" | "id">) =>
  `${e.tenantId}:${e.kind}:${e.id}`;
const samePolicy = (a: PolicyRevision | undefined, b: PolicyRevision) =>
  !!a &&
  a.tenantId === b.tenantId &&
  a.revision === b.revision &&
  a.modelId === b.modelId &&
  a.namespace === b.namespace;
const samePrincipal = (a: PrincipalRef | undefined, b: PrincipalRef) =>
  !!a &&
  a.kind === b.kind &&
  a.id === b.id &&
  a.generation === b.generation &&
  (a.kind !== "workload" || (b.kind === "workload" && a.purpose === b.purpose));
const unavailable = () =>
  new ApiError(
    503,
    "Authorization policy is not ready. Try again shortly.",
    "POLICY_UNAVAILABLE",
  );
const denied = () =>
  new ApiError(
    403,
    "You do not have access to this operation.",
    "AUTHORIZATION_DENIED",
  );
const conflict = () =>
  new ApiError(
    409,
    "This operation identifier was already used for a different request.",
    "IDEMPOTENCY_CONFLICT",
  );

/**
 * Authoritative publication and admission primitives, initially a POC. This
 * module is not wired into legacy routes until the engine and identity gates
 * pass. Mutators are trusted control-plane code, not public policy APIs.
 * Every lifecycle mutation must update the same tenant epoch as admission.
 */
export class PolicyStateStore {
  constructor(private readonly store: Store) {}
  get states() {
    return this.store.catalog.collection<TenantPolicyState>(
      "authorization_policy_state",
    );
  }
  get entities() {
    return this.store.catalog.collection<EntityDocument>(
      "authorization_entities",
    );
  }
  get outbox() {
    return this.store.catalog.collection<PolicyOutbox>("authorization_outbox");
  }
  get audit() {
    return this.store.catalog.collection<PolicyAudit>("authorization_audit");
  }
  get mutations() {
    return this.store.catalog.collection<MutationReceipt>(
      "authorization_mutations",
    );
  }
  get admissions() {
    return this.store.catalog.collection<StoredAdmission>(
      "authorization_admissions",
    );
  }

  async ensureIndexes() {
    await Promise.all([
      this.entities.createIndex(
        { tenantId: 1, kind: 1, id: 1 },
        { unique: true },
      ),
      this.entities.createIndex({ tenantId: 1, status: 1, revision: 1 }),
      this.outbox.createIndex({ state: 1, at: 1 }),
      this.outbox.createIndex(
        { tenantId: 1, "revision.revision": 1 },
        { unique: true },
      ),
      this.audit.createIndex({ tenantId: 1, at: -1 }),
      this.admissions.createIndex(
        { tenantId: 1, operationId: 1 },
        { unique: true },
      ),
    ]);
  }

  private validateOperation(operation: PolicyOperation) {
    if (
      !isResource({
        tenantId: operation.tenantId,
        type: "organization",
        id: operation.tenantId,
        generation: operation.tenantGeneration,
      }) ||
      !ID.test(operation.operationId) ||
      !DIGEST.test(operation.payloadDigest) ||
      !isPrincipal(operation.actor) ||
      !isAction(operation.action) ||
      !/^[\w.:-]{1,64}$/.test(operation.requestId)
    )
      throw new ApiError(
        400,
        "Invalid authorization operation.",
        "INVALID_INPUT",
      );
  }

  async initialize(input: PolicyOperation, modelId: string) {
    const operation = structuredClone(input);
    this.validateOperation(operation);
    if (!ID.test(modelId))
      throw new ApiError(400, "Invalid policy model.", "INVALID_INPUT");
    const revision: PolicyRevision = {
      tenantId: operation.tenantId,
      revision: 1,
      modelId,
      namespace: randomUUID(),
    };
    return this.store.withCatalogTransaction(async (session) => {
      const previous = await this.mutations.findOne(
        { _id: operationKey(operation.tenantId, operation.operationId) },
        { session },
      );
      if (previous) return this.replayMutation(previous, operation);
      await this.states.insertOne(
        {
          _id: operation.tenantId,
          generation: operation.tenantGeneration,
          epoch: 1,
          desired: revision,
          fence: "pending",
          status: "active",
        },
        { session },
      );
      await this.recordMutation(operation, revision, 1, session);
      return revision;
    });
  }

  private replayMutation(
    previous: MutationReceipt,
    operation: PolicyOperation,
  ) {
    if (
      previous.tenantGeneration !== operation.tenantGeneration ||
      previous.payloadDigest !== operation.payloadDigest ||
      !samePrincipal(previous.actor, operation.actor) ||
      previous.action !== operation.action
    )
      throw conflict();
    return previous.revision;
  }

  private async recordMutation(
    operation: PolicyOperation,
    revision: PolicyRevision,
    epoch: number,
    session: ClientSession,
    changes: readonly EntityChange[] = [],
  ) {
    const key = operationKey(operation.tenantId, operation.operationId);
    await this.mutations.insertOne(
      {
        _id: key,
        payloadDigest: operation.payloadDigest,
        actor: operation.actor,
        tenantGeneration: operation.tenantGeneration,
        action: operation.action,
        revision,
      },
      { session },
    );
    await this.audit.insertOne(
      {
        _id: key,
        tenantId: operation.tenantId,
        actor: operation.actor,
        action: operation.action,
        requestId: operation.requestId,
        operationId: operation.operationId,
        outcome: "committed",
        targets: changes.map((change) => ({
          kind: change.entity.kind,
          id: change.entity.id,
          generation: change.entity.generation,
          operation: change.kind,
        })),
        revision,
        at: new Date(),
      },
      { session },
    );
    await this.outbox.insertOne(
      {
        _id: key,
        tenantId: operation.tenantId,
        epoch,
        revision,
        state: "pending",
        at: new Date(),
      },
      { session },
    );
  }

  async mutate(input: PolicyMutation) {
    const operation = structuredClone(input);
    this.validateOperation(operation);
    if (
      !Array.isArray(operation.changes) ||
      !operation.changes.length ||
      operation.changes.length > 1000 ||
      !["pending", "revoked"].includes(operation.fence)
    )
      throw new ApiError(
        400,
        "A policy mutation requires 1–1000 changes and a valid fence.",
        "INVALID_INPUT",
      );
    for (const change of operation.changes) {
      const e = change.entity;
      const type =
        e.kind === "principal" || e.kind === "binding"
          ? "organization"
          : e.kind;
      if (
        !["create", "revoke", "replace"].includes(change.kind) ||
        !isResource({
          tenantId: e.tenantId,
          type,
          id: e.id,
          generation: e.generation,
        }) ||
        e.tenantId !== operation.tenantId ||
        (["binding", "principal"].includes(e.kind) &&
          !isPrincipal(e.subject)) ||
        (e.kind === "principal" &&
          (e.subject?.id !== e.id || e.subject?.generation !== e.generation))
      )
        throw new ApiError(400, "Invalid policy entity.", "INVALID_INPUT");
    }
    // Mint a namespace once, outside a retryable callback. A failed attempt
    // never dispatches projection; the outbox becomes visible only at commit.
    const namespace = randomUUID();
    return this.store.withCatalogTransaction(async (session) => {
      const previous = await this.mutations.findOne(
        { _id: operationKey(operation.tenantId, operation.operationId) },
        { session },
      );
      if (previous) return this.replayMutation(previous, operation);
      const state = await this.states.findOne(
        { _id: operation.tenantId, generation: operation.tenantGeneration },
        { session },
      );
      if (!state) throw denied();
      if (
        state.fence === "restore" ||
        !isPolicyRevision(state.desired) ||
        state.desired.tenantId !== state._id ||
        state.desired.revision >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(state.epoch) ||
        state.epoch >= Number.MAX_SAFE_INTEGER
      )
        throw unavailable();
      const revision = {
        ...state.desired,
        revision: state.desired.revision + 1,
        namespace,
      };
      const written = await this.states.updateOne(
        { _id: state._id, epoch: state.epoch },
        {
          $set: { desired: revision, fence: operation.fence },
          $inc: { epoch: 1 },
        },
        { session },
      );
      if (written.modifiedCount !== 1) throw unavailable();
      for (const change of operation.changes) {
        const e = change.entity;
        const existing = await this.entities.findOne(
          { _id: entityKey(e) },
          { session },
        );
        if (change.kind === "create") {
          if (existing)
            throw new ApiError(
              409,
              "This policy entity already exists.",
              "POLICY_ENTITY_CONFLICT",
            );
          await this.entities.insertOne(
            {
              ...e,
              _id: entityKey(e),
              status: "pending",
              revision: revision.revision,
            },
            { session },
          );
        } else if (change.kind === "revoke") {
          if (!existing || existing.generation !== e.generation) throw denied();
          await this.entities.updateOne(
            { _id: existing._id, generation: e.generation },
            { $set: { status: "revoked", revision: revision.revision } },
            { session },
          );
        } else {
          if (
            !existing ||
            existing.status !== "revoked" ||
            existing.generation === e.generation
          )
            throw new ApiError(
              409,
              "A new generation requires a revoked entity.",
              "POLICY_ENTITY_CONFLICT",
            );
          await this.entities.replaceOne(
            { _id: existing._id, generation: existing.generation },
            {
              ...e,
              status: "pending",
              revision: revision.revision,
            },
            { session },
          );
        }
      }
      await this.recordMutation(
        operation,
        revision,
        state.epoch + 1,
        session,
        operation.changes,
      );
      return revision;
    });
  }

  // Only the trusted projector may acknowledge its verified, complete graph.
  // An old acknowledgment cannot change the active pointer or clear a fence.
  private requirePolicyWorkload(
    context: AuthorizationContext,
    purpose: "projection" | "reconciliation",
    tenantId: string,
    targetId: string,
  ) {
    if (
      contextFailure(
        context,
        purpose === "projection"
          ? "worker.policy.project"
          : "worker.policy.reconcile",
        {
          tenantId,
          type: "policy",
          id: targetId,
          generation: context?.tenant?.generation,
        },
        Date.now(),
      ) ||
      context.principal.kind !== "workload" ||
      context.principal.purpose !== purpose
    )
      throw denied();
  }

  async publish(input: PolicyRevision, authority: AuthorizationContext) {
    const revision = structuredClone(input);
    const context = structuredClone(authority);
    if (!isPolicyRevision(revision)) throw unavailable();
    this.requirePolicyWorkload(
      context,
      "projection",
      revision.tenantId,
      revision.namespace,
    );
    return this.store.withCatalogTransaction(async (session) => {
      this.requirePolicyWorkload(
        context,
        "projection",
        revision.tenantId,
        revision.namespace,
      );
      const state = await this.states.findOne(
        { _id: revision.tenantId },
        { session },
      );
      this.requirePolicyWorkload(
        context,
        "projection",
        revision.tenantId,
        revision.namespace,
      );
      if (
        !state ||
        state.generation !== context.tenant.generation ||
        !samePolicy(state.desired, revision) ||
        state.status !== "active"
      )
        return false;
      if (
        !Number.isSafeInteger(state.epoch) ||
        state.epoch >= Number.MAX_SAFE_INTEGER
      )
        throw unavailable();
      if (state.fence === null && samePolicy(state.active, revision))
        return true;
      if (state.fence === "restore") return false;
      const outbox = await this.outbox.findOne(
        { tenantId: state._id, "revision.namespace": revision.namespace },
        { session },
      );
      if (!outbox || !samePolicy(outbox.revision, revision))
        throw unavailable();
      const written = await this.states.updateOne(
        { _id: state._id, epoch: state.epoch, desired: state.desired },
        { $set: { active: revision, fence: null }, $inc: { epoch: 1 } },
        { session },
      );
      if (written.modifiedCount !== 1) return false;
      await this.entities.updateMany(
        {
          tenantId: state._id,
          status: "pending",
          revision: { $lte: revision.revision },
        },
        { $set: { status: "active" } },
        { session },
      );
      await this.outbox.updateOne(
        { tenantId: state._id, "revision.namespace": revision.namespace },
        { $set: { state: "published" } },
        { session },
      );
      // Publication evidence is mandatory and append-only, not a best-effort log.
      await this.audit.insertOne(
        {
          _id: `publish:${revision.namespace}`,
          tenantId: state._id,
          actor: context.principal,
          action: "worker.policy.project",
          requestId: context.requestId,
          operationId: revision.namespace,
          outcome: "published",
          revision,
          at: new Date(),
        },
        { session },
      );
      this.requirePolicyWorkload(
        context,
        "projection",
        revision.tenantId,
        revision.namespace,
      );
      return true;
    });
  }

  async fenceForRestore(tenantId: string, authority: AuthorizationContext) {
    const context = structuredClone(authority);
    this.requirePolicyWorkload(context, "reconciliation", tenantId, tenantId);
    // A restore fence cannot be cleared by an ordinary projection acknowledgment.
    // Explicit reconciliation requires a new desired revision before release.
    const operationId = randomUUID();
    await this.store.withCatalogTransaction(async (session) => {
      this.requirePolicyWorkload(context, "reconciliation", tenantId, tenantId);
      const state = await this.states.findOne({ _id: tenantId }, { session });
      if (
        !state ||
        state.generation !== context.tenant.generation ||
        !isPolicyRevision(state.desired) ||
        !Number.isSafeInteger(state.epoch) ||
        state.epoch >= Number.MAX_SAFE_INTEGER
      )
        throw unavailable();
      const written = await this.states.updateOne(
        { _id: tenantId, epoch: state.epoch },
        { $set: { fence: "restore" }, $inc: { epoch: 1 } },
        { session },
      );
      if (written.modifiedCount !== 1) throw unavailable();
      this.requirePolicyWorkload(context, "reconciliation", tenantId, tenantId);
      await this.audit.insertOne(
        {
          _id: `restore:${operationId}`,
          tenantId,
          actor: context.principal,
          action: "worker.policy.reconcile",
          requestId: context.requestId,
          operationId,
          outcome: "restore_fenced",
          revision: state.desired,
          at: new Date(),
        },
        { session },
      );
      this.requirePolicyWorkload(context, "reconciliation", tenantId, tenantId);
    });
  }

  private async liveEntity(
    context: AuthorizationContext,
    kind: EntityKind,
    id: string,
    generation: string,
    session: ClientSession,
  ) {
    return this.entities.findOne(
      {
        _id: entityKey({ tenantId: context.tenant.id, kind, id }),
        generation,
        status: "active",
      },
      { session },
    );
  }

  /** Engine calls stay outside retryable transaction callbacks. */
  async admit(
    input: {
      context: AuthorizationContext;
      action: Action;
      resource: ResourceRef;
      operationId: string;
      payloadDigest: string;
    },
    checker: PolicyChecker,
  ): Promise<AdmissionReceipt> {
    const action = input.action;
    const context = structuredClone(input.context);
    const resource = structuredClone(input.resource);
    const operationId = input.operationId;
    const payloadDigest = input.payloadDigest;
    if (contextFailure(context, action, resource, Date.now())) throw denied();
    if (!ID.test(operationId) || !DIGEST.test(payloadDigest))
      throw new ApiError(400, "Invalid admission request.", "INVALID_INPUT");
    Object.freeze(context.principal);
    if (context.effectivePrincipal) Object.freeze(context.effectivePrincipal);
    Object.freeze(context.tenant);
    Object.freeze(context.binding);
    Object.freeze(context.credential.scopes);
    Object.freeze(context.credential);
    Object.freeze(context);
    Object.freeze(resource);
    const state = await this.states.findOne(
      { _id: context.tenant.id, generation: context.tenant.generation },
      { readConcern: { level: "majority" } },
    );
    if (!state || state.status !== "active") throw denied();
    if (
      state.fence !== null ||
      !isPolicyRevision(state.active) ||
      !isPolicyRevision(state.desired) ||
      state.active.tenantId !== state._id ||
      !Number.isSafeInteger(state.epoch) ||
      state.epoch >= Number.MAX_SAFE_INTEGER ||
      !samePolicy(state.desired, state.active)
    )
      throw unavailable();
    Object.freeze(state.active);
    const signal = AbortSignal.timeout(1000);
    // Independent expiry also bounds an adapter that fails to honor its signal.
    const expired = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(unavailable()), {
        once: true,
      });
    });
    let allowed: boolean;
    try {
      allowed = await Promise.race([
        checker.check({
          context,
          action,
          resource,
          policy: state.active,
          signal,
        }),
        expired,
      ]);
    } catch {
      throw unavailable();
    }
    if (allowed !== true) throw denied();
    const receiptId = randomUUID();
    return this.store.withCatalogTransaction(async (session) => {
      // The engine deadline bounds the remote check, not subsequent Mongo
      // contention. Transactional live state and the pinned policy still
      // validate authority on every retry; credential expiry is independent.
      if (contextFailure(context, action, resource, Date.now())) throw denied();
      // This is a real write, including idempotent replay, to the exact document
      // revocation writes. A snapshot read alone would not establish ordering.
      const written = await this.states.updateOne(
        {
          _id: state._id,
          generation: state.generation,
          fence: null,
          status: "active",
          active: state.active,
          desired: state.desired,
        },
        { $inc: { epoch: 1 } },
        { session },
      );
      if (written.modifiedCount !== 1) throw unavailable();
      const principal = await this.liveEntity(
        context,
        "principal",
        context.principal.id,
        context.principal.generation,
        session,
      );
      const effective = context.effectivePrincipal ?? context.principal;
      const binding = await this.liveEntity(
        context,
        "binding",
        context.binding.id,
        context.binding.generation,
        session,
      );
      const target = await this.liveEntity(
        context,
        resource.type,
        resource.id,
        resource.generation,
        session,
      );
      if (
        !principal ||
        !samePrincipal(principal.subject, context.principal) ||
        !binding ||
        !samePrincipal(binding.subject, effective) ||
        !target ||
        (context.effectivePrincipal &&
          !samePrincipal(
            (
              await this.liveEntity(
                context,
                "principal",
                effective.id,
                effective.generation,
                session,
              )
            )?.subject,
            effective,
          ))
      )
        throw denied();
      const key = operationKey(context.tenant.id, operationId);
      const previous = await this.admissions.findOne({ _id: key }, { session });
      if (previous) {
        if (
          previous.payloadDigest !== payloadDigest ||
          previous.action !== action ||
          !samePrincipal(previous.principal, context.principal) ||
          previous.resource.id !== resource.id ||
          previous.resource.type !== resource.type ||
          previous.resource.generation !== resource.generation ||
          previous.tenantGeneration !== context.tenant.generation ||
          previous.credentialId !== context.credential.id ||
          previous.binding.id !== context.binding.id ||
          previous.binding.generation !== context.binding.generation ||
          previous.executionGrantId !== context.executionGrantId ||
          !samePolicy(previous.policy, state.active!)
        )
          throw conflict();
        if (previous.expiresAtMs <= Date.now() || previous.state !== "admitted")
          throw denied();
        if (contextFailure(context, action, resource, Date.now()))
          throw denied();
        const { _id, state: _state, ...receipt } = previous;
        return receipt;
      }
      const now = Date.now();
      const receipt: AdmissionReceipt = {
        version: AUTHORIZATION_VERSION,
        id: receiptId,
        tenantId: context.tenant.id,
        operationId,
        payloadDigest,
        action,
        resource,
        principal: context.principal,
        tenantGeneration: context.tenant.generation,
        binding: context.binding,
        credentialId: context.credential.id,
        ...(context.effectivePrincipal
          ? { effectivePrincipal: context.effectivePrincipal }
          : {}),
        ...(context.executionGrantId
          ? { executionGrantId: context.executionGrantId }
          : {}),
        policy: state.active!,
        admittedAtMs: now,
        expiresAtMs: Math.min(context.credential.expiresAtMs, now + 5000),
      };
      await this.admissions.insertOne(
        { ...receipt, _id: key, state: "admitted" },
        { session },
      );
      await this.audit.insertOne(
        {
          _id: `admit:${key}`,
          tenantId: context.tenant.id,
          actor: context.principal,
          action,
          requestId: context.requestId,
          operationId,
          outcome: "admitted",
          revision: state.active!,
          at: new Date(now),
        },
        { session },
      );
      if (contextFailure(context, action, resource, Date.now())) throw denied();
      return receipt;
    });
  }

  async consume(input: AdmissionReceipt) {
    let receipt: AdmissionReceipt;
    try {
      receipt = structuredClone(input);
    } catch {
      return false;
    }
    if (!isAdmissionReceipt(receipt)) return false;
    // Protected dispatch must consume once before issuing an external effect.
    // An admitted operation ordered before a revoke may already be in flight.
    const result = await this.admissions.updateOne(
      {
        _id: operationKey(receipt.tenantId, receipt.operationId),
        id: receipt.id,
        payloadDigest: receipt.payloadDigest,
        action: receipt.action,
        tenantId: receipt.tenantId,
        tenantGeneration: receipt.tenantGeneration,
        resource: receipt.resource,
        principal: receipt.principal,
        binding: receipt.binding,
        credentialId: receipt.credentialId,
        effectivePrincipal: receipt.effectivePrincipal ?? { $exists: false },
        executionGrantId: receipt.executionGrantId ?? { $exists: false },
        policy: receipt.policy,
        admittedAtMs: receipt.admittedAtMs,
        state: "admitted",
        expiresAtMs: { $eq: receipt.expiresAtMs, $gt: Date.now() },
      },
      { $set: { state: "consumed" } },
      { writeConcern: { w: "majority" } },
    );
    return result.modifiedCount === 1;
  }
}

// Digests are computed by trusted boundary code over canonical operation data.
export function policyOperationDigest(canonical: string) {
  return createHash("sha256").update(canonical).digest("hex");
}

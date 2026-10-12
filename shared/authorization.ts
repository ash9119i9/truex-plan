// Versioned wire contracts shared by the platform and protected services.
// Shape validation is not authentication: only trusted authentication code may
// install a context, and live lifecycle/engine checks still precede each action.
export const AUTHORIZATION_VERSION = 1 as const;

export const ACTIONS = [
  "organization.read",
  "organization.members.manage",
  "organization.groups.manage",
  "organization.roles.manage",
  "organization.clients.manage",
  "organization.security.manage",
  "workspace.read",
  "workspace.manage",
  "agent.read",
  "agent.create",
  "agent.update",
  "agent.delete",
  "agent.publish",
  "agent.use",
  "conversation.create",
  "conversation.read",
  "conversation.send",
  "conversation.interrupt",
  "conversation.approve",
  "conversation.approval_mode.manage",
  "conversation.settings.manage",
  "conversation.archive",
  "conversation.fork",
  "conversation.resume",
  "conversation.delete",
  "conversation.share",
  "conversation.trace.read",
  "conversation.goal.read",
  "conversation.goal.update",
  "conversation.goal.review",
  "conversation.compact",
  "document.read",
  "document.download",
  "document.upload",
  "document.delete",
  "project.read",
  "project.create",
  "project.update",
  "project.delete",
  "connector.read",
  "connector.create",
  "connector.update",
  "connector.delete",
  "connector.manage",
  "connector.attach",
  "connector.use",
  "tool.discover",
  "tool.read",
  "tool.invoke",
  "tool.write",
  "model.read",
  "model.use",
  "skill.read",
  "skill.use",
  "audit.read",
  "audit.export",
  "support.request_access",
  "support.approve_access",
  "platform.tenants.read",
  "platform.tenants.create",
  "platform.tenants.manage",
  "platform.members.manage",
  "platform.invites.manage",
  "platform.security.manage",
  "worker.records.read",
  "worker.records.persist",
  "worker.records.ack",
  "worker.policy.project",
  "worker.policy.reconcile",
  "worker.cleanup",
] as const;
export type Action = (typeof ACTIONS)[number];
const actionSet: ReadonlySet<string> = new Set(ACTIONS);
export const isAction = (value: unknown): value is Action =>
  typeof value === "string" && actionSet.has(value);

export const RESOURCE_TYPES = [
  "organization",
  "workspace",
  "agent",
  "conversation",
  "document",
  "project",
  "connector",
  "model",
  "skill",
  "audit",
  "execution",
  "policy",
  "invite",
  "group",
  "role",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type WorkloadPurpose =
  | "ingestion"
  | "projection"
  | "reconciliation"
  | "cleanup"
  | "runtime"
  | "broker"
  | "gateway";
export type PrincipalRef =
  | { kind: "human" | "service"; id: string; generation: string }
  | {
      kind: "workload";
      id: string;
      generation: string;
      purpose: WorkloadPurpose;
    };

export interface AuthorizationContext {
  version: typeof AUTHORIZATION_VERSION;
  principal: PrincipalRef;
  tenant: { id: string; generation: string };
  binding: { id: string; generation: string };
  credential: {
    kind: "session" | "access_token" | "workload";
    id: string;
    issuedAtMs: number;
    expiresAtMs: number;
    scopes: readonly Action[];
  };
  requestId: string;
  // Required for runtime/broker/gateway workloads doing delegated execution.
  effectivePrincipal?: Exclude<PrincipalRef, { kind: "workload" }>;
  executionGrantId?: string;
}

export interface ResourceRef {
  tenantId: string;
  type: ResourceType;
  id: string;
  generation: string;
}

export interface PolicyRevision {
  tenantId: string;
  revision: number;
  modelId: string;
  namespace: string;
}

export const DENIAL_REASONS = [
  "missing_context",
  "invalid_context",
  "invalid_action",
  "invalid_resource",
  "credential_expired",
  "scope_denied",
  "tenant_mismatch",
  "lifecycle_stale",
  "principal_disabled",
  "tenant_disabled",
  "binding_removed",
  "resource_inactive",
  "policy_pending",
  "policy_fenced",
  "capability_denied",
  "content_denied",
  "grant_revoked",
  "approval_required",
  "assurance_required",
  "dependency_unavailable",
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];
export type AuthorizationDecision =
  | {
      allowed: true;
      decisionId: string;
      policy: PolicyRevision;
      validUntilMs: number;
    }
  | {
      allowed: false;
      decisionId: string;
      reason: DenialReason;
      unavailable: boolean;
    };

export interface InvocationAuthority {
  version: typeof AUTHORIZATION_VERSION;
  credential: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
  resourceGeneration: string;
  action: Action;
  operationId: string;
  expiresAtMs: number;
}

// Protected-service protocol. The credential is verified by the receiving
// service; a serialized AuthorizationContext supplied by a caller is never
// accepted as proof. Resource metadata is reloaded before an admission.
export interface AuthorizationCheckRequest {
  version: typeof AUTHORIZATION_VERSION;
  credential: string;
  action: Action;
  resource: Pick<ResourceRef, "type" | "id">;
  requestId: string;
}

export interface AdmissionRequest extends AuthorizationCheckRequest {
  operationId: string;
  // SHA-256 of the canonical operation, including target and all arguments.
  payloadDigest: string;
}

export interface AdmissionReceipt {
  version: typeof AUTHORIZATION_VERSION;
  id: string;
  tenantId: string;
  operationId: string;
  payloadDigest: string;
  action: Action;
  resource: ResourceRef;
  principal: PrincipalRef;
  tenantGeneration: string;
  binding: AuthorizationContext["binding"];
  credentialId: string;
  effectivePrincipal?: AuthorizationContext["effectivePrincipal"];
  executionGrantId?: string;
  policy: PolicyRevision;
  admittedAtMs: number;
  expiresAtMs: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REQUEST_ID = /^[\w.:-]{1,64}$/;
const PURPOSES = new Set<WorkloadPurpose>([
  "ingestion",
  "projection",
  "reconciliation",
  "cleanup",
  "runtime",
  "broker",
  "gateway",
]);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const millis = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function isPrincipal(value: unknown): value is PrincipalRef {
  if (!object(value) || !id(value.id) || !id(value.generation)) return false;
  return (
    value.kind === "human" ||
    value.kind === "service" ||
    (value.kind === "workload" &&
      PURPOSES.has(value.purpose as WorkloadPurpose))
  );
}

export function isResource(value: unknown): value is ResourceRef {
  return (
    object(value) &&
    typeof value.tenantId === "string" &&
    TENANT.test(value.tenantId) &&
    RESOURCE_TYPES.includes(value.type as ResourceType) &&
    id(value.id) &&
    id(value.generation)
  );
}

export function isPolicyRevision(value: unknown): value is PolicyRevision {
  return (
    object(value) &&
    typeof value.tenantId === "string" &&
    TENANT.test(value.tenantId) &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    id(value.modelId) &&
    id(value.namespace)
  );
}

// Receipt fields become Mongo predicates at consumption. Require scalar values
// and the exact v1 envelope so query operators cannot become authority.
export function isAdmissionReceipt(value: unknown): value is AdmissionReceipt {
  const keys = (record: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(record).every((key) => allowed.includes(key));
  const principal = (p: unknown) =>
    isPrincipal(p) &&
    keys(
      p as unknown as Record<string, unknown>,
      p.kind === "workload"
        ? ["kind", "id", "generation", "purpose"]
        : ["kind", "id", "generation"],
    );
  if (
    !object(value) ||
    !keys(value, [
      "version",
      "id",
      "tenantId",
      "operationId",
      "payloadDigest",
      "action",
      "resource",
      "principal",
      "tenantGeneration",
      "binding",
      "credentialId",
      "effectivePrincipal",
      "executionGrantId",
      "policy",
      "admittedAtMs",
      "expiresAtMs",
    ]) ||
    value.version !== AUTHORIZATION_VERSION ||
    !id(value.id) ||
    !id(value.operationId) ||
    typeof value.tenantId !== "string" ||
    !TENANT.test(value.tenantId) ||
    typeof value.payloadDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
    !isAction(value.action) ||
    !isResource(value.resource) ||
    !keys(value.resource as unknown as Record<string, unknown>, [
      "tenantId",
      "type",
      "id",
      "generation",
    ]) ||
    value.resource.tenantId !== value.tenantId ||
    !principal(value.principal) ||
    !id(value.tenantGeneration) ||
    !id(value.credentialId) ||
    !object(value.binding) ||
    !keys(value.binding, ["id", "generation"]) ||
    !id(value.binding.id) ||
    !id(value.binding.generation) ||
    !isPolicyRevision(value.policy) ||
    !keys(value.policy as unknown as Record<string, unknown>, [
      "tenantId",
      "revision",
      "modelId",
      "namespace",
    ]) ||
    value.policy.tenantId !== value.tenantId ||
    !millis(value.admittedAtMs) ||
    !millis(value.expiresAtMs) ||
    Number(value.expiresAtMs) <= Number(value.admittedAtMs) ||
    Number(value.expiresAtMs) - Number(value.admittedAtMs) > 5000
  )
    return false;
  const actor = value.principal as PrincipalRef;
  const delegated =
    actor.kind === "workload" &&
    ["runtime", "broker", "gateway"].includes(actor.purpose);
  return delegated
    ? principal(value.effectivePrincipal) &&
        (value.effectivePrincipal as PrincipalRef).kind !== "workload" &&
        id(value.executionGrantId)
    : value.effectivePrincipal === undefined &&
        value.executionGrantId === undefined;
}

export function isAuthorizationContext(
  value: unknown,
): value is AuthorizationContext {
  if (
    !object(value) ||
    value.version !== AUTHORIZATION_VERSION ||
    !isPrincipal(value.principal) ||
    !object(value.tenant) ||
    typeof value.tenant.id !== "string" ||
    !TENANT.test(value.tenant.id) ||
    !id(value.tenant.generation) ||
    !object(value.binding) ||
    !id(value.binding.id) ||
    !id(value.binding.generation) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    !object(value.credential)
  )
    return false;
  const credential = value.credential;
  if (
    typeof credential.kind !== "string" ||
    !["session", "access_token", "workload"].includes(credential.kind) ||
    !id(credential.id) ||
    !millis(credential.issuedAtMs) ||
    !millis(credential.expiresAtMs) ||
    credential.expiresAtMs <= credential.issuedAtMs ||
    !Array.isArray(credential.scopes) ||
    credential.scopes.length > ACTIONS.length ||
    !credential.scopes.every(isAction) ||
    new Set(credential.scopes).size !== credential.scopes.length
  )
    return false;
  if (value.principal.kind === "workload") {
    if (credential.kind !== "workload") return false;
    if (["runtime", "broker", "gateway"].includes(value.principal.purpose))
      return (
        isPrincipal(value.effectivePrincipal) &&
        value.effectivePrincipal.kind !== "workload" &&
        id(value.executionGrantId)
      );
  } else if (
    credential.kind === "workload" ||
    (value.principal.kind === "service" && credential.kind !== "access_token")
  )
    return false;
  return (
    value.effectivePrincipal === undefined &&
    value.executionGrantId === undefined
  );
}

export const PRIVATE_CONTENT_ACTIONS: ReadonlySet<Action> = new Set([
  "conversation.read",
  "conversation.trace.read",
  "conversation.goal.read",
  "document.read",
  "document.download",
  "project.read",
]);

// A workload has a fixed ceiling independent of any relationship permissions.
export const WORKLOAD_ACTIONS: Readonly<
  Record<WorkloadPurpose, readonly Action[]>
> = {
  ingestion: [
    "worker.records.read",
    "worker.records.persist",
    "worker.records.ack",
  ],
  projection: ["worker.policy.project"],
  reconciliation: ["worker.policy.reconcile"],
  cleanup: ["worker.cleanup", "conversation.interrupt", "conversation.delete"],
  runtime: [
    "conversation.send",
    "conversation.resume",
    "conversation.fork",
    "conversation.interrupt",
    "conversation.approve",
    "conversation.approval_mode.manage",
    "conversation.settings.manage",
    "conversation.archive",
    "conversation.compact",
    "conversation.goal.update",
    "conversation.goal.review",
    "conversation.read",
    "conversation.trace.read",
    "conversation.goal.read",
    "document.read",
    "document.download",
    "document.upload",
    "document.delete",
    "tool.discover",
    "tool.read",
    "tool.invoke",
    "tool.write",
    "model.use",
  ],
  broker: [
    "tool.discover",
    "tool.read",
    "tool.invoke",
    "tool.write",
    "connector.use",
  ],
  gateway: ["model.use"],
};

export function contextFailure(
  context: unknown,
  action: unknown,
  resource: unknown,
  nowMs: number,
): DenialReason | undefined {
  if (context === undefined || context === null) return "missing_context";
  if (!isAuthorizationContext(context) || !millis(nowMs))
    return "invalid_context";
  if (!isAction(action)) return "invalid_action";
  if (!isResource(resource)) return "invalid_resource";
  if (context.tenant.id !== resource.tenantId) return "tenant_mismatch";
  if (
    context.credential.expiresAtMs <= nowMs ||
    context.credential.issuedAtMs > nowMs
  )
    return "credential_expired";
  if (!context.credential.scopes.includes(action)) return "scope_denied";
  if (action.startsWith("worker.") && context.principal.kind !== "workload")
    return "scope_denied";
  if (
    context.principal.kind === "workload" &&
    !WORKLOAD_ACTIONS[context.principal.purpose].includes(action)
  )
    return "scope_denied";
  // Passing these invariants does not grant access: live state and the engine
  // must still authorize, including the private-content relationship.
  return undefined;
}

export const CAPABILITY_ACTIONS = {
  "thread/fork": "conversation.fork",
  "thread/compact/start": "conversation.compact",
  "thread/archive": "conversation.archive",
  "thread/unarchive": "conversation.archive",
  "thread/goal/get": "conversation.goal.read",
  "thread/goal/set": "conversation.goal.update",
  "thread/goal/clear": "conversation.goal.update",
  "thread/settings/update": "conversation.settings.manage",
} as const satisfies Readonly<Record<string, Action>>;

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWK,
} from "jose";
import { ApiError } from "./errors";
import type { Store } from "./store";
import { tenantId, tenantContext } from "./tenant";
import { userContext } from "./user";
import { requestContext } from "./http";
import {
  requireActionContext,
  requireAuthorizationContext,
  withAuthorizationContext,
} from "./authorization-context";
import {
  WORKLOAD_ACTIONS,
  isAction,
  isPrincipal,
  type Action,
  type AuthorizationContext,
  type PrincipalRef,
} from "../../shared/authorization";

export const WORKLOAD_AUDIENCE = "truex-platform-workload";
export const WORKLOAD_CLAIM = "https://truex.dev/workload-authz";
export const WORKER_PURPOSES = [
  "ingestion",
  "projection",
  "reconciliation",
  "cleanup",
] as const;
export type WorkerPurpose = (typeof WORKER_PURPOSES)[number];
type WorkerRef = Extract<PrincipalRef, { kind: "workload" }>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const purpose = (v: unknown): v is WorkerPurpose =>
  (WORKER_PURPOSES as readonly unknown[]).includes(v);
const invalid = () =>
  new ApiError(
    401,
    "Invalid or expired workload credential",
    "WORKLOAD_CREDENTIAL_INVALID",
  );
const unavailable = (cause?: unknown) =>
  new ApiError(
    503,
    "Workload authentication is unavailable",
    "WORKLOAD_AUTH_UNAVAILABLE",
    { cause },
  );
const digest = (parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function issuer(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error("Invalid workload issuer");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.href !== value
  )
    throw new Error("Invalid workload issuer");
  return value;
}
function scopes(value: unknown, p: WorkerPurpose): value is Action[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= WORKLOAD_ACTIONS[p].length &&
    new Set(value).size === value.length &&
    value.every((a) => isAction(a) && WORKLOAD_ACTIONS[p].includes(a))
  );
}
function publicKey(key: JWK): void {
  if (
    !key ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    key.alg !== "ES256" ||
    !id(key.kid) ||
    key.use !== "sig" ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.x ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y ?? "") ||
    Object.keys(key).some(
      (name) => !["kty", "crv", "alg", "kid", "use", "x", "y"].includes(name),
    )
  )
    throw new Error("Only pinned public ES256 workload keys are supported");
}
function operator(actor: PrincipalRef) {
  // Low-level control-plane writers: the caller must separately authorize the
  // named operator. These functions are never mounted as public HTTP routes.
  if (!isPrincipal(actor) || actor.kind !== "human")
    throw new ApiError(
      400,
      "Named operator required",
      "INVALID_WORKLOAD_INPUT",
    );
}
export interface WorkloadPrincipal {
  _id: string;
  generation: string;
  purpose: WorkerPurpose;
  status: "active" | "disabled";
  createdAt: Date;
}
export interface WorkloadBinding {
  _id: string;
  workloadId: string;
  workloadGeneration: string;
  tenantId: string;
  tenantGeneration: string;
  generation: string;
  credentialGeneration: string;
  scopes: Action[];
  notBeforeMs: number;
  status: "active" | "revoked";
  createdAt: Date;
}
export interface WorkloadKeyTrust {
  _id: string;
  issuer: string;
  kid: string;
  thumbprint: string;
  generation: string;
  status: "active" | "revoked";
  createdAt: Date;
}
export interface WorkloadAudit {
  _id: string;
  action: string;
  actor: PrincipalRef;
  targetId: string;
  generation: string;
  tenantId?: string;
  at: Date;
}

export class WorkloadStore {
  constructor(readonly store: Store) {}
  get principals() {
    return this.store.catalog.collection<WorkloadPrincipal>(
      "authorization_workloads",
    );
  }
  get bindings() {
    return this.store.catalog.collection<WorkloadBinding>(
      "authorization_workload_bindings",
    );
  }
  get keys() {
    return this.store.catalog.collection<WorkloadKeyTrust>(
      "authorization_workload_keys",
    );
  }
  get audit() {
    return this.store.catalog.collection<WorkloadAudit>(
      "authorization_workload_audit",
    );
  }
  async ensureIndexes() {
    await Promise.all([
      this.bindings.createIndex(
        { workloadId: 1, tenantId: 1 },
        { unique: true },
      ),
      this.keys.createIndex({ issuer: 1, kid: 1 }, { unique: true }),
      this.audit.createIndex({ tenantId: 1, at: -1 }),
    ]);
  }
  async registerKey(
    trustedIssuer: string,
    publicJwk: JWK,
    actor: PrincipalRef,
  ) {
    operator(actor);
    actor = structuredClone(actor);
    issuer(trustedIssuer);
    const key = structuredClone(publicJwk);
    publicKey(key);
    const kid = key.kid!;
    const thumbprint = await calculateJwkThumbprint(key);
    const row: WorkloadKeyTrust = {
      _id: digest([trustedIssuer, kid]),
      issuer: trustedIssuer,
      kid,
      thumbprint,
      generation: randomUUID(),
      status: "active",
      createdAt: new Date(),
    };
    await this.insert("key", row, actor);
    return row;
  }
  async registerPrincipal(p: WorkerPurpose, actor: PrincipalRef) {
    operator(actor);
    actor = structuredClone(actor);
    if (!purpose(p))
      throw new ApiError(
        400,
        "Invalid worker purpose",
        "INVALID_WORKLOAD_INPUT",
      );
    const row: WorkloadPrincipal = {
      _id: randomUUID(),
      generation: randomUUID(),
      purpose: p,
      status: "active",
      createdAt: new Date(),
    };
    await this.insert("principal", row, actor);
    return row;
  }
  async bindTenant(
    ref: WorkerRef,
    target: string,
    allowed: readonly Action[],
    actor: PrincipalRef,
  ) {
    operator(actor);
    actor = structuredClone(actor);
    tenantId(target);
    ref = structuredClone(ref);
    if (
      !isPrincipal(ref) ||
      ref.kind !== "workload" ||
      !purpose(ref.purpose) ||
      !scopes(allowed, ref.purpose)
    )
      throw new ApiError(
        400,
        "Invalid workload binding",
        "INVALID_WORKLOAD_INPUT",
      );
    const row: WorkloadBinding = {
      _id: randomUUID(),
      workloadId: ref.id,
      workloadGeneration: ref.generation,
      tenantId: target,
      tenantGeneration: "",
      generation: randomUUID(),
      credentialGeneration: randomUUID(),
      scopes: [...allowed],
      notBeforeMs: Date.now(),
      status: "active",
      createdAt: new Date(),
    };
    try {
      await this.store.withCatalogTransaction(async (session) => {
        const p = await this.principals.findOne({ _id: ref.id }, { session });
        const t = await this.store.tenantRegistry.findOne(
          { _id: target },
          { session },
        );
        if (
          !p ||
          p.status !== "active" ||
          p.generation !== ref.generation ||
          p.purpose !== ref.purpose ||
          !t ||
          t.status !== "active" ||
          t.provisioningStatus === "pending" ||
          !id(t.authorizationGeneration)
        )
          throw new ApiError(
            403,
            "Workload or workspace is unavailable",
            "WORKLOAD_BINDING_DENIED",
          );
        row.tenantGeneration = t.authorizationGeneration;
        await this.bindings.insertOne(row, { session });
        await this.audit.insertOne(
          {
            _id: randomUUID(),
            action: "workload.binding.create",
            actor,
            targetId: row._id,
            generation: row.generation,
            tenantId: target,
            at: new Date(),
          },
          { session },
        );
      });
    } catch (error) {
      this.writeError(error);
    }
    return row;
  }
  private async insert(
    kind: "key" | "principal",
    row: WorkloadKeyTrust | WorkloadPrincipal,
    actor: PrincipalRef,
  ) {
    try {
      await this.store.withCatalogTransaction(async (session) => {
        if (kind === "key")
          await this.keys.insertOne(row as WorkloadKeyTrust, { session });
        else
          await this.principals.insertOne(row as WorkloadPrincipal, {
            session,
          });
        await this.audit.insertOne(
          {
            _id: randomUUID(),
            action: `workload.${kind}.create`,
            actor,
            targetId: row._id,
            generation: row.generation,
            at: new Date(),
          },
          { session },
        );
      });
    } catch (error) {
      this.writeError(error);
    }
  }
  /** Revoked records remain as tombstones; IDs and key IDs cannot be reused. */
  async revoke(
    kind: "key" | "principal" | "binding",
    target: string,
    actor: PrincipalRef,
  ) {
    operator(actor);
    actor = structuredClone(actor);
    if (!id(target) || !["key", "principal", "binding"].includes(kind))
      throw new ApiError(
        400,
        "Invalid workload target",
        "INVALID_WORKLOAD_INPUT",
      );
    return this.store.withCatalogTransaction(async (session) => {
      const collection =
        kind === "key"
          ? this.keys
          : kind === "principal"
            ? this.principals
            : this.bindings;
      const row = await collection.findOne({ _id: target }, { session });
      if (!row)
        throw new ApiError(
          404,
          "Workload target not found",
          "WORKLOAD_TARGET_NOT_FOUND",
        );
      if (row.status !== "active") return false;
      const filter = {
        _id: target,
        generation: row.generation,
        status: "active" as const,
      };
      if (kind === "key")
        await this.keys.updateOne(
          filter,
          { $set: { status: "revoked" } },
          { session },
        );
      else if (kind === "principal")
        await this.principals.updateOne(
          filter,
          { $set: { status: "disabled" } },
          { session },
        );
      else
        await this.bindings.updateOne(
          filter,
          { $set: { status: "revoked" } },
          { session },
        );
      await this.audit.insertOne(
        {
          _id: randomUUID(),
          action: `workload.${kind}.revoke`,
          actor,
          targetId: target,
          generation: row.generation,
          ...("tenantId" in row ? { tenantId: row.tenantId } : {}),
          at: new Date(),
        },
        { session },
      );
      return true;
    });
  }
  private writeError(error: unknown): never {
    if ((error as { code?: number })?.code === 11000)
      throw new ApiError(
        409,
        "Workload record already exists; reuse is prohibited",
        "WORKLOAD_RECORD_CONFLICT",
      );
    throw error;
  }
}

export interface WorkloadAuthConfig {
  issuer: string;
  /** Operator-pinned PUBLIC ES256 keys, never credentials or token URLs. */
  keys: readonly JWK[];
}
// Only authenticate-and-run installs this private credential proof. A copied
// AuthorizationContext cannot stand in for a verified workload credential.
const workloadProof = new AsyncLocalStorage<{
  authenticator: WorkloadAuthenticator;
  token: string;
  purpose: WorkerPurpose;
  target: string;
}>();
export class WorkloadAuthenticator {
  private readonly keys: ReturnType<typeof createLocalJWKSet>;
  private readonly issuer: string;
  private readonly thumbprints = new Map<string, Promise<string>>();
  constructor(
    readonly registry: WorkloadStore,
    config: WorkloadAuthConfig,
  ) {
    this.issuer = issuer(config.issuer);
    if (
      !Array.isArray(config.keys) ||
      config.keys.length < 1 ||
      config.keys.length > 8
    )
      throw new Error("Workload auth requires 1 to 8 public keys");
    const pinnedKeys = structuredClone(config.keys);
    const kids = new Set<string>();
    for (const key of pinnedKeys) {
      publicKey(key);
      if (kids.has(key.kid!))
        throw new Error("Duplicate workload key identifier");
      kids.add(key.kid!);
      this.thumbprints.set(key.kid!, calculateJwkThumbprint(key));
    }
    this.keys = createLocalJWKSet({
      keys: pinnedKeys as JWK[],
    });
  }
  /** Crypto and live state verification precede entering the async actor scope. */
  async authenticate(
    token: string,
    expectedPurpose: WorkerPurpose,
    target: string,
  ): Promise<AuthorizationContext> {
    if (
      !purpose(expectedPurpose) ||
      typeof token !== "string" ||
      token.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw invalid();
    try {
      tenantId(target);
    } catch {
      throw invalid();
    }
    let verified;
    try {
      const header = decodeProtectedHeader(token);
      if (
        Object.keys(header).some(
          (name) => !["alg", "kid", "typ"].includes(name),
        ) ||
        !id(header.kid) ||
        header.typ !== "truex-workload+jwt"
      )
        throw invalid();
      verified = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: WORKLOAD_AUDIENCE,
        algorithms: ["ES256"],
        typ: "truex-workload+jwt",
        clockTolerance: 0,
        requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti", "scope"],
      });
    } catch {
      throw invalid();
    }
    const p = verified.payload;
    const now = Date.now();
    const raw = p[WORKLOAD_CLAIM];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const c = raw as Record<string, unknown>;
    const names = [
      "purpose",
      "tenant_id",
      "tenant_generation",
      "workload_generation",
      "binding_id",
      "binding_generation",
      "credential_generation",
      "key_generation",
    ];
    if (
      Object.keys(c).length !== names.length ||
      names.some((name) => !id(c[name])) ||
      c.purpose !== expectedPurpose ||
      c.tenant_id !== target ||
      !id(p.sub) ||
      !id(p.jti) ||
      p.aud !== WORKLOAD_AUDIENCE ||
      !Number.isSafeInteger(p.iat) ||
      !Number.isSafeInteger(p.exp) ||
      p.iat! * 1000 > now ||
      p.exp! * 1000 <= now ||
      p.exp! <= p.iat! ||
      p.exp! - p.iat! > 120 ||
      [
        "nonce",
        "at_hash",
        "c_hash",
        "client_id",
        "effective_principal",
        "execution_grant_id",
      ].some((name) => name in p)
    )
      throw invalid();
    if (
      typeof p.scope !== "string" ||
      p.scope.length > 256 ||
      !/^[a-z][a-z.]+(?: [a-z][a-z.]+)*$/.test(p.scope)
    )
      throw invalid();
    const signedScopes = p.scope.split(" ");
    if (!scopes(signedScopes, expectedPurpose)) throw invalid();
    const thumbprint = await this.thumbprints.get(
      verified.protectedHeader.kid!,
    );
    try {
      return await this.registry.store.withCatalogTransaction(
        async (session) => {
          const key = await this.registry.keys.findOne(
            { _id: digest([this.issuer, verified.protectedHeader.kid!]) },
            { session },
          );
          const worker = await this.registry.principals.findOne(
            { _id: p.sub! },
            { session },
          );
          const binding = await this.registry.bindings.findOne(
            { _id: c.binding_id as string },
            { session },
          );
          const tenant = await this.registry.store.tenantRegistry.findOne(
            { _id: target },
            { session },
          );
          if (
            !key ||
            key.status !== "active" ||
            key.issuer !== this.issuer ||
            key.kid !== verified.protectedHeader.kid ||
            key.generation !== c.key_generation ||
            key.thumbprint !== thumbprint ||
            !worker ||
            worker.status !== "active" ||
            worker.generation !== c.workload_generation ||
            worker.purpose !== expectedPurpose ||
            !binding ||
            binding.status !== "active" ||
            binding.workloadId !== worker._id ||
            binding.workloadGeneration !== worker.generation ||
            binding.tenantId !== target ||
            binding.tenantGeneration !== c.tenant_generation ||
            binding.generation !== c.binding_generation ||
            binding.credentialGeneration !== c.credential_generation ||
            !Number.isSafeInteger(binding.notBeforeMs) ||
            binding.notBeforeMs < 0 ||
            p.iat! * 1000 < binding.notBeforeMs ||
            !scopes(binding.scopes, expectedPurpose) ||
            !tenant ||
            tenant.status !== "active" ||
            tenant.provisioningStatus === "pending" ||
            tenant.authorizationGeneration !== c.tenant_generation
          )
            throw invalid();
          const permitted = signedScopes.filter((a) =>
            binding.scopes.includes(a),
          );
          if (!permitted.length || p.exp! * 1000 <= Date.now()) throw invalid();
          return {
            version: 1,
            principal: {
              kind: "workload",
              id: worker._id,
              generation: worker.generation,
              purpose: expectedPurpose,
            },
            tenant: { id: target, generation: binding.tenantGeneration },
            binding: { id: binding._id, generation: binding.generation },
            credential: {
              kind: "workload",
              id: createHash("sha256").update(token).digest("hex"),
              issuedAtMs: p.iat! * 1000,
              expiresAtMs: p.exp! * 1000,
              scopes: permitted,
            },
            requestId: randomUUID(),
          };
        },
      );
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw invalid();
      throw unavailable(error);
    }
  }
  async run<T>(
    token: string,
    p: WorkerPurpose,
    target: string,
    fn: () => T,
  ): Promise<Awaited<T>> {
    const context = await this.authenticate(token, p, target);
    return await userContext.exit(() =>
      tenantContext.exit(() =>
        requestContext.run({ requestId: context.requestId }, () =>
          workloadProof.run(
            { authenticator: this, token, purpose: p, target },
            () => withAuthorizationContext(context, fn),
          ),
        ),
      ),
    );
  }
}

/** Fixed mechanical ceiling, never a relationship/admission permission. */
export function requireWorkerAction(p: WorkerPurpose, action: Action) {
  const context = requireAuthorizationContext();
  if (context.principal.kind !== "workload" || context.principal.purpose !== p)
    throw new ApiError(
      403,
      "This worker cannot perform the operation",
      "WORKLOAD_ACTION_DENIED",
    );
  return requireActionContext(action, {
    type: "organization",
    tenantId: context.tenant.id,
    id: context.tenant.id,
    generation: context.tenant.generation,
  });
}
/** Workers cannot use a generic runtime transport to escape their purpose. */
export function requireWorkloadRuntimeScope(path: string, method: string) {
  const context = requireAuthorizationContext();
  if (context.principal.kind !== "workload") return;
  const p = context.principal.purpose;
  let action: Action | undefined;
  if (
    p === "ingestion" &&
    method === "GET" &&
    /^\/threads\/[A-Za-z0-9_-]{1,128}\/records$/.test(path)
  )
    action = "worker.records.read";
  if (
    p === "ingestion" &&
    method === "POST" &&
    /^\/threads\/[A-Za-z0-9_-]{1,128}\/records\/ack$/.test(path)
  )
    action = "worker.records.ack";
  if (
    p === "cleanup" &&
    method === "POST" &&
    /^\/threads\/[A-Za-z0-9_-]{1,128}\/interrupt$/.test(path)
  )
    action = "conversation.interrupt";
  if (!action)
    throw new ApiError(
      403,
      "This worker cannot invoke this runtime operation",
      "WORKLOAD_ACTION_DENIED",
    );
  requireWorkerAction(p as WorkerPurpose, action);
  return action;
}

/** Live actor/credential check; sensitive admission ordering remains A07. */
export async function requireLiveWorkerAction(
  p: WorkerPurpose,
  action: Action,
) {
  const current = requireWorkerAction(p, action);
  const proof = workloadProof.getStore();
  if (!proof || proof.purpose !== p || proof.target !== current.tenant.id)
    throw new ApiError(
      401,
      "Authenticated workload scope is required",
      "WORKLOAD_CONTEXT_REQUIRED",
    );
  const live = await proof.authenticator.authenticate(
    proof.token,
    p,
    proof.target,
  );
  if (
    live.credential.id !== current.credential.id ||
    live.principal.id !== current.principal.id ||
    live.principal.generation !== current.principal.generation ||
    live.tenant.generation !== current.tenant.generation ||
    live.binding.id !== current.binding.id ||
    live.binding.generation !== current.binding.generation ||
    !live.credential.scopes.includes(action)
  )
    throw new ApiError(
      403,
      "Workload access has changed",
      "WORKLOAD_ACTION_DENIED",
    );
  // The await must not extend an expired captured credential's authority.
  return requireWorkerAction(p, action);
}
export async function requireLiveWorkloadRuntimeScope(
  path: string,
  method: string,
) {
  const action = requireWorkloadRuntimeScope(path, method);
  if (action) {
    const current = requireAuthorizationContext();
    if (current.principal.kind !== "workload") throw invalid();
    await requireLiveWorkerAction(
      current.principal.purpose as WorkerPurpose,
      action,
    );
  }
}

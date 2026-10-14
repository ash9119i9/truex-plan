import {
  AgentDocument,
  ModelDocument,
  McpDocument,
  DatabaseId,
  idCandidates,
} from "./configuration-documents";
import { MongoClient, Db, type ClientSession } from "mongodb";
import { ApiError } from "../core/errors";
import { errorFields, log } from "../../../shared/logging";
import {
  currentTenant,
  DEFAULT_TENANT_ID,
  tenantContext,
  policyOf,
  type TenantDocument,
  type TenantRef,
} from "../tenancy/tenant";
import type {
  AuthFlowDocument,
  AuthSessionDocument,
  InviteDocument,
  MembershipDocument,
  UserDocument,
} from "../identity/auth";
import type {
  Session,
  Message,
  DomainEvent,
  TurnTrace,
  Project,
} from "../../../shared/contracts";
import type {
  TraceDocument,
  SessionDocument,
  AuditDocument,
  DemoUsageDocument,
  DemoTurnDocument,
  SkillDocument,
} from "./documents";
import { savePlan, type PlanUpdate } from "./plans";
import { persist } from "./records";
import { mcpIndexes, agentIndexes } from "./indexes";
export type {
  TraceDocument,
  SessionDocument,
  AuditDocument,
  DemoUsageDocument,
  DemoTurnDocument,
  SkillDocument,
} from "./documents";
export { newerPlan, type StoredPlan, type PlanUpdate } from "./plans";
export { mcpIndexes, agentIndexes } from "./indexes";
const TENANT_CACHE_MS = 5_000;
export class Store {
  readonly client: MongoClient;
  /** Models, skills and the tenant registry, shared by every tenant. */
  catalog!: Db;
  private connected = false;
  private indexed = new Map<string, Promise<unknown>>();
  private mcpIndexed = new Map<string, Promise<unknown>>();
  private tenants = new Map<string, { ref: TenantRef; expires: number }>();
  constructor(
    uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
    /** Database of the default tenant (the pre-tenancy database). */
    readonly database = process.env.MONGO_DB || "truex",
    // Unset keeps the catalog in the default tenant's database, which is
    // how data was laid out before tenancy.
    readonly catalogDatabase = process.env.CATALOG_MONGO_DB || database,
  ) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  }
  async connect() {
    await this.client.connect();
    this.catalog = this.client.db(this.catalogDatabase);
    this.connected = true;
    await Promise.all([
      this.tenantIndexes(this.database),
      this.catalog
        .collection("tenants")
        .createIndex({ dbName: 1 }, { unique: true }),
      this.catalog.collection("tenants").createIndex(
        { creationKey: 1 },
        {
          unique: true,
          partialFilterExpression: { creationKey: { $type: "string" } },
        },
      ),
      this.catalog
        .collection("truex_skills")
        .createIndex({ name: 1 }, { unique: true }),
      this.catalog
        .collection("tenants")
        .createIndex({ createdBy: 1, provisioningStatus: 1 }),
      ...this.authIndexes(),
    ]);
    return this;
  }
  // Database of the tenant in context; the default tenant outside any.
  get db(): Db {
    if (!this.connected) return undefined as unknown as Db;
    const tenant = currentTenant();
    const dbName = tenant?.dbName ?? this.database;
    // Background: a failure (or shutdown mid-build) is logged and retried on
    // the next use, never left as an unhandled rejection.
    this.tenantIndexes(dbName, tenant?.isUserSpecific === true).catch((error) =>
      log("warn", "tenant index creation failed", {
        op: "indexes",
        dbName,
        ...errorFields(error),
      }),
    );
    return this.client.db(dbName);
  }
  /** Builds a tenant database's indexes now, e.g. right after creating it. */
  ensureTenantIndexes(dbName: string, creatorHandles = false) {
    return this.tenantIndexes(dbName, creatorHandles);
  }
  /**
   * Resolves once the current tenant's indexes exist. Writes that rely on a
   * unique index (agent handles) wait for this, so a duplicate can never be
   * written before the index that would have rejected it.
   */
  indexesReady() {
    const tenant = currentTenant();
    return this.tenantIndexes(
      tenant?.dbName ?? this.database,
      tenant?.isUserSpecific === true,
    );
  }
  private tenantIndexes(dbName: string, creatorHandles = false) {
    let done = this.indexed.get(dbName);
    if (!done) {
      const db = this.client.db(dbName);
      done = Promise.all([
        db.collection("messages").createIndex({ sessionId: 1, at: 1 }),
        db.collection("sessions").createIndex({ status: 1 }),
        db.collection("traces").createIndex({ sessionId: 1, startedAt: 1 }),
        db.collection("sessions").createIndex({ projectId: 1, createdAt: -1 }),
        db.collection("sessions").createIndex({ userId: 1, createdAt: -1 }),
        db.collection("projects").createIndex({ ownerId: 1, updatedAt: -1 }),
        ...agentIndexes(db, creatorHandles),
        ...mcpIndexes(db),
      ]).catch((error) => {
        this.indexed.delete(dbName);
        throw error;
      });
      this.indexed.set(dbName, done);
    }
    return done;
  }
  // Tenant indexes are built in the background on first use. MCP names rely
  // on unique indexes, so MCP writes wait for these first: a duplicate written
  // before the build would slip through and then make the build itself fail.
  mcpReady() {
    const dbName = currentTenant()?.dbName ?? this.database;
    let done = this.mcpIndexed.get(dbName);
    if (!done) {
      done = Promise.all(mcpIndexes(this.client.db(dbName))).catch((error) => {
        this.mcpIndexed.delete(dbName);
        throw error;
      });
      this.mcpIndexed.set(dbName, done);
    }
    return done;
  }
  // Sign-in lives in the catalog: it has to find a user's tenants before any
  // tenant database is opened.
  private authIndexes() {
    return [
      this.users.createIndex({ googleSub: 1 }, { unique: true }),
      this.users.createIndex({ emailKey: 1 }, { unique: true }),
      this.memberships.createIndex(
        { userId: 1, tenantId: 1 },
        { unique: true },
      ),
      this.memberships.createIndex({ tenantId: 1, role: 1 }),
      this.invites.createIndex({ tokenHash: 1 }, { unique: true }),
      // One pending invite per address and tenant. Partial filters cannot
      // express "$exists: false", so this keys on a status field instead;
      // accepting or revoking sets status next to acceptedAt/revokedAt.
      this.invites.createIndex(
        { tenantId: 1, emailKey: 1 },
        { unique: true, partialFilterExpression: { status: "pending" } },
      ),
      // TTL indexes only expire Date values, so these fields are Dates.
      this.authSessions.createIndex(
        { absoluteExpiresAt: 1 },
        { expireAfterSeconds: 0 },
      ),
      this.authFlows.createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 }),
      // Revoking by user and workspace, e.g. on removal or a disabled tenant.
      this.authSessions.createIndex({ userId: 1, tenantId: 1 }),
      this.authSessions.createIndex({ tenantId: 1 }),
      // Security audit trail and public-demo usage live in the catalog too.
      this.audit.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.audit.createIndex({ tenantId: 1, at: -1 }),
      this.demoUsage.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.demoTurns.createIndex(
        { userId: 1, tenantId: 1, conversationId: 1, clientId: 1 },
        { unique: true },
      ),
      this.demoTurns.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ];
  }
  get users() {
    return this.catalog.collection<UserDocument>("users");
  }
  get memberships() {
    return this.catalog.collection<MembershipDocument>("memberships");
  }
  get invites() {
    return this.catalog.collection<InviteDocument>("invites");
  }
  get authSessions() {
    return this.catalog.collection<AuthSessionDocument>("auth_sessions");
  }
  get authFlows() {
    return this.catalog.collection<AuthFlowDocument>("auth_flows");
  }
  get tenantRegistry() {
    return this.catalog.collection<TenantDocument>("tenants");
  }
  get audit() {
    return this.catalog.collection<AuditDocument>("security_audit");
  }
  get demoUsage() {
    return this.catalog.collection<DemoUsageDocument>("demo_usage");
  }
  get demoTurns() {
    return this.catalog.collection<DemoTurnDocument>("demo_turn_reservations");
  }
  private defaultRef(doc?: TenantDocument | null): TenantRef {
    return {
      id: DEFAULT_TENANT_ID,
      dbName: this.database,
      ...(doc?.allowedModelIds ? { allowedModelIds: doc.allowedModelIds } : {}),
      ...(doc?.allowedSkillIds ? { allowedSkillIds: doc.allowedSkillIds } : {}),
      ...policyOf(doc),
    };
  }
  private toRef(doc: TenantDocument): TenantRef {
    return {
      id: doc._id,
      dbName: doc.dbName,
      ...(doc.allowedModelIds ? { allowedModelIds: doc.allowedModelIds } : {}),
      ...(doc.allowedSkillIds ? { allowedSkillIds: doc.allowedSkillIds } : {}),
      ...policyOf(doc),
    };
  }
  /** Drops the cached ref, e.g. right after a policy or status change. */
  invalidateTenant(id: string) {
    this.tenants.delete(id);
  }
  // The default tenant always exists (its database is MONGO_DB); others must
  // be registered and active. Briefly cached: every request resolves one.
  // fresh reads the registry now, for checks that must not trust the cache
  // (e.g. whether a long-lived stream may keep going).
  async resolveTenant(
    id: string,
    options: { fresh?: boolean } = {},
  ): Promise<TenantRef> {
    const hit = this.tenants.get(id);
    if (!options.fresh && hit && hit.expires > Date.now()) return hit.ref;
    const doc = await this.tenantRegistry.findOne({ _id: id });
    if (doc?.provisioningStatus === "pending")
      throw new ApiError(
        403,
        "This workspace is still being set up. Try again shortly.",
        "TENANT_NOT_READY",
      );
    if (doc?.status === "disabled")
      throw new ApiError(403, "This workspace is disabled", "TENANT_DISABLED");
    let ref: TenantRef;
    if (id === DEFAULT_TENANT_ID) ref = this.defaultRef(doc);
    else if (doc && doc.dbName) ref = this.toRef(doc);
    else throw new ApiError(403, "Unknown workspace", "TENANT_NOT_FOUND");
    this.tenants.set(id, { ref, expires: Date.now() + TENANT_CACHE_MS });
    return ref;
  }
  /** Every tenant whose sessions need background ingestion. */
  async activeTenants(): Promise<TenantRef[]> {
    const docs = await this.tenantRegistry
      .find({ status: "active", provisioningStatus: { $ne: "pending" } })
      .toArray();
    const def = docs.find((d) => d._id === DEFAULT_TENANT_ID);
    const disabledDefault = await this.tenantRegistry.findOne({
      _id: DEFAULT_TENANT_ID,
      status: "disabled",
    });
    // A tenant with an invalid policy is skipped (and logged) rather than
    // stopping ingestion for every other tenant.
    const refs: TenantRef[] = [];
    for (const d of [
      ...(disabledDefault ? [] : [def ?? null]),
      ...docs.filter((d) => d._id !== DEFAULT_TENANT_ID),
    ])
      try {
        refs.push(
          d && d._id !== DEFAULT_TENANT_ID ? this.toRef(d) : this.defaultRef(d),
        );
      } catch (error) {
        log("error", "tenant skipped by ingestion", {
          tenantId: d?._id ?? DEFAULT_TENANT_ID,
          ...errorFields(error),
        });
      }
    return refs;
  }
  /**
   * Runs fn in a catalog transaction: account, membership and invite writes
   * that must commit together. The driver retries transient failures and an
   * unknown commit result; fn must therefore be safe to run again and keep
   * external effects (Google, email, cookies) outside. A server without
   * transactions (no replica set) is a deployment fault, reported as 503 and
   * never worked around.
   */
  async withCatalogTransaction<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: 10_000,
        },
      );
      return result;
    } catch (error) {
      if (
        (error as { code?: number })?.code === 20 &&
        /replica set|mongos/i.test(String((error as Error)?.message))
      )
        throw new ApiError(
          503,
          "Sign-in storage does not support transactions. The database must run as a replica set.",
          "TRANSACTIONS_UNAVAILABLE",
          { cause: error },
        );
      throw error;
    } finally {
      await session.endSession();
    }
  }
  /** Whether the catalog server can run transactions (a replica set or mongos). */
  async supportsTransactions(): Promise<boolean> {
    const hello = await this.client.db("admin").command({ hello: 1 });
    return typeof hello.setName === "string" || hello.msg === "isdbgrid";
  }
  /** Runs fn with the given tenant as context. */
  withTenant<T>(tenant: TenantRef, fn: () => T): T {
    return tenantContext.run(tenant, fn);
  }
  // Tenant-owned configuration.
  get agents() {
    return this.db.collection<AgentDocument>("truex_agents");
  }
  get mcp() {
    return this.db.collection<McpDocument>("truex_mcp");
  }
  // Shared catalog.
  get profiles() {
    return this.catalog.collection<ModelDocument>("truex_models");
  }
  get skills() {
    return this.catalog.collection<SkillDocument>("truex_skills");
  }
  findAgent(id: DatabaseId) {
    return this.agents.findOne({
      _id: { $in: idCandidates(id) },
      enabled: { $ne: false },
    });
  }
  // A tenant with an allow-list sees only those models; others are "missing".
  findModel(id: DatabaseId) {
    const allowed = currentTenant()?.allowedModelIds;
    if (allowed && !allowed.includes(String(id))) return Promise.resolve(null);
    return this.profiles.findOne({
      _id: { $in: idCandidates(id) },
      enabled: { $ne: false },
    });
  }
  async findSkills(ids: DatabaseId[]) {
    const allowed = currentTenant()?.allowedSkillIds;
    const wanted = ids.filter((id) => !allowed || allowed.includes(String(id)));
    if (!wanted.length) return [];
    return this.skills
      .find({
        _id: { $in: wanted.flatMap(idCandidates) },
        enabled: { $ne: false },
      })
      .toArray();
  }
  findMcp(id: DatabaseId) {
    return this.mcp.findOne({ _id: { $in: idCandidates(id) } });
  }
  get sessions() {
    return this.db.collection<SessionDocument>("sessions");
  }
  get messages() {
    return this.db.collection<Message>("messages");
  }
  get projects() {
    return this.db.collection<Project>("projects");
  }
  get traces() {
    return this.db.collection<TraceDocument>("traces");
  }
  // Last `limit` traces of a session, oldest first.
  async sessionTraces(sessionId: string, limit = 200): Promise<TurnTrace[]> {
    const rows = await this.traces
      .find({ sessionId }, { projection: { _id: 0, sessionId: 0 } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return rows.reverse() as TurnTrace[];
  }
  // Saves the plan unless a newer one is already stored. Returns whether it
  // was written.
  async savePlan(sessionId: string, update: PlanUpdate) {
    return savePlan.call(this, sessionId, update);
  }
  async persist(sessionId: string, event: DomainEvent) {
    return persist.call(this, sessionId, event);
  }
}

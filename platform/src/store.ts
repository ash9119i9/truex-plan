import {
  AgentDocument,
  ModelDocument,
  McpDocument,
  DatabaseId,
  idCandidates,
} from "./documents";
import { MongoClient, Db, type ClientSession } from "mongodb";
import { publicPlan, type PlanStep } from "./public";
import { ApiError } from "./errors";
import { errorFields, log } from "../../shared/logging";
import {
  currentTenant,
  DEFAULT_TENANT_ID,
  tenantContext,
  policyOf,
  type TenantDocument,
  type TenantRef,
} from "./tenant";
import type {
  AuthFlowDocument,
  AuthSessionDocument,
  InviteDocument,
  MembershipDocument,
  UserDocument,
} from "./auth";
import type {
  Session,
  Message,
  DomainEvent,
  TurnTrace,
  Project,
} from "../../shared/contracts";
// One document per {sessionId, turnId}. Holds only the TurnTrace, which has no
// raw text (privacy findings are already masked).
export type TraceDocument = TurnTrace & { _id: string; sessionId: string };
// Latest plan of a session, so the sidebar survives reload and agent-core
// restart. Steps are stored already projected to {step, status}.
export interface StoredPlan {
  steps: PlanStep[];
  explanation?: string;
  turnId?: string;
  // agent-core cursor "<generation>:<seq>" of the update, when known.
  cursor?: string;
  // When the update happened (event time, or save time for a snapshot).
  eventAt: string;
  updatedAt: string;
  // Compare-and-set guard for concurrent savers.
  version: number;
}
export type SessionDocument = Session & { plan?: StoredPlan };
export interface PlanUpdate {
  plan: unknown;
  explanation?: unknown;
  turnId?: string;
  cursor?: string;
  at?: string;
}
function cursorParts(cursor?: string) {
  const i = cursor ? cursor.lastIndexOf(":") : -1;
  if (!cursor || i < 0) return null;
  const seq = Number(cursor.slice(i + 1));
  return Number.isFinite(seq) ? { generation: cursor.slice(0, i), seq } : null;
}
// Within one agent-core generation the sequence number orders updates. Across
// generations (restart) the event time does. A replayed or delayed older
// update therefore never replaces a newer plan.
export function newerPlan(saved: StoredPlan | undefined, next: PlanUpdate) {
  if (!saved) return true;
  const a = cursorParts(saved.cursor),
    b = cursorParts(next.cursor);
  if (a && b && a.generation === b.generation) return b.seq > a.seq;
  const savedAt = Date.parse(saved.eventAt),
    nextAt = Date.parse(next.at ?? "");
  if (Number.isNaN(savedAt) || Number.isNaN(nextAt)) return true;
  return nextAt >= savedAt;
}
// Security audit trail (catalog, security_audit). Rows never hold message
// text, cookies, invite links or credentials; only who touched what and when.
export interface AuditDocument {
  _id: string;
  at: Date;
  expiresAt: Date;
  actor: string;
  actorRole: string;
  action: string;
  tenantId: string;
  target?: { type: string; id: string; ownerId?: string };
  outcome: string;
  requestId?: string;
  /** Repeated identical reads inside one window are counted, not duplicated. */
  count: number;
  detail?: Record<string, string | number | boolean>;
}
export interface DemoUsageDocument {
  /** `${utcDay}:${tenantId}:${userId | "*" | "signups"}` */
  _id: string;
  count: number;
  expiresAt: Date;
}
export interface DemoTurnDocument {
  _id: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  clientId: string;
  day: string;
  state: "reserved" | "released";
  at: Date;
  expiresAt: Date;
}
export interface SkillDocument {
  _id: DatabaseId;
  /** Folder name Codex sees; [a-z0-9-], unique in the catalog. */
  name: string;
  description: string;
  /** SKILL.md body (markdown, without front matter). */
  body: string;
  version: number;
  enabled?: boolean;
}
const TENANT_CACHE_MS = 5_000;
// Tenant MCP names are unique per tenant, user MCP names per owner; the
// cross-scope rule (a tenant name is reserved) is enforced in the service.
// Same definitions as scripts/tenant.mjs and scripts/migrate-mcp-scopes.mjs.
export function mcpIndexes(db: Db) {
  const mcp = db.collection("truex_mcp");
  return [
    mcp.createIndex(
      { scope: 1, name: 1 },
      {
        name: "tenant_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "tenant" },
      },
    ),
    mcp.createIndex(
      { ownerId: 1, name: 1 },
      {
        name: "user_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "user" },
      },
    ),
    mcp.createIndex({ agentIds: 1, scope: 1 }),
  ];
}
// Agent handles: one pair of index definitions per tenant mode. A private
// tenant (isUserSpecific) keys handles by creator, so one person's handle never
// blocks, or reveals, another's. A shared or unconfigured tenant keeps the
// workspace-wide unique handle it has always had. The legacy index is never
// created for a private tenant and never dropped by the application.
export function agentIndexes(db: Db, creatorHandles: boolean) {
  const agents = db.collection("truex_agents");
  return creatorHandles
    ? [
        agents.createIndex(
          { createdBy: 1, handle: 1 },
          {
            name: "agent_creator_handle",
            unique: true,
            partialFilterExpression: {
              createdBy: { $type: "string" },
              handle: { $type: "string" },
            },
          },
        ),
        agents.createIndex({ createdBy: 1, enabled: 1 }),
      ]
    : [
        // Sparse: agents seeded before handles existed have none.
        agents.createIndex({ handle: 1 }, { unique: true, sparse: true }),
      ];
}
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
      this.catalog
        .collection("truex_skills")
        .createIndex({ name: 1 }, { unique: true }),
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
    const docs = await this.tenantRegistry.find({ status: "active" }).toArray();
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = await this.sessions.findOne(
        { _id: sessionId },
        { projection: { plan: 1 } },
      );
      if (!session) return false;
      const saved = session.plan;
      if (!newerPlan(saved, update)) return false;
      const now = new Date().toISOString();
      const plan: StoredPlan = {
        steps: publicPlan(update.plan),
        ...(typeof update.explanation === "string" && update.explanation
          ? { explanation: update.explanation }
          : {}),
        ...(typeof update.turnId === "string" ? { turnId: update.turnId } : {}),
        ...(typeof update.cursor === "string" ? { cursor: update.cursor } : {}),
        eventAt:
          update.at && !Number.isNaN(Date.parse(update.at)) ? update.at : now,
        updatedAt: now,
        version: (saved?.version ?? 0) + 1,
      };
      const result = await this.sessions.updateOne(
        { _id: sessionId, "plan.version": saved?.version ?? null },
        { $set: { plan } },
      );
      if (result.modifiedCount) return true;
    }
    return false;
  }
  async persist(sessionId: string, event: DomainEvent) {
    if (event.type === "plan.updated")
      await this.savePlan(sessionId, {
        plan: event.data.plan,
        explanation: event.data.explanation,
        turnId: event.turnId,
        cursor: event.cursor,
        at: event.at,
      });
    if (event.type === "message.final") {
      const automation = await this.sessions.findOne(
        { _id: sessionId, automationPolicy: { $exists: true } },
        { projection: { _id: 1 } },
      );
      const message = {
        sessionId,
        role: "assistant" as const,
        text: event.data.text,
        at: event.at,
        turnId: event.turnId,
        itemId: event.itemId,
        messageIndex: event.data.messageIndex,
      };
      await this.messages.updateOne(
        {
          _id: `${sessionId}:assistant:${event.turnId}:${event.data.messageIndex ?? event.itemId}`,
        },
        automation ? { $setOnInsert: message } : { $set: message },
        { upsert: true },
      );
    }
    if (event.type === "approval.resolved")
      await this.sessions.updateOne(
        {
          _id: sessionId,
          "approvals.requestId": { $ne: event.data.requestId },
        },
        {
          $push: {
            approvals: { ...event.data, at: event.at, turnId: event.turnId },
          },
        },
      );
    if (event.type === "turn.completed" && event.data.timing)
      await this.sessions.updateOne(
        { _id: sessionId, "timings.turnId": { $ne: event.turnId } },
        { $push: { timings: event.data.timing } },
      );
    const trace = event.data?.trace as TurnTrace | undefined;
    if (event.type === "turn.completed" && trace?.turnId)
      await this.traces.updateOne(
        { _id: `${sessionId}:${trace.turnId}` },
        { $set: { ...trace, sessionId } },
        { upsert: true },
      );
  }
}

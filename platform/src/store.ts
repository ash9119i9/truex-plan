import {
  AgentDocument,
  ModelDocument,
  McpDocument,
  DatabaseId,
  idCandidates,
} from "./documents";
import { MongoClient, Db } from "mongodb";
import { publicPlan, publicVisualAttachment, type PlanStep } from "./public";
import { ApiError } from "./errors";
import { errorFields, log } from "../../shared/logging";
import {
  currentTenant,
  DEFAULT_TENANT_ID,
  tenantContext,
  chatVisibilityOf,
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
// Carried only when set; a missing value means "all".
function visibility(doc?: TenantDocument | null) {
  const chatVisibility = chatVisibilityOf(doc?.chatVisibility);
  return chatVisibility ? { chatVisibility } : {};
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
    const dbName = currentTenant()?.dbName ?? this.database;
    // Background: a failure (or shutdown mid-build) is logged and retried on
    // the next use, never left as an unhandled rejection.
    this.tenantIndexes(dbName).catch((error) =>
      log("warn", "tenant index creation failed", {
        op: "indexes",
        dbName,
        ...errorFields(error),
      }),
    );
    return this.client.db(dbName);
  }
  /** Builds a tenant database's indexes now, e.g. right after creating it. */
  ensureTenantIndexes(dbName: string) {
    return this.tenantIndexes(dbName);
  }
  private tenantIndexes(dbName: string) {
    let done = this.indexed.get(dbName);
    if (!done) {
      const db = this.client.db(dbName);
      done = Promise.all([
        db.collection("messages").createIndex({ sessionId: 1, at: 1 }),
        db.collection("messages").createIndex(
          { sessionId: 1 },
          {
            name: "visual_publications",
            partialFilterExpression: { visuals: { $exists: true } },
          },
        ),
        db.collection("sessions").createIndex({ status: 1 }),
        db.collection("traces").createIndex({ sessionId: 1, startedAt: 1 }),
        db.collection("sessions").createIndex({ projectId: 1, createdAt: -1 }),
        db.collection("sessions").createIndex({ userId: 1, createdAt: -1 }),
        // Sparse: agents seeded before handles existed have none.
        db
          .collection("truex_agents")
          .createIndex({ handle: 1 }, { unique: true, sparse: true }),
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
      this.memberships.createIndex({ userId: 1, tenantId: 1 }, { unique: true }),
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
  private defaultRef(doc?: TenantDocument | null): TenantRef {
    return {
      id: DEFAULT_TENANT_ID,
      dbName: this.database,
      ...(doc?.allowedModelIds ? { allowedModelIds: doc.allowedModelIds } : {}),
      ...(doc?.allowedSkillIds ? { allowedSkillIds: doc.allowedSkillIds } : {}),
      ...visibility(doc),
    };
  }
  private toRef(doc: TenantDocument): TenantRef {
    return {
      id: doc._id,
      dbName: doc.dbName,
      ...(doc.allowedModelIds ? { allowedModelIds: doc.allowedModelIds } : {}),
      ...(doc.allowedSkillIds ? { allowedSkillIds: doc.allowedSkillIds } : {}),
      ...visibility(doc),
    };
  }
  // The default tenant always exists (its database is MONGO_DB); others must
  // be registered and active. Briefly cached: every request resolves one.
  async resolveTenant(id: string): Promise<TenantRef> {
    const hit = this.tenants.get(id);
    if (hit && hit.expires > Date.now()) return hit.ref;
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
    return [
      ...(disabledDefault ? [] : [this.defaultRef(def)]),
      ...docs
        .filter((d) => d._id !== DEFAULT_TENANT_ID)
        .map((d) => this.toRef(d)),
    ];
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
    if (event.type === "visual.published") {
      const visual = publicVisualAttachment(event.data.visual);
      if (!visual || visual.turnId !== event.turnId) return;
      await this.messages.updateOne(
        { _id: `${sessionId}:visual:${visual.id}` },
        {
          $setOnInsert: {
            sessionId,
            role: "assistant",
            text: "",
            at: event.at,
            turnId: visual.turnId,
            itemId: visual.callId,
            visuals: [visual],
          },
        },
        { upsert: true },
      );
    }
    if (event.type === "plan.updated")
      await this.savePlan(sessionId, {
        plan: event.data.plan,
        explanation: event.data.explanation,
        turnId: event.turnId,
        cursor: event.cursor,
        at: event.at,
      });
    if (event.type === "message.final")
      await this.messages.updateOne(
        {
          _id: `${sessionId}:assistant:${event.turnId}:${event.data.messageIndex ?? event.itemId}`,
        },
        {
          $set: {
            sessionId,
            role: "assistant",
            text: event.data.text,
            at: event.at,
            turnId: event.turnId,
            itemId: event.itemId,
            messageIndex: event.data.messageIndex,
          },
        },
        { upsert: true },
      );
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

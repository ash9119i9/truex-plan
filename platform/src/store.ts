import {
  AgentDocument,
  ModelDocument,
  McpDocument,
  DatabaseId,
  idCandidates,
} from "./documents";
import { MongoClient, Db } from "mongodb";
import { publicPlan, type PlanStep } from "./public";
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
export class Store {
  readonly client: MongoClient;
  db!: Db;
  constructor(
    uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
    readonly database = process.env.MONGO_DB || "truex",
  ) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  }
  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.database);
    await Promise.all([
      this.messages.createIndex({ sessionId: 1, at: 1 }),
      this.sessions.createIndex({ status: 1 }),
      this.traces.createIndex({ sessionId: 1, startedAt: 1 }),
      this.sessions.createIndex({ projectId: 1, createdAt: -1 }),
    ]);
    return this;
  }
  get agents() {
    return this.db.collection<AgentDocument>("truex_agents");
  }
  get profiles() {
    return this.db.collection<ModelDocument>("truex_models");
  }
  get mcp() {
    return this.db.collection<McpDocument>("truex_mcp");
  }
  findAgent(id: DatabaseId) {
    return this.agents.findOne({
      _id: { $in: idCandidates(id) },
      enabled: { $ne: false },
    });
  }
  findModel(id: DatabaseId) {
    return this.profiles.findOne({
      _id: { $in: idCandidates(id) },
      enabled: { $ne: false },
    });
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

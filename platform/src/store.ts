import {
  AgentDocument,
  ModelDocument,
  McpDocument,
  DatabaseId,
  idCandidates,
} from "./documents";
import { MongoClient, Db } from "mongodb";
import type {
  Session,
  Message,
  DomainEvent,
  TurnTrace,
} from "../../shared/contracts";
// One document per {sessionId, turnId}. Holds only the TurnTrace, which has no
// raw text (privacy findings are already masked).
export type TraceDocument = TurnTrace & { _id: string; sessionId: string };
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
    return this.db.collection<Session>("sessions");
  }
  get messages() {
    return this.db.collection<Message>("messages");
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
  async persist(sessionId: string, event: DomainEvent) {
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

// Performance audit harness for platform-next: query plans and latencies on
// production index definitions, plus per-request MongoDB call counts through
// the real HTTP app against a local mongod.
//
// Run: npm run bench:perf   (writes nothing; prints a report)
//
// The dataset is synthetic and fixed, so two runs are comparable. Millisecond
// figures are loopback numbers: use them for relative comparison, not as
// production latency.
import "reflect-metadata";
import { gzipSync } from "node:zlib";
import { ObjectId, type Db, type Document, type MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { DatabaseService } from "../src/database/database.service";
import { createTenantIndexes } from "../src/modules/tenants/tenant-indexes";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
} from "../src/modules/chats/chat";
import { TENANTS_COLLECTION } from "../src/modules/tenants/tenant";
import { dbNameFor } from "../src/modules/tenants/tenant";
import { OperatorService } from "../src/modules/operator/operator.service";
import { UsersService } from "../src/modules/users/users.service";
import { MembershipsService } from "../src/modules/memberships/memberships.service";
import { SessionsService } from "../src/modules/sessions/sessions.service";
import { testAuthConfig } from "../test/support/test-auth";
import {
  builtinDefinition,
  modelDefinition,
} from "../test/support/catalog-fixtures";

const CATALOG = "perf_catalog";
const OWNER = new ObjectId();
const NOW = Date.now();

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function ms(n: number): string {
  return n.toFixed(2).padStart(8);
}

async function timed(
  label: string,
  work: () => Promise<unknown>,
  n = 60,
): Promise<void> {
  for (let i = 0; i < 3; i++) await work();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await work();
    samples.push(performance.now() - t);
  }
  console.log(
    `${label.padEnd(34)} p50=${ms(pct(samples, 50))}ms p95=${ms(pct(samples, 95))}ms`,
  );
}

// ---- plan helpers ---------------------------------------------------------

function stages(plan: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.stage === "string") out.push(n.stage);
    for (const key of [
      "inputStage",
      "queryPlan",
      "thenStage",
      "elseStage",
      "outerStage",
      "innerStage",
    ])
      if (n[key]) walk(n[key]);
    if (Array.isArray(n.inputStages)) for (const s of n.inputStages) walk(s);
  };
  walk(plan);
  return out;
}

async function explain(
  label: string,
  explainable: { explain: (v: string) => Promise<Document> },
): Promise<void> {
  const result = (await explainable.explain("executionStats")) as Document;
  // An aggregation's plan lives in its $cursor stage.
  let node: Document = result;
  if (Array.isArray(result.stages)) {
    const cursor = (result.stages as Document[]).find((s) => s.$cursor);
    node = (cursor?.$cursor ?? {}) as Document;
  }
  const stats = node.executionStats as Record<string, number>;
  const plan = stages(node.queryPlanner?.winningPlan);
  console.log(
    `${label.padEnd(34)} ${plan.join(">").padEnd(34)} keys=${String(
      stats.totalKeysExamined,
    ).padStart(7)} docs=${String(stats.totalDocsExamined).padStart(7)} ` +
      `returned=${String(stats.nReturned).padStart(5)}`,
  );
}

// ---- dataset --------------------------------------------------------------

async function seedTenant(db: Db, ownerId: ObjectId = OWNER): Promise<void> {
  await createTenantIndexes(db);
  const chats = db.collection(CHATS_COLLECTION);
  const messages = db.collection(MESSAGES_COLLECTION);
  const files = db.collection("chat_files");
  await chats.deleteMany({});
  await messages.deleteMany({});
  await files.deleteMany({});

  // 100k chats for one owner; 50 of them answering with a lapsed lease.
  const chatBatch: Document[] = [];
  for (let i = 0; i < 100_000; i++) {
    const id = new ObjectId();
    const lapsed = i < 50;
    chatBatch.push({
      _id: id,
      ownerId,
      title: `Chat ${i}`,
      agent: { source: "builtin", id: new ObjectId(), revision: 1 },
      model: { id: new ObjectId(), revision: 1 },
      platformInstructionsVersion: "v4",
      runtime: { threadId: `thread_${i}`, state: "ready" },
      activeRun: lapsed
        ? { runId: new ObjectId(), leaseExpiresAt: new Date(NOW - 60_000) }
        : null,
      nextSeq: 1,
      status: "active",
      createdByMessageId: `cm-${i}`,
      lastMessageAt: new Date(NOW - i * 60_000),
      createdAt: new Date(NOW - i * 60_000),
      updatedAt: new Date(NOW),
    });
    if (chatBatch.length === 5_000) {
      await chats.insertMany(chatBatch);
      chatBatch.length = 0;
    }
  }
  if (chatBatch.length) await chats.insertMany(chatBatch);

  const chatId = (await chats.findOne({ createdByMessageId: "cm-500" }))!._id;
  // 100k messages in that one chat.
  const messageBatch: Document[] = [];
  for (let seq = 1; seq <= 100_000; seq++) {
    messageBatch.push({
      _id: new ObjectId(),
      chatId,
      ownerId,
      seq,
      runId: new ObjectId(),
      role: seq % 2 ? "user" : "assistant",
      text: "x".repeat(200),
      state: "complete",
      createdAt: new Date(NOW - (100_000 - seq) * 1_000),
    });
    if (messageBatch.length === 5_000) {
      await messages.insertMany(messageBatch);
      messageBatch.length = 0;
    }
  }
  if (messageBatch.length) await messages.insertMany(messageBatch);

  // 5,000 file versions across 40 paths.
  const fileBatch: Document[] = [];
  for (let i = 0; i < 5_000; i++) {
    const path = `src/file_${i % 40}.ts`;
    fileBatch.push({
      _id: new ObjectId(),
      chatId,
      ownerId,
      runId: new ObjectId(),
      path,
      version: Math.floor(i / 40) + 1,
      size: 1_024,
      sha256: `sha_${i}`,
      contentType: "text/plain; charset=utf-8",
      storageKey: `k/${i}`,
      sourceModifiedAt: i,
      createdAt: new Date(NOW - (5_000 - i) * 1_000),
    });
  }
  await files.insertMany(fileBatch);
  console.log(`seeded: 100k chats, 100k messages, 5k file versions`);
  return;
}

async function seedCatalog(db: Db): Promise<void> {
  const tenants = db.collection(TENANTS_COLLECTION);
  if ((await tenants.estimatedDocumentCount()) > 0) return;
  // The catalog indexes the app builds, by their real names.
  await tenants.createIndexes([
    { key: { dbName: 1 }, name: "dbName_unique", unique: true },
    {
      key: { kind: 1 },
      name: "one_default_tenant",
      unique: true,
      partialFilterExpression: { kind: "default" },
    },
  ]);
  const batch: Document[] = [];
  for (let i = 0; i < 20_000; i++) {
    batch.push({
      _id: new ObjectId(),
      name: `Tenant ${i}`,
      dbName: `truex_next_t_${i}`,
      kind: "organization",
      status: "active",
      provisioningStatus: i < 19_800 ? "ready" : "pending",
      indexVersion: 5,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    if (batch.length === 5_000) {
      await tenants.insertMany(batch);
      batch.length = 0;
    }
  }
  if (batch.length) await tenants.insertMany(batch);
  console.log(`seeded: 20k tenant registry rows`);
}

// ---- parts ----------------------------------------------------------------

async function plans(uri: string): Promise<void> {
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  await client.connect();
  // A dedicated database: provisioning refuses to adopt one that already
  // holds data, and the HTTP part below needs an empty default tenant.
  const db = client.db("perf_tenant_plans");
  const catalog = client.db(CATALOG);
  console.log("\n## Seeding");
  await seedTenant(db);
  await seedCatalog(catalog);

  const chats = db.collection(CHATS_COLLECTION);
  const messages = db.collection(MESSAGES_COLLECTION);
  const files = db.collection("chat_files");
  const tenants = catalog.collection(TENANTS_COLLECTION);
  const chatId = (await chats.findOne({ createdByMessageId: "cm-500" }))!._id;
  // The real cursor the list endpoint hands out: the 30th row's time and id.
  const page1 = await chats
    .find({ ownerId: OWNER, status: "active" })
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(30)
    .toArray();
  const before = page1.at(-1)!.lastMessageAt as Date;
  const beforeId = page1.at(-1)!._id;

  console.log("\n## Query plans (executionStats)");
  await explain(
    "sidebar page 1",
    chats
      .find({ ownerId: OWNER, status: "active" })
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(31),
  );
  await explain(
    "sidebar cursor page 2",
    chats
      .find({
        ownerId: OWNER,
        status: "active",
        $or: [
          { lastMessageAt: { $lt: before } },
          { lastMessageAt: before, _id: { $lt: beforeId } },
        ],
      })
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(31),
  );
  await explain(
    "history page (50 + 1)",
    messages.find({ chatId, ownerId: OWNER }).sort({ seq: -1 }).limit(51),
  );
  await explain(
    "recovery: lapsed chats",
    chats
      .find({
        "activeRun.leaseExpiresAt": { $type: "date", $lte: new Date(NOW) },
      })
      .sort({ "activeRun.leaseExpiresAt": 1 })
      .limit(100),
  );
  await explain(
    "chat files listing (300)",
    files.find({ chatId }).sort({ createdAt: -1, _id: -1 }).limit(300),
  );

  // Capture: newest version of each path in one aggregation (40 paths).
  const paths = Array.from({ length: 40 }, (_, i) => `src/file_${i}.ts`);
  await explain(
    "file capture: latest versions",
    files.aggregate([
      { $match: { chatId, path: { $in: paths } } },
      { $sort: { path: 1, version: -1 } },
      { $group: { _id: "$path", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
    ]),
  );
  await explain(
    "tenant registry listReady",
    tenants
      .find(
        { provisioningStatus: "ready" },
        { projection: { _id: 1, dbName: 1 } },
      )
      .sort({ _id: 1 }),
  );

  console.log("\n## Repeated-run latency (loopback, warm cache)");
  await timed("sidebar page 1", () =>
    chats
      .find({ ownerId: OWNER, status: "active" })
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(31)
      .toArray(),
  );
  await timed("history page", () =>
    messages
      .find({ chatId, ownerId: OWNER })
      .sort({ seq: -1 })
      .limit(51)
      .toArray(),
  );
  await timed("chat files listing", () =>
    files
      .find({ chatId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(300)
      .toArray(),
  );
  await timed("file capture: latest versions", () =>
    files
      .aggregate([
        { $match: { chatId, path: { $in: paths } } },
        { $sort: { path: 1, version: -1 } },
        { $group: { _id: "$path", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
      ])
      .toArray(),
  );
  await timed("tenant registry listReady", () =>
    tenants
      .find(
        { provisioningStatus: "ready" },
        { projection: { _id: 1, dbName: 1 } },
      )
      .sort({ _id: 1 })
      .toArray(),
  );

  // Candidate indexes: measure the plan before and after, keep only if it moves.
  console.log("\n## Candidate index experiments");
  await files.createIndex(
    { chatId: 1, createdAt: -1, _id: -1 },
    { name: "chat_files_recent_try" },
  );
  await explain(
    "chat files listing (+index)",
    files.find({ chatId }).sort({ createdAt: -1, _id: -1 }).limit(300),
  );
  await timed("chat files listing (+index)", () =>
    files
      .find({ chatId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(300)
      .toArray(),
  );
  await files.dropIndex("chat_files_recent_try");

  await tenants.createIndex(
    { provisioningStatus: 1, _id: 1 },
    { name: "ready_tenants_try" },
  );
  await explain(
    "tenant registry listReady (+index)",
    tenants
      .find(
        { provisioningStatus: "ready" },
        { projection: { _id: 1, dbName: 1 } },
      )
      .sort({ _id: 1 }),
  );
  await timed("tenant registry listReady (+index)", () =>
    tenants
      .find(
        { provisioningStatus: "ready" },
        { projection: { _id: 1, dbName: 1 } },
      )
      .sort({ _id: 1 })
      .toArray(),
  );
  await tenants.dropIndex("ready_tenants_try");

  // Sweep shape: one lapsed-chats query per tenant, sequential vs parallel.
  const tenantDbs = await tenants
    .find(
      { provisioningStatus: "ready" },
      { projection: { _id: 1, dbName: 1 } },
    )
    .sort({ _id: 1 })
    .limit(500)
    .toArray();
  for (const t of tenantDbs.slice(0, 3))
    await createTenantIndexes(client.db(String(t.dbName)));
  let t0 = performance.now();
  for (const t of tenantDbs)
    await client
      .db(String(t.dbName))
      .collection(CHATS_COLLECTION)
      .find({
        "activeRun.leaseExpiresAt": { $type: "date", $lte: new Date(NOW) },
      })
      .sort({ "activeRun.leaseExpiresAt": 1 })
      .limit(100)
      .toArray();
  const sequential = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < tenantDbs.length; i += 20)
    await Promise.all(
      tenantDbs.slice(i, i + 20).map((t) =>
        client
          .db(String(t.dbName))
          .collection(CHATS_COLLECTION)
          .find({
            "activeRun.leaseExpiresAt": { $type: "date", $lte: new Date(NOW) },
          })
          .sort({ "activeRun.leaseExpiresAt": 1 })
          .limit(100)
          .toArray(),
      ),
    );
  const parallel = performance.now() - t0;
  console.log(
    `sweep 500 tenants: sequential ${sequential.toFixed(1)}ms, 20-way parallel ${parallel.toFixed(1)}ms`,
  );

  // monitorCommands: the app enables it unconditionally.
  console.log("\n## monitorCommands cost (20k findOne)");
  for (const monitorCommands of [false, true]) {
    const c = new MongoClient(uri, { monitorCommands });
    await c.connect();
    if (monitorCommands) c.on("commandStarted", () => undefined);
    const coll = c.db("perf_tenant_plans").collection(CHATS_COLLECTION);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++)
      await coll.findOne({ ownerId: OWNER }, { projection: { _id: 1 } });
    console.log(
      `monitorCommands=${String(monitorCommands).padEnd(5)} ${(performance.now() - started).toFixed(0)}ms`,
    );
    await c.close();
  }

  await client.close();
}

async function http(uri: string): Promise<void> {
  const { MongoClient } = await import("mongodb");
  const seedClient = new MongoClient(uri);
  await seedClient.connect();
  await seedCatalog(seedClient.db(CATALOG));
  await seedClient.close();

  const config = {
    mongodbUri: uri,
    catalogDbName: CATALOG,
    auth: testAuthConfig(),
  };
  const app = await createApp(config as never, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const database = app.get(DatabaseService);
  const operator = app.get(OperatorService);

  const tenantId = new ObjectId();
  await operator.provisionTenant({
    operator: "bench",
    tenantId,
    name: "Perf",
    kind: "default",
  });
  const modelId = (
    await operator.putModel({
      operator: "bench",
      definition: modelDefinition(),
    })
  ).model.id;
  const agentId = (
    await operator.putBuiltinAgent({
      operator: "bench",
      definition: builtinDefinition(),
    })
  ).agent.id;

  const users = app.get(UsersService);
  const { user } = await users.findOrCreateFromIdentity({
    provider: "google",
    subject: "perf-owner",
    email: "perf-owner@example.test",
    emailVerified: true,
    name: "Perf Owner",
  });
  await app
    .get(MembershipsService)
    .join({ userId: user._id, tenantId, joinedVia: "signup" });
  const sessions = app.get(SessionsService);
  const created = await sessions.create(user._id);
  const issued = await sessions.refresh(
    created.refreshCredential,
    new Date(),
    tenantId,
  );

  // Provisioning has claimed the default tenant database; fill it with the
  // same dataset the plan part uses, owned by the signed-in member and
  // pointing at the real agent and model (the common, cheap view path).
  const db = database.tenantDb(dbNameFor("default", tenantId));
  await seedTenant(db, user._id);
  const chats = db.collection(CHATS_COLLECTION);
  await chats.updateMany(
    {},
    {
      $set: {
        agent: { source: "builtin", id: new ObjectId(agentId), revision: 1 },
        model: { id: new ObjectId(modelId), revision: 1 },
      },
    },
  );
  const mine = await chats.findOne({ createdByMessageId: "cm-500" });
  if (!mine) throw new Error("no seeded chat for the bench member");
  const chatId = mine._id.toHexString();

  const call = (path: string) =>
    fetch(
      `${base}${path}${path.includes("?") ? "&" : "?"}tenantId=${tenantId.toHexString()}`,
      {
        headers: { authorization: `Bearer ${issued.accessToken}` },
      },
    );

  async function measure(path: string, n = 30): Promise<void> {
    for (let i = 0; i < 3; i++) await (await call(path)).text();
    const wall: number[] = [];
    let calls = 0;
    let dbMs = 0;
    let bytes = 0;
    let gzipped = 0;
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      const res = await call(path);
      const text = await res.text();
      wall.push(performance.now() - t);
      if (res.status !== 200)
        console.log(`  ${path} -> ${res.status} ${text.slice(0, 160)}`);
      bytes = Buffer.byteLength(text);
      gzipped = gzipSync(text).length;
      const header = res.headers.get("server-timing") ?? "";
      const match = /db;dur=([\d.]+);desc="MongoDB \((\d+) calls?\)"/.exec(
        header,
      );
      if (match) {
        dbMs = Number(match[1]);
        calls = Number(match[2]);
      }
    }
    console.log(
      `${path.padEnd(48)} p50=${ms(pct(wall, 50))}ms p95=${ms(pct(wall, 95))}ms  db=${String(calls).padStart(2)} calls ${ms(dbMs)}ms  body=${(bytes / 1024).toFixed(0)}KB gzip=${(gzipped / 1024).toFixed(0)}KB (${((gzipped / Math.max(bytes, 1)) * 100).toFixed(0)}%)`,
    );
  }

  console.log(
    "\n## HTTP requests through the real app (100k chats, one chat of 100k messages)",
  );
  await measure("/me");
  await measure("/tenant");
  await measure("/models");
  await measure("/agents");
  await measure("/chats");
  const list = (await (await call("/chats")).json()) as {
    nextCursor: string | null;
  };
  if (list.nextCursor) {
    const [before, beforeId] = list.nextCursor.split("_");
    await measure(`/chats?before=${before}&beforeId=${beforeId}`);
  }
  await measure(`/chats/${chatId}`);
  await measure(`/chats/${chatId}/messages?before=50000`);
  await measure(`/chats/${chatId}/files`);

  // The stream heartbeat's authorization work, measured through the app.
  console.log(
    "\n## Stream heartbeat authorization (per open stream, every 15 s)",
  );
  const beats: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await sessions.authenticate(issued.accessToken);
    await app.get(MembershipsService).findActive(user._id, tenantId);
    beats.push(performance.now() - t);
  }
  const beatMs = pct(beats, 50);
  console.log(
    `3 catalog reads  p50=${ms(beatMs)}ms p95=${ms(pct(beats, 95))}ms  -> ` +
      `${(1000 / beatMs).toFixed(0)} beats/s per core; 10k open streams = ` +
      `${((3 * 10_000) / 15).toFixed(0)} catalog reads/s (${(((10_000 / 15) * beatMs) / 1000).toFixed(1)} cores of this work)`,
  );

  const client = (database as unknown as { client: MongoClient }).client;
  let opened = 0;
  client.on("connectionReady", () => opened++);
  await Promise.all(
    Array.from({ length: 50 }, async () => {
      const res = await call("/chats");
      await res.text();
    }),
  );
  const status = (await client.db("admin").command({ serverStatus: 1 })) as {
    connections: { current: number };
  };
  console.log(
    `\n## Pool: 50 concurrent /chats opened ${opened} connections; server current=${status.connections.current}`,
  );

  const options = client.options as Record<string, unknown>;
  console.log("\n## MongoDB client options in use");
  for (const key of [
    "maxPoolSize",
    "minPoolSize",
    "maxConnecting",
    "waitQueueTimeoutMS",
    "maxIdleTimeMS",
    "connectTimeoutMS",
    "socketTimeoutMS",
    "serverSelectionTimeoutMS",
    "retryWrites",
    "monitorCommands",
  ])
    console.log(`${key.padEnd(26)} ${String(options[key])}`);

  await app.close();
}

async function main(): Promise<void> {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongo.getUri();
  try {
    if (!process.argv.includes("--http-only")) await plans(uri);
    if (!process.argv.includes("--plans-only")) await http(uri);
  } finally {
    await mongo.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

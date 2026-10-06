import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

const script = resolve(__dirname, "../../scripts/rebuild-usage.mjs");
const DEFAULT_DB = "rebuild_default";
const CATALOG_DB = "rebuild_catalog";

// Runs the script with only explicit env, so neither the developer's shell
// nor platform/.env can point it at real data.
function run(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

const sums = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  cachedInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: 0,
  totalTokens: inputTokens + outputTokens,
  contextWindow: 1000,
  contextUsedTokens: inputTokens,
});
const legacy = (sessionId: string, turnId: string) => ({
  _id: `${sessionId}:${turnId}`,
  sessionId,
  turnId,
  startedAt: "2026-10-05T10:00:00.000Z",
  usage: sums(1000, 100),
  helperUsage: null,
});

test(
  "rebuild-usage: dry run writes nothing; a real run prices, owns and totals; again changes nothing",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const client = await MongoClient.connect(mongo.getUri());
    t.after(async () => {
      await client.close();
      await mongo.stop();
    });
    const env = {
      MONGO_URI: mongo.getUri(),
      MONGO_DB: DEFAULT_DB,
      CATALOG_MONGO_DB: CATALOG_DB,
    };
    const catalog = client.db(CATALOG_DB);
    const db = client.db(DEFAULT_DB);
    await catalog
      .collection("truex_models")
      .insertOne({ _id: "prof1", modelName: "m1" } as any);
    await catalog.collection("truex_model_pricing").insertOne({
      _id: "p1",
      modelName: "m1",
      currency: "USD",
      inputPerMTok: "3",
      cachedInputPerMTok: "0.3",
      cacheWritePerMTok: "3.75",
      outputPerMTok: "15",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveTo: null,
    } as any);
    await db.collection("truex_agents").insertMany([
      { _id: "a1", modelProfileId: "prof1" },
      { _id: "a2", modelProfileId: "gone" },
    ] as any[]);
    await db.collection("sessions").insertMany([
      { _id: "s1", userId: "u1", agentId: "a1" },
      { _id: "s2", userId: "u2", agentId: "a2" },
      // A conversation with no turns at all stays as it is.
      { _id: "s3", userId: "u3", agentId: "a1" },
    ] as any[]);
    const kept = {
      ...legacy("s1", "t2"),
      userId: "u1",
      // Priced earlier at other rates: it must keep this cost.
      cost: {
        costMicros: 999,
        requests: 1,
        unpricedRequests: 0,
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        modelName: "old",
      },
    };
    await db
      .collection("traces")
      .insertMany([legacy("s1", "t1"), kept, legacy("s2", "t1")] as any[]);

    const refused = await run(["--oops"], env);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /usage:/);

    const dry = await run([], env);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /\[dry run\]/);
    assert.match(
      dry.out,
      /2 trace\(s\) would be priced \(1 without a usable price\)/,
    );
    assert.match(
      dry.out,
      /2 of 3 session\(s\) would have their usage totals rebuilt/,
    );
    assert.equal(
      (await db.collection("traces").findOne({ _id: "s1:t1" }))?.cost,
      undefined,
    );
    assert.equal(
      (await db.collection("sessions").findOne({ _id: "s1" }))?.usage,
      undefined,
    );

    const applied = await run(["--confirm", "rebuild-usage"], env);
    assert.equal(applied.code, 0);
    assert.match(applied.out, /2 trace\(s\) priced/);
    const t1 = await db.collection("traces").findOne({ _id: "s1:t1" });
    // 1000 in at $3/M and 100 out at $15/M.
    assert.equal(t1?.cost.costMicros, 4500);
    assert.equal(t1?.cost.modelName, "m1");
    assert.equal(t1?.userId, "u1");
    assert.equal(
      (await db.collection("traces").findOne({ _id: "s1:t2" }))?.cost
        .costMicros,
      999,
    );
    const s1 = (await db.collection("sessions").findOne({ _id: "s1" }))?.usage;
    assert.equal(s1?.turns, 2);
    assert.equal(s1?.costMicros, 4500 + 999);
    assert.deepEqual([...s1?.turnIds].sort(), ["t1", "t2"]);
    // No usable price for this session's model: counted, as unpriced.
    const s2 = (await db.collection("sessions").findOne({ _id: "s2" }))?.usage;
    assert.equal(s2?.turns, 1);
    assert.equal(s2?.costMicros, 0);
    assert.equal(s2?.unpricedRequests, 1);
    assert.equal(
      (await db.collection("sessions").findOne({ _id: "s3" }))?.usage,
      undefined,
    );

    const again = await run(["--confirm", "rebuild-usage"], env);
    assert.equal(again.code, 0);
    assert.match(again.out, /0 trace\(s\) priced/);
    assert.match(
      again.out,
      /0 of 3 session\(s\) had their usage totals rebuilt/,
    );

    // A session whose stored totals drifted is corrected.
    await db
      .collection("sessions")
      .updateOne({ _id: "s1" }, { $set: { "usage.costMicros": 1 } });
    const fixed = await run(["--confirm", "rebuild-usage"], env);
    assert.match(
      fixed.out,
      /1 of 3 session\(s\) had their usage totals rebuilt/,
    );
    assert.equal(
      (await db.collection("sessions").findOne({ _id: "s1" }))?.usage
        .costMicros,
      5499,
    );
  },
);

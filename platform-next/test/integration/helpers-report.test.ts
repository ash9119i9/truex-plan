import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { buildHelpersReport } from "../../src/modules/chats/helpers-report";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
} from "../../src/modules/chats/chat";
import { UsageError, parseOperatorCommand } from "../../src/cli/operator";

const NOW = new Date("2026-10-27T00:00:00.000Z");
const SINCE = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000);
const M1 = new ObjectId("6ade9db5b3565371f505fee1");
const M2 = new ObjectId("6ade9db5b3565371f505fee2");
const owner = new ObjectId();
const SECRET = "HELPER_TEXT_MUST_NOT_LEAK";

// A run accepted `hoursAgo` before NOW: its _id carries that time.
const runId = (hoursAgo: number) =>
  ObjectId.createFromTime(Math.floor(NOW.getTime() / 1000) - hoursAgo * 3600);

describe("helpers report", () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: ReturnType<MongoClient["db"]>;

  const chat1 = new ObjectId();
  const chat2 = new ObjectId();
  const chatOff = new ObjectId();
  const r1 = runId(10);
  const r2 = runId(9);
  const r3 = runId(8);
  const r4 = runId(1);
  const old = runId(24 * 8);
  const offRun = runId(5);

  const usage = (input: number, output: number) => ({
    input,
    cached: 0,
    cacheWrite: 0,
    output,
    reasoning: 0,
  });
  const run = (
    _id: ObjectId,
    chatId: ObjectId,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    _id,
    chatId,
    ownerId: owner,
    status,
    timings: { acceptedAt: _id.getTimestamp() },
    createdAt: _id.getTimestamp(),
    updatedAt: _id.getTimestamp(),
    ...extra,
  });
  const done = (_id: ObjectId, seconds: number) => ({
    timings: {
      acceptedAt: _id.getTimestamp(),
      completedAt: new Date(_id.getTimestamp().getTime() + seconds * 1000),
    },
  });
  let seq = 0;
  const helperRow = (
    runId: ObjectId,
    chatId: ObjectId,
    status: string,
    u?: ReturnType<typeof usage>,
  ) => ({
    _id: new ObjectId(),
    chatId,
    runId,
    seq: ++seq,
    role: "tool",
    text: "",
    state: "complete",
    runtimeItemId: `agent:th-${seq}`,
    agent: {
      path: `/root/${SECRET}`,
      status,
      result: SECRET,
      ...(u ? { usage: u } : {}),
    },
  });

  before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    db = client.db("tenant_helpers_report");
    await db.collection(CHATS_COLLECTION).insertMany([
      {
        _id: chat1,
        ownerId: owner,
        helpers: true,
        model: { id: M1, revision: 1 },
      },
      {
        _id: chat2,
        ownerId: owner,
        helpers: true,
        model: { id: M2, revision: 1 },
      },
      // An agent without helpers: none of its runs count.
      { _id: chatOff, ownerId: owner, model: { id: M1, revision: 1 } },
    ]);
    await db.collection(RUNS_COLLECTION).insertMany([
      run(r1, chat1, "completed", {
        helperCount: 2,
        usage: usage(100, 50),
        ...done(r1, 20),
      }),
      run(r2, chat1, "completed", { usage: usage(40, 10), ...done(r2, 5) }),
      run(r3, chat2, "failed", {
        helperCount: 7,
        error: { code: "SUBAGENT_LIMIT", message: "x", retryable: false },
        usage: usage(500, 100),
      }),
      // Still answering: counted in total, not in any settled rate.
      run(r4, chat2, "running"),
      // Before the window.
      run(old, chat1, "completed", { helperCount: 1, ...done(old, 3) }),
      run(offRun, chatOff, "completed", { helperCount: 1, ...done(offRun, 3) }),
    ]);
    await db.collection(MESSAGES_COLLECTION).insertMany([
      helperRow(r1, chat1, "completed", usage(30, 10)),
      helperRow(r1, chat1, "failed", usage(10, 0)),
      // Not a helper row: ignored.
      {
        _id: new ObjectId(),
        chatId: chat1,
        runId: r1,
        seq: ++seq,
        role: "tool",
        runtimeItemId: "tool:call-1",
        text: SECRET,
      },
      ...Array.from({ length: 6 }, () => helperRow(r3, chat2, "completed")),
      helperRow(r3, chat2, "stopped"),
      helperRow(old, chat1, "failed"),
      helperRow(offRun, chatOff, "failed"),
    ]);
  });

  after(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test("counts runs, helpers, latency and tokens for opted-in chats in the window", async () => {
    const report = await buildHelpersReport([db], { since: SINCE, now: NOW });
    assert.equal(report.tenantDatabases, 1);
    assert.equal(report.chats, 2);
    assert.deepEqual(report.runs, {
      total: 4,
      settled: 3,
      withHelpers: 2,
      spawnRate: 2 / 3,
      completed: 2,
      stopped: 0,
      failed: 1,
      uncertain: 0,
      helperLimit: 1,
      helperLimitRate: 0.5,
      helpersDisabled: 0,
    });
    assert.deepEqual(report.helpers, {
      total: 9,
      completed: 7,
      failed: 1,
      stopped: 1,
      failureRate: 1 / 9,
      stoppedRate: 1 / 9,
      perRun: { count: 2, p50: 2, p90: 7, max: 7 },
    });
    assert.deepEqual(report.latencyMs, {
      withHelpers: { count: 1, p50: 20_000, p90: 20_000 },
      withoutHelpers: { count: 1, p50: 5_000, p90: 5_000 },
    });
    assert.deepEqual(report.tokens.withHelpers, {
      count: 1,
      p50: 150,
      p90: 150,
    });
    assert.deepEqual(report.tokens.withoutHelpers, {
      count: 1,
      p50: 50,
      p90: 50,
    });
    // r1's helpers used 50 of its 150 tokens.
    assert.equal(report.tokens.helperShare, 50 / 150);
    assert.deepEqual(report.byModel, [
      {
        modelId: M1.toHexString(),
        runs: 2,
        settled: 2,
        withHelpers: 1,
        spawnRate: 0.5,
        helpers: 2,
        helperFailureRate: 0.5,
      },
      {
        modelId: M2.toHexString(),
        runs: 2,
        settled: 1,
        withHelpers: 1,
        spawnRate: 1,
        helpers: 7,
        helperFailureRate: 0,
      },
    ]);
  });

  test("never prints a helper's task or result", async () => {
    const report = await buildHelpersReport([db], { since: SINCE, now: NOW });
    assert.ok(!JSON.stringify(report).includes(SECRET));
  });

  test("an empty window reports zeros and no rates", async () => {
    const report = await buildHelpersReport([db], {
      since: new Date(NOW.getTime() - 60_000),
      now: NOW,
    });
    assert.equal(report.runs.total, 0);
    assert.equal(report.runs.spawnRate, null);
    assert.equal(report.helpers.failureRate, null);
    assert.deepEqual(report.helpers.perRun, {
      count: 0,
      p50: null,
      p90: null,
      max: null,
    });
    assert.equal(report.tokens.helperShare, null);
    assert.deepEqual(report.byModel, []);
  });

  test("the operator command parses its window and tenant", () => {
    const tenant = new ObjectId().toHexString();
    const command = parseOperatorCommand([
      "helpers-report",
      "--operator",
      "ops",
      "--since",
      "30d",
      "--tenant",
      tenant,
    ]);
    assert.equal(command.command, "helpers-report");
    if (command.command !== "helpers-report") assert.fail("wrong command");
    assert.equal(command.tenantId?.toHexString(), tenant);
    const days = (Date.now() - command.since.getTime()) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1, String(days));
    const plain = parseOperatorCommand(["helpers-report", "--operator", "ops"]);
    if (plain.command !== "helpers-report") assert.fail("wrong command");
    assert.equal(plain.tenantId, undefined);
    for (const args of [
      ["--since", "0d"],
      ["--tenant", "nope"],
      ["--bogus", "1"],
    ])
      assert.throws(
        () =>
          parseOperatorCommand([
            "helpers-report",
            "--operator",
            "ops",
            ...args,
          ]),
        UsageError,
      );
  });
});

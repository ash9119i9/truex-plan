import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  buildFollowUpsReport,
  overlapScore,
} from "../../src/modules/chats/followups-report";
import {
  CHATS_COLLECTION,
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
} from "../../src/modules/chats/chat";
import { UsageError, parseOperatorCommand } from "../../src/cli/operator";

const NOW = new Date("2026-10-25T00:00:00.000Z");
const SINCE = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
const owner = new ObjectId();

function at(msBeforeNow: number): Date {
  return new Date(NOW.getTime() - msBeforeNow);
}

describe("follow-ups report", () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let db: ReturnType<MongoClient["db"]>;

  const chat = (
    id: ObjectId,
    agentId: ObjectId,
    followUps: "on" | "holdout",
    createdAt: Date,
  ) => ({
    _id: id,
    ownerId: owner,
    agent: { source: "personal", id: agentId, revision: 1 },
    model: { id: new ObjectId("6ad25557bd7f03d236240be6"), revision: 1 },
    followUps,
    createdAt,
  });
  const run = (
    id: ObjectId,
    chatId: ObjectId,
    status: string,
    acceptedAt: Date,
    extra: Record<string, unknown> = {},
  ) => ({
    _id: id,
    chatId,
    ownerId: owner,
    userMessageId: extra.userMessageId ?? new ObjectId(),
    clientMessageId: `cm-${id.toHexString()}`,
    status,
    timings: { acceptedAt },
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    ...extra,
  });
  const okSet = (shape: string, stage: string, items: unknown[]) => ({
    status: "ok",
    shape,
    stage,
    items,
  });

  const a1 = new ObjectId();
  const a3 = new ObjectId();
  const a4 = new ObjectId();
  const chatA = new ObjectId();
  const chatC = new ObjectId();
  const chatD = new ObjectId();
  const s1 = new ObjectId();
  const s2 = new ObjectId();
  const s3 = new ObjectId();
  const s4 = new ObjectId();
  const s5 = new ObjectId();
  const s6 = new ObjectId();
  const s7 = new ObjectId();
  const c1 = new ObjectId();
  const c2 = new ObjectId();
  const c3 = new ObjectId();
  const c4 = new ObjectId();

  before(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    db = client.db("truex_next_report_test");

    await db
      .collection(CHATS_COLLECTION)
      .insertMany([
        chat(chatA, a1, "on", at(2 * 24 * 60 * 60_000)),
        chat(chatC, a3, "holdout", at(8 * 24 * 60 * 60_000)),
        chat(chatD, a4, "on", at(8 * 24 * 60 * 60_000)),
      ]);
    const s1At = at(24 * 60 * 60_000);
    const msg2 = new ObjectId();
    const msg4 = new ObjectId();
    await db.collection(RUNS_COLLECTION).insertMany([
      // Set 1: clicked, stopped in 10 s and steered: went badly.
      run(s1, chatA, "completed", s1At, {
        followUps: okSet("how-to", "build", [
          { slot: 1, intent: "act", text: "Draft the report" },
          { slot: 2, intent: "verify", text: "Check the authorisations" },
        ]),
        timings: {
          acceptedAt: s1At,
          completedAt: new Date(s1At.getTime() + 60_000),
        },
      }),
      run(c1, chatA, "stopped", new Date(s1At.getTime() + 5 * 60_000), {
        origin: { source: "suggestion", fromRunId: s1, slot: 1 },
        steers: [
          {
            clientMessageId: "cm-steer-1",
            text: "Also the log",
            textHash: "x",
            createdAt: new Date(s1At.getTime() + 5 * 60_000),
          },
        ],
        timings: {
          acceptedAt: new Date(s1At.getTime() + 5 * 60_000),
          completedAt: new Date(s1At.getTime() + 5 * 60_000 + 10_000),
        },
      }),
      // Set 2: typed, words close to the row.
      run(s2, chatA, "completed", at(20 * 60 * 60_000), {
        followUps: okSet("explain", "understand", [
          { slot: 1, intent: "deepen", text: "Explain the access sequence" },
        ]),
        timings: {
          acceptedAt: at(20 * 60 * 60_000),
          completedAt: at(20 * 60 * 60_000 - 60_000),
        },
      }),
      run(c2, chatA, "completed", at(20 * 60 * 60_000 - 10 * 60_000), {
        userMessageId: msg2,
      }),
      // Set 3: no next run for two hours: left.
      run(s3, chatA, "completed", at(18 * 60 * 60_000), {
        followUps: okSet("compare", "design", [
          { slot: 1, intent: "compare", text: "Compare ZK07 with ZK08" },
        ]),
        timings: {
          acceptedAt: at(18 * 60 * 60_000),
          completedAt: at(18 * 60 * 60_000 - 60_000),
        },
      }),
      run(c3, chatA, "completed", at(15 * 60 * 60_000)),
      // Format failures are counted but are not sets.
      run(s4, chatA, "completed", at(17 * 60 * 60_000), {
        followUps: {
          status: "invalid",
          shape: "unknown",
          stage: "unknown",
          items: [],
        },
      }),
      run(s5, chatA, "completed", at(16 * 60 * 60_000), {
        followUps: {
          status: "missing",
          shape: "unknown",
          stage: "unknown",
          items: [],
        },
      }),
      // Set 4: a forged origin (the wrong suggesting run) counts as typed.
      run(s6, chatA, "completed", at(14 * 60 * 60_000), {
        followUps: okSet("verify", "test", [
          {
            slot: 1,
            intent: "verify",
            text: "Check the authorisation objects",
          },
        ]),
        timings: {
          acceptedAt: at(14 * 60 * 60_000),
          completedAt: at(14 * 60 * 60_000 - 60_000),
        },
      }),
      run(c4, chatA, "completed", at(13 * 60 * 60_000 + 50 * 60_000), {
        origin: { source: "suggestion", fromRunId: s1, slot: 1 },
        userMessageId: msg4,
      }),
      // The holdout chat and a returning on-chat, for the comparison.
      run(new ObjectId(), chatC, "completed", at(7 * 24 * 60 * 60_000)),
      run(new ObjectId(), chatC, "stopped", at(6 * 24 * 60 * 60_000)),
      run(new ObjectId(), chatD, "completed", at(60 * 60_000)),
      // Set 5: completed 10 minutes before the report with no next run yet:
      // pending, neither left nor part of any rate.
      run(s7, chatD, "completed", at(11 * 60_000), {
        followUps: okSet("explain", "none", [
          { slot: 1, intent: "deepen", text: "Explain the posting keys" },
        ]),
        timings: {
          acceptedAt: at(11 * 60_000),
          completedAt: at(10 * 60_000),
        },
      }),
    ]);
    await db.collection(MESSAGES_COLLECTION).insertMany([
      {
        _id: msg2,
        chatId: chatA,
        ownerId: owner,
        text: "Explain the access sequence in detail",
      },
      {
        _id: msg4,
        chatId: chatA,
        ownerId: owner,
        text: "Something entirely different",
      },
    ]);
  });

  after(async () => {
    await client?.close();
    await mongo?.stop();
  });

  test("overlap drops stop words and compares word sets", () => {
    assert.equal(
      overlapScore("Explain the access sequence", "Explain access sequence"),
      1,
    );
    assert.equal(overlapScore("Compare ZK07 with ZK08", "Show the pricing"), 0);
  });

  test("counts shown, clicked, typed, close, left and a bad click", async () => {
    const report = await buildFollowUpsReport([db], {
      since: SINCE,
      now: NOW,
      minSets: 1,
      close: 0.6,
    });
    assert.equal(report.totals.sets, 4);
    assert.equal(report.totals.pending, 1);
    assert.equal(report.totals.clicked, 1);
    assert.equal(report.totals.typed, 2);
    // The forged origin (wrong run) counted as typed, not clicked.
    assert.equal(report.totals.typedClose, 1);
    assert.equal(report.totals.left, 1);
    assert.equal(report.totals.clickRate, 0.25);
    assert.equal(report.totals.typedRate, 0.5);
    assert.equal(report.totals.typedCloseRate, 0.5);
    assert.equal(report.totals.leftRate, 0.25);
    assert.equal(report.totals.clickedGoingBadly, 1);
    assert.equal(report.totals.clickedGoingBadlyRate, 1);
    assert.deepEqual(report.totals.timeToClickMs, {
      count: 1,
      p50: 4 * 60_000,
      p90: 4 * 60_000,
    });

    // The pending set is still a format attempt.
    const model = report.byModel.find((row) => row.attempts === 7)!;
    assert.equal(model.ok, 5);
    assert.equal(model.missing, 1);
    assert.equal(model.invalid, 1);
    assert.equal(model.formatFailureRate, 2 / 7);

    const cell = report.byIntent.find((row) => row.intent === "act")!;
    assert.equal(cell.sets, 1);
    assert.equal(cell.clicked, 1);
    assert.equal(cell.clickRate, 1);
    assert.equal(report.bySlot[0]?.slot, 1);
    assert.equal(report.bySlot[0]?.sets, 4);
    assert.equal(report.bySlot[0]?.clicked, 1);

    const agentCell = report.cells.find((row) => row.intent === "act")!;
    assert.equal(agentCell.agentId, a1.toHexString());
    assert.equal(agentCell.shape, "how-to");
    assert.equal(agentCell.stage, "build");
    assert.equal(agentCell.sets, 1);
    assert.equal(agentCell.clicked, 1);

    const agents = report.byAgentModel.find(
      (row) => row.agentId === a1.toHexString(),
    )!;
    assert.equal(agents.sets, 4);
    assert.equal(agents.clicked, 1);
    assert.equal(agents.typed, 2);
    assert.equal(agents.left, 1);
  });

  test("the holdout compares on and holdout chats", async () => {
    const report = await buildFollowUpsReport([db], {
      since: SINCE,
      now: NOW,
      minSets: 1,
    });
    const on = report.holdout.find((row) => row.assignment === "on")!;
    const holdout = report.holdout.find((row) => row.assignment === "holdout")!;
    assert.equal(on.chats, 2);
    assert.equal(holdout.chats, 1);
    assert.equal(holdout.turns, 2);
    assert.equal(holdout.chatsWithTwoTurns, 1);
    assert.equal(holdout.stopRate, 0.5);
    // chatA is two days old and cannot have returned yet: only chatD counts.
    assert.equal(on.return7Chats, 1);
    assert.equal(on.return7Rate, 1);
    assert.equal(holdout.return7Chats, 1);
    assert.equal(holdout.return7Rate, 0);
  });

  test("the operator command parses its window, tenant and thresholds", () => {
    const tenant = new ObjectId().toHexString();
    const command = parseOperatorCommand([
      "followups-report",
      "--operator",
      "ops",
      "--since",
      "14d",
      "--tenant",
      tenant,
      "--min-sets",
      "50",
      "--close",
      "0.7",
    ]);
    assert.equal(command.command, "followups-report");
    if (command.command !== "followups-report") assert.fail("wrong command");
    assert.equal(command.tenantId?.toHexString(), tenant);
    assert.equal(command.minSets, 50);
    assert.equal(command.close, 0.7);
    const days = (Date.now() - command.since.getTime()) / 86_400_000;
    assert.ok(days > 13.9 && days < 14.1, String(days));
    for (const since of ["7", "0d", "a week", "400d"])
      assert.throws(
        () =>
          parseOperatorCommand([
            "followups-report",
            "--operator",
            "ops",
            "--since",
            since,
          ]),
        UsageError,
      );
    assert.throws(
      () =>
        parseOperatorCommand([
          "followups-report",
          "--operator",
          "ops",
          "--min-sets",
          "0",
        ]),
      UsageError,
    );
    assert.throws(
      () =>
        parseOperatorCommand([
          "followups-report",
          "--operator",
          "ops",
          "--close",
          "1.5",
        ]),
      UsageError,
    );
  });

  test("min-sets hides small cells and leaves totals intact", async () => {
    const report = await buildFollowUpsReport([db], {
      since: SINCE,
      now: NOW,
      minSets: 5,
    });
    assert.equal(report.totals.sets, 4);
    assert.deepEqual(report.byAgentModel, []);
    assert.deepEqual(report.byIntent, []);
    assert.deepEqual(report.cells, []);
    assert.deepEqual(report.bySlot, []);
    assert.ok(report.hiddenCells > 0);
  });
});

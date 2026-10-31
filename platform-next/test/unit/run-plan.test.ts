import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import type { ChatStore, Settlement } from "../../src/modules/chats/chat-store";
import {
  RunExecutor,
  type Dispatch,
  type LiveEvent,
} from "../../src/modules/chats/run-executor";
import type {
  AdapterEvent,
  RuntimeClient,
} from "../../src/modules/chats/runtime-client";

// The lead's checklist (Codex update_plan) on the platform: relayed live as
// a whole-plan replacement, kept for a reconnecting browser, re-parsed from
// the runtime, and handed to settle.

function dispatchFor(runId: ObjectId): Dispatch {
  return {
    dbName: "truex_next_t",
    chatId: new ObjectId(),
    runId,
    ownerId: new ObjectId(),
    replySeq: 2,
    ref: { tenantId: "t", chatId: "c" },
    mode: "start",
    body: {} as Dispatch["body"],
  };
}

// Runs one adapter stream through the executor. `pause` (when given) holds
// the stream at that point until `midRun` has run, so a browser can join
// mid-run.
async function drive(
  events: AdapterEvent[],
  options: {
    pauseAfter?: number;
    midRun?: (join: () => LiveEvent[]) => Promise<void> | void;
    // Runs once the reply is settled, before drain clears the live runs.
    afterSettle?: (join: () => LiveEvent[]) => void;
  } = {},
) {
  let outcome: Settlement | undefined;
  let settled!: () => void;
  const atSettle = new Promise<void>((done) => (settled = done));
  const store = {
    markAccepted: async () => undefined,
    renewLease: async () => true,
    markUncertain: async () => undefined,
    settleWithRetry: async (...args: unknown[]) => {
      outcome = args[4] as Settlement;
      settled();
      return { run: {}, messages: [] };
    },
  };
  let resume!: () => void;
  const paused = new Promise<void>((done) => (resume = done));
  let reached!: () => void;
  const atPause = new Promise<void>((done) => (reached = done));
  const client = {
    startRun: async function* () {
      for (const [index, event] of events.entries()) {
        yield event;
        if (index === options.pauseAfter) {
          reached();
          await paused;
        }
      }
    },
  };
  const executor = new RunExecutor(
    store as unknown as ChatStore,
    client as unknown as RuntimeClient,
  );
  const runId = new ObjectId();
  const live: LiveEvent[] = [];
  executor.begin(dispatchFor(runId));
  executor.subscribe(runId, {
    send: (event) => live.push(event),
    end: () => undefined,
  });
  const join = (): LiveEvent[] => {
    const seen: LiveEvent[] = [];
    executor.subscribe(runId, {
      send: (event) => seen.push(event),
      end: () => undefined,
    });
    return seen;
  };
  if (options.pauseAfter !== undefined) {
    await atPause;
    // Let the executor apply the event it was just handed.
    await new Promise((done) => setImmediate(done));
    await options.midRun?.(join);
    resume();
  }
  if (options.afterSettle) {
    await atSettle;
    options.afterSettle(join);
  }
  await executor.drain(5_000);
  return { live, outcome, join };
}

const accepted: AdapterEvent = {
  seq: 1,
  type: "run.accepted",
  data: { threadId: "t", turnId: "u" },
};

const first = {
  explanation: "Two parts.",
  steps: [
    { step: "Compare vendors", status: "inProgress" },
    { step: "Draft summary", status: "pending" },
  ],
};
const second = {
  explanation: null,
  steps: [
    { step: "Compare vendors", status: "completed" },
    { step: "Draft summary", status: "inProgress" },
  ],
};

const completedEvent = (seq: number, extra: Record<string, unknown> = {}) =>
  ({
    seq,
    type: "run.completed",
    data: { status: "completed", delivery: "accepted", items: [], ...extra },
  }) as AdapterEvent;

const plansOf = (events: LiveEvent[]) =>
  events.flatMap((e) => (e.type === "plan" ? [e.data] : []));

describe("RunExecutor plan", () => {
  test("each plan.updated reaches subscribers once, latest wins", async () => {
    const { live, outcome } = await drive([
      accepted,
      { seq: 2, type: "plan.updated", data: first },
      { seq: 3, type: "plan.updated", data: second },
      completedEvent(4, { plan: second }),
    ]);
    assert.deepEqual(plansOf(live), [first, second]);
    // The run completed, so its unticked last step is saved as done.
    const done = {
      explanation: null,
      steps: second.steps.map((s) => ({ ...s, status: "completed" })),
    };
    const completed = live.find((e) => e.type === "completed");
    assert.deepEqual(
      completed?.type === "completed" && completed.data.plan,
      done,
    );
    assert.deepEqual(outcome?.plan, done);
  });

  test("a browser joining mid-run gets the current plan in its snapshot", async () => {
    let snapshot: LiveEvent | undefined;
    await drive(
      [
        accepted,
        { seq: 2, type: "plan.updated", data: first },
        { seq: 3, type: "plan.updated", data: second },
        completedEvent(4, { plan: second }),
      ],
      {
        pauseAfter: 2,
        midRun: (join) => {
          snapshot = join().find((e) => e.type === "snapshot");
        },
      },
    );
    assert.deepEqual(
      snapshot?.type === "snapshot" && snapshot.data.plan,
      second,
    );
  });

  test("the same snapshot applied twice leaves one plan", async () => {
    const runSnapshot = (seq: number): AdapterEvent => ({
      seq,
      type: "run.snapshot",
      data: { status: "running", items: [], approvals: [], plan: second },
    });
    let snapshot: LiveEvent | undefined;
    const { live } = await drive(
      [
        accepted,
        { seq: 2, type: "plan.updated", data: first },
        runSnapshot(3),
        runSnapshot(4),
        completedEvent(5, { plan: second }),
      ],
      {
        pauseAfter: 3,
        midRun: (join) => {
          snapshot = join().find((e) => e.type === "snapshot");
        },
      },
    );
    assert.deepEqual(
      snapshot?.type === "snapshot" && snapshot.data.plan,
      second,
    );
    // The first snapshot replaced the plan; the repeat changed nothing.
    assert.deepEqual(plansOf(live), [first, second]);
  });

  test("the runtime's plan is parsed again and bounded", async () => {
    const { live } = await drive([
      accepted,
      {
        seq: 2,
        type: "plan.updated",
        data: {
          explanation: "e".repeat(3_000),
          steps: [
            { step: "s".repeat(800), status: "pending" },
            { step: "bad status", status: "done" },
            { step: 7, status: "pending" },
            { step: "   ", status: "pending" },
            "not a step",
            ...Array.from({ length: 60 }, (_, i) => ({
              step: `Step ${i}`,
              status: "completed",
            })),
          ],
        },
      },
      // A plan that isn't an object is ignored.
      {
        seq: 3,
        type: "plan.updated",
        data: "nope" as unknown as Record<string, unknown>,
      },
      { seq: 4, type: "plan.updated", data: { explanation: 5, steps: "x" } },
      completedEvent(5),
    ]);
    const plans = plansOf(live);
    assert.equal(plans.length, 2);
    const [bounded, empty] = plans;
    assert.equal(bounded!.explanation?.length, 2_000);
    assert.equal(bounded!.steps.length, 50);
    assert.equal(bounded!.steps[0]!.step.length, 500);
    assert.deepEqual(bounded!.steps[1], {
      step: "Step 0",
      status: "completed",
    });
    // A plan with no readable steps is still a plan (empty), with no
    // explanation.
    assert.deepEqual(empty, { explanation: null, steps: [] });
  });

  test("runs that never planned carry no plan field", async () => {
    let snapshot: LiveEvent | undefined;
    const { live, outcome } = await drive(
      [accepted, completedEvent(2, { plan: "junk" })],
      {
        pauseAfter: 0,
        midRun: (join) => {
          snapshot = join().find((e) => e.type === "snapshot");
        },
      },
    );
    assert.equal(
      snapshot?.type === "snapshot" && "plan" in snapshot.data,
      false,
    );
    assert.equal(plansOf(live).length, 0);
    const completed = live.find((e) => e.type === "completed");
    assert.equal(
      completed?.type === "completed" && "plan" in completed.data,
      false,
    );
    assert.equal(outcome && "plan" in outcome, false);
  });

  test("a stopped run keeps its last plan as sent", async () => {
    const { outcome } = await drive([
      accepted,
      { seq: 2, type: "plan.updated", data: first },
      completedEvent(3, { status: "stopped", plan: first }),
    ]);
    assert.equal(outcome?.status, "stopped");
    assert.deepEqual(outcome?.plan, first);
  });

  test("a completed run saves every step as done", async () => {
    // The model writes its reply in one final message and calls nothing
    // after it, so its last tick never arrives: a finished reply did them all.
    const { live, outcome } = await drive([
      accepted,
      { seq: 2, type: "plan.updated", data: second },
      completedEvent(3, { plan: second }),
    ]);
    const done = {
      explanation: null,
      steps: second.steps.map((s) => ({ ...s, status: "completed" })),
    };
    assert.deepEqual(outcome?.plan, done);
    // The completed event carries it; no extra plan event is sent.
    assert.deepEqual(plansOf(live), [second]);
    const completed = live.find((e) => e.type === "completed");
    assert.deepEqual(
      completed?.type === "completed" ? completed.data.plan : null,
      done,
    );
  });

  test("a viewer joining after the reply finished sees the plan it was saved with", async () => {
    let seen: LiveEvent[] = [];
    await drive(
      [
        accepted,
        { seq: 2, type: "plan.updated", data: second },
        completedEvent(3, { plan: second }),
      ],
      { afterSettle: (join) => (seen = join()) },
    );
    const done = {
      explanation: null,
      steps: second.steps.map((s) => ({ ...s, status: "completed" })),
    };
    const snapshot = seen.find((e) => e.type === "snapshot");
    assert.deepEqual(
      snapshot?.type === "snapshot"
        ? (snapshot.data as { plan?: unknown }).plan
        : null,
      done,
    );
  });

  test("a plan missed live still reaches the settlement", async () => {
    const { outcome } = await drive([
      accepted,
      completedEvent(2, { status: "stopped", plan: second }),
    ]);
    assert.deepEqual(outcome?.plan, second);
  });
});

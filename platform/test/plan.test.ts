import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import {
  POLICY_VERSION,
  PublicEventStream,
  publicApproval,
  withPlanFallback,
} from "../src/public";
import type { DomainEvent } from "../../shared/contracts";

const steps = [
  { step: "Draft outline", status: "completed" },
  { step: "Write sections", status: "inProgress" },
];
function planEvent(
  cursor: string,
  at: string,
  plan: any[],
  turnId = "turn-1",
): DomainEvent {
  const seq = Number(cursor.split(":")[1]);
  return {
    type: "plan.updated",
    threadId: "t",
    turnId,
    seq,
    cursor,
    at,
    data: { plan, explanation: "Report plan", internal: "hidden" },
  };
}
async function setup(t: any) {
  const mongo = await MongoMemoryServer.create();
  const store = await new Store(mongo.getUri(), "plan-test").connect();
  t.after(async () => {
    await store.client.close();
    await mongo.stop();
  });
  await store.sessions.insertOne({
    _id: "s",
    agentId: "assistant",
    threadId: "t",
    agentCoreHost: "http://127.0.0.1:4100",
    status: "active",
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    runtimePolicyVersion: POLICY_VERSION,
  });
  const service = new PlatformService(store);
  return { store, service };
}
// Stands in for agent-core: a snapshot and empty records/items pages.
function stubAgentCore(service: PlatformService, snapshot: any) {
  (service as any).owned = async (_s: any, path: string) =>
    path === "/snapshot" ? snapshot : { data: [], nextCursor: null };
  (service as any).call = async () => [];
}

test("plan.updated persists the projected plan with the session", async (t) => {
  const { store } = await setup(t);
  await store.persist(
    "s",
    planEvent("g1:5", "2026-09-28T10:00:00.000Z", [
      ...steps,
      { step: "Bad status", status: "weird", extra: "x" },
      { status: "pending" },
    ]),
  );
  const plan = (await store.sessions.findOne({ _id: "s" }))!.plan!;
  assert.deepEqual(plan.steps, [
    ...steps,
    { step: "Bad status", status: "pending" },
  ]);
  assert.equal(plan.explanation, "Report plan");
  assert.equal(plan.turnId, "turn-1");
  assert.equal(plan.cursor, "g1:5");
  assert.equal(plan.eventAt, "2026-09-28T10:00:00.000Z");
  assert.equal(typeof plan.updatedAt, "string");
  assert.doesNotMatch(JSON.stringify(plan), /hidden|extra/);
});

test("a stale plan update cannot overwrite a newer one", async (t) => {
  const { store } = await setup(t);
  const done = steps.map((s) => ({ ...s, status: "completed" }));
  await store.persist("s", planEvent("g1:9", "2026-09-28T10:05:00.000Z", done));
  // Same generation, lower sequence: a replayed or delayed update.
  await store.persist(
    "s",
    planEvent("g1:5", "2026-09-28T10:06:00.000Z", steps),
  );
  assert.deepEqual(
    (await store.sessions.findOne({ _id: "s" }))!.plan!.steps,
    done,
  );
  // New generation (agent-core restart) but an older event time.
  await store.persist(
    "s",
    planEvent("g2:1", "2026-09-28T10:00:00.000Z", steps),
  );
  assert.deepEqual(
    (await store.sessions.findOne({ _id: "s" }))!.plan!.steps,
    done,
  );
  // New generation and a later event time replaces it.
  const next = [{ step: "Next task", status: "pending" }];
  await store.persist(
    "s",
    planEvent("g2:2", "2026-09-28T11:00:00.000Z", next, "turn-2"),
  );
  const plan = (await store.sessions.findOne({ _id: "s" }))!.plan!;
  assert.deepEqual(plan.steps, next);
  assert.equal(plan.turnId, "turn-2");
  // Concurrent saves of the same update write once and leave one version.
  const again = planEvent("g2:3", "2026-09-28T11:01:00.000Z", steps);
  await Promise.all([store.persist("s", again), store.persist("s", again)]);
  const final = (await store.sessions.findOne({ _id: "s" }))!.plan!;
  assert.deepEqual(final.steps, steps);
  assert.equal(final.version, plan.version + 1);
});

test("history falls back to the saved plan when agent-core has none", async (t) => {
  const { store, service } = await setup(t);
  await store.persist(
    "s",
    planEvent("g1:5", "2026-09-28T10:00:00.000Z", steps),
  );
  // agent-core restarted: its snapshot has no plan.
  stubAgentCore(service, {
    cursor: "g2:0",
    state: { kind: "idle" },
    plan: null,
  });
  const history = await service.history("s");
  assert.deepEqual(history.snapshot!.plan, steps);
  assert.deepEqual(history.plan!.steps, steps);
  assert.equal(history.plan!.explanation, "Report plan");
  // The empty snapshot never clears the saved plan.
  assert.deepEqual(
    (await store.sessions.findOne({ _id: "s" }))!.plan!.steps,
    steps,
  );
  // Internal ordering fields stay out of the browser payload.
  assert.doesNotMatch(
    JSON.stringify(history),
    /"cursor":"g1|"version"|"eventAt"/,
  );
});

test("a newer agent-core plan wins over the saved one and is saved", async (t) => {
  const { store, service } = await setup(t);
  await store.persist(
    "s",
    planEvent("g1:5", "2026-09-28T10:00:00.000Z", steps),
  );
  const live = [
    { step: "Draft outline", status: "completed" },
    { step: "Write sections", status: "completed" },
    { step: "Review", status: "inProgress", secret: "x" },
  ];
  stubAgentCore(service, {
    cursor: "g1:12",
    state: { kind: "running", turnId: "turn-2" },
    plan: live,
  });
  const history = await service.history("s");
  const projected = live.map(({ step, status }) => ({ step, status }));
  assert.deepEqual(history.snapshot!.plan, projected);
  assert.deepEqual(
    (await store.sessions.findOne({ _id: "s" }))!.plan!.steps,
    projected,
  );
  // A replayed older event after the snapshot does not roll it back.
  await store.persist(
    "s",
    planEvent("g1:6", "2026-09-28T12:00:00.000Z", steps),
  );
  assert.deepEqual(
    (await store.sessions.findOne({ _id: "s" }))!.plan!.steps,
    projected,
  );
});

test("live stream snapshots without a plan get the saved plan", () => {
  let saved = steps;
  const stream = new PublicEventStream((event) => {
    if (event.type === "plan.updated") saved = event.data.plan;
    if (event.type === "snapshot" && !event.data.plan.length)
      return { ...event, data: withPlanFallback(event.data, { steps: saved }) };
  });
  const frame = (e: any) =>
    new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`);
  const out = stream.push(
    frame({ type: "snapshot", cursor: "g2:0", data: { plan: null } }),
  );
  const event = JSON.parse(out.split("data: ")[1]);
  assert.deepEqual(event.data.plan, steps);
  // A snapshot with its own plan is left alone.
  const own = [{ step: "Live step", status: "pending" }];
  assert.deepEqual(withPlanFallback({ plan: own }, { steps }).plan, own);
});

test("plan approval audit keeps the Revise feedback note", () => {
  const detail = {
    questions: [
      {
        id: "plan_approval",
        header: "Plan",
        question: "Approve this plan?",
        options: [{ label: "Approve" }, { label: "Revise" }],
      },
    ],
  };
  const revise = publicApproval({
    requestId: "r",
    method: "item/tool/requestUserInput",
    detail,
    result: {
      answers: {
        plan_approval: {
          answers: ["Revise", "user_note: Add a budget section"],
        },
      },
    },
    reason: "user",
  });
  assert.deepEqual(revise!.items, [
    {
      kind: "question",
      question: "Approve this plan?",
      answer: "Revise",
      note: "Add a budget section",
    },
  ]);
  const approve = publicApproval({
    requestId: "r2",
    method: "item/tool/requestUserInput",
    detail,
    result: { answers: { plan_approval: { answers: ["Approve"] } } },
    reason: "user",
  });
  assert.deepEqual(approve!.items, [
    { kind: "question", question: "Approve this plan?", answer: "Approve" },
  ]);
});

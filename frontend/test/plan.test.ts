import { test } from "node:test";
import assert from "node:assert/strict";
import type { DomainEvent, PendingRequest } from "../../shared/contracts";
import {
  applyPlanEvent,
  awaitingApproval,
  isPlanApproval,
  planApprovalPayload,
  planProgress,
  stepStatus,
  type PlanStep,
} from "../lib/plan.ts";
import { answerPayload } from "../lib/request-input.ts";

const ev = (type: string, data: unknown = {}) =>
  ({ type, data }) as unknown as DomainEvent;

const plan: PlanStep[] = [
  { step: "Gather data", status: "completed" },
  { step: "Draft report", status: "inProgress" },
  { step: "Review", status: "pending" },
];

const request = (id: string, method = "item/tool/requestUserInput") =>
  ({
    requestId: "r1",
    method,
    detail: {
      questions: [
        {
          id,
          header: "Plan",
          question: "Approve this plan?",
          options: [{ label: "Approve" }, { label: "Revise" }],
        },
      ],
    },
    expiresAt: "2030-01-01T00:00:00.000Z",
    responseSchema: null,
  }) as PendingRequest;

test("the plan survives turn boundaries", () => {
  assert.equal(applyPlanEvent(plan, ev("turn.started")), plan);
  assert.equal(applyPlanEvent(plan, ev("turn.completed")), plan);
  assert.equal(applyPlanEvent(plan, ev("message.delta")), plan);
});

test("plan updates and snapshots replace the plan", () => {
  const next = [{ step: "Only step", status: "pending" }];
  assert.deepEqual(
    applyPlanEvent(plan, ev("plan.updated", { plan: next })),
    next,
  );
  assert.deepEqual(applyPlanEvent(plan, ev("snapshot", { plan: next })), next);
  assert.deepEqual(applyPlanEvent(plan, ev("snapshot", { plan: null })), []);
});

test("step statuses accept both Codex and snake_case spellings", () => {
  assert.equal(stepStatus("inProgress"), "inProgress");
  assert.equal(stepStatus("in_progress"), "inProgress");
  assert.equal(stepStatus("completed"), "completed");
  assert.equal(stepStatus("weird"), "pending");
});

test("progress counts completed steps and finds the current one", () => {
  assert.deepEqual(planProgress(plan), {
    done: 1,
    total: 3,
    current: 1,
    label: "1 of 3 done",
  });
  // Between steps, the next pending step is current.
  const between = plan.map((p, i) =>
    i === 1 ? { ...p, status: "completed" } : p,
  );
  assert.equal(planProgress(between).current, 2);
  // A fresh plan awaiting approval has no current step.
  const fresh = plan.map((p) => ({ ...p, status: "pending" }));
  assert.equal(planProgress(fresh).current, -1);
  assert.equal(planProgress(fresh).label, "0 of 3 done");
  assert.equal(planProgress([]).label, "");
});

test("a pending plan_approval request means the plan awaits approval", () => {
  assert.equal(isPlanApproval(request("plan_approval")), true);
  assert.equal(isPlanApproval(request("other")), false);
  assert.equal(
    isPlanApproval(
      request("plan_approval", "item/commandExecution/requestApproval"),
    ),
    false,
  );
  assert.equal(
    awaitingApproval([request("other"), request("plan_approval")]),
    true,
  );
  assert.equal(awaitingApproval([]), false);
});

test("approve answers with the option label in the shared answer shape", () => {
  const q = [{ id: "plan_approval", question: "Approve this plan?" }];
  assert.deepEqual(
    planApprovalPayload("Approve"),
    answerPayload(q, { plan_approval: "Approve" }),
  );
  // Stray feedback is not sent with an approval.
  assert.deepEqual(planApprovalPayload("Approve", "ignored"), {
    answers: { plan_approval: { answers: ["Approve"] } },
  });
});

test("revise sends the label first and feedback as a trimmed user note", () => {
  assert.deepEqual(planApprovalPayload("Revise", "  Split step 2  "), {
    answers: {
      plan_approval: { answers: ["Revise", "user_note: Split step 2"] },
    },
  });
  assert.deepEqual(planApprovalPayload("Revise", "   "), {
    answers: { plan_approval: { answers: ["Revise"] } },
  });
});

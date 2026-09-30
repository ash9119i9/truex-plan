import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalRecord, PendingRequest } from "../../shared/contracts.ts";
import {
  auditView,
  clockLabel,
  composerActions,
  countdown,
  fieldValues,
  holdView,
  kindOf,
  missingFields,
  planSteps,
  questionView,
  requestView,
  schemaFields,
  sortRequests,
  toolDecisions,
} from "../lib/vm-requests.ts";

const req = (
  questions: unknown[],
  extra: Partial<PendingRequest> & { detail?: Record<string, unknown> } = {},
): PendingRequest => ({
  requestId: "r1",
  method: "item/tool/requestUserInput",
  expiresAt: "2026-09-30T10:05:00Z",
  responseSchema: null,
  ...extra,
  detail: { questions, ...(extra.detail || {}) },
});

const toolQ = {
  id: "mcp_tool_call_approval_1",
  kind: "toolApproval",
  header: "Permission needed",
  question: "The assistant wants to use a connected business service.",
  action: "Run tests",
  options: [
    { label: "Allow" },
    { label: "Allow for this session" },
    { label: "Allow and don't ask me again" },
    { label: "Cancel" },
  ],
};

test("kind comes from the questions: tool, plan, secret, question", () => {
  assert.equal(kindOf(req([toolQ])), "tool");
  assert.equal(
    kindOf(req([{ id: "plan_approval", question: "Approve?", options: [] }])),
    "plan",
  );
  assert.equal(kindOf(req([{ id: "k", question: "Key", isSecret: true }])), "secret");
  assert.equal(kindOf(req([{ id: "q", question: "Who?" }])), "question");
});

test("tool decisions keep Codex labels, number allows and put Decline last on Esc", () => {
  const d = toolDecisions(toolQ as never);
  assert.deepEqual(
    d.map((x) => [x.value, x.text, x.variant, x.kbd]),
    [
      ["Allow", "Allow once", "primary", "1"],
      ["Allow for this session", "Allow for this chat", "default", "2"],
      ["Allow and don't ask me again", "Always allow", "default", "3"],
      ["Cancel", "Decline", "ghost", "Esc"],
    ],
  );
});

test("tool card shows the command block only for an explicit command", () => {
  const plain = requestView(req([toolQ]));
  assert.equal(plain.kindLabel, "Tool approval");
  assert.equal(plain.title, "Run tests");
  assert.equal(plain.tool, null);
  assert.equal(plain.then, "then declines");
  const withCmd = requestView(
    req([toolQ], {
      detail: {
        tool: {
          command: "npm test",
          cwd: "~/true-ui",
          effects: ["Runs tests", { text: "No network", safe: true }],
        },
      },
    }),
  );
  assert.deepEqual(withCmd.tool, {
    command: "npm test",
    cwd: "~/true-ui",
    effects: [
      { text: "Runs tests", safe: false },
      { text: "No network", safe: true },
    ],
  });
  assert.deepEqual(holdView(req([toolQ])), {
    text: "Waiting for approval to run tests",
  });
});

test("recommended option is badged once, preselected and label-stripped", () => {
  const q = questionView(
    {
      id: "who",
      question: "Which analysts?",
      options: [
        { label: "New hires (Recommended)" },
        { label: "Everyone (recommended)" },
        { label: "Leads" },
      ],
    },
    true,
  );
  assert.deepEqual(
    q.options.map((o) => [o.text, o.recommended, o.kbd]),
    [
      ["New hires", true, "1"],
      ["Everyone", false, "2"],
      ["Leads", false, "3"],
    ],
  );
  assert.equal(q.preselected, "New hires (Recommended)");
});

test("secret and plan requests always ask; questions show a ring", () => {
  const secret = requestView(req([{ id: "k", question: "Paste the Qlik API key", isSecret: true }]));
  assert.equal(secret.kindLabel, "Question · Secret");
  assert.equal(secret.alwaysAsks, true);
  assert.equal(secret.tile, "ink");
  const plan = requestView(
    req([{ id: "plan_approval", header: "Plan", question: "Approve?", options: [{ label: "Approve" }] }]),
    [
      { step: "Map week one", status: "pending" },
      { step: "Build checklist", status: "pending" },
    ],
    { planVersion: 2, previousPlan: [{ step: "Map week one", status: "pending" }] },
  );
  assert.equal(plan.title, "Plan v2 · 2 steps");
  assert.equal(plan.alwaysAsks, true);
  assert.deepEqual(plan.plan.map((s) => s.isNew), [false, true]);
  const question = requestView(req([{ id: "q", question: "Who?", options: [{ label: "A" }] }]));
  assert.equal(question.alwaysAsks, false);
  assert.equal(question.ringTone, "acc");
});

test("plan steps are never new without a previous version", () => {
  assert.deepEqual(
    planSteps([{ step: "One", status: "pending" }]).map((s) => s.isNew),
    [false],
  );
});

test("schema fields map types, required and hints; bad schema is ignored", () => {
  const fields = schemaFields(
    JSON.stringify({
      properties: {
        start: { type: "string", format: "date", title: "Start date" },
        note: { type: "string", title: "Anything else" },
        count: { type: "integer" },
        team: { enum: ["Sales", "Ops"] },
        remote: { type: "boolean" },
      },
      required: ["start"],
    }),
  );
  assert.deepEqual(
    fields.map((f) => [f.key, f.type, f.required, f.hint]),
    [
      ["start", "date", true, "date"],
      ["note", "text", false, "text, optional"],
      ["count", "number", false, "number, optional"],
      ["team", "select", false, "select, optional"],
      ["remote", "boolean", false, "boolean, optional"],
    ],
  );
  assert.deepEqual(schemaFields("{not json"), []);
  assert.deepEqual(schemaFields(null), []);
  assert.deepEqual(missingFields(fields, {}), ["start"]);
  assert.deepEqual(missingFields(fields, { start: "2026-10-06" }), []);
  assert.deepEqual(
    fieldValues(fields, { start: "2026-10-06", count: "3", remote: "true", note: " " }),
    { start: "2026-10-06", count: 3, remote: true },
  );
});

test("countdown drains to zero and is absent without an expiry", () => {
  const start = Date.parse("2026-09-30T10:00:00Z");
  const end = "2026-09-30T10:01:40Z";
  assert.deepEqual(countdown(end, start, start + 30_000), {
    label: "1:10",
    percent: 70,
    left: 70_000,
  });
  assert.equal(countdown(end, start, start + 200_000)!.percent, 0);
  assert.equal(countdown("", start, start), null);
  assert.equal(clockLabel(42_000), "0:42");
  assert.equal(clockLabel(250_000), "4:10");
});

test("requests sort oldest first, keeping arrival order without times", () => {
  const a = req([], { requestId: "a", detail: { createdAt: "2026-09-30T10:02:00Z" } });
  const b = req([], { requestId: "b", detail: { createdAt: "2026-09-30T10:01:00Z" } });
  const c = req([], { requestId: "c" });
  const d = req([], { requestId: "d" });
  assert.deepEqual(sortRequests([c, a, d, b]).map((r) => r.requestId), ["b", "a", "c", "d"]);
});

test("audit rows: allowed tool, expired tool, secret never repeated", () => {
  const time = () => "10:23";
  const allowed: ApprovalRecord = {
    requestId: "r",
    at: "2026-09-30T10:23:00Z",
    outcome: "answered",
    items: [{ kind: "toolApproval", action: "Read files", decision: "allowedChat" }],
  };
  assert.deepEqual(auditView(allowed, time), {
    ok: true,
    lead: "Allowed for this chat",
    detail: "read files",
    meta: "by you · 10:23",
  });
  const expired: ApprovalRecord = {
    requestId: "r",
    outcome: "expired",
    items: [{ kind: "toolApproval", decision: "expired" }],
  };
  assert.equal(auditView(expired, time).lead, "Expired, declined");
  assert.equal(auditView(expired, time).ok, false);
  const secret: ApprovalRecord = {
    requestId: "r",
    outcome: "answered",
    items: [{ kind: "question", question: "Key", secret: true }],
  };
  assert.equal(auditView(secret, time).lead, "Key provided");
});

test("composer actions: send idle, Steer and Stop running, Stopping disables Steer", () => {
  assert.deepEqual(composerActions("idle", true, false), {
    send: "send",
    sendEnabled: true,
    stop: null,
  });
  assert.deepEqual(composerActions("running", true, false), {
    send: "steer",
    sendEnabled: true,
    stop: "stop",
  });
  assert.equal(composerActions("running", true, true).sendEnabled, false);
  assert.deepEqual(composerActions("stopping", true, false), {
    send: "steer-off",
    sendEnabled: false,
    stop: "stopping",
  });
});

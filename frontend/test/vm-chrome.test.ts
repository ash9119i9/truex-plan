import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectedTools,
  crumb,
  errorToast,
  formatElapsed,
  goalPill,
  goalStrip,
  pillAriaLabel,
  sessionHealth,
  statusPill,
  turnState,
} from "../lib/vm-chrome.ts";
import type { Goal } from "../../shared/contracts";

const goal = {
  objective: "Ship a one-page onboarding plan",
  status: "active",
  tokenBudget: 500_000,
  tokensUsed: 142_000,
  timeUsedSeconds: 60,
  createdAt: 1,
  updatedAt: 1,
} as unknown as Goal;

test("formatElapsed", () => {
  assert.equal(formatElapsed(42_000), "0:42");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});

test("turnState precedence: ended > stopping > waiting > starting > running", () => {
  assert.equal(turnState({ running: false }), "idle");
  assert.equal(turnState({ running: true }), "running");
  assert.equal(turnState({ running: true, starting: true }), "starting");
  assert.equal(turnState({ running: true, pendingCount: 2 }), "waiting");
  assert.equal(turnState({ running: true, pendingCount: 2, stopping: true }), "interrupting");
  assert.equal(turnState({ running: true, sessionStatus: "dead" }), "ended");
});

test("statusPill maps each state to the wireframe tone, glyph and label", () => {
  const run = statusPill({ running: true, startedAt: 0, now: 42_000 });
  assert.deepEqual([run.tone, run.glyph, run.label, run.time], ["s-run", "pulse", "Working", "0:42"]);
  assert.equal(statusPill({ running: true }).time, null);
  const start = statusPill({ running: true, starting: true });
  assert.deepEqual([start.tone, start.glyph, start.label], ["", "spinner", "Starting…"]);
  const stop = statusPill({ running: true, stopping: true });
  assert.deepEqual([stop.tone, stop.glyph, stop.label], ["s-stop", "square", "Stopping…"]);
  const wait = statusPill({ running: true, pendingCount: 1 });
  assert.deepEqual([wait.tone, wait.glyph, wait.label], ["s-wait", "user", "Waiting on you"]);
  const idle = statusPill({ running: false, toolIssue: true });
  assert.deepEqual([idle.tone, idle.glyph, idle.label, idle.flag], ["s-idle", "pulse-idle", "Idle", true]);
  assert.equal(statusPill({ running: false, sessionStatus: "orphaned" }).glyph, "pulse-warn");
  assert.equal(statusPill({ running: false, sessionStatus: "dead" }).label, "Ended");
});

test("pillAriaLabel", () => {
  const pill = statusPill({ running: true, toolIssue: true });
  assert.equal(pillAriaLabel("Qlik Analyst", pill, 1), "Qlik Analyst, working, one tool needs attention");
  assert.equal(pillAriaLabel("Qlik Analyst", statusPill({ running: false })), "Qlik Analyst, idle");
});

test("crumb falls back to New conversation", () => {
  assert.deepEqual(crumb({}), { project: null, title: "New conversation", archived: false });
  assert.deepEqual(crumb({ title: " Plan ", projectName: "true-ui", archived: true }), {
    project: "true-ui",
    title: "Plan",
    archived: true,
  });
});

test("connectedTools: tape, LED and counts", () => {
  const vm = connectedTools([
    { id: "q", name: "Qlik Cloud", status: "ready", toolCount: 12 },
    { id: "g", name: "GitHub", toolCount: 8 },
    { id: "d", name: "Google Drive", status: "failed", failureReason: "reauthenticationRequired" },
    { id: "j", name: "Jira", status: "failed" },
  ]);
  assert.equal(vm.count, "2 of 4 ready");
  assert.equal(vm.footer, "2 tools need attention");
  assert.deepEqual(
    vm.carts.map((c) => [c.sub, c.tape, c.led, c.glyph]),
    [
      ["12 tools", null, "", "chart"],
      ["8 tools", null, "", "term"],
      ["Needs auth", "sign in", "warn", "file"],
      ["Failed", "failed", "bad", "list"],
    ],
  );
  assert.equal(connectedTools([{ id: "x", name: "X", enabled: false }]).footer, "1 tool needs attention");
  assert.equal(connectedTools([]).footer, null);
});

test("goalPill covers every status", () => {
  assert.deepEqual(goalPill(goal, null), { tone: "accent", label: "Active", pulse: true });
  assert.equal(goalPill({ ...goal, status: "paused" }, null).tone, "");
  for (const status of ["blocked", "usageLimited", "budgetLimited"] as const)
    assert.equal(goalPill({ ...goal, status }, null).tone, "warn");
  assert.equal(goalPill({ ...goal, status: "budgetLimited" }, null).label, "Budget reached");
  assert.equal(goalPill({ ...goal, status: "complete" }, null).label, "Ready for review");
  const accepted = goalPill({ ...goal, status: "complete" }, {
    decision: "accepted",
    objective: goal.objective,
    goalCreatedAt: goal.createdAt,
  } as never);
  assert.deepEqual(accepted, { tone: "ok", label: "Accepted", pulse: false });
});

test("goalStrip meter turns amber past 80%", () => {
  const s = goalStrip(goal, null, 150_000);
  assert.deepEqual(s.meter, { used: "142k", budget: "500k", pct: 28, warn: false });
  assert.equal(goalStrip({ ...goal, tokensUsed: 410_000 }, null, 0).meter?.warn, true);
  assert.equal(goalStrip({ ...goal, tokenBudget: null }, null, 1500).meter, null);
  assert.equal(goalStrip({ ...goal, tokenBudget: null }, null, 1500).total, "1.5k");
});

test("sessionHealth", () => {
  assert.equal(sessionHealth(null), null);
  assert.equal(sessionHealth({ status: "active" }), null);
  assert.equal(sessionHealth({ status: "orphaned" })?.kind, "orphaned");
  assert.equal(sessionHealth({ status: "dead", archived: true })?.kind, "dead");
  assert.equal(sessionHealth({ status: "active", archived: true })?.kind, "archived");
});

test("errorToast", () => {
  assert.equal(errorToast({ message: "  " }), null);
  assert.deepEqual(errorToast({ message: "Export failed", ref: { code: "err_7f3a21" } }), {
    title: "Export failed",
    detail: null,
    ref: "err_7f3a21",
  });
  assert.equal(errorToast({ message: "x", ref: { code: "C", turnId: "t1" } })?.ref, "C · t1");
});

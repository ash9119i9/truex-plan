import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as automations from "../lib/automations.ts";

test("cancellation remains available for fenced outcomes until already requested or stopped", () => {
  for (const run of [
    { status: "accepted", stopState: "not_started" },
    { status: "preparing", stopState: "not_started" },
    { status: "running", stopState: "running" },
    { status: "failed", stopState: "unknown" },
    { status: "failed", stopState: "running" },
    { status: "failed", stopState: "stop_requested" },
    { status: "unknown", stopState: "unknown" },
  ] as const)
    assert.equal(automations.canRequestAutomationCancellation(run), true);
  for (const run of [
    { status: "failed", stopState: "not_started" },
    { status: "succeeded", stopState: "stopped" },
    { status: "cancelled", stopState: "stopped" },
    { status: "cancellation_requested", stopState: "unknown" },
    { status: "cancellation_requested", stopState: "stop_requested" },
    {
      status: "failed",
      stopState: "unknown",
      cancellationRequestedAt: "2026-10-09T00:00:00.000Z",
    },
  ] as const)
    assert.equal(automations.canRequestAutomationCancellation(run), false);
});

// Execute the component's actual handlers to test state across polling and actions.
const source = readFileSync(
  new URL("../components/automations/run-details.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "run-details.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const handlers: string[] = [];
function collect(node: ts.Node) {
  if (
    ts.isFunctionDeclaration(node) &&
    ["load", "action", "refreshRun"].includes(node.name?.text ?? "")
  )
    handlers.push(node.getText(tree));
  ts.forEachChild(node, collect);
}
collect(tree);

function harness() {
  const context = {
    automation: { id: "automation-a" },
    runId: "run-a",
    live: true,
    error: "Cancellation receipt lost",
    loadError: "Old read error",
    busy: false,
    failRead: false,
    failCancel: false,
    refresh: 0,
    async getAutomationRun() {
      if (context.failRead) throw new Error("Evidence unavailable");
      return { run: { status: "failed", stopState: "stopped" } };
    },
    async cancelAutomationRun() {
      if (context.failCancel) throw new Error("Cancellation rejected");
    },
    async onRetry() {},
    onChanged() {},
    setDetail() {},
    setCancelConfirm() {},
    setBusy(value: boolean) {
      context.busy = value;
    },
    setError(value: string) {
      context.error = value;
    },
    setLoadError(value: string) {
      context.loadError = value;
    },
    setRefresh(update: (value: number) => number) {
      context.refresh = update(context.refresh);
    },
    userMessage(error: Error) {
      return error.message;
    },
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(
    ts.transpile(
      handlers.join("\n") +
        "\n globalThis.executeLoad = load; globalThis.executeAction = action;",
      { target: ts.ScriptTarget.ES2022 },
    ),
    sandbox,
  );
  return {
    context,
    load: (sandbox as any).executeLoad as () => Promise<void>,
    action: (sandbox as any).executeAction as (
      cancel: boolean,
    ) => Promise<void>,
    sandbox,
  };
}

test("successful and failed background reads preserve the action error", async () => {
  const rig = harness();
  await rig.load();
  assert.equal(rig.context.error, "Cancellation receipt lost");
  assert.equal(rig.context.loadError, "");
  rig.context.failRead = true;
  await rig.load();
  assert.equal(rig.context.error, "Cancellation receipt lost");
  assert.equal(rig.context.loadError, "Evidence unavailable");
});

test("an explicit action or Refresh clears the previous action error", async () => {
  const rig = harness();
  await rig.action(true);
  assert.equal(rig.context.error, "");
  rig.context.failCancel = true;
  await rig.action(true);
  assert.equal(rig.context.error, "Cancellation rejected");
  vm.runInContext("refreshRun()", rig.sandbox);
  assert.equal(rig.context.error, "");
  assert.equal(rig.context.refresh, 2);
});

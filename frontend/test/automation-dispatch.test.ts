import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual view's dispatch handler with delayed receipts, without a browser or agent.
const source = readFileSync(
  new URL("../components/automations/view.tsx", import.meta.url),
  "utf8",
);
const tree = ts.createSourceFile(
  "view.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let handler = "";
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "run")
    handler = node.getText(tree);
  ts.forEachChild(node, collect);
}
collect(tree);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const calls: unknown[][] = [];
  const receipts: ReturnType<typeof deferred<{ id: string }>>[] = [];
  const context = {
    selected: { id: "automation-a", revision: 1 },
    selectedIdRef: { current: "automation-a" },
    pendingKeys: { current: new Map<string, string>() },
    crypto: { randomUUID: () => `key-${calls.length}` },
    busy: false,
    error: "",
    openedRun: "",
    changes: 0,
    setBusy(value: boolean) {
      context.busy = value;
    },
    setError(value: string) {
      context.error = value;
    },
    setRunId(value: string) {
      context.openedRun = value;
    },
    changed() {
      context.changes++;
    },
    userMessage(error: Error) {
      return error.message;
    },
    runAutomation(...args: unknown[]) {
      calls.push(args);
      const receipt = deferred<{ id: string }>();
      receipts.push(receipt);
      return receipt.promise;
    },
  };
  const sandbox = vm.createContext(context);
  const javascript = ts.transpile(handler + "\n globalThis.executeRun = run;", {
    target: ts.ScriptTarget.ES2022,
  });
  vm.runInContext(javascript, sandbox);
  return {
    context,
    calls,
    receipts,
    run: (sandbox as any).executeRun as (
      retryOfRunId?: string,
    ) => Promise<void>,
  };
}

test("an ambiguous Run now receipt reuses its operation key on explicit retry", async () => {
  const rig = harness();
  const first = rig.run();
  rig.receipts[0].reject(new Error("Receipt lost; inspect history."));
  await assert.rejects(first, /Receipt lost/);
  assert.equal(rig.context.busy, false);
  assert.match(rig.context.error, /Receipt lost/);
  const retry = rig.run();
  rig.receipts[1].resolve({ id: "run-a" });
  await retry;
  assert.equal(rig.calls[0][1], rig.calls[1][1]);
  assert.equal(rig.context.openedRun, "run-a");
});

test("a receipt arriving after selecting another automation never opens in that automation", async () => {
  const rig = harness();
  const pending = rig.run();
  rig.context.selectedIdRef.current = "automation-b";
  rig.receipts[0].resolve({ id: "run-a" });
  await pending;
  assert.equal(rig.context.openedRun, "");
  assert.equal(
    rig.context.changes,
    1,
    "history still refreshes to show accepted work",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalModesOff,
  decisionLabel,
  loadApprovalModes,
  modePicker,
  recordSummary,
  setApprovalMode,
  type ModeRecord,
} from "../lib/approval-mode.ts";
import type { ApprovalModesConfig } from "../../shared/contracts.ts";

const on: ApprovalModesConfig = {
  enabled: true,
  defaultMode: "ask",
  autopilot: true,
  nameHeuristic: false,
};

function mockFetch(t: any, reply: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status });
  });
  return calls;
}

test("the picker is hidden when approval modes are off", () => {
  assert.equal(modePicker(approvalModesOff, null), null);
  assert.equal(
    modePicker({ ...on, enabled: false }, { approvalMode: "auto" }),
    null,
  );
});

test("autopilot is offered only when it is switched on", () => {
  const values = (c: ApprovalModesConfig) =>
    modePicker(c, null)!.options.map((o) => o.value);
  assert.deepEqual(values(on), ["ask", "readOnly", "auto"]);
  assert.deepEqual(values({ ...on, autopilot: false }), ["ask", "readOnly"]);
  const labels = modePicker(on, null)!.options.map((o) => o.label);
  assert.deepEqual(labels, [
    "Ask me every time",
    "Auto-allow read-only tools",
    "Autopilot",
  ]);
  assert.ok(modePicker(on, null)!.options.every((o) => o.description));
});

test("the selected mode is the session's, then the draft, then the default", () => {
  const config = { ...on, defaultMode: "readOnly" as const };
  assert.equal(modePicker(config, null)!.selected, "readOnly");
  assert.equal(modePicker(config, {})!.selected, "readOnly");
  assert.equal(modePicker(config, { approvalMode: "ask" })!.selected, "ask");
  assert.equal(modePicker(config, null, "auto")!.selected, "auto");
  // A draft choice never overrides an existing chat.
  assert.equal(modePicker(config, {}, "auto")!.selected, "readOnly");
});

test("an unavailable autopilot selection falls back to an offered mode", () => {
  const noAuto = { ...on, autopilot: false };
  assert.equal(modePicker(noAuto, { approvalMode: "auto" })!.selected, "ask");
  assert.equal(
    modePicker({ ...noAuto, defaultMode: "auto" }, null)!.selected,
    "ask",
  );
  assert.equal(
    modePicker(
      { ...noAuto, defaultMode: "readOnly" },
      { approvalMode: "auto" },
    )!.selected,
    "readOnly",
  );
});

test("features load from platform and failures mean off", async (t) => {
  const calls = mockFetch(t, { approvalModes: on });
  assert.deepEqual(await loadApprovalModes(), on);
  assert.match(calls[0].url, /\/api\/features$/);
  t.mock.restoreAll();
  mockFetch(t, { error: "nope" }, 500);
  assert.deepEqual(await loadApprovalModes(), approvalModesOff);
  t.mock.restoreAll();
  mockFetch(t, {});
  assert.deepEqual(await loadApprovalModes(), approvalModesOff);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("offline");
  });
  assert.deepEqual(await loadApprovalModes(), approvalModesOff);
});

test("changing the mode posts it to the session", async (t) => {
  const calls = mockFetch(t, { mode: "readOnly" });
  assert.equal(await setApprovalMode("s 1", "readOnly"), "readOnly");
  assert.match(calls[0].url, /\/api\/sessions\/s%201\/approval-mode$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    mode: "readOnly",
  });
  t.mock.restoreAll();
  mockFetch(t, { error: "Autopilot is off" }, 422);
  await assert.rejects(setApprovalMode("s1", "auto"), { status: 422 });
});

const record = (extra: Partial<ModeRecord>): ModeRecord => ({
  requestId: "r1",
  outcome: "auto",
  items: [],
  ...extra,
});

test("records answered by a mode say which mode", () => {
  assert.equal(
    recordSummary(record({ autoMode: "readOnly" })),
    "Auto-allowed (read-only)",
  );
  assert.equal(
    recordSummary(record({ autoMode: "auto" })),
    "Auto-accepted (Autopilot)",
  );
  assert.equal(
    recordSummary(record({ autoMode: "grant" })),
    "Allowed for this chat",
  );
  assert.equal(recordSummary(record({})), "Recommended option chosen");
  assert.equal(recordSummary(record({ outcome: "answered" })), "You answered");
  assert.equal(recordSummary(record({ outcome: "expired" })), "Closed");
});

test("tool decisions use the mode label when a mode allowed them", () => {
  assert.deepEqual(decisionLabel(record({}), "allowedChat"), {
    text: "Allowed for this chat",
    tone: "allowed",
  });
  assert.equal(
    decisionLabel(record({ autoMode: "readOnly" }), "allowedOnce").text,
    "Auto-allowed (read-only)",
  );
  assert.equal(
    decisionLabel(record({ autoMode: "grant" }), "allowedOnce").text,
    "Allowed for this chat",
  );
  assert.equal(decisionLabel(record({}), "allowedOnce").text, "Allowed once");
  assert.equal(
    decisionLabel(record({ outcome: "answered" }), "allowedSession").text,
    "Allowed for this chat",
  );
  // A mode never relabels a refusal.
  assert.equal(
    decisionLabel(record({ autoMode: "auto" }), "declined").text,
    "Not allowed",
  );
});

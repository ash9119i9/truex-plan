import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTOMATION_LIMITS,
  assertAutomationRunTransition,
  canReleaseAutomationFence,
  validateAutomationRecipe,
  validateAutomationWorkflowInput,
} from "../../shared/automations";

const intervalRecipe = () => ({
  name: "Daily summary",
  agentId: "agent-1",
  prompt: "Summarize the permitted project activity.",
  trigger: {
    kind: "interval",
    everyMs: 60_000,
    anchorAt: "2026-10-09T04:00:00Z",
    timeZone: "UTC",
  },
});

test("automation recipes validate and normalize the fixed-rate anchor and limits", () => {
  const recipe = validateAutomationRecipe(intervalRecipe());
  assert.deepEqual(recipe.limits, DEFAULT_AUTOMATION_LIMITS);
  assert.deepEqual(recipe.trigger, {
    kind: "interval",
    everyMs: 60_000,
    anchorAt: "2026-10-09T04:00:00.000Z",
    timeZone: "UTC",
  });
  const changed = validateAutomationRecipe({
    ...intervalRecipe(),
    name: "Renamed",
  });
  assert.deepEqual(changed.trigger, recipe.trigger);
});

test("intervals persist an explicit validated display timezone", () => {
  assert.throws(() =>
    validateAutomationRecipe({
      ...intervalRecipe(),
      trigger: { ...intervalRecipe().trigger, timeZone: undefined },
    }),
  );
  assert.throws(() =>
    validateAutomationRecipe({
      ...intervalRecipe(),
      trigger: { ...intervalRecipe().trigger, timeZone: "bad/zone" },
    }),
  );
});

test("native Temporal intervals and anchors require whole-second precision", () => {
  assert.throws(() =>
    validateAutomationRecipe({
      ...intervalRecipe(),
      trigger: { ...intervalRecipe().trigger, everyMs: 60_001 },
    }),
  );
  assert.throws(() =>
    validateAutomationRecipe({
      ...intervalRecipe(),
      trigger: {
        ...intervalRecipe().trigger,
        anchorAt: "2026-10-09T04:00:00.123Z",
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateAutomationRecipe({
      ...intervalRecipe(),
      trigger: {
        ...intervalRecipe().trigger,
        anchorAt: "2026-10-09T04:00:00.000Z",
      },
    }),
  );
});

test("run lifecycle rejects success before execution and terminal-state revival", () => {
  assert.doesNotThrow(() =>
    assertAutomationRunTransition("accepted", "preparing"),
  );
  assert.doesNotThrow(() => assertAutomationRunTransition("running", "failed"));
  assert.doesNotThrow(() =>
    assertAutomationRunTransition("running", "cancellation_requested"),
  );
  assert.doesNotThrow(() =>
    assertAutomationRunTransition("cancellation_requested", "unknown"),
  );
  assert.doesNotThrow(() =>
    assertAutomationRunTransition("unknown", "succeeded"),
  );
  for (const [from, to] of [
    ["accepted", "succeeded"],
    ["preparing", "succeeded"],
    ["failed", "running"],
    ["succeeded", "failed"],
    ["cancelled", "running"],
    ["skipped", "preparing"],
  ] as const)
    assert.throws(() => assertAutomationRunTransition(from, to));
});

test("failed business outcome never releases a fence without confirmed absence or stop", () => {
  assert.equal(canReleaseAutomationFence("not_started"), true);
  assert.equal(canReleaseAutomationFence("stopped"), true);
  assert.equal(canReleaseAutomationFence("running"), false);
  assert.equal(canReleaseAutomationFence("stop_requested"), false);
  assert.equal(canReleaseAutomationFence("unknown"), false);
});

test("workflow inputs contain only bounded identifiers and no restricted content", () => {
  const input = {
    tenantId: "tenant-1",
    ownerId: "owner-1",
    automationId: "automation-1",
    runId: "run-1",
    revision: 1,
    controlVersion: 2,
  };
  assert.deepEqual(validateAutomationWorkflowInput(input), input);
  for (const invalid of [
    { ...input, tenantId: "" },
    { ...input, revision: 0 },
    { ...input, controlVersion: 1.1 },
    { ...input, prompt: "private instructions" },
    { ...input, credentials: "secret" },
    { ...input, toolArguments: {} },
  ])
    assert.throws(() => validateAutomationWorkflowInput(invalid));
});

test("automation calendar recipes require valid weekdays, local time and IANA zone", () => {
  const calendar = {
    kind: "calendar",
    weekdays: [5, 1],
    localTime: "09:30",
    timeZone: "Asia/Kolkata",
  };
  const recipe = validateAutomationRecipe({
    ...intervalRecipe(),
    trigger: calendar,
  });
  assert.deepEqual(recipe.trigger, { ...calendar, weekdays: [1, 5] });
  for (const invalid of [
    { localTime: "24:00" },
    { localTime: "9:30" },
    { localTime: "10:60" },
    { timeZone: "Not/AZone" },
    { timeZone: "+05:30" },
    { weekdays: [] },
    { weekdays: [1, 1] },
    { weekdays: [7] },
    { weekdays: [1.5] },
  ]) {
    assert.throws(() =>
      validateAutomationRecipe({
        ...intervalRecipe(),
        trigger: { ...calendar, ...invalid },
      }),
    );
  }
});

test("automation validation rejects missing recipes, arbitrary cron and malformed anchors", () => {
  for (const invalid of [
    null,
    [],
    { ...intervalRecipe(), name: " " },
    { ...intervalRecipe(), agentId: "" },
    { ...intervalRecipe(), prompt: " " },
    { ...intervalRecipe(), projectId: "" },
    { ...intervalRecipe(), trigger: { kind: "cron", cron: "* * * * *" } },
    {
      ...intervalRecipe(),
      trigger: { kind: "interval", everyMs: 60_000, anchorAt: "tomorrow" },
    },
    {
      ...intervalRecipe(),
      trigger: {
        kind: "interval",
        everyMs: 60_000,
        anchorAt: "2026-02-30T04:00:00Z",
      },
    },
    {
      ...intervalRecipe(),
      trigger: {
        kind: "interval",
        everyMs: 60_000,
        anchorAt: "2026-10-09T04:00:00",
      },
    },
  ])
    assert.throws(() => validateAutomationRecipe(invalid));
});

test("automation intervals and execution limits are bounded integer durations", () => {
  for (const everyMs of [
    0,
    -1,
    59_999,
    60_000.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() =>
      validateAutomationRecipe({
        ...intervalRecipe(),
        trigger: { ...intervalRecipe().trigger, everyMs },
      }),
    );
  }
  for (const limits of [
    { executionTimeoutMs: 0, latenessGraceMs: 600_000 },
    { executionTimeoutMs: 1_800_001, latenessGraceMs: 600_000 },
    { executionTimeoutMs: 1000.5, latenessGraceMs: 600_000 },
    { executionTimeoutMs: 1000, latenessGraceMs: -1 },
    { executionTimeoutMs: 1000, latenessGraceMs: 600_001 },
  ])
    assert.throws(() =>
      validateAutomationRecipe({ ...intervalRecipe(), limits }),
    );
  assert.deepEqual(
    validateAutomationRecipe({
      ...intervalRecipe(),
      limits: { executionTimeoutMs: 1000, latenessGraceMs: 0 },
    }).limits,
    { executionTimeoutMs: 1000, latenessGraceMs: 0 },
  );
});

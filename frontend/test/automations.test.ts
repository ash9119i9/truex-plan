import { test } from "node:test";
import assert from "node:assert/strict";
import {
  automationExportHref,
  automationAttentionCount,
  canRunAutomation,
  canRetryAutomationRun,
  defaultAutomationFields,
  editAutomation,
  recipeFromFields,
  runAutomation,
  runOutcomeLabel,
  historyQuery,
  listAutomations,
} from "../lib/automations.ts";
import { bumpIdentityGeneration } from "../lib/identity.ts";

test("editor preserves cadence and UTC anchor while changing the reviewed title", () => {
  const fields = defaultAutomationFields(
    "agent-1",
    "Asia/Kolkata",
    "2026-10-09T04:00:12.345Z",
  );
  const recipe = recipeFromFields({
    ...fields,
    name: "Summary",
    prompt: "  Keep formatting.  ",
    intervalAmount: "2",
    intervalUnit: "hours",
  });
  assert.deepEqual(recipe.trigger, {
    kind: "interval",
    everyMs: 7_200_000,
    anchorAt: "2026-10-09T04:00:12.000Z",
    timeZone: "Asia/Kolkata",
  });
  assert.equal(recipe.prompt, "  Keep formatting.  ");
  assert.deepEqual(
    recipeFromFields({ ...fields, name: "Renamed", prompt: "x" }).trigger,
    recipeFromFields({ ...fields, name: "Summary", prompt: "x" }).trigger,
  );
});

test("historical unread failures remain visible after a later successful run", () => {
  assert.equal(
    automationAttentionCount({ unreadCount: 2, latestRun: { unread: false } }),
    2,
  );
  assert.equal(
    automationAttentionCount({ unreadCount: 0, latestRun: { unread: true } }),
    0,
  );
  assert.equal(automationAttentionCount({ latestRun: { unread: true } }), 1);
  assert.equal(automationAttentionCount({}), 0);
});

test("editor validates calendar selection, missing agent and bounded limits", () => {
  const fields = {
    ...defaultAutomationFields("agent-1", "UTC"),
    name: "Summary",
    prompt: "Summarize",
    triggerKind: "calendar" as const,
    weekdays: [1, 3, 5],
    localTime: "09:30",
  };
  assert.deepEqual(recipeFromFields(fields).trigger, {
    kind: "calendar",
    weekdays: [1, 3, 5],
    localTime: "09:30",
    timeZone: "UTC",
  });
  for (const changed of [
    { agentId: "" },
    { weekdays: [] },
    { localTime: "24:00" },
    { executionMinutes: "31" },
    { latenessMinutes: "-1" },
    { timeZone: "bad/zone" },
  ])
    assert.throws(() => recipeFromFields({ ...fields, ...changed }));
});

test("run actions keep uncertain execution fenced even after a failed outcome", () => {
  const definition = {
    status: "enabled",
    revision: 2,
    enabledRevision: 2,
    activeRunId: undefined,
  } as const;
  const run = { status: "failed", stopState: "stopped" } as const;
  assert.equal(canRunAutomation(definition), true);
  assert.equal(canRetryAutomationRun(run, definition), true);
  assert.equal(
    canRunAutomation({ ...definition, activeRunId: "old-run" }),
    false,
  );
  assert.equal(
    canRetryAutomationRun({ ...run, stopState: "stop_requested" }, definition),
    false,
  );
  assert.equal(
    canRetryAutomationRun(
      { status: "unknown", stopState: "unknown" },
      definition,
    ),
    false,
  );
  assert.equal(
    canRunAutomation({
      ...definition,
      status: "draft",
      enabledRevision: undefined,
    }),
    false,
  );
  assert.equal(canRunAutomation({ ...definition, status: "archived" }), false);
  assert.equal(canRunAutomation({ ...definition, status: "paused" }), false);
  assert.match(
    runOutcomeLabel({ status: "failed", reason: "approval_required" }),
    /Failed.*approval/i,
  );
  assert.match(runOutcomeLabel({ status: "unknown" }), /unknown/i);
});

test("history and metadata exports encode IDs and retain only supported filters", () => {
  assert.equal(
    historyQuery({
      status: "failed",
      from: "2026-10-01",
      to: "2026-10-09",
      before: "a/b",
      limit: 25,
    }),
    "?status=failed&from=2026-10-01&to=2026-10-09&before=a%2Fb&limit=25",
  );
  assert.equal(
    automationExportHref("a/b", { status: "unknown" }),
    "/api/automations/a%2Fb/export.csv?status=unknown",
  );
});

test("API mutations use versioned PUT and retain the exact Run now request key", async (t) => {
  const calls: { path: string; init: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      calls.push({ path, init });
      return Response.json({ available: true, items: [] });
    },
  );
  const recipe = recipeFromFields({
    ...defaultAutomationFields("a", "UTC"),
    name: "Summary",
    prompt: "x",
  });
  await listAutomations();
  await editAutomation("a/b", 3, recipe);
  await runAutomation("a/b", "same-key", 2, "old-run");
  await runAutomation("a/b", "same-key", 2, "old-run");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[1].path, "/api/automations/a%2Fb");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    version: 3,
    recipe,
  });
  assert.equal(calls[2].init.body, calls[3].init.body);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    requestKey: "same-key",
    revision: 2,
    retryOfRunId: "old-run",
  });
});

test("automation responses from a previous identity are discarded", async (t) => {
  t.mock.method(console, "error", () => {});
  let respond!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
  );
  const pending = listAutomations();
  bumpIdentityGeneration();
  respond(
    Response.json({
      available: true,
      items: [{ prompt: "old owner's content" }],
    }),
  );
  await assert.rejects(pending, { code: "STALE_IDENTITY" });
});

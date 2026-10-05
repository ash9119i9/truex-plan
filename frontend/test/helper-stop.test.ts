import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmHelperStop, markHelperStop } from "../lib/helper-stop.ts";
import {
  applySubAgentEvent,
  helperStatusLabel,
  isRunning,
  rehydrate,
  type SubAgentState,
} from "../lib/subagents.ts";
import type { SubAgent } from "../../shared/contracts.ts";

const helper = (extra: Partial<SubAgent> = {}): SubAgent => ({
  threadId: "child",
  path: null,
  nickname: "Helper",
  role: null,
  depth: 1,
  status: "running",
  startedAt: "2026-10-06T10:00:00.000Z",
  ...extra,
});
const state = (): SubAgentState => ({
  agents: [helper({ status: "pendingInit" }), helper({ threadId: "sibling" })],
  previews: { child: "partial", sibling: "other output" },
});

test("helper Stop marks initializing helper pending without changing runtime status or siblings", () => {
  const original = state();
  const next = markHelperStop(original, "child", "pending");
  assert.equal(next.agents[0].status, "pendingInit");
  assert.equal(next.agents[0].stopStatus, "pending");
  assert.equal(helperStatusLabel(next.agents[0]), "Stopping…");
  assert.equal(next.agents[1], original.agents[1]);
  assert.equal(next.previews, original.previews);
  assert.equal(original.agents[0].stopStatus, undefined);
});

test("ACK alone, wrong helper and unresolved result cannot optimistically mark interrupted", () => {
  const pending = markHelperStop(state(), "child", "pending");
  for (const result of [
    { ok: true },
    { ok: true, agent: helper({ threadId: "sibling", status: "interrupted" }) },
    { ok: true, agent: helper() },
    {
      ok: true,
      agent: helper({ status: "interrupted", stopStatus: "unconfirmed" }),
    },
  ])
    assert.equal(confirmHelperStop(pending, "child", result), null);
  assert.equal(pending.agents[0].status, "pendingInit");
});

test("SSE and reconnect retain uncertainty; a confirmed terminal response clears it", () => {
  let next = markHelperStop(state(), "child", "pending");
  next = applySubAgentEvent(next, {
    type: "subagent.status",
    data: { agent: helper({ stopStatus: "unconfirmed" }) },
  });
  next = rehydrate(next, next.agents);
  assert.equal(next.agents[0].stopStatus, "unconfirmed");
  assert.equal(helperStatusLabel(next.agents[0]), "Stop unconfirmed");
  const confirmed = confirmHelperStop(next, "child", {
    ok: true,
    agent: helper({ status: "interrupted" }),
  })!;
  assert.equal(confirmed.agents[0].status, "interrupted");
  assert.equal(confirmed.agents[0].stopStatus, undefined);
  assert.equal(confirmed.agents[1], next.agents[1]);
});

test("natural completion wins over delayed Stop failure or response", () => {
  const pending = markHelperStop(state(), "child", "pending");
  const done = applySubAgentEvent(pending, {
    type: "subagent.completed",
    data: { agent: helper({ status: "completed" }) },
  });
  assert.equal(done.agents[0].stopStatus, undefined);
  assert.equal(markHelperStop(done, "child", "unconfirmed"), done);
  assert.equal(
    confirmHelperStop(done, "child", {
      ok: true,
      agent: helper({ status: "interrupted" }),
    }),
    done,
  );
  assert.equal(done.agents[0].status, "completed");
});

test("confirmed natural terminal outcomes are accepted and stale running replay cannot restore Stop", () => {
  for (const status of [
    "completed",
    "errored",
    "shutdown",
    "notFound",
  ] as const) {
    const confirmed = confirmHelperStop(
      markHelperStop(state(), "child", "pending"),
      "child",
      {
        ok: true,
        agent: helper({ status }),
      },
    )!;
    const replayed = applySubAgentEvent(confirmed, {
      type: "subagent.status",
      data: { agent: helper({ stopStatus: "pending" }) },
    });
    assert.equal(replayed.agents[0].status, status);
    assert.equal(replayed.agents[0].stopStatus, undefined);
  }
});

test("terminal snapshot preserves unresolved Stop and missing helper is untouched", () => {
  const recovered = rehydrate(state(), [
    helper({ status: "completed", stopStatus: "unconfirmed" }),
  ]);
  assert.equal(recovered.agents[0].stopStatus, "unconfirmed");
  assert.equal(isRunning(recovered.agents[0]), true);
  assert.equal(helperStatusLabel(recovered.agents[0]), "Stop unconfirmed");
  const original = state();
  assert.equal(markHelperStop(original, "missing", "pending"), original);
});

test("natural completion retains pending then unconfirmed Stop until terminal confirmation omits the field", () => {
  let next = markHelperStop(state(), "child", "pending");
  next = applySubAgentEvent(next, {
    type: "subagent.completed",
    data: { agent: helper({ status: "completed", stopStatus: "pending" }) },
  });
  assert.equal(next.agents[0].status, "completed");
  assert.equal(next.agents[0].stopStatus, "pending");
  assert.equal(isRunning(next.agents[0]), true);
  assert.equal(helperStatusLabel(next.agents[0]), "Stopping…");
  next = applySubAgentEvent(next, {
    type: "subagent.status",
    data: { agent: helper({ status: "completed", stopStatus: "unconfirmed" }) },
  });
  assert.equal(next.agents[0].stopStatus, "unconfirmed");
  assert.equal(helperStatusLabel(next.agents[0]), "Stop unconfirmed");
  const retrying = markHelperStop(next, "child", "pending");
  assert.equal(retrying.agents[0].status, "completed");
  assert.equal(retrying.agents[0].stopStatus, "pending");
  const confirmed = confirmHelperStop(retrying, "child", {
    ok: true,
    agent: helper({ status: "completed" }),
  })!;
  assert.equal(confirmed.agents[0].status, "completed");
  assert.equal(confirmed.agents[0].stopStatus, undefined);
  assert.equal(isRunning(confirmed.agents[0]), false);
});

test("stale running replay cannot clear or change a terminal helper's stop uncertainty", () => {
  const unresolved = rehydrate(state(), [
    helper({ status: "shutdown", stopStatus: "unconfirmed" }),
  ]);
  for (const stopStatus of [undefined, "pending"] as const) {
    const next = applySubAgentEvent(unresolved, {
      type: "subagent.status",
      data: { agent: helper({ stopStatus }) },
    });
    assert.equal(next.agents[0].status, "shutdown");
    assert.equal(next.agents[0].stopStatus, "unconfirmed");
  }
  const settled = applySubAgentEvent(unresolved, {
    type: "subagent.completed",
    data: { agent: helper({ status: "shutdown" }) },
  });
  assert.equal(settled.agents[0].stopStatus, undefined);
  assert.equal(isRunning(settled.agents[0]), false);
});

test("authoritative shutdown clears uncertainty while retaining a completed helper's outcome", () => {
  const unresolved = rehydrate(state(), [
    helper({ status: "completed", stopStatus: "unconfirmed" }),
  ]);
  const confirmed = confirmHelperStop(unresolved, "child", {
    ok: true,
    agent: helper({ status: "shutdown" }),
  })!;
  assert.equal(confirmed.agents[0].status, "completed");
  assert.equal(confirmed.agents[0].stopStatus, undefined);
  assert.equal(isRunning(confirmed.agents[0]), false);
});

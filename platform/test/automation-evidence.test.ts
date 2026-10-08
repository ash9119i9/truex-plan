import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAutomationEvidence } from "../src/automation/evidence";
const run = {
  id: "run",
  automationId: "auto",
  revision: 1,
  sessionId: "session",
  turnId: "root",
  ownerId: "owner",
  tenantId: "default",
};
const session = {
  _id: "session",
  threadId: "thread",
  automationPolicy: {
    automationId: "auto",
    runId: "run",
    revision: 1,
    promptRef: "auto:1",
  },
};
const event = {
  type: "turn.completed",
  threadId: "thread",
  turnId: "root",
  cursor: "generation:1",
  at: new Date().toISOString(),
  data: {
    automationPolicy: session.automationPolicy,
    turn: { id: "root", status: "completed" },
    terminationEvidence: "runtime",
  },
};
test("automation evidence requires exact root native termination and persisted result", () => {
  assert.equal(
    projectAutomationEvidence(run as any, session as any, event as any)
      ?.runtimeTerminal,
    "completed",
  );
  assert.equal(
    projectAutomationEvidence(
      run as any,
      session as any,
      { ...event, threadId: "helper" } as any,
    ),
    null,
  );
  assert.equal(
    projectAutomationEvidence(
      run as any,
      session as any,
      { ...event, turnId: "other" } as any,
    ),
    null,
  );
  assert.equal(
    projectAutomationEvidence(
      run as any,
      session as any,
      {
        ...event,
        data: { ...event.data, terminationEvidence: "unconfirmed" },
      } as any,
    )?.runtimeTerminal,
    undefined,
  );
});
test("automation blockers are structural events; tool metadata never leaks private payloads", () => {
  const blocked = projectAutomationEvidence(
    run as any,
    session as any,
    {
      ...event,
      type: "automation.blocked",
      data: {
        reason: "approval_required",
        automationPolicy: session.automationPolicy,
        args: { token: "private" },
      },
    } as any,
  );
  assert.equal(blocked?.blocker, "approval_required");
  const prose = projectAutomationEvidence(
    run as any,
    session as any,
    {
      ...event,
      type: "message.final",
      data: {
        text: "No approval required. Completed.",
        automationPolicy: session.automationPolicy,
      },
    } as any,
  );
  assert.equal(prose?.blocker, undefined);
  assert.equal(prose?.resultSeen, true);
  assert.equal(JSON.stringify(blocked).includes("private"), false);
});
test("automation conversation outputs and writes are owner-only even in shared tenants", async () => {
  const { checkSession } = await import("../src/access");
  const { userContext } = await import("../src/user");
  const owned = { userId: "owner", automationPolicy: { runId: "run" } };
  userContext.run(
    { id: "other", email: "other@dev.local", role: "admin" },
    () => assert.throws(() => checkSession(owned, "read")),
  );
  userContext.run(
    { id: "owner", email: "owner@dev.local", role: "user" },
    () => {
      assert.equal(checkSession(owned, "read"), owned);
      assert.throws(() => checkSession(owned, "write"));
    },
  );
});

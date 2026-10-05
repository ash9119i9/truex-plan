import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { approvalModesConfig } from "../src/features";
import { publicApproval, publicSession, POLICY_VERSION } from "../src/public";
import { ALLOW_FOR_CHAT } from "../../shared/contracts";
import type { ApprovalModesConfig } from "../../shared/contracts";
import { admin, asUser, insertFixtures } from "./fixtures";

const OFF = approvalModesConfig({});
const ON: ApprovalModesConfig = {
  enabled: true,
  defaultMode: "ask",
  autopilot: false,
  nameHeuristic: true,
};

test("approval mode config is off by default and rejects unsafe defaults", () => {
  assert.deepEqual(OFF, {
    enabled: false,
    defaultMode: "ask",
    autopilot: false,
    nameHeuristic: false,
  });
  assert.deepEqual(
    approvalModesConfig({
      APPROVAL_MODES: "on",
      APPROVAL_MODES_DEFAULT: "readOnly",
      APPROVAL_NAME_HEURISTIC: "ON",
    }),
    {
      enabled: true,
      defaultMode: "readOnly",
      autopilot: false,
      nameHeuristic: true,
    },
  );
  // Unknown values, and "auto" without autopilot, fall back to "ask".
  for (const value of ["bogus", "auto", ""])
    assert.equal(
      approvalModesConfig({
        APPROVAL_MODES: "on",
        APPROVAL_MODES_DEFAULT: value,
      }).defaultMode,
      "ask",
    );
  assert.deepEqual(
    approvalModesConfig({
      APPROVAL_MODES: "on",
      APPROVAL_MODES_DEFAULT: "auto",
      APPROVAL_MODES_AUTOPILOT: "on",
    }),
    {
      enabled: true,
      defaultMode: "auto",
      autopilot: true,
      nameHeuristic: false,
    },
  );
  assert.equal(approvalModesConfig({ APPROVAL_MODES: "yes" }).enabled, false);
});

test(
  "approval modes: MCP prompt mode, thread options and the approval-mode endpoint",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "approval-modes").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const off = new PlatformService(store, ["http://core"], OFF);
    const on = new PlatformService(store, ["http://core"], ON);
    const auto = new PlatformService(store, ["http://core"], {
      ...ON,
      autopilot: true,
    });
    // A tenant MCP (admin-managed), so it loads without a chat owner.
    await asUser(admin, async () => {
      const mcp = await off.createTenantMcp({
        name: "sap",
        transport: "http",
        url: "https://example.com/mcp",
      });
      await off.setAgentTenantMcp("assistant", [mcp.id]);
    });

    // Codex asks for every MCP call only when agent-core decides.
    const offServer = (await off.configuration("assistant")).config[
      "mcp_servers.sap"
    ];
    assert.equal("default_tools_approval_mode" in offServer, false);
    assert.equal(
      (await on.configuration("assistant")).config["mcp_servers.sap"]
        .default_tools_approval_mode,
      "prompt",
    );

    const calls: { path: string; method?: string; body?: any }[] = [];
    for (const service of [off, on, auto])
      service.call = async (_host, path, method, body) => {
        calls.push({ path, method, body });
        if (path === "/threads") return { threadId: "t1" };
        if (path.endsWith("/approval-mode")) return { mode: body.mode };
        return {};
      };

    // Thread start: nothing extra while off.
    const plain = await off.create("assistant");
    assert.equal("approvalMode" in calls[0].body, false);
    assert.equal("approvalNameHeuristic" in calls[0].body, false);
    assert.equal("approvalMode" in plain, false);
    const created = await on.create("assistant");
    assert.equal(calls[1].body.approvalMode, "ask");
    assert.equal(calls[1].body.approvalNameHeuristic, true);
    assert.equal(created.approvalMode, "ask");

    // Endpoint validation.
    await assert.rejects(off.setApprovalMode(created._id, "readOnly"), {
      status: 404,
      code: "FEATURE_DISABLED",
    });
    for (const mode of ["bogus", undefined, "auto"])
      await assert.rejects(on.setApprovalMode(created._id, mode), {
        status: 422,
        code: "INVALID_APPROVAL_MODE",
      });
    await assert.rejects(on.setApprovalMode("sess_missing", "ask"), {
      status: 404,
    });
    calls.length = 0;
    assert.deepEqual(await on.setApprovalMode(created._id, "readOnly"), {
      mode: "readOnly",
    });
    assert.deepEqual(calls, [
      {
        path: "/threads/t1/approval-mode",
        method: "POST",
        body: { mode: "readOnly" },
      },
    ]);
    const saved = await store.sessions.findOne({ _id: created._id });
    assert.equal(saved?.approvalMode, "readOnly");
    const listed = (await on.sessions()).find((s) => s._id === created._id);
    assert.equal(listed?.approvalMode, "readOnly");
    const listedOff = (await off.sessions()).find((s) => s._id === created._id);
    assert.equal(listedOff && "approvalMode" in listedOff, false);

    const validCall = on.call;
    for (const confirmation of [
      undefined,
      {},
      { mode: "ask" },
      { mode: null },
    ]) {
      on.call = async () => confirmation;
      await assert.rejects(on.setApprovalMode(created._id, "readOnly"), {
        status: 502,
        code: "INVALID_UPSTREAM_RESPONSE",
      });
      // Desired configuration remains durable so a later resume can apply it.
      assert.equal(
        (await store.sessions.findOne({ _id: created._id }))?.approvalMode,
        "readOnly",
      );
    }
    on.call = validCall;

    // Resume carries the saved mode; off sends neither field.
    calls.length = 0;
    await on.resume(saved!);
    assert.equal(calls[0].path, "/threads/t1/resume");
    assert.equal(calls[0].body.approvalMode, "readOnly");
    assert.equal(calls[0].body.approvalNameHeuristic, true);
    calls.length = 0;
    await off.resume(saved!);
    assert.equal("approvalMode" in calls[0].body, false);
    assert.equal("approvalNameHeuristic" in calls[0].body, false);

    // Autopilot allows "auto".
    assert.deepEqual(await auto.setApprovalMode(created._id, "auto"), {
      mode: "auto",
    });
    // A saved "auto" falls back to the default once autopilot is off.
    calls.length = 0;
    await on.resume((await store.sessions.findOne({ _id: created._id }))!);
    assert.equal(calls[0].body.approvalMode, "ask");
  },
);

test("public sessions include approvalMode only when the feature is on", () => {
  const session = {
    _id: "s",
    agentId: "a",
    status: "active",
    createdAt: "now",
    runtimePolicyVersion: POLICY_VERSION,
    approvalMode: "readOnly",
  } as any;
  assert.equal("approvalMode" in publicSession(session), false);
  assert.equal("approvalMode" in publicSession(session, OFF), false);
  assert.equal(publicSession(session, ON).approvalMode, "readOnly");
  assert.equal(
    publicSession({ ...session, approvalMode: undefined }, ON).approvalMode,
    "ask",
  );
});

const toolDetail = {
  questions: [
    {
      id: "mcp_tool_call_approval_1",
      header: "Approve",
      question: 'Allow the btp MCP server to run tool "get_deployed_artifact"?',
      options: [
        { label: "Allow" },
        { label: ALLOW_FOR_CHAT },
        { label: "Cancel" },
      ],
    },
  ],
};
const toolRecord = (answer: string, reason: string) =>
  publicApproval({
    requestId: "r",
    method: "item/tool/requestUserInput",
    detail: toolDetail,
    result: { answers: { mcp_tool_call_approval_1: { answers: [answer] } } },
    reason,
  })!;

test("audit records show approvals settled by a mode and allow-for-chat", () => {
  for (const mode of ["readOnly", "auto", "grant"]) {
    const record = toolRecord("Allow", `auto-mode:${mode}`);
    assert.equal(record.outcome, "auto");
    assert.equal(record.autoMode, mode);
    assert.deepEqual(record.items, [
      {
        kind: "toolApproval",
        action: "Get deployed artifact",
        decision: "allowedOnce",
      },
    ]);
  }
  const declined = toolRecord("Cancel", "auto-mode:readOnly");
  assert.equal((declined.items[0] as any).decision, "declined");

  const chat = toolRecord(ALLOW_FOR_CHAT, "user");
  assert.equal(chat.outcome, "answered");
  assert.equal("autoMode" in chat, false);
  assert.equal((chat.items[0] as any).decision, "allowedChat");

  // The existing recommended-option timeout stays unchanged.
  const recommended = toolRecord("Allow", "auto-recommended");
  assert.equal(recommended.outcome, "auto");
  assert.equal("autoMode" in recommended, false);
});

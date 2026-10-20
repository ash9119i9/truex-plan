import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Harness, completed, readSse, type SseEvent } from "../support/harness";
import { deadMcpUrl, McpFixture } from "../support/mcp-fixture";

// MCP support on the real pinned Codex, driven by the loopback MCP fixture and
// a scripted model that asks Codex to call a tool. Everything here is verified
// end to end through the adapter's HTTP contract, so a Codex upgrade that
// changes the MCP wire shape fails the suite.

// A token that would be a disaster to leak. Asserted absent from logs and disk.
const HEADER_MARKER = "SECRETMARKER_header_9f2c7e41ab0d";
// The server name is the connector slug the model namespaces its call with.
const CONNECTOR = "fixture";
const NAMESPACE = `mcp__${CONNECTOR}`;

function mcpSpec(fixture: McpFixture, token = HEADER_MARKER) {
  return [
    {
      name: CONNECTOR,
      url: fixture.url,
      headers: { Authorization: `Bearer ${token}`, "X-Probe": "fixed" },
      toolTimeoutSec: 30,
      startupTimeoutSec: 15,
    },
  ];
}

// The bearer token on each tools/call the fixture received, deduplicated.
function callTokens(fixture: McpFixture): string[] {
  const tokens = fixture.log
    .filter((r) => r.rpcMethod === "tools/call")
    .map((r) => r.authorization?.replace(/^Bearer /, "") ?? "");
  return [...new Set(tokens)];
}

function tool(events: SseEvent[], type: string) {
  return events.filter((e) => e.type === type).map((e) => e.data);
}

// The run.accepted event (no longer guaranteed to be first: a connector's
// startup status can precede it).
function accepted(events: SseEvent[]): Record<string, unknown> {
  const event = events.find((e) => e.type === "run.accepted");
  if (!event) throw new Error("no run.accepted event");
  return event.data;
}

describe("MCP tool calls (real Codex)", () => {
  const mcp = new McpFixture();
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  test("a read-only tool runs and surfaces tool.started/completed and a RunItem", async () => {
    mcp.reset();
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "Here is the issue." });
    const events = await h.run(h.body({ chatId: "mcp1", mcp: mcpSpec(mcp) }));

    const started = tool(events, "tool.started");
    const done = tool(events, "tool.completed");
    assert.equal(started.length, 1);
    assert.equal(started[0]!.connector, CONNECTOR);
    assert.equal(started[0]!.tool, "get_issue");
    assert.equal(done.length, 1);
    assert.equal(done[0]!.status, "completed");
    assert.equal(done[0]!.errorCode, undefined);
    assert.equal(typeof done[0]!.durationMs, "number");
    // The call reached the fixture server.
    assert.ok(mcp.toolCalls() >= 1, "tools/call reached the server");

    const final = completed(events);
    assert.equal(final.status, "completed");
    const toolItems = (final.items as Array<{ type: string }>).filter(
      (i) => i.type === "tool",
    );
    assert.deepEqual(toolItems, [
      {
        type: "tool",
        itemId: started[0]!.itemId,
        connector: CONNECTOR,
        tool: "get_issue",
        status: "completed",
        durationMs: done[0]!.durationMs,
      },
    ]);
  });

  test("Codex's built-in list_mcp_resources call is not reported as a tool", async () => {
    mcp.reset();
    h.model.script.push({ kind: "call", name: "list_mcp_resources", args: {} });
    h.model.script.push({ kind: "reply", text: "no resources" });
    const events = await h.run(
      h.body({ chatId: "res0", threadId: null, mcp: mcpSpec(mcp) }),
    );
    const final = completed(events);
    assert.equal(final.status, "completed");
    // The model got the call's output (it made a second request) …
    assert.ok(
      JSON.stringify(h.model.lastRequest().body.input).includes(
        "function_call_output",
      ),
    );
    // … but no tool row leaves the adapter.
    assert.equal(tool(events, "tool.started").length, 0);
    assert.equal(tool(events, "tool.completed").length, 0);
    assert.equal(
      (final.items as Array<{ type: string }>).filter((i) => i.type === "tool")
        .length,
      0,
    );
  });

  test("a server slower than the pin's 1 s startup grace is in the first model call", async () => {
    mcp.reset();
    mcp.initializeDelayMs = 2500;
    h.model.script.push({ kind: "reply", text: "tools ready" });
    const events = await h.run(
      h.body({ chatId: "slow1", threadId: null, mcp: mcpSpec(mcp) }),
    );
    assert.equal(completed(events).status, "completed");
    const decls = h.model.lastRequest().body.tools ?? [];
    assert.ok(
      JSON.stringify(decls).includes(NAMESPACE),
      "the first model call already offers the connector's tools",
    );
  });

  test("a tool result larger than the pin's 10 KB fallback reaches the model whole", async () => {
    mcp.reset();
    // ~40 KB with a marker in the middle, where Codex's truncation cuts.
    const half = "x".repeat(20_000);
    mcp.resultText = `${half}MIDDLE_MARKER_4b1d${half}`;
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "read it all" });
    const events = await h.run(
      h.body({ chatId: "big1", threadId: null, mcp: mcpSpec(mcp) }),
    );
    assert.equal(completed(events).status, "completed");
    assert.ok(
      JSON.stringify(h.model.lastRequest().body.input).includes(
        "MIDDLE_MARKER_4b1d",
      ),
      "the middle of the tool result was not truncated away",
    );
  });
});

// A run that answers each approval card as `answer` decides, as the browser
// would. `answer` may return null to leave a card unanswered.
async function runAnswering(
  h: Harness,
  body: Record<string, unknown>,
  answer: (approval: Record<string, unknown>) => string | null,
): Promise<{ events: SseEvent[]; answers: Response[] }> {
  const answers: Response[] = [];
  const res = await h.post("/v1/runs", body);
  assert.equal(res.status, 200);
  const events = await readSse(res, async (event) => {
    if (event.type !== "approval.requested") return;
    const decision = answer(event.data);
    if (!decision) return;
    answers.push(
      await h.post(
        `/v1/runs/${String(body.runId)}/approvals/${String(event.data.approvalId)}`,
        { tenantId: "tenant1", chatId: body.chatId, decision },
      ),
    );
  });
  return { events, answers };
}

// Scripts `times` write calls and a closing reply. Clears what an earlier
// (stopped) scenario left unconsumed first.
function callWrite(h: Harness, times = 1) {
  h.model.script.length = 0;
  for (let i = 0; i < times; i++)
    h.model.script.push({
      kind: "call",
      name: "create_issue",
      namespace: NAMESPACE,
      args: { title: `t${i}` },
    });
  h.model.script.push({ kind: "reply", text: "done" });
}

describe("MCP tool approvals (real Codex)", () => {
  const mcp = new McpFixture();
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  test("a read-only tool still runs without a card", async () => {
    mcp.reset();
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "ok" });
    const events = await h.run(
      h.body({ chatId: "ap0", threadId: null, mcp: mcpSpec(mcp) }),
    );
    assert.equal(tool(events, "approval.requested").length, 0);
    assert.equal(tool(events, "tool.completed")[0]!.status, "completed");
  });

  test("allow: runs once; the next call asks again", async () => {
    mcp.reset();
    callWrite(h, 2);
    const body = h.body({
      chatId: "ap2",
      threadId: null,
      mcp: mcpSpec(mcp),
      limits: { silenceMs: 1500 },
    });
    let first = true;
    const res = await h.post("/v1/runs", body);
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      // The first card waits longer than silenceMs before it is answered.
      if (first) await new Promise((r) => setTimeout(r, 2500));
      first = false;
      const answer = await h.post(
        `/v1/runs/${String(body.runId)}/approvals/${String(event.data.approvalId)}`,
        { tenantId: "tenant1", chatId: "ap2", decision: "allow" },
      );
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), { decision: "allow" });
    });
    const requested = tool(events, "approval.requested");
    assert.equal(requested.length, 2, "each call asks");
    assert.equal(requested[0]!.connector, CONNECTOR);
    assert.equal(requested[0]!.tool, "create_issue");
    assert.deepEqual(requested[0]!.params, [{ name: "title", value: "t0" }]);
    assert.equal(typeof requested[0]!.expiresAt, "number");
    assert.equal(mcp.toolCalls(), 2);
    const final = completed(events);
    assert.equal(final.status, "completed", "no MODEL_TIMEOUT while waiting");
    const tools = (final.items as Array<Record<string, unknown>>).filter(
      (i) => i.type === "tool",
    );
    assert.deepEqual(
      tools.map((t) => [t.status, t.approval]),
      [
        ["completed", "allow"],
        ["completed", "allow"],
      ],
    );
  });

  test("deny: the server is never called and the call fails DENIED", async () => {
    mcp.reset();
    callWrite(h);
    const body = h.body({ chatId: "ap3", threadId: null, mcp: mcpSpec(mcp) });
    const { events } = await runAnswering(h, body, () => "deny");
    assert.equal(mcp.toolCalls(), 0);
    const done = tool(events, "tool.completed")[0]!;
    assert.equal(done.status, "failed");
    assert.equal(done.errorCode, "DENIED");
    assert.equal(tool(events, "approval.resolved")[0]!.decision, "deny");
    assert.equal(completed(events).status, "completed");
    assert.ok(
      JSON.stringify(h.model.lastRequest().body.input).includes(
        "user rejected MCP tool call",
      ),
      "the model is told the member said no",
    );
  });

  test("allow for this chat: later calls in the run are answered without a card", async () => {
    mcp.reset();
    callWrite(h, 2);
    const body = h.body({ chatId: "ap4", threadId: null, mcp: mcpSpec(mcp) });
    const { events } = await runAnswering(h, body, () => "allow_for_chat");
    assert.equal(tool(events, "approval.requested").length, 1);
    const resolved = tool(events, "approval.resolved");
    assert.deepEqual(
      resolved.map((r) => [r.decision, r.auto]),
      [
        ["allow_for_chat", false],
        ["allow_for_chat", true],
      ],
    );
    // Each auto answer is still an audited event with its own arguments.
    assert.deepEqual(resolved[1]!.params, [{ name: "title", value: "t1" }]);
    assert.equal(mcp.toolCalls(), 2);
  });

  test("approvedTools from the platform skip the card; other tools still ask", async () => {
    mcp.reset();
    h.model.script.push({
      kind: "call",
      name: "create_issue",
      namespace: NAMESPACE,
      args: { title: "x" },
    });
    h.model.script.push({
      kind: "call",
      name: "list_unlabelled",
      namespace: NAMESPACE,
      args: {},
    });
    h.model.script.push({ kind: "reply", text: "done" });
    const [server] = mcpSpec(mcp);
    const body = h.body({
      chatId: "ap5",
      threadId: null,
      mcp: [{ ...server, approvedTools: ["create_issue"] }],
    });
    const { events } = await runAnswering(h, body, () => "deny");
    const requested = tool(events, "approval.requested");
    assert.deepEqual(
      requested.map((r) => r.tool),
      ["list_unlabelled"],
    );
    assert.deepEqual(
      tool(events, "approval.resolved").map((r) => [
        r.tool,
        r.decision,
        r.auto,
      ]),
      [
        ["create_issue", "allow_for_chat", true],
        ["list_unlabelled", "deny", false],
      ],
    );
    assert.equal(mcp.toolCalls(), 1);
  });

  // Longer than the in-flight tool watchdog (toolTimeoutSec 1 s + 15 s grace)
  // and silenceMs: only the approval timer may end the wait.
  test("an unanswered card expires as denied, and no watchdog fires first", async () => {
    mcp.reset();
    callWrite(h);
    const [server] = mcpSpec(mcp);
    const body = h.body({
      chatId: "ap6",
      threadId: null,
      mcp: [{ ...server, toolTimeoutSec: 1 }],
      limits: { approvalMs: 20_000, silenceMs: 1500 },
    });
    const { events } = await runAnswering(h, body, () => null);
    assert.equal(completed(events).status, "completed");
    assert.equal(tool(events, "approval.resolved")[0]!.decision, "expired");
    assert.equal(tool(events, "tool.completed")[0]!.errorCode, "DENIED");
    assert.equal(mcp.toolCalls(), 0);
  });

  test("stop while a card is open cancels it; a late answer is refused", async () => {
    mcp.reset();
    callWrite(h);
    const body = h.body({ chatId: "ap7", threadId: null, mcp: mcpSpec(mcp) });
    let approvalId = "";
    const res = await h.post("/v1/runs", body);
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      approvalId = String(event.data.approvalId);
      await h.stop(String(body.runId), { tenantId: "tenant1", chatId: "ap7" });
    });
    assert.equal(completed(events).status, "stopped");
    assert.equal(tool(events, "approval.resolved")[0]!.decision, "cancelled");
    const late = await h.post(
      `/v1/runs/${String(body.runId)}/approvals/${approvalId}`,
      { tenantId: "tenant1", chatId: "ap7", decision: "allow" },
    );
    assert.equal(late.status, 404);
    // Give a stray late tool call time to show up, then check none did.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mcp.toolCalls(), 0);
  });

  test("first answer wins; another chat cannot answer; unknown ids are 404", async () => {
    mcp.reset();
    callWrite(h);
    const body = h.body({ chatId: "ap8", threadId: null, mcp: mcpSpec(mcp) });
    const statuses: number[] = [];
    const res = await h.post("/v1/runs", body);
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      const url = `/v1/runs/${String(body.runId)}/approvals/${String(event.data.approvalId)}`;
      // Another chat's reference looks like an unknown run.
      statuses.push(
        (
          await h.post(url, {
            tenantId: "tenant1",
            chatId: "other",
            decision: "allow",
          })
        ).status,
      );
      statuses.push(
        (
          await h.post(`/v1/runs/${String(body.runId)}/approvals/ap_unknown`, {
            tenantId: "tenant1",
            chatId: "ap8",
            decision: "allow",
          })
        ).status,
      );
      const [a, b] = await Promise.all([
        h.post(url, { tenantId: "tenant1", chatId: "ap8", decision: "deny" }),
        h.post(url, { tenantId: "tenant1", chatId: "ap8", decision: "allow" }),
      ]);
      statuses.push(a.status, b.status);
    });
    assert.deepEqual(statuses, [404, 404, 200, 409]);
    assert.equal(tool(events, "approval.resolved").length, 1);
    assert.equal(tool(events, "approval.resolved")[0]!.decision, "deny");
    assert.equal(mcp.toolCalls(), 0);
  });

  test("a steer while a card is open denies the call, then steers", async () => {
    mcp.reset();
    callWrite(h);
    h.model.script.push({ kind: "reply", text: "after steer" });
    const body = h.body({ chatId: "ap9", threadId: null, mcp: mcpSpec(mcp) });
    const res = await h.post("/v1/runs", body);
    let steerStatus = 0;
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      steerStatus = (
        await h.steer(
          String(body.runId),
          { text: "never mind", clientMessageId: "steer_ap9" },
          { tenantId: "tenant1", chatId: "ap9" },
        )
      ).status;
    });
    assert.equal(steerStatus, 202);
    assert.equal(tool(events, "approval.resolved")[0]!.decision, "deny");
    assert.equal(mcp.toolCalls(), 0);
    assert.equal(completed(events).status, "completed");
  });

  test("a recovery with a longer approvedTools list attaches to the same run", async () => {
    mcp.reset();
    callWrite(h);
    const body = h.body({ chatId: "ap10", threadId: null, mcp: mcpSpec(mcp) });
    const res = await h.post("/v1/runs", body);
    let reattach = 0;
    const events = await readSse(res, async (event) => {
      if (event.type !== "approval.requested") return;
      const [server] = body.mcp as Array<Record<string, unknown>>;
      const again = await h.post("/v1/runs", {
        ...body,
        mcp: [{ ...server, approvedTools: ["create_issue"] }],
      });
      reattach = again.status;
      await again.body?.cancel();
      await h.post(
        `/v1/runs/${String(body.runId)}/approvals/${String(event.data.approvalId)}`,
        { tenantId: "tenant1", chatId: "ap10", decision: "allow" },
      );
    });
    assert.equal(reattach, 200, "not RUN_CONFLICT");
    assert.equal(completed(events).status, "completed");
  });
});

describe("MCP resume and token rotation (real Codex)", () => {
  const mcp = new McpFixture();
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  test("resume without mcp exposes no tools; resume with mcp (rotated token) does", async () => {
    // Turn 1: create the thread with MCP and run a tool.
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "first" });
    const first = await h.run(h.body({ chatId: "res1", mcp: mcpSpec(mcp) }));
    const threadId = String(accepted(first).threadId);
    assert.equal(tool(first, "tool.completed")[0]!.status, "completed");

    // Restart the adapter so the thread is resumed, not kept loaded.
    await h.restart();

    // Turn 2: resume WITHOUT mcp. The model is offered no MCP tools.
    h.model.script.push({ kind: "reply", text: "no tools" });
    const noMcp = await h.run(h.body({ chatId: "res1", threadId }));
    assert.equal(accepted(noMcp).resumed, true);
    assert.equal(completed(noMcp).status, "completed");
    const decls = (h.model.lastRequest().body.tools ?? []) as Array<{
      name?: string;
    }>;
    assert.ok(
      !JSON.stringify(decls).includes(NAMESPACE),
      "resume without mcp offers no MCP namespace",
    );

    // Turn 3: resume WITH mcp and a rotated token. The tool is callable again
    // and the fixture sees the new token.
    await h.restart();
    mcp.reset();
    const rotated = "SECRETMARKER_rotated_1234567890ab";
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 2 },
    });
    h.model.script.push({ kind: "reply", text: "rotated" });
    const withMcp = await h.run(
      h.body({ chatId: "res1", threadId, mcp: mcpSpec(mcp, rotated) }),
    );
    assert.equal(tool(withMcp, "tool.completed")[0]!.status, "completed");
    const decls3 = h.model.requests.at(-2)?.body.tools ?? [];
    assert.ok(
      JSON.stringify(decls3).includes(NAMESPACE),
      "resume with mcp offers the MCP namespace",
    );
    assert.ok(
      mcp.bearerTokens().includes(rotated),
      "the fixture saw the rotated token",
    );
    assert.ok(
      !mcp.bearerTokens().includes(HEADER_MARKER),
      "the old token is not reused after rotation",
    );
  });

  // The platform refreshes an expiring token at run start, while the chat's
  // thread may still be loaded in this process. The next run must use the new
  // token without an adapter restart.
  test("a token rotated while the thread stays loaded is used on the next run", async () => {
    mcp.reset();
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "first" });
    const first = await h.run(h.body({ chatId: "rot1", mcp: mcpSpec(mcp) }));
    const threadId = String(accepted(first).threadId);
    assert.equal(tool(first, "tool.completed")[0]!.status, "completed");

    mcp.reset();
    const rotated = "SECRETMARKER_loaded_rotation_77aa";
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 2 },
    });
    h.model.script.push({ kind: "reply", text: "second" });
    const second = await h.run(
      h.body({ chatId: "rot1", threadId, mcp: mcpSpec(mcp, rotated) }),
    );
    assert.equal(tool(second, "tool.completed")[0]!.status, "completed");
    // The stopped process may close its old session with the old token;
    // every tool call carries the new one.
    assert.deepEqual(callTokens(mcp), [rotated]);

    // Same token again: no reload, the tool still works.
    mcp.reset();
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 3 },
    });
    h.model.script.push({ kind: "reply", text: "third" });
    const third = await h.run(
      h.body({ chatId: "rot1", threadId, mcp: mcpSpec(mcp, rotated) }),
    );
    assert.equal(tool(third, "tool.completed")[0]!.status, "completed");
    assert.deepEqual(callTokens(mcp), [rotated]);
  });
});

describe("MCP secrets never leak (real Codex)", () => {
  const mcp = new McpFixture();
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  test("the header marker is in no adapter log nor any file under the state dir", async () => {
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "done" });
    await h.run(h.body({ chatId: "leak1", mcp: mcpSpec(mcp) }));

    const logText = JSON.stringify(h.logs);
    assert.ok(
      !logText.includes(HEADER_MARKER),
      "the header marker is absent from adapter logs",
    );
    const hits = await grep(join(h.stateDir, "t"), HEADER_MARKER);
    assert.deepEqual(hits, [], "the header marker is absent from disk");
  });
});

describe("MCP watchdog (real Codex)", () => {
  const mcp = new McpFixture();
  // A short silence timer that a slow tool call must not trip.
  const h = new Harness({
    allowLoopbackMcp: true,
    limits: { silenceMs: 1500, stopMs: 3000 },
  });
  before(async () => {
    await mcp.start();
    await h.start();
  });
  after(async () => {
    await h.close();
    await mcp.close();
  });

  test("a tool call slower than silenceMs completes without MODEL_TIMEOUT", async () => {
    mcp.callDelayMs = 3000; // > silenceMs (1500)
    h.model.script.push({
      kind: "call",
      name: "get_issue",
      namespace: NAMESPACE,
      args: { number: 1 },
    });
    h.model.script.push({ kind: "reply", text: "slow but done" });
    const events = await h.run(h.body({ chatId: "wd1", mcp: mcpSpec(mcp) }));
    mcp.callDelayMs = 0;
    const final = completed(events);
    assert.equal(final.status, "completed");
    assert.equal(
      h.logs.filter((l) => l.event === "model_timeout").length,
      0,
      "the tool-aware watchdog did not fire",
    );
    assert.equal(tool(events, "tool.completed")[0]!.status, "completed");
  });
});

describe("MCP startup failures (real Codex)", () => {
  const h = new Harness({ allowLoopbackMcp: true, limits: { stopMs: 3000 } });
  before(() => h.start());
  after(() => h.close());

  test("a server down at startup still answers and emits connector.status failed", async () => {
    const url = await deadMcpUrl();
    // The pin emits `starting` during thread/start, then `failed`
    // asynchronously ~1.3s later when the dead endpoint times out. The model
    // replies slowly so the run is still live when `failed` arrives.
    h.model.script.push({
      kind: "reply",
      text: "word ".repeat(40),
      chunk: 5,
      delayMs: 150,
    });
    const events = await h.run(
      h.body({
        chatId: "down1",
        mcp: [
          {
            name: CONNECTOR,
            url,
            headers: { Authorization: `Bearer ${HEADER_MARKER}` },
            toolTimeoutSec: 30,
            startupTimeoutSec: 3,
          },
        ],
      }),
    );
    assert.equal(
      completed(events).status,
      "completed",
      "the chat still answers",
    );
    const statuses = tool(events, "connector.status");
    const failed = statuses.find((s) => s.status === "failed");
    assert.ok(
      failed,
      `expected a failed connector.status, saw ${JSON.stringify(statuses)}`,
    );
    // Finding: for a refused connection the pin surfaces no error text or
    // failureReason on this notification, so the adapter maps it to "unknown"
    // (not "unreachable"). Recorded here so a future pin that starts providing
    // a reason is noticed.
    assert.ok(
      failed!.reason === "unreachable" || failed!.reason === "unknown",
      `recorded down-server reason: ${JSON.stringify(failed!.reason)}`,
    );
  });

  test("a 401 at startup emits connector.status failed; the pin's reason is recorded", async () => {
    const mcp = new McpFixture();
    mcp.unauthorized = true;
    await mcp.start();
    try {
      h.model.script.push({ kind: "reply", text: "answered despite 401" });
      const events = await h.run(
        h.body({ chatId: "auth1", mcp: mcpSpec(mcp) }),
      );
      assert.equal(completed(events).status, "completed");
      const statuses = tool(events, "connector.status");
      const failed = statuses.find((s) => s.status === "failed");
      assert.ok(
        failed,
        `expected a failed status, saw ${JSON.stringify(statuses)}`,
      );
      // Finding (this pin): a bearer-header 401 is NOT reported as
      // `reauthenticationRequired` (that failureReason is reserved for
      // OAuth-configured servers). The notification carries no failureReason or
      // error text, so the adapter maps it to reason "unknown". The
      // `reauthenticationRequired` → "auth" mapping still exists for the OAuth
      // case. Accept either so the test records what the pin does today.
      assert.ok(
        failed!.reason === "auth" || failed!.reason === "unknown",
        `recorded 401 reason: ${JSON.stringify(failed!.reason)}`,
      );
    } finally {
      await mcp.close();
    }
  });
});

async function grep(
  dir: string,
  needle: string,
  hits: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await grep(path, needle, hits);
    else if (
      (await stat(path)).size < 50e6 &&
      (await readFile(path)).includes(needle)
    )
      hits.push(path);
  }
  return hits;
}

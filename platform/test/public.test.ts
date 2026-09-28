import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicEvent,
  publicGoal,
  publicSession,
  PublicEventStream,
  toolAction,
  publicApproval,
} from "../src/public";
import { subAgentOptions } from "../src/service";

test("web, documents and collaboration emit public activity without raw arguments", () => {
  for (const type of [
    "webSearch",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
  ]) {
    for (const eventType of ["item.started", "item.completed"]) {
      const event = publicEvent({
        type: eventType,
        data: {
          item: {
            type,
            arguments: { secret: "hidden" },
            prompt: "private",
            tool: "/host/path",
          },
        },
      });
      assert.equal(event.type, "activity.updated");
      assert.ok(event.data.label);
      assert.doesNotMatch(JSON.stringify(event), /hidden|private|host/);
    }
  }
});

test("provider rate limits are actionable without exposing raw diagnostics", () => {
  for (const codexErrorInfo of [
    { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    { httpConnectionFailed: { httpStatusCode: 429 } },
    { responseStreamConnectionFailed: { httpStatusCode: 429 } },
    { responseStreamDisconnected: { httpStatusCode: 429 } },
  ]) {
    const event = publicEvent({
      type: "error",
      data: {
        error: {
          codexErrorInfo,
          message: "private provider diagnostics",
          additionalDetails: "secret credentials",
        },
      },
    });
    assert.equal(event.data.code, "PROVIDER_RATE_LIMITED");
    assert.equal(event.data.reason, "rateLimited");
    assert.equal(event.data.httpStatus, 429);
    assert.match(event.data.message, /rate limit/);
    assert.doesNotMatch(JSON.stringify(event), /private|secret/);
  }
  const fallback = publicEvent({
    type: "error",
    data: { error: { message: "private diagnostics 429" } },
  }).data;
  assert.equal(fallback.code, "RUNTIME_FAILED");
  assert.doesNotMatch(fallback.message, /private|429/);
});

test("public boundary drops raw runtime data and unknown events, including nested completed-turn items", () => {
  const secret = "/Users/internal/repo truex_models command_output";
  for (const type of [
    "runtime.event",
    "diff.updated",
    "unknown",
    "thread.started",
    "item.started",
    "item.completed",
  ])
    assert.equal(
      publicEvent({
        type,
        data: {
          item: { type: "commandExecution", command: secret },
          delta: secret,
        },
      }),
      null,
    );
  const completion = publicEvent({
    type: "turn.completed",
    threadId: secret,
    data: {
      turn: { status: "completed", items: [secret], error: secret },
      raw: secret,
    },
  });
  assert.ok(!JSON.stringify(completion).includes(secret));
  const snapshot = publicEvent({
    type: "snapshot",
    data: {
      state: { kind: "idle", cwd: secret },
      messages: [{ id: "m", text: "Business answer", raw: secret }],
      pending: [
        {
          method: "item/commandExecution/requestApproval",
          detail: { command: secret },
        },
      ],
      diff: secret,
      plan: [secret],
      runtime: secret,
    },
  });
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.equal(snapshot.data.messages[0].text, "Business answer");
  assert.ok(
    !JSON.stringify(
      publicSession({
        _id: "s",
        cwd: secret,
        agentCoreHost: secret,
        threadId: secret,
      } as any),
    ).includes(secret),
  );
});

test("SSE projection handles byte-split Unicode, replay and heartbeat without forwarding hidden data", () => {
  const source = `: heartbeat\n\nid: g:1\ndata: ${JSON.stringify({ type: "runtime.event", cursor: "g:1", data: { secret: "hidden" } })}\n\nid: g:2\ndata: ${JSON.stringify({ type: "message.delta", cursor: "g:2", data: { delta: "Hello 🌏", command: "hidden" } })}\n\n`;
  const stream = new PublicEventStream();
  let output = "";
  for (const byte of new TextEncoder().encode(source))
    output += stream.push(new Uint8Array([byte]));
  assert.match(output, /Hello 🌏/);
  assert.match(output, /id: g:2/);
  assert.match(output, /heartbeat/);
  assert.doesNotMatch(output, /hidden|runtime.event|g:1|command/);
});

test("thinking, plans and timings survive live events and snapshots without exposing runtime metadata", () => {
  const extra = {
    cwd: "/private/repo",
    command: "cat .env",
    modelProvider: "codex",
    secret: "internal",
  };
  const timing = {
    ...extra,
    turnId: "t",
    totalMs: 1200,
    ttftMs: 150,
    streamMs: 900,
    status: "completed",
  };
  const reasoning = publicEvent({
    type: "reasoning.delta",
    itemId: "r",
    turnId: "t",
    data: {
      ...extra,
      delta: "Checking the order status.",
      method: "item/reasoning/summaryTextDelta",
    },
  });
  assert.equal(reasoning.data.delta, "Checking the order status.");
  const plan = publicEvent({
    type: "plan.updated",
    data: {
      ...extra,
      plan: [{ ...extra, step: "Check order status", status: "inProgress" }],
    },
  });
  assert.deepEqual(plan.data.plan, [
    { step: "Check order status", status: "inProgress" },
  ]);
  const final = publicEvent({
    type: "turn.completed",
    data: { ...extra, timing, turn: { status: "completed", items: [extra] } },
  });
  assert.equal(final.data.timing.totalMs, 1200);
  const snapshot = publicEvent({
    type: "snapshot",
    data: {
      state: { kind: "idle" },
      plan: plan.data.plan,
      timings: [timing],
      thinking: [
        { ...extra, id: "r", summary: "Checked orders", raw: "", done: true },
      ],
    },
  });
  assert.equal(snapshot.data.timings[0].ttftMs, 150);
  assert.equal(snapshot.data.thinking[0].summary, "Checked orders");
  for (const output of [reasoning, plan, final, snapshot])
    assert.doesNotMatch(
      JSON.stringify(output),
      /private\/repo|cat .env|codex|internal|modelProvider/,
    );
});

test("goal projection keeps only public fields and normalizes status", () => {
  assert.deepEqual(
    publicGoal({
      threadId: "thread_private",
      objective: "Report",
      status: "unexpected",
      tokenBudget: 1000,
      tokensUsed: 50,
      timeUsedSeconds: 12,
      createdAt: 1,
      updatedAt: 2,
      internal: "hidden",
    }),
    {
      objective: "Report",
      status: "active",
      tokenBudget: 1000,
      tokensUsed: 50,
      timeUsedSeconds: 12,
      createdAt: 1,
      updatedAt: 2,
    },
  );
  assert.equal(publicGoal(null), null);
  const updated = publicEvent({
    type: "goal.updated",
    data: {
      goal: {
        threadId: "thread_private",
        objective: "Report",
        status: "complete",
      },
    },
  });
  assert.equal(updated.data.goal.status, "complete");
  assert.doesNotMatch(JSON.stringify(updated), /thread_private/);
  assert.deepEqual(
    publicEvent({ type: "goal.cleared", data: { threadId: "thread_private" } })
      .data,
    {},
  );
});
test("relay keeps a healthy stream open when a frame exceeds the socket buffer", async (t) => {
  const { createServer } = await import("node:http");
  const { relay } = await import("../src/public");
  const frame = (seq: number, text: string) =>
    new TextEncoder().encode(
      `id: g:${seq}\ndata: ${JSON.stringify({ type: "message.final", seq, cursor: `g:${seq}`, turnId: "turn", itemId: "answer", data: { text, messageIndex: 0 } })}\n\n`,
    );
  async function* upstream() {
    yield frame(1, "x".repeat(256 * 1024));
    await new Promise((r) => setTimeout(r, 20));
    yield frame(2, "done");
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    void relay(upstream(), res, new PublicEventStream()).then(() => res.end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}`,
  );
  const body = await response.text();
  const events = body
    .split("\n\n")
    .map((f) => f.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((d) => JSON.parse(d!.slice(5)));
  assert.deepEqual(
    events.map((e) => [e.seq, e.data.text.length]),
    [
      [1, 256 * 1024],
      [2, 4],
    ],
  );
});
test("input requests expose question flags only as real booleans", () => {
  const event = publicEvent({
    type: "approval.requested",
    seq: 1,
    cursor: "g:1",
    data: {
      requestId: "r1",
      method: "item/tool/requestUserInput",
      expiresAt: "2030-01-01T00:00:00.000Z",
      detail: {
        questions: [
          {
            id: "a",
            question: "Allow?",
            isSecret: "[REDACTED]",
            isOther: "[REDACTED]",
          },
          { id: "b", question: "Token?", isSecret: true, isOther: false },
        ],
      },
    },
  });
  assert.deepEqual(
    event.data.detail.questions.map((q: any) => [q.id, q.isSecret, q.isOther]),
    [
      ["a", false, false],
      ["b", true, false],
    ],
  );
});
test("MCP tool approvals hide server and tool ids behind a friendly action", () => {
  const event = publicEvent({
    type: "approval.requested",
    seq: 1,
    cursor: "g:1",
    data: {
      requestId: "r1",
      method: "item/tool/requestUserInput",
      expiresAt: "2030-01-01T00:00:00.000Z",
      detail: {
        questions: [
          {
            id: "mcp_tool_call_approval_call_1",
            header: "Approve app tool call?",
            question:
              'Allow the btp MCP server to run tool "get_deployed_artifact"?',
            isOther: false,
            isSecret: false,
            options: [
              { label: "Allow", description: "Run the tool and continue." },
              { label: "Allow for this session", description: "x" },
              { label: "Cancel", description: "Cancel this tool call." },
            ],
          },
        ],
      },
    },
  });
  const q = event.data.detail.questions[0];
  assert.equal(q.kind, "toolApproval");
  assert.equal(q.action, "Get deployed artifact");
  assert.deepEqual(
    q.options.map((o: any) => o.label),
    ["Allow", "Allow for this session", "Cancel"],
  );
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /btp|get_deployed_artifact|MCP/);
});
test("tool approvals with unrecognised wording omit the action", () => {
  const event = publicEvent({
    type: "approval.requested",
    seq: 1,
    cursor: "g:1",
    data: {
      requestId: "r1",
      method: "item/tool/requestUserInput",
      expiresAt: "2030-01-01T00:00:00.000Z",
      detail: {
        questions: [
          {
            id: "mcp_tool_call_approval_2",
            question: "Custom server text mentioning secret_server",
            options: [{ label: "Allow", description: "d" }],
          },
        ],
      },
    },
  });
  const q = event.data.detail.questions[0];
  assert.equal(q.action, undefined);
  assert.doesNotMatch(JSON.stringify(event), /secret_server/);
});
test("tool actions read as plain words", () => {
  assert.equal(toolAction("getDeployedArtifact"), "Get deployed artifact");
  assert.equal(toolAction("mcp__btp__list-iflows"), "List iflows");
  assert.equal(toolAction("___"), "");
});

const approvalDetail = {
  turnId: "turn_1",
  questions: [
    {
      id: "mcp_tool_call_approval_1",
      question: 'Allow the btp MCP server to run tool "get_deployed_artifact"?',
      options: [{ label: "Allow" }, { label: "Allow for this session" }],
    },
  ],
};
test("resolved tool approvals become an audit record without raw ids", () => {
  const event = publicEvent({
    type: "approval.resolved",
    seq: 2,
    cursor: "g:2",
    at: "2030-01-01T00:00:00.000Z",
    turnId: "turn_1",
    data: {
      requestId: "r1",
      method: "item/tool/requestUserInput",
      detail: approvalDetail,
      result: {
        answers: {
          mcp_tool_call_approval_1: { answers: ["Allow for this session"] },
        },
      },
      reason: "user",
    },
  });
  assert.deepEqual(event.data.audit, {
    requestId: "r1",
    at: "2030-01-01T00:00:00.000Z",
    turnId: "turn_1",
    outcome: "answered",
    items: [
      {
        kind: "toolApproval",
        action: "Get deployed artifact",
        decision: "allowedSession",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(event), /btp|get_deployed_artifact/);
});
test("audit records mark timeouts and never repeat secret answers", () => {
  const expired = publicApproval({
    requestId: "r1",
    method: "item/tool/requestUserInput",
    detail: approvalDetail,
    result: { answers: {} },
    reason: "expired",
  });
  assert.equal(expired!.outcome, "expired");
  assert.equal((expired!.items[0] as any).decision, "expired");
  const secret = publicApproval({
    requestId: "r2",
    method: "item/tool/requestUserInput",
    detail: {
      questions: [
        { id: "t", question: "API token?", isSecret: true },
        { id: "n", question: "Name?" },
      ],
    },
    result: {
      answers: { t: { answers: ["sk-live"] }, n: { answers: ["Ada"] } },
    },
    reason: "user",
  });
  assert.deepEqual(secret!.items, [
    { kind: "question", question: "API token?", secret: true },
    { kind: "question", question: "Name?", answer: "Ada" },
  ]);
  assert.doesNotMatch(JSON.stringify(secret), /sk-live/);
  assert.equal(
    publicApproval({ method: "item/commandExecution/requestApproval" }),
    null,
  );
});

test("sub-agent events keep allowlisted fields and a readable label", () => {
  const agent = {
    threadId: "child-1",
    path: "/root/researcher",
    nickname: "researcher",
    role: "explorer",
    depth: 1,
    status: "running",
    task: "Find the pricing page",
    startedAt: "2026-09-28T10:00:00.000Z",
    prompt: "raw spawn prompt",
    arguments: { secret: "hidden" },
  };
  const spawned = publicEvent({
    type: "subagent.spawned",
    data: { agent, tool: "spawnAgent", callStatus: "inProgress", raw: 1 },
  });
  assert.equal(spawned.data.label, "Spawned Researcher");
  assert.equal(spawned.data.tool, "spawnAgent");
  assert.deepEqual(Object.keys(spawned.data.agent).sort(), [
    "depth",
    "nickname",
    "path",
    "role",
    "startedAt",
    "status",
    "task",
    "threadId",
  ]);
  assert.ok(!JSON.stringify(spawned).includes("hidden"));
  assert.ok(!JSON.stringify(spawned).includes("raw spawn prompt"));

  const done = publicEvent({
    type: "subagent.completed",
    data: {
      agent: { ...agent, status: "completed", endedAt: "2026-09-28T10:01:00Z" },
    },
  });
  assert.equal(done.data.label, "Researcher finished");
  assert.equal(done.data.agent.endedAt, "2026-09-28T10:01:00Z");

  const bogus = publicEvent({
    type: "subagent.status",
    data: { agent: { ...agent, status: "exploded", tool: "shell" } },
  });
  assert.equal(bogus.data.agent.status, "running");
  assert.equal(bogus.data.tool, undefined);

  assert.equal(
    publicEvent({
      type: "subagent.status",
      data: { agent: { threadId: "../x" } },
    }),
    null,
  );
});

test("sub-agent stream events pass only known kinds and fields", () => {
  const e = publicEvent({
    type: "subagent.event",
    data: {
      agentThreadId: "child-1",
      nickname: "researcher",
      depth: 1,
      kind: "message.delta",
      delta: "Hello",
      arguments: { cmd: "rm -rf /" },
    },
  });
  assert.equal(e.data.delta, "Hello");
  assert.equal(e.data.arguments, undefined);
  for (const kind of ["item.started", "approval.requested", "runtime.event"])
    assert.equal(
      publicEvent({
        type: "subagent.event",
        data: { agentThreadId: "child-1", kind },
      }),
      null,
    );
});

test("snapshots rebuild sub-agents and tolerate older runtimes", () => {
  const snap = publicEvent({
    type: "snapshot",
    data: {
      subAgents: [
        { threadId: "child-1", status: "completed", startedAt: "t", secret: 1 },
        { threadId: 42 },
      ],
    },
  });
  assert.equal(snap.data.subAgents.length, 1);
  assert.equal(snap.data.subAgents[0].secret, undefined);
  assert.deepEqual(
    publicEvent({ type: "snapshot", data: {} }).data.subAgents,
    [],
  );
});

test("collab labels name the action without prompts", () => {
  const e = publicEvent({
    type: "item.started",
    data: {
      item: {
        type: "collabAgentToolCall",
        tool: "wait",
        receiverThreadIds: ["a", "b"],
        prompt: "private",
      },
    },
  });
  assert.equal(e.data.label, "Waiting on 2 helpers");
});

test("sub-agent session options are validated", () => {
  assert.equal(subAgentOptions(undefined), undefined);
  assert.deepEqual(subAgentOptions({ mode: "proactive", maxConcurrent: 3 }), {
    mode: "proactive",
    maxConcurrent: 3,
  });
  for (const bad of [
    "proactive",
    { mode: "always" },
    { maxConcurrent: 0 },
    { maxConcurrent: 6 },
    { maxConcurrent: 2.5 },
  ])
    assert.throws(() => subAgentOptions(bad), /subAgents/);
});

test("observability events reach the public stream without internal ids or raw text", () => {
  const trace = {
    turnId: "turn-1",
    threadId: "internal-thread",
    startedAt: "2026-09-28T08:16:00.000Z",
    totalMs: 7721,
    status: "completed",
    steps: [
      {
        id: "s1",
        kind: "command",
        label: "Ran a command",
        agent: "main",
        agentThreadId: "internal-thread",
        startMs: 10,
        durationMs: 50,
        status: "completed",
        command: "cat /etc/passwd",
      },
      {
        id: "s2",
        kind: "tool",
        label: "Used search",
        agent: "scout",
        agentThreadId: "helper-1",
        startMs: 20,
        durationMs: null,
        status: "running",
      },
      {
        id: "s3",
        kind: "bogus",
        label: "x",
        agent: "main",
        startMs: -5,
        durationMs: 1,
        status: "weird",
      },
    ],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: 120,
      contextWindow: 1000,
      contextUsedTokens: 100,
      raw: "prompt text",
    },
    helperUsage: null,
    rateLimits: {
      primaryUsedPercent: 12,
      at: "2026-09-28T08:16:00.000Z",
      secret: "hidden",
    },
    privacy: {
      scannedChars: 50,
      findings: [
        {
          kind: "email",
          source: "userMessage",
          count: 1,
          sample: "j***@***.com",
          value: "jane@example.com",
        },
        { kind: "unknown", source: "userMessage", count: 1, sample: "x" },
      ],
    },
  };
  const completed = publicEvent({
    type: "turn.completed",
    data: { trace, turn: { status: "completed" } },
  });
  const t = completed.data.trace;
  assert.equal(t.threadId, undefined);
  assert.equal(t.steps.length, 3);
  assert.equal(t.steps[0].agentThreadId, "main");
  assert.equal(t.steps[1].agentThreadId, "helper-1");
  assert.equal(t.steps[2].kind, "other");
  assert.equal(t.steps[2].startMs, 0);
  assert.equal(t.steps[2].status, "completed");
  assert.equal(t.privacy.findings.length, 1);
  assert.equal(t.usage.cachedInputTokens, 40);
  assert.doesNotMatch(
    JSON.stringify(completed),
    /internal-thread|passwd|prompt text|hidden|jane@example/,
  );

  const usage = publicEvent({
    type: "usage.updated",
    data: { usage: trace.usage },
  });
  assert.equal(usage.data.usage.contextWindow, 1000);
  assert.doesNotMatch(JSON.stringify(usage), /prompt text/);
  const limits = publicEvent({
    type: "limits.updated",
    data: { rateLimits: trace.rateLimits },
  });
  assert.equal(limits.data.rateLimits.primaryUsedPercent, 12);
  assert.doesNotMatch(JSON.stringify(limits), /hidden/);
  assert.equal(publicEvent({ type: "usage.updated", data: {} }), null);
});

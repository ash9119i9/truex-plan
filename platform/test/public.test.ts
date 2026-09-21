import { test } from "node:test";
import assert from "node:assert/strict";
import { publicEvent, publicSession, PublicEventStream } from "../src/public";

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
    "usageLimitExceeded",
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

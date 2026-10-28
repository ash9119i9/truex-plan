import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Harness, completed, readSse, streamedText } from "../support/harness";

// The core path against the real pinned Codex: first message, follow-up,
// usage, tool lockdown, idempotent run IDs and one active turn per chat.

describe("chat lifecycle (real Codex)", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());

  let threadId = "";

  test("first message streams text, creates the thread and reports usage", async () => {
    h.model.script.push({
      kind: "reply",
      text: "First answer, streamed in pieces.",
    });
    const body = h.body();
    const events = await h.run(body);
    const types = events.map((e) => e.type);

    assert.equal(types[0], "run.accepted");
    const accepted = events[0]!.data;
    assert.equal(accepted.resumed, false);
    threadId = String(accepted.threadId);
    assert.match(threadId, /^[0-9a-f-]{36}$/);

    assert.equal(streamedText(events), "First answer, streamed in pieces.");
    assert.ok(types.includes("item.completed"));
    assert.ok(types.includes("usage"));
    const done = completed(events);
    assert.equal(done.status, "completed");
    assert.equal(done.delivery, "accepted");
    assert.equal(done.error, null);
    assert.deepEqual(
      (done.items as Array<{ text: string; completed: boolean }>).map((i) => [
        i.text,
        i.completed,
      ]),
      [["First answer, streamed in pieces.", true]],
    );
    const usage = done.usage as {
      last: Record<string, number>;
      turn: Record<string, number>;
    };
    assert.equal(usage.last.inputTokens, 20);
    assert.equal(usage.last.outputTokens, 10);
    assert.equal(usage.turn.inputTokens, 20);
    assert.equal(usage.turn.cachedInputTokens, 5);
    assert.equal(usage.turn.outputTokens, 10);
    const timings = done.timings as Record<string, number>;
    assert.ok(timings.receivedAt! <= timings.dispatchedAt!);
    assert.ok(timings.firstTextAt! <= timings.completedAt!);

    // Event numbers are 1, 2, 3… with no gaps.
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
    );

    const request = h.model.lastRequest();
    assert.equal(request.authorized, true);
    assert.deepEqual(
      ((request.body.tools ?? []) as Array<{ name?: string }>).map(
        (tool) => tool.name,
      ),
      ["update_plan"],
      "the model is offered only the plan checklist tool",
    );
    assert.ok(JSON.stringify(request.body).includes("AGENT_PROMPT_MARKER"));
    // The app-server copies its system skills into each chat's home; none
    // may be advertised to the model, nor any plugin or connector.
    assert.doesNotMatch(
      JSON.stringify(request.body),
      /SKILL\.md|skills_instructions|plugins?_instructions|\bmcp__/i,
      "the prompt advertises no skills, plugins or connectors",
    );
    // Codex's own permissions and environment blocks contradict the
    // no-tools prompt and expose host paths, shell and timezone.
    assert.doesNotMatch(
      JSON.stringify(request.body.input),
      /permissions instructions|sandbox_mode|environment_context/i,
      "Codex adds no permissions or environment block",
    );
    assert.ok(
      !JSON.stringify(request.body).includes(h.stateDir),
      "no host path reaches the model",
    );
  });

  test("a follow-up uses the same thread and carries the conversation", async () => {
    h.model.script.push({ kind: "reply", text: "Second answer." });
    const events = await h.run(
      h.body({ threadId, input: { text: "and then?", clientMessageId: "m2" } }),
    );
    assert.equal(events[0]!.data.threadId, threadId);
    assert.equal(completed(events).status, "completed");
    // The turn counts only its own calls; the thread total keeps both.
    const usage = completed(events).usage as {
      total: Record<string, number>;
      turn: Record<string, number>;
    };
    assert.equal(usage.turn.inputTokens, 20);
    assert.equal(usage.total.inputTokens, 40);
    const sent = JSON.stringify(h.model.lastRequest().body.input);
    assert.ok(
      sent.includes("First answer, streamed in pieces."),
      "history reaches the model",
    );
    assert.ok(sent.includes("and then?"));
  });

  test("a second message while one is streaming is refused with CHAT_BUSY", async () => {
    h.model.script.push({
      kind: "reply",
      text: "x".repeat(200),
      chunk: 10,
      delayMs: 30,
    });
    const first = h.body({ threadId });
    const res = await h.post("/v1/runs", first);
    const reading = readSse(res);
    const busy = await h.post("/v1/runs", h.body({ threadId }));
    assert.equal(busy.status, 409);
    assert.deepEqual(await busy.json(), {
      error: {
        code: "CHAT_BUSY",
        message: "This chat is still answering. Wait or stop it.",
        retryable: false,
      },
    });
    assert.equal(completed(await reading).status, "completed");
  });

  test("repeating a runId attaches to the same run instead of starting another turn", async () => {
    h.model.script.push({
      kind: "reply",
      text: "only once",
      delayMs: 20,
      chunk: 2,
    });
    const body = h.body({ threadId });
    const requestsBefore = h.model.requests.length;
    const [a, b] = await Promise.all([h.run(body), h.run(body)]);
    assert.equal(h.model.requests.length, requestsBefore + 1, "one model call");
    assert.deepEqual(completed(a), completed(b));
    // After it finished, the same runId still replays the outcome.
    assert.deepEqual(completed(await h.run(body)), completed(a));
  });

  test("a retry with a refreshed gateway token still attaches", async () => {
    const body = h.body({ threadId });
    const first = await h.run(body);
    const model = {
      ...(body.model as object),
      gatewayToken: "refreshed-token-0123456789",
    };
    assert.deepEqual(
      completed(await h.run({ ...body, model })),
      completed(first),
    );
  });

  test("the same runId with a different body is RUN_CONFLICT", async () => {
    const body = h.body({ threadId });
    await h.run(body);
    const res = await h.post("/v1/runs", {
      ...body,
      input: { text: "different", clientMessageId: "x1" },
    });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "RUN_CONFLICT",
    );
  });

  test("a different chat cannot see or stop this chat's run", async () => {
    const body = h.body({ threadId });
    await h.run(body);
    const other = { tenantId: "tenant1", chatId: "chat2" };
    const events = await h.fetch(
      `/v1/runs/${String(body.runId)}/events?tenantId=tenant1&chatId=chat2`,
    );
    assert.equal(events.status, 404);
    const stop = await h.stop(String(body.runId), other);
    assert.equal(stop.status, 404);
  });

  test("history lists turns with their clientMessageId", async () => {
    const res = await h.fetch("/v1/chats/chat1/history?tenantId=tenant1");
    assert.equal(res.status, 200);
    const { turns } = (await res.json()) as {
      turns: Array<{
        clientMessageId: string | null;
        text: string;
        status: string;
      }>;
    };
    const m2 = turns.find((t) => t.clientMessageId === "m2");
    assert.ok(m2);
    assert.equal(m2.text, "Second answer.");
    assert.equal(m2.status, "completed");
  });

  test("history of a chat that never ran is THREAD_LOST", async () => {
    const res = await h.fetch("/v1/chats/never-used/history?tenantId=tenant1");
    assert.equal(res.status, 404);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "THREAD_LOST",
    );
  });
});

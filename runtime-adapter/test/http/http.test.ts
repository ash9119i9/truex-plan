import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openChatStream, until } from "../support/goals";
import { Harness, TOKEN } from "../support/harness";

// The HTTP boundary: authentication, body limits, routing and error shape.
// None of these reach Codex.

describe("HTTP boundary", () => {
  const h = new Harness();
  before(() => h.start());
  after(() => h.close());

  async function code(res: Response) {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  test("health needs no token and reports state", async () => {
    const res = await fetch(`${h.base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      activeRuns: 0,
      processes: 0,
      draining: false,
    });
  });

  test("every operation needs the exact bearer token", async () => {
    for (const authorization of [
      "",
      "Bearer wrong",
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
      TOKEN,
    ]) {
      const res = await h.fetch("/v1/runs", {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify(h.body()),
      });
      assert.equal(res.status, 401, authorization);
      assert.equal(await code(res), "UNAUTHORIZED");
    }
    const history = await h.fetch("/v1/chats/c/history?tenantId=t", {
      headers: { authorization: "Bearer nope" },
    });
    assert.equal(history.status, 401);
  });

  test("bodies must be JSON and at most 256 KiB", async () => {
    const wrongType = await h.fetch("/v1/runs", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 400);
    const broken = await h.fetch("/v1/runs", {
      method: "POST",
      body: "{not json",
    });
    assert.equal(await code(broken), "INVALID_REQUEST");
    const huge = await h.fetch("/v1/runs", {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    });
    assert.equal(huge.status, 413);
    assert.equal(await code(huge), "PAYLOAD_TOO_LARGE");
  });

  test("invalid requests are refused before any Codex process starts", async () => {
    const res = await h.post("/v1/runs", { ...h.body(), chatId: "../escape" });
    assert.equal(res.status, 400);
    assert.equal(h.manager.stats.processes, 0);
  });

  test("unknown routes and runs", async () => {
    assert.equal((await h.fetch("/v1/anything")).status, 400);
    const missing = await h.fetch("/v1/runs/nope/events?tenantId=t&chatId=c");
    assert.equal(missing.status, 404);
    assert.equal(await code(missing), "RUN_NOT_FOUND");
    const badCursor = await h.fetch(
      "/v1/runs/nope/events?tenantId=t&chatId=c&after=-1",
    );
    assert.equal(badCursor.status, 400);
    const stop = await h.stop("nope", { tenantId: "t", chatId: "c" });
    assert.equal(stop.status, 404);
  });

  test("steering validates its body like a start input", async () => {
    const needsAuth = await h.fetch("/v1/runs/nope/steer", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({
        tenantId: "t",
        chatId: "c",
        input: { text: "hi", clientMessageId: "m" },
      }),
    });
    assert.equal(needsAuth.status, 401);
    // Unknown field, then blank text: both refused before any Codex process.
    const unknown = await h.post("/v1/runs/nope/steer", {
      tenantId: "t",
      chatId: "c",
      input: { text: "hi", clientMessageId: "m" },
      runId: "x",
    });
    assert.equal(unknown.status, 400);
    assert.equal(await code(unknown), "INVALID_REQUEST");
    const blank = await h.post("/v1/runs/nope/steer", {
      tenantId: "t",
      chatId: "c",
      input: { text: "   ", clientMessageId: "m" },
    });
    assert.equal(blank.status, 400);
    assert.equal(h.manager.stats.processes, 0);
  });

  test("goal routes validate first; a chat with no thread has no goal", async () => {
    const goals = { maxTokenBudget: 1_000_000 };
    const put = (body: unknown, chat = "c") =>
      h.fetch(`/v1/chats/${chat}/goal`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    const needsAuth = await h.fetch("/v1/chats/c/goal?tenantId=t", {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(needsAuth.status, 401);
    for (const [res, why] of [
      [await put({ tenantId: "t", goals, status: "paused", x: 1 }), "unknown"],
      [await put({ tenantId: "t", goals, status: "active" }), "no context"],
      [
        await put({ tenantId: "t", goals, status: "paused", tokenBudget: 2e6 }),
        "over max",
      ],
      [await put({ tenantId: "t", goals, status: "paused" }, ".."), "chatId"],
      [await h.fetch("/v1/chats/c/goal?tenantId=../x"), "tenantId"],
      [
        await h.fetch("/v1/chats/c/goal?tenantId=../x", { method: "DELETE" }),
        "tenantId",
      ],
      [await h.fetch("/v1/chats/c/events?tenantId=t&after=-1"), "cursor"],
      [await h.fetch("/v1/chats/c/events?tenantId=t&streamId=a.b"), "streamId"],
    ] as const) {
      assert.equal(res.status, 400, why);
      assert.equal(await code(res), "INVALID_REQUEST", why);
    }
    const paused = await put({ tenantId: "t", goals, status: "paused" });
    assert.equal(paused.status, 404);
    assert.equal(await code(paused), "GOAL_NOT_FOUND");
    const get = await h.fetch("/v1/chats/c/goal?tenantId=t");
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { goal: null });
    const clear = await h.fetch("/v1/chats/c/goal?tenantId=t", {
      method: "DELETE",
    });
    assert.equal(clear.status, 200);
    assert.deepEqual(await clear.json(), { cleared: false });
    // A cursor from another stream (another adapter process's) gets one
    // snapshot naming this stream; the stream stays open.
    const events = await openChatStream(h, "c", {
      after: 3,
      streamId: "earlier",
      tenantId: "t",
    });
    assert.ok(await until(() => events.events.length === 1));
    const streamId = events.events[0]!.data.streamId;
    assert.match(String(streamId), /^[0-9a-f]{24}$/);
    assert.deepEqual(events.events, [
      {
        seq: 0,
        type: "chat.snapshot",
        data: { streamId, goal: null, origin: null, activeRun: null },
      },
    ]);
    await events.close();
    // None of these needed a Codex process.
    assert.equal(h.manager.stats.processes, 0);
  });

  test("steering an unknown or another chat's run is RUN_NOT_FOUND", async () => {
    const res = await h.steer(
      "nope",
      { text: "hi", clientMessageId: "m" },
      { tenantId: "t", chatId: "c" },
    );
    assert.equal(res.status, 404);
    assert.equal(await code(res), "RUN_NOT_FOUND");
  });
});

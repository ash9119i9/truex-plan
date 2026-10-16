import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
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
});

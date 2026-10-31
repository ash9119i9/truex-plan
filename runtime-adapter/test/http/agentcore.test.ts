import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { agentCoreSessionId } from "../../src/agentcore/session";
import { BridgeHarness, envelope } from "../support/agentcore";

// The AgentCore bridge in front of the real adapter. Nothing here starts a
// Codex process, so the binary can be any executable.

const NO_CODEX = { RUNTIME_CODEX_BINARY: process.execPath };
const chat1 = { tenantId: "tenant1", chatId: "chat1" };
const chat2 = { tenantId: "tenant1", chatId: "chat2" };
const missingRun = {
  method: "GET",
  path: "/v1/runs/nope/events",
  query: chat1,
};

describe("AgentCore bridge", () => {
  const h = new BridgeHarness(NO_CODEX);
  before(() => h.start());
  after(() => h.close());

  test("ping is Healthy before anything starts", async () => {
    assert.deepEqual(await h.ping(), {
      status: 200,
      body: { status: "Healthy" },
    });
    assert.equal(h.bridge.stats.started, false);
  });

  test("only /ping and POST /invocations exist", async () => {
    for (const [method, path] of [
      ["GET", "/invocations"],
      ["POST", "/ping"],
      ["GET", "/health"],
      ["POST", "/v1/runs"],
    ] as const) {
      const res = await fetch(`${h.base}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  test("bad bodies are refused in the envelope before the adapter starts", async () => {
    const notJson = await fetch(`${h.base}/invocations`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal((await envelope(notJson)).status, 400);
    const broken = await fetch(`${h.base}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    assert.equal((await envelope(broken)).body.error?.code, "INVALID_REQUEST");
    const route = await envelope(
      await h.invoke({ method: "GET", path: "/health" }),
    );
    assert.deepEqual(
      [route.status, route.body.error?.code],
      [400, "INVALID_REQUEST"],
    );
    assert.equal(h.bridge.stats.started, false);
  });

  test("a missing or foreign session header is refused", async () => {
    for (const session of [
      null,
      "",
      agentCoreSessionId("tenant1", "other"),
      agentCoreSessionId("chat1", "tenant1"),
    ]) {
      const res = await envelope(await h.invoke(missingRun, chat1, session));
      assert.equal(res.status, 403, String(session));
      assert.equal(res.body.error?.code, "SESSION_MISMATCH");
    }
    assert.equal(h.bridge.stats.started, false);
    assert.equal(h.count("agentcore_session_rejected"), 4);
  });

  test("concurrent first invocations start one adapter", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.invoke(missingRun).then(envelope)),
    );
    for (const res of results) {
      // The adapter's own status and code arrive intact.
      assert.equal(res.status, 404);
      assert.equal(res.body.error?.code, "RUN_NOT_FOUND");
    }
    assert.equal(h.count("agentcore_adapter_started"), 1);
    assert.equal(h.bridge.stats.started, true);
    assert.deepEqual((await h.ping()).body, { status: "Healthy" });
  });

  test("a second chat in the same runtime is refused", async () => {
    const res = await envelope(
      await h.invoke({ ...missingRun, query: chat2 }, chat2),
    );
    assert.deepEqual(
      [res.status, res.body.error?.code],
      [403, "SESSION_MISMATCH"],
    );
  });

  test("adapter errors keep their status, code and details", async () => {
    const res = await envelope(
      await h.invoke({
        method: "PUT",
        path: "/v1/chats/chat1/uploads/a.txt",
        query: { tenantId: "tenant1", sha256: "0".repeat(64) },
        bodyBase64: "aGk=",
      }),
    );
    assert.deepEqual(
      [res.status, res.body.error?.code],
      [409, "UPLOADS_DISABLED"],
    );
  });

  test("the adapter token never reaches a response or log", async () => {
    const res = await h.invoke(missingRun);
    const text = await res.text();
    assert.doesNotMatch(text, /Bearer/i);
    assert.doesNotMatch(JSON.stringify(h.logs), /token|Bearer/i);
  });

  test("shutdown closes both servers, before or after the adapter started", async () => {
    for (const started of [false, true]) {
      const other = await new BridgeHarness(NO_CODEX).start();
      try {
        if (started) await envelope(await other.invoke(missingRun));
        await Promise.all([other.bridge.shutdown(), other.bridge.shutdown()]);
        assert.equal(other.bridge.stats.stopping, true);
        await assert.rejects(fetch(`${other.base}/ping`));
      } finally {
        await other.close();
      }
    }
  });
});

describe("AgentCore bridge with coding on", () => {
  const h = new BridgeHarness({ ...NO_CODEX, RUNTIME_CODING_ENABLED: "1" });
  before(() => h.start());
  after(() => h.close());

  test("uploads and file reads round-trip bytes exactly", async () => {
    const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const sha256 = createHash("sha256").update(data).digest("hex");
    const put = await envelope(
      await h.invoke({
        method: "PUT",
        path: `/v1/chats/chat1/uploads/${encodeURIComponent("data (1).bin")}`,
        query: { tenantId: "tenant1", sha256 },
        bodyBase64: data.toString("base64"),
      }),
    );
    assert.equal(put.status, 200);
    assert.equal(put.body.path, "uploads/data (1).bin");
    assert.equal(put.body.size, data.length);

    const read = await h.invoke({
      method: "GET",
      path: "/v1/chats/chat1/file",
      query: { tenantId: "tenant1", path: "uploads/data (1).bin" },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), data);

    const missing = await envelope(
      await h.invoke({
        method: "GET",
        path: "/v1/chats/chat1/file",
        query: { tenantId: "tenant1", path: "uploads/none.bin" },
      }),
    );
    assert.deepEqual(
      [missing.status, missing.body.error?.code],
      [404, "FILE_NOT_FOUND"],
    );
  });

  test("a body that doesn't match its sha256 leaves nothing behind", async () => {
    const res = await envelope(
      await h.invoke({
        method: "PUT",
        path: "/v1/chats/chat1/uploads/bad.bin",
        query: { tenantId: "tenant1", sha256: "0".repeat(64) },
        bodyBase64: "aGk=",
      }),
    );
    assert.equal(res.status, 400);
    const files = await envelope(
      await h.invoke({
        method: "GET",
        path: "/v1/chats/chat1/files",
        query: { tenantId: "tenant1" },
      }),
    );
    assert.doesNotMatch(JSON.stringify(files.body), /bad\.bin/);
  });
});

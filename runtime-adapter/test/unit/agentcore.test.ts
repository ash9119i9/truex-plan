import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseInvocation } from "../../src/agentcore/routes";
import { agentCoreSessionId } from "../../src/agentcore/session";
import { ConfigError, loadConfig } from "../../src/config";
import { AdapterError } from "../../src/errors";
import { MAX_FILE_BYTES } from "../../src/runtime/files";

// AgentCore mode without Codex: the session ID, the invocation allowlist and
// the RUNTIME_MODE switch.

describe("AgentCore session ID", () => {
  // The platform's AgentCore transport pins the same vector.
  test("is chat- plus sha256 of tenantId/chatId", () => {
    const id = agentCoreSessionId("tenant1", "chat1");
    assert.equal(
      id,
      "chat-4dd6e2ba97c8672ae10daac7b78f0c0b2b03d6cfe4e5c37790a597ab53f757fa",
    );
    assert.equal(id.length, 69);
    assert.notEqual(id, agentCoreSessionId("tenant1", "chat2"));
    assert.notEqual(id, agentCoreSessionId("tenant2", "chat1"));
  });
});

describe("AgentCore invocations", () => {
  const ref = { tenantId: "t1", chatId: "c1" };

  function rejects(value: unknown, code = "INVALID_REQUEST") {
    assert.throws(
      () => parseInvocation(value),
      (error: unknown) => error instanceof AdapterError && error.code === code,
      JSON.stringify(value)?.slice(0, 200),
    );
  }

  test("accepts every adapter route and finds its chat", () => {
    const cases: Array<[unknown, string]> = [
      [{ method: "POST", path: "/v1/runs", body: { ...ref } }, "/v1/runs"],
      [
        {
          method: "GET",
          path: "/v1/runs/r1/events",
          query: { ...ref, after: "3" },
        },
        "/v1/runs/r1/events?tenantId=t1&chatId=c1&after=3",
      ],
      [
        { method: "POST", path: "/v1/runs/r1/stop", body: ref },
        "/v1/runs/r1/stop",
      ],
      [
        { method: "POST", path: "/v1/runs/r1/steer", body: ref },
        "/v1/runs/r1/steer",
      ],
      [
        { method: "POST", path: "/v1/runs/r1/approvals/a1", body: ref },
        "/v1/runs/r1/approvals/a1",
      ],
      [
        {
          method: "GET",
          path: "/v1/chats/c1/history",
          query: { tenantId: "t1" },
        },
        "/v1/chats/c1/history?tenantId=t1",
      ],
      [
        {
          method: "GET",
          path: "/v1/chats/c1/files",
          query: { tenantId: "t1" },
        },
        "/v1/chats/c1/files?tenantId=t1",
      ],
      [
        {
          method: "GET",
          path: "/v1/chats/c1/file",
          query: { tenantId: "t1", path: "uploads/a b.txt" },
        },
        "/v1/chats/c1/file?tenantId=t1&path=uploads%2Fa+b.txt",
      ],
      [
        {
          method: "PUT",
          path: `/v1/chats/c1/uploads/${encodeURIComponent("report (1).pdf")}`,
          query: { tenantId: "t1", sha256: "ab" },
          bodyBase64: "aGk=",
        },
        "/v1/chats/c1/uploads/report%20(1).pdf?tenantId=t1&sha256=ab",
      ],
      [
        {
          method: "PUT",
          path: `/v1/chats/c1/skills/${"a".repeat(64)}`,
          query: { tenantId: "t1" },
          bodyBase64: "",
        },
        `/v1/chats/c1/skills/${"a".repeat(64)}?tenantId=t1`,
      ],
    ];
    for (const [value, target] of cases) {
      const invocation = parseInvocation(value);
      assert.equal(invocation.target, target);
      assert.deepEqual(invocation.chat, ref);
    }
  });

  test("decodes PUT bodies with the route's content type", () => {
    const upload = parseInvocation({
      method: "PUT",
      path: "/v1/chats/c1/uploads/a.png",
      query: { tenantId: "t1", sha256: "x" },
      bodyBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
    });
    assert.deepEqual([...upload.bytes!.data], [0, 1, 2, 255]);
    assert.equal(upload.bytes!.contentType, "application/octet-stream");
    const skill = parseInvocation({
      method: "PUT",
      path: "/v1/chats/c1/skills/abc",
      query: { tenantId: "t1" },
      bodyBase64: "",
    });
    assert.equal(skill.bytes!.contentType, "application/gzip");
  });

  test("refuses anything outside the adapter's routes", () => {
    for (const value of [
      null,
      [],
      "x",
      { method: "DELETE", path: "/v1/runs", body: ref },
      { method: "GET", path: "/v1/runs" },
      { method: "GET", path: "/health" },
      { method: "GET", path: "/v1/chats/c1/history/extra", query: ref },
      { method: "GET", path: "/v1/chats//history", query: ref },
      { method: "GET", path: "/v1/chats/../history", query: ref },
      { method: "GET", path: "/v1/chats/%2e%2E/history", query: ref },
      { method: "GET", path: "/v1/chats/c1/history?tenantId=t1" },
      { method: "GET", path: "v1/chats/c1/history", query: ref },
      { method: "GET", path: `/v1/${"a/".repeat(600)}history` },
      {
        method: "PUT",
        path: "/v1/chats/c1/uploads/a%2Fb",
        query: { tenantId: "t1", sha256: "x" },
        bodyBase64: "",
      },
      {
        method: "PUT",
        path: "/v1/chats/c1/uploads/a%5Cb",
        query: { tenantId: "t1", sha256: "x" },
        bodyBase64: "",
      },
    ])
      rejects(value);
  });

  test("refuses unknown fields, misplaced bodies and bad queries", () => {
    rejects({ method: "POST", path: "/v1/runs", body: ref, extra: 1 });
    rejects({ method: "POST", path: "/v1/runs" });
    rejects({ method: "POST", path: "/v1/runs", body: ref, bodyBase64: "" });
    rejects({
      method: "GET",
      path: "/v1/chats/c1/files",
      query: { tenantId: "t1" },
      body: {},
    });
    rejects({
      method: "GET",
      path: "/v1/chats/c1/files",
      query: { tenantId: "t1", chatId: "c1" },
    });
    rejects({
      method: "GET",
      path: "/v1/runs/r1/events",
      query: { ...ref, after: 3 },
    });
    rejects({ method: "GET", path: "/v1/chats/c1/files", query: [] });
  });

  test("needs a valid chat to pick the session", () => {
    rejects({ method: "POST", path: "/v1/runs", body: { tenantId: "t1" } });
    rejects({ method: "POST", path: "/v1/runs", body: [ref] });
    rejects({
      method: "POST",
      path: "/v1/runs/r1/stop",
      body: { ...ref, chatId: "a/b" },
    });
    rejects({
      method: "GET",
      path: "/v1/runs/r1/events",
      query: { tenantId: "t1" },
    });
    rejects({ method: "GET", path: "/v1/chats/c1/files" });
    rejects({
      method: "GET",
      path: "/v1/chats/c%201/files",
      query: { tenantId: "t1" },
    });
  });

  test("checks base64 and size before decoding", () => {
    const put = (bodyBase64: unknown) => ({
      method: "PUT",
      path: "/v1/chats/c1/uploads/a.bin",
      query: { tenantId: "t1", sha256: "x" },
      bodyBase64,
    });
    rejects(put(undefined));
    rejects(put("not base64!"));
    rejects(put("abc"));
    rejects(put("ab=c"));
    rejects(
      put("A".repeat((Math.ceil(MAX_FILE_BYTES / 3) + 1) * 4)),
      "PAYLOAD_TOO_LARGE",
    );
    const skill = {
      method: "PUT",
      path: "/v1/chats/c1/skills/abc",
      query: { tenantId: "t1" },
      bodyBase64: "A".repeat((Math.ceil((5 * 1024 * 1024) / 3) + 1) * 4),
    };
    rejects(skill, "PAYLOAD_TOO_LARGE");
  });
});

describe("RUNTIME_MODE", () => {
  const base = {
    RUNTIME_STATE_DIR: "/tmp/x",
    RUNTIME_CODEX_BINARY: process.execPath,
  };

  test("defaults to server with today's settings", () => {
    const config = loadConfig({
      ...base,
      RUNTIME_ADAPTER_TOKEN: "x".repeat(32),
    });
    assert.equal(config.mode, "server");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4400);
    assert.equal(config.token, "x".repeat(32));
    assert.throws(() => loadConfig(base), /RUNTIME_ADAPTER_TOKEN/);
  });

  test("agentcore listens on 0.0.0.0:8080 and reads no token", () => {
    const config = loadConfig({
      ...base,
      RUNTIME_MODE: "agentcore",
      RUNTIME_ADAPTER_TOKEN: "y".repeat(32),
    });
    assert.equal(config.mode, "agentcore");
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 8080);
    assert.equal(config.token, "");
    const custom = loadConfig({
      ...base,
      RUNTIME_MODE: "agentcore",
      HOST: "127.0.0.1",
      PORT: "9000",
    });
    assert.equal(custom.host, "127.0.0.1");
    assert.equal(custom.port, 9000);
  });

  test("an unknown mode stops startup", () => {
    for (const RUNTIME_MODE of ["AgentCore", "lambda", "1"])
      assert.throws(
        () =>
          loadConfig({
            ...base,
            RUNTIME_ADAPTER_TOKEN: "x".repeat(32),
            RUNTIME_MODE,
          }),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.problems.some((p) => p.includes("RUNTIME_MODE")),
      );
  });
});

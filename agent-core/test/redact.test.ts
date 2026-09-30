import { test } from "node:test";
import assert from "node:assert/strict";
import { Redactor } from "../src/redact";

test("flags under sensitive-looking keys survive; values that can hold secrets do not", () => {
  const redactor = new Redactor();
  redactor.remember({ experimental_bearer_token: "sk-live-123456" });
  const cleaned = redactor.clean({
    questions: [{ id: "q", isSecret: false, isOther: false }],
    tokenCount: 42,
    secret: null,
    api_key: "plain-value",
    authorization: { scheme: "Bearer", value: "abc" },
    http_headers: ["x"],
    note: "uses sk-live-123456 here",
  });
  assert.deepEqual(cleaned.questions, [
    { id: "q", isSecret: false, isOther: false },
  ]);
  assert.equal(cleaned.tokenCount, 42);
  assert.equal(cleaned.secret, null);
  assert.equal(cleaned.api_key, "[REDACTED]");
  assert.equal(cleaned.authorization, "[REDACTED]");
  assert.equal(cleaned.http_headers, "[REDACTED]");
  assert.equal(cleaned.note, "uses [REDACTED] here");
  assert.equal(redactor.clean({ isSecret: true }).isSecret, true);
});

test("MCP credentials: apiKeyEnc and decrypted http_headers values never reach traces or logs", () => {
  const redactor = new Redactor();
  // The thread config the platform sends at session build, keys decrypted.
  redactor.remember({
    config: {
      "mcp_servers.qlik": {
        url: "https://mcp.example/mcp",
        http_headers: { "x-api-qlik-key": "qlik-decrypted-key" },
      },
      "mcp_servers.btp": {
        url: "https://btp.example/mcp",
        http_headers: { Authorization: "Bearer btp-decrypted-token" },
      },
    },
  });
  const apiKeyEnc = {
    v: 1,
    kid: "k1",
    iv: "aXYtdmFsdWUtMTI=",
    tag: "dGFnLXZhbHVlLTE2Ynl0ZXM=",
    data: "Y2lwaGVydGV4dC1kYXRh",
  };
  const cleaned = redactor.clean({
    profile: { name: "qlik", apiKeyEnc, hasKey: true },
    server: {
      url: "https://mcp.example/mcp",
      http_headers: { "x-api-qlik-key": "qlik-decrypted-key" },
    },
    log: "connecting with qlik-decrypted-key and Bearer btp-decrypted-token",
    trace: [{ detail: "header x-api-qlik-key: qlik-decrypted-key" }],
  });
  // The whole encrypted record is masked, not just fields inside it.
  assert.equal(cleaned.profile.apiKeyEnc, "[REDACTED]");
  assert.equal(cleaned.profile.hasKey, true);
  assert.equal(cleaned.server.http_headers, "[REDACTED]");
  assert.equal(cleaned.server.url, "https://mcp.example/mcp");
  const text = JSON.stringify(cleaned);
  assert.doesNotMatch(
    text,
    /qlik-decrypted-key|btp-decrypted-token|Y2lwaGVydGV4dC1kYXRh/,
  );
  // The whole remembered header value is masked, scheme included.
  assert.equal(cleaned.log, "connecting with [REDACTED] and [REDACTED]");
});

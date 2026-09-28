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

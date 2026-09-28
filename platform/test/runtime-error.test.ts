import assert from "node:assert/strict";
import test from "node:test";
import { runtimeError } from "../../shared/errors";

test("agent-core codes map to specific user messages", () => {
  for (const code of [
    "RUNTIME_UNAVAILABLE",
    "RUNTIME_OVERLOADED",
    "TURN_STALLED",
    "ADAPTER_INTERNAL",
    "STORAGE_UNAVAILABLE",
  ]) {
    assert.equal(runtimeError({ code }).code, code, "error event");
    assert.equal(runtimeError({ error: { code } }).code, code, "failed turn");
  }
});

test("provider info still wins over agent-core codes", () => {
  const r = runtimeError({
    code: "TURN_STALLED",
    error: { codexErrorInfo: { x: { httpStatusCode: 429 } } },
  });
  assert.equal(r.code, "PROVIDER_RATE_LIMITED");
});

test("unknown failures stay generic", () => {
  assert.equal(runtimeError({ code: "SOMETHING_ELSE" }).code, "RUNTIME_FAILED");
});

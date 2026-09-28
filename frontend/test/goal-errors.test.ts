import { test } from "node:test";
import assert from "node:assert/strict";
import {
  errorReasons,
  goalFailure,
  providerTip,
  turnFailure,
} from "../lib/goal-errors.ts";

test("every reason has a label and a resume, compact or no action", () => {
  for (const info of Object.values(errorReasons)) {
    assert.ok(info.label);
    assert.ok(["resume", "compact", null].includes(info.action));
  }
  assert.equal(errorReasons.contextWindow.action, "compact");
  assert.equal(errorReasons.rateLimited.action, "resume");
});

test("provider tips follow the model profile's provider, with a fallback", () => {
  assert.match(providerTip("openrouter", "quota")!, /OpenRouter/);
  assert.match(providerTip("Amazon Bedrock", "credentials")!, /IAM/);
  assert.match(providerTip("openai", "quota")!, /OpenAI/);
  assert.match(providerTip("custom-llm", "quota")!, /administrator/);
  assert.match(providerTip(undefined, "credentials")!, /administrator/);
  // Only quota and credential problems need the provider's console.
  assert.equal(providerTip("openrouter", "rateLimited"), null);
});

test("turn failures keep only the public fields and default to other", () => {
  assert.deepEqual(
    turnFailure({
      code: "PROVIDER_RATE_LIMITED",
      reason: "rateLimited",
      message: "Rate limited.",
      httpStatus: 429,
      raw: "private",
    }),
    { reason: "rateLimited", message: "Rate limited.", httpStatus: 429 },
  );
  assert.equal(turnFailure({ reason: "made-up", message: "x" })?.reason, "other");
  assert.equal(turnFailure(undefined), null);
  assert.equal(turnFailure({ reason: "quota" }), null);
});

test("a failure explains the goal only while Codex has it stopped", () => {
  const failure = { reason: "quota" as const, message: "Out of credits." };
  assert.equal(goalFailure("blocked", failure), failure);
  assert.equal(goalFailure("usageLimited", failure), failure);
  assert.equal(goalFailure("active", failure), null);
  assert.equal(goalFailure("blocked", null), null);
});

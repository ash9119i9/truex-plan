import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../../src/common/domain-error";
import {
  goalLength,
  MAX_GOAL_OBJECTIVE,
  mergeFeedback,
  parseGoalEdit,
  parseGoalStart,
  parseRequestChanges,
} from "../../src/modules/goals/goal-input";

const start = (objective: string) =>
  parseGoalStart({
    clientRequestId: "client-request-1",
    objective,
    tokenBudget: 100_000,
  });

const refused = (run: () => unknown) =>
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof DomainError && error.code === "INVALID_INPUT",
  );

// One character as Codex counts them (chars().count()), two UTF-16 units.
const EMOJI = "\u{1F600}";

describe("goal objective length (Codex's 4000-character limit)", () => {
  test("is counted in Unicode characters, as Codex counts them, not UTF-16 units", () => {
    assert.equal(goalLength(EMOJI.repeat(3)), 3);
    assert.equal(EMOJI.repeat(3).length, 6);
  });

  test("exactly 4000 characters is accepted, including 4000 emoji (8000 UTF-16 units)", () => {
    for (const objective of [
      "a".repeat(MAX_GOAL_OBJECTIVE),
      EMOJI.repeat(MAX_GOAL_OBJECTIVE),
      `${"a".repeat(MAX_GOAL_OBJECTIVE - 1)}${EMOJI}`,
    ]) {
      const parsed = start(objective);
      assert.equal(parsed.objective, objective);
      assert.equal(goalLength(parsed.objective!), MAX_GOAL_OBJECTIVE);
      assert.equal(parseGoalEdit({ objective }).objective, objective);
    }
  });

  test("4001 characters is refused, whether the last one is ASCII or an emoji", () => {
    for (const objective of [
      "a".repeat(MAX_GOAL_OBJECTIVE + 1),
      EMOJI.repeat(MAX_GOAL_OBJECTIVE + 1),
      `${"a".repeat(MAX_GOAL_OBJECTIVE)}${EMOJI}`,
    ]) {
      refused(() => start(objective));
      refused(() => parseGoalEdit({ objective }));
    }
  });

  test("is counted after NFC, which is the text Codex receives", () => {
    // "é" typed as e + combining acute: two characters before NFC, one after.
    const decomposed = "é".repeat(MAX_GOAL_OBJECTIVE);
    assert.equal(goalLength(decomposed), 2 * MAX_GOAL_OBJECTIVE);
    const parsed = start(decomposed);
    assert.equal(parsed.objective, "é".repeat(MAX_GOAL_OBJECTIVE));
    assert.equal(goalLength(parsed.objective!), MAX_GOAL_OBJECTIVE);
    refused(() => start("é".repeat(MAX_GOAL_OBJECTIVE + 1)));
  });

  test("a broken character (lone surrogate), empty or blank text is refused", () => {
    for (const objective of [
      "Write the summary \uD83D",
      "\uDE00 then the rest",
      "",
      "   \n\t  ",
    ]) {
      refused(() => start(objective));
      refused(() => parseGoalEdit({ objective }));
    }
  });

  test("review feedback is checked as text but never cut; the merge keeps every character", () => {
    const feedback = EMOJI.repeat(MAX_GOAL_OBJECTIVE);
    assert.equal(parseRequestChanges({ feedback }).feedback, feedback);
    refused(() =>
      parseRequestChanges({ feedback: EMOJI.repeat(MAX_GOAL_OBJECTIVE + 1) }),
    );
    // The service refuses a merge over the limit (OBJECTIVE_TOO_LONG); the
    // merge itself never shortens either part.
    const merged = mergeFeedback("a".repeat(3990), feedback);
    assert.ok(merged.startsWith("a".repeat(3990)));
    assert.ok(merged.endsWith(feedback));
    assert.ok(goalLength(merged) > MAX_GOAL_OBJECTIVE);
  });
});

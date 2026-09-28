import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenChange } from "../lib/goal.ts";
import type { GoalHistoryEntry } from "../../shared/contracts";

const at = "2026-09-28T00:00:00.000Z";
const entry = (
  kind: GoalHistoryEntry["kind"],
  tokensUsed?: number,
): GoalHistoryEntry => ({ at, kind, objective: "Board deck", tokensUsed });

test("token change is Codex's count since the previous change of the same goal", () => {
  const entries = [
    entry("set", 0),
    entry("budget", 1200),
    entry("accepted"),
    entry("status", 5000),
  ];
  assert.equal(tokenChange(entries, 0), null);
  assert.equal(tokenChange(entries, 1), 1200);
  assert.equal(tokenChange(entries, 2), null);
  // Entries without a count, like reviews, are skipped.
  assert.equal(tokenChange(entries, 3), 3800);
});

test("token change does not reach across goals or report a drop", () => {
  const entries = [
    entry("set", 0),
    entry("status", 900),
    entry("cleared"),
    entry("set", 0),
    entry("status", 300),
    entry("objective", 300),
  ];
  assert.equal(tokenChange(entries, 3), null);
  assert.equal(tokenChange(entries, 4), 300);
  assert.equal(tokenChange(entries, 5), null);
  assert.equal(tokenChange([entry("cleared"), entry("status", 50)], 1), null);
  assert.equal(tokenChange(entries, 99), null);
});

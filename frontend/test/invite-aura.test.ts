import { test } from "node:test";
import assert from "node:assert/strict";
import { AURA_DOTS, AURA_SOFT, auraFor } from "../lib/invite-aura.ts";

test("auraFor is deterministic and returns property names", () => {
  assert.deepEqual(auraFor("Alex Rivera"), ["--peach-dot", "--butter-dot", "--peach"]);
  assert.deepEqual(auraFor("Alex Rivera"), auraFor("Alex Rivera"));
});

test("auraFor fixes the signed-shift bug for hashes at or above 2^31", () => {
  // "Priya Patel" hashes to 3052680818; the prototype's (h >> 4) gives b === a.
  assert.deepEqual(auraFor("Priya Patel"), ["--peach-dot", "--butter-dot", "--peach"]);
  // "Jon Okafor" hashes to 3314595938; the fix gives b = 1.
  assert.deepEqual(auraFor("Jon Okafor"), ["--peach-dot", "--mint-dot", "--peach"]);
});

test("auraFor keeps b in range and different from a, with a3 the soft of a1", () => {
  const names = ["", "A", "ab", "Zoë", "Maya Chen", "Sam", "李雷", "x".repeat(60)];
  for (let i = 0; i < 500; i++) names.push(`Person ${i} ${String.fromCharCode(65 + (i % 26))}`);
  for (const name of names) {
    const [a1, a2, a3] = auraFor(name);
    const a = AURA_DOTS.indexOf(a1 as (typeof AURA_DOTS)[number]);
    const b = AURA_DOTS.indexOf(a2 as (typeof AURA_DOTS)[number]);
    assert.ok(a >= 0 && b >= 0, name);
    assert.notEqual(a, b, name);
    assert.equal(a3, AURA_SOFT[a], name);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createSpring,
  jumpSpring,
  retargetSpring,
  sampleSpring,
} from "../lib/spring.ts";

const FRAME = 1000 / 60;

// Frames until rest for a move from `from` to `to`, sampling at 60 fps.
const settle = (from: number, to: number) => {
  const s = createSpring(from);
  retargetSpring(s, to, 0);
  for (let f = 1; f <= 120; f++) if (sampleSpring(s, f * FRAME)) return { s, f };
  return { s, f: -1 };
};

test("the caret spring settles exactly on its target within half a second", () => {
  for (const [from, to] of [
    [0, 8],
    [0, 60],
    [10, 30],
    [0, 300],
  ]) {
    const { s, f } = settle(from, to);
    assert.ok(f > 1 && f <= 30, `${from}→${to} settled after ${f} frames`);
    assert.equal(s.pos, to);
    assert.equal(s.vel, 0);
  }
});

// Values sampled from motion 13.4.4's spring() with the caret's constants
// (stiffness 500, damping 30, mass 0.5), 0 → 60 px at 60 fps.
test("it follows motion's spring curve frame for frame", () => {
  const motion = [6.0, 17.48, 29.0, 38.55, 45.75, 50.85, 54.29, 56.54];
  const s = createSpring(0);
  retargetSpring(s, 60, 0);
  motion.forEach((expected, i) => {
    sampleSpring(s, (i + 1) * FRAME);
    assert.ok(Math.abs(s.pos - expected) < 0.01, `frame ${i + 1}: ${s.pos} vs ${expected}`);
  });
});

test("retargeting mid-move keeps the caret's velocity, so it never jerks", () => {
  const s = createSpring(0);
  retargetSpring(s, 100, 0);
  sampleSpring(s, 50);
  const { pos, vel } = s;
  assert.ok(vel > 0);
  retargetSpring(s, 140, 50);
  assert.equal(s.pos, pos);
  assert.equal(s.vel, vel);
  sampleSpring(s, 50 + FRAME);
  assert.ok(s.pos > pos, "keeps moving forward");
});

test("a late frame lands on the curve instead of overshooting", () => {
  const s = createSpring(0);
  retargetSpring(s, 50, 0);
  assert.equal(sampleSpring(s, 5000), true);
  assert.equal(s.pos, 50);
});

test("a jump lands at once and stops any motion", () => {
  const s = createSpring(0);
  retargetSpring(s, 10, 0);
  sampleSpring(s, 30);
  jumpSpring(s, 42);
  assert.equal(s.pos, 42);
  assert.equal(s.vel, 0);
  assert.equal(sampleSpring(s, 60), true);
});

test("the composer caret no longer pulls in motion", () => {
  const src = readFileSync(
    new URL("../components/smooth-textarea.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(src, /from "motion/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  dragPose,
  grabX,
  LANYARD,
  releaseSpin,
  settled,
  swingStep,
} from "../lib/lanyard.ts";

// Runs the pendulum at 60 fps until it rests; returns the angle per frame.
const run = (a: number, v: number, reduced = false, seconds = 12) => {
  const s = { a, v };
  const path: number[] = [];
  for (let t = 0; t < seconds && !settled(s); t += 1 / 60) {
    swingStep(s, 1 / 60, reduced);
    path.push(s.a);
  }
  return { path, s };
};
const peaks = (path: number[]) =>
  path.filter(
    (a, i) =>
      i > 0 &&
      i < path.length - 1 &&
      Math.abs(a) >= Math.abs(path[i - 1]) &&
      Math.abs(a) > Math.abs(path[i + 1]),
  );

test("let go off-centre, the card swings through the middle and comes to rest", () => {
  const { path, s } = run(30, 0);
  assert.ok(settled(s), "rests within 12 s");
  assert.ok(Math.min(...path) < -10, "swings well past the middle");
  // each swing is smaller than the one before
  const p = peaks(path).map(Math.abs);
  assert.ok(p.length >= 3, `at least 3 visible swings, got ${p.length}`);
  for (let i = 1; i < p.length; i++) assert.ok(p[i] < p[i - 1]);
  // and it rests in a few seconds, not a long tail
  assert.ok(
    path.length / 60 < 8,
    `rests in ${(path.length / 60).toFixed(1)} s`,
  );
});

test("a flick keeps its speed: released spinning from the middle, it swings out", () => {
  const { path } = run(0, 300);
  assert.ok(Math.max(...path) > 20);
});

test("under reduced motion it returns once, with no swing", () => {
  const { path, s } = run(30, 0, true);
  assert.ok(settled(s));
  assert.ok(Math.min(...path) > -0.5, "never swings past the middle");
});

test("a dropped frame doesn't destabilise it", () => {
  const s = { a: 40, v: 0 };
  swingStep(s, 0.064);
  assert.ok(Number.isFinite(s.a) && Math.abs(s.a) <= 40);
});

test("release spin comes from the last 80 ms of the drag and is capped", () => {
  assert.equal(releaseSpin([]), 0);
  assert.equal(releaseSpin([{ t: 0, a: 5 }]), 0);
  // old samples outside the window are ignored
  assert.equal(
    releaseSpin([
      { t: 0, a: -50 },
      { t: 200, a: 0 },
      { t: 250, a: 10 },
    ]),
    200,
  );
  assert.equal(
    releaseSpin([
      { t: 0, a: 0 },
      { t: 10, a: 40 },
    ]),
    LANYARD.maxSpin,
  );
  assert.equal(
    releaseSpin([
      { t: 0, a: 0 },
      { t: 10, a: -40 },
    ]),
    -LANYARD.maxSpin,
  );
});

test("grabbing a swinging card holds it where it is", () => {
  for (const angle of [-25, -8, 0, 12, 30]) {
    const r = 300;
    const pose = dragPose(grabX(angle, r), 0, 60, r);
    assert.ok(Math.abs(pose.angle - angle) < 0.01, `${angle} → ${pose.angle}`);
    // measured from the reach at the grab, the strap doesn't jump either
    assert.equal(dragPose(grabX(angle, r), 0, 60, r, pose.reach).height, 60);
  }
});

test("held still at the grab point the strap rests; pulled down it stretches, with resistance", () => {
  assert.deepEqual(
    (({ angle, height, width }) => ({ angle, height, width }))(
      dragPose(0, 0, 60, 200),
    ),
    { angle: 0, height: 60, width: 22 },
  );
  const pulled = dragPose(0, 400, 60, 200);
  assert.ok(pulled.height > 60 && pulled.height < 60 + 400);
  assert.ok(pulled.width < 22 && pulled.width >= 16);
  // pushed up it shortens, never below three quarters
  assert.ok(dragPose(0, -500, 60, 200).height >= 45);
  // dragged right, it swings right (negative angle on screen is left of the pivot)
  assert.ok(dragPose(200, 0, 60, 200).angle < 0);
});

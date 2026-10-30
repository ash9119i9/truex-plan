// The composer caret's spring, without motion/react. It is the closed-form
// damped spring motion uses (motion-dom 13.4.4, animation/generators/spring.mjs)
// with the caret's old constants and motion's rest thresholds, so the caret
// moves frame for frame as it did with the library.
const STIFFNESS = 500;
const DAMPING = 30;
const MASS = 0.5;
const W0 = Math.sqrt(STIFFNESS / MASS); // rad/s
// 0.95: underdamped, the only case these constants need.
const ZETA = DAMPING / (2 * Math.sqrt(STIFFNESS * MASS));
const DECAY = ZETA * W0;
const WD = W0 * Math.sqrt(1 - ZETA * ZETA);

export interface Spring {
  pos: number;
  /** px/s */
  vel: number;
  to: number;
  done: boolean;
  from: number;
  v0: number;
  /** performance.now() when the current move began */
  start: number;
  restSpeed: number;
  restDelta: number;
}

export const createSpring = (value: number): Spring => ({
  pos: value,
  vel: 0,
  to: value,
  done: true,
  from: value,
  v0: 0,
  start: 0,
  restSpeed: 0,
  restDelta: 0,
});

/** Moves `s` to `value` at once, dropping any velocity. */
export function jumpSpring(s: Spring, value: number) {
  Object.assign(s, createSpring(value));
}

/** Aims `s` at `to` from where it is now, keeping its velocity (as motion's animate() does). */
export function retargetSpring(s: Spring, to: number, now: number) {
  sampleSpring(s, now);
  const delta = to - s.pos;
  // motion's "granular scale" thresholds for moves under 5px.
  const fine = Math.abs(delta) < 5;
  Object.assign(s, {
    to,
    done: false,
    from: s.pos,
    v0: s.vel,
    start: now,
    restSpeed: fine ? 0.01 : 2,
    restDelta: fine ? 0.005 : 0.5,
  });
}

/** Sets `s.pos` and `s.vel` for time `now`. Returns true once it is at rest, exactly on target. */
export function sampleSpring(s: Spring, now: number): boolean {
  if (s.done) return true;
  const t = Math.max(0, now - s.start) / 1000;
  const delta = s.to - s.from;
  const a = (DECAY * delta - s.v0) / WD;
  const env = Math.exp(-DECAY * t);
  const sin = Math.sin(WD * t);
  const cos = Math.cos(WD * t);
  s.pos = s.to - env * (delta * cos + a * sin);
  s.vel = env * ((DECAY * a + delta * WD) * sin + (DECAY * delta - a * WD) * cos);
  if (Math.abs(s.vel) <= s.restSpeed && Math.abs(s.to - s.pos) <= s.restDelta) {
    s.pos = s.to;
    s.vel = 0;
    s.done = true;
  }
  return s.done;
}

// The lanyard's swing (DESIGN-SPEC 15.3: "drag to swing"), as pure functions so
// the component only reads the pointer and writes a transform.
//
// While held, the card follows the pointer: the lanyard pivots on its anchor
// and the strap stretches with rubber-band resistance. Let go and it is a
// damped pendulum that keeps the speed it was released at, swings through the
// middle a few times and comes to rest. Angles are degrees, spin is deg/s.

export const LANYARD = {
  /** Natural frequency, rad/s: one swing takes about 1.1 s. */
  w: 5.5,
  /** Damping ratio: a few visible swings, then rest. */
  zeta: 0.16,
  /** Under reduced motion it returns once, with no swing (critically damped). */
  reducedZeta: 1,
  /** The fastest release spin kept, deg/s, so a flick can't spin it round. */
  maxSpin: 600,
  /** Release spin is measured over this much of the drag, ms. */
  window: 80,
  /** Fixed integration sub-step, seconds. */
  step: 0.008,
} as const;

export type Swing = { a: number; v: number };

const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// Advances the pendulum by dt seconds in fixed sub-steps, so a dropped frame
// stays stable. sin() keeps large swings slower than small ones.
export function swingStep(s: Swing, dt: number, reduced = false) {
  const zeta = reduced ? LANYARD.reducedZeta : LANYARD.zeta;
  const { w } = LANYARD;
  const n = Math.max(1, Math.ceil(dt / LANYARD.step));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (-(w * w) * (Math.sin(s.a * RAD) / RAD) - 2 * zeta * w * s.v) * h;
    s.a += s.v * h;
  }
}

export const settled = (s: Swing) => Math.abs(s.a) < 0.1 && Math.abs(s.v) < 1;

// The pose for a pointer `x`, `y` px from where the drag started: the lanyard's
// angle, and the strap's length and width. `len` is the strap's resting length,
// `r` the grabbed point's distance below the anchor, `r0` the reach when the
// drag started, so grabbing a swinging card doesn't jump the strap.
export function dragPose(x: number, y: number, len: number, r: number, r0 = r) {
  const dy =
    y > 0 ? 220 * Math.tanh(y / 280) : -len * 0.25 * Math.tanh(-y / 90);
  const dx = 260 * Math.tanh(x / 320);
  const reach = Math.hypot(dx, r + dy);
  const height = Math.max(len * 0.75, len + reach - r0);
  return {
    // || 0: a straight pull gives -0, which would print as "-0deg"
    angle: -Math.atan2(dx, r + dy) / RAD || 0,
    height,
    width: clamp(22 * Math.sqrt(len / height), 16, 22),
    reach,
  };
}

// The pointer offset that poses the lanyard at `angle`: a card grabbed
// mid-swing is held where it was, not snapped to the middle.
export function grabX(angle: number, r: number) {
  const dx = -r * Math.tan(clamp(angle, -80, 80) * RAD);
  return 320 * Math.atanh(clamp(dx / 260, -0.95, 0.95));
}

// The spin at release, from the last few drag samples; 0 when the pointer was
// still, and capped so a flick can't spin it round.
export function releaseSpin(samples: { t: number; a: number }[]) {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((s) => last.t - s.t <= LANYARD.window) ?? last;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return 0;
  return clamp((last.a - first.a) / dt, -LANYARD.maxSpin, LANYARD.maxSpin);
}

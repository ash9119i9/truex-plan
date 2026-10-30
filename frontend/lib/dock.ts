// The floating dock's motion (DESIGN-SPEC 11.9), as pure functions so the
// component only reads the pointer and writes sizes.
//
// Two critically damped springs carry the pointer's position and its presence
// over the bar; each key's size is a pure function of the two, so the swell
// glides in from nothing and deflates in place. Key centres come from the
// resting layout, not live rects, so a growing key never pushes the curve that
// sizes it.

export const DOCK = {
  /** Resting and fully swollen key size, CSS px (19.1: dock geometry is px). */
  base: 40,
  peak: 52,
  /** Pointer distance over which a key swells, px. */
  reach: 140,
  /** Spring stiffness, rad/s; settle time is roughly 5 / ω seconds. */
  wPointer: 11,
  wPresence: 7,
  /** Fixed integration sub-step, seconds. */
  step: 0.008,
  /** The smallest band above the stage's bottom edge that raises the dock, px. */
  rise: 10,
  /** Px above the dock's top edge the pointer may move before it stows. */
  slack: 24,
  /** Share of a key's growth the glyph follows. */
  glyph: 0.6,
} as const;

export type Spring = { x: number; v: number; t: number };

// Cosine falloff: a soft shoulder at the edge of reach instead of a hard ramp.
export function keySize(pointer: number, rest: number, presence: number) {
  const d = Math.min(Math.abs(pointer - rest), DOCK.reach);
  return (
    DOCK.base +
    (DOCK.peak - DOCK.base) *
      presence *
      (0.5 + 0.5 * Math.cos((Math.PI * d) / DOCK.reach))
  );
}

// Centres of `count` resting keys separated by `gap`, relative to the dock's centre.
export function restCentres(count: number, gap: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => (i - (count - 1) / 2) * (DOCK.base + gap),
  );
}

// Advances a critically damped spring by dt seconds in fixed sub-steps, so a
// dropped frame stays stable.
export function spring(s: Spring, w: number, dt: number) {
  const n = Math.max(1, Math.ceil(dt / DOCK.step));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (-w * w * (s.x - s.t) - 2 * w * s.v) * h;
    s.x += s.v * h;
  }
}

export const settle = (s: Spring, eps: number) =>
  Math.abs(s.x - s.t) < eps && Math.abs(s.v) < eps * 10;

// Whether the dock is up after the pointer moves to `fromBottom` px above the
// stage's bottom edge (negative in the gap below it). It rises inside `rise`,
// the empty room it will fill, and stows only once the pointer leaves `reach`,
// the dock's resting top plus the slack, so it does not flicker at the edge.
export function dockOpen(
  open: boolean,
  fromBottom: number,
  reach: number,
  focusInside: boolean,
  rise: number = DOCK.rise,
) {
  if (focusInside) return true;
  return open ? fromBottom < reach : fromBottom <= Math.max(rise, DOCK.rise);
}

// The band that raises a stowed dock: the room it will fill (stage bottom to
// its resting top), cut off at the lowest content above it, so reaching for
// the composer doesn't raise it. Never thinner than DOCK.rise.
export function riseBand(footprint: number, toContent: number) {
  return Math.max(DOCK.rise, Math.min(footprint, toContent));
}

// Magnification is off under reduced motion and on touch (hover: none).
export const magnifies = (m: { reduced: boolean; fine: boolean }) =>
  m.fine && !m.reduced;

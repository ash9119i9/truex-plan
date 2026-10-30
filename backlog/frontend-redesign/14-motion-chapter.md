# Motion chapter

Status: open · Design · Added 2026-10-28 · Spec 8, 19.4

## Gap

Only `--tx-d-1/2/3` (120 / 200 / 320 ms) and `--tx-spring` exist as tokens, and they live in `primitives.css`. The three springs (Confirm ζ 1.00 / 320 ms, Arrive ζ 0.82 / 400 ms, Toggle ζ 0.62 / 480 ms) are design intent, not contract.

## Do

- Lock the three springs as tokens: durations and easing curves, with the ζ and overshoot behind each.
- Move the motion tokens from `primitives.css` into a motion layer of their own, and update the load order (2.1).
- Assign every moving thing in the screens to a spring or a duration, and confirm each has its static twin under reduced motion (8.3).
- Cover the motion the frontend has today that isn't in the spec: the smooth textarea caret and the topbar slimming (0.45 s).

## Done when

The chapter is locked, its tokens ship in the system CSS, and no screen uses a duration or curve outside them.

# Sidebar calendar and shelf continuity

Baseline: `d6e3f45a45e6948873b8a64d0a9453fb2c2f4307`.
T3 reference: `cf3e714b0f58e29c8fa8660db50d2187e3263b65`.

Source inspection found a concrete calendar bug: Truex computes Today/Earlier
from `new Date()` during Sidebar rendering, but the memoized sidebar has no clock
wake when its props stay unchanged. Its Today section can remain yesterday's
Today indefinitely. T3's Sidebar schedules classification changes at meaningful
boundaries (`Sidebar.tsx:2866–2881`, specifically snooze wake boundaries); Truex's
local-midnight schedule is an adaptation for Truex's calendar grouping.

Ordinary panel close/reopen already preserves shelf state. `Panel` always keeps
its children mounted and hides/inerts its aside, so there is no panel-remount bug.
An actual Sidebar remount/page reload resets its expanded choice. T3 retains the
settled shelf's expanded boolean using validated local storage
(`Sidebar.tsx:2916–2925`) while keeping its paging count tied to scope. Truex now
retains only the Earlier shelf's expanded boolean. The ten-row initial window,
25-row page increment, source ordering and selected-row visibility remain.

The new clock owns one timeout for the next local calendar midnight, rather than
a per-second/minute interval. Calendar construction preserves 23/25-hour DST
days. It clears its timer while the document is hidden, recomputes local calendar
state on visibility/focus (including a changed time zone), and removes timer and
listeners on unmount. Closed sidebar panels still retain the component and its
one visible-document midnight timer; no hidden-panel CPU benefit is claimed.

Storage contains one validated presentation boolean under
`truex-sidebar-earlier-expanded`, without account/session IDs, titles or chat
text. Unknown/denied storage keeps the previous expanded default; denied writes
leave the mounted shelf usable. It is read after mount to preserve the existing
server/hydration default. This increment does not synchronize preference changes
across tabs or retain transcript data.

## Executable evidence

`sidebar-lifecycle.test.ts` loads the actual Sidebar, helpers and clock hook in
an isolated TypeScript/JSX/hook harness with a fake wall clock, browser events,
timeouts and test-owned preference storage. Neither user storage nor network is
contacted. The same three regressions fail on baseline and pass on candidate:
unchanged-props midnight transition, actual remount shelf preference, and hidden
resume/cleanup. Raw outputs are `next-sidebar-red-tests.txt` and
`next-sidebar-paired-after.txt`.

The broader candidate run (`next-sidebar-tests-after.txt`) passes thirteen tests:
calendar/group/row-window behavior, midnight, hidden resume, listener/timer
cleanup, 23/25-hour DST boundaries, a focus-time zone change, invalid preference
and denied storage. `next-sidebar-format.txt` records scoped format validation.
The final frontend typecheck passes (`next-sidebar-typecheck.txt`). This harness does not measure React commits, browser paint,
actual OS time-zone events or cross-browser geometry.

Reproduce from the repository root:

```sh
git show d6e3f45a45e6948873b8a64d0a9453fb2c2f4307:frontend/components/v2/sidebar.tsx > /tmp/next-sidebar-before.tsx
TRUEX_SIDEBAR_SOURCE=/tmp/next-sidebar-before.tsx node --experimental-strip-types --test --test-name-pattern='^(unchanged memoized|collapsed shelf preference|hidden sidebar clock)' frontend/test/sidebar-lifecycle.test.ts
node --experimental-strip-types --test --test-name-pattern='^(unchanged memoized|collapsed shelf preference|hidden sidebar clock)' frontend/test/sidebar-lifecycle.test.ts
node --experimental-strip-types --test frontend/test/sidebar-lifecycle.test.ts frontend/test/sidebar.test.ts
npm --prefix frontend run typecheck
```

## Scoped performance review

Source inspection shows stable Sidebar callbacks and metadata props plus
memoized rows. The stream text path does not change the `sessions` array;
list refresh happens on sidebar/search opening, creation/send/commands and
explicit mutation/retry, not on each text delta. `useProjects` returns a fresh
facade but its state fields used in `renderSessionMenu` dependencies remain
stable on transcript-only updates. This is source evidence, not a measured
React-rerender count; a new navigation metadata API is not justified here.

`useFollowActivity` already holds current options in refs and uses one bounded
burst timer for semantic goal/plan/helper changes; text events do not create
follow timers. `SmoothTextarea` geometry effects depend on input value/disabled
and a stable update callback, not transcript text. Typing still performs mirror
measurements through value/selection/resize paths, but there is no controlled
browser profile establishing a cost or redundant layout work in this pass.
Composer state extraction and geometry batching remain profile-gated, with no
new authoritative-input debounce or guessed optimization introduced.

There are no backend/API/dependency or migration changes. Rollback is a normal
code rollback; the optional boolean preference can remain harmlessly stored.

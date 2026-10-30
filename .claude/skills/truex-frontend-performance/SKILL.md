---
name: truex-frontend-performance
description: Audits and improves how fast the Truex frontend loads and how light it feels - Lighthouse scores, Core Web Vitals (LCP, INP, CLS), TTFB, JavaScript and CSS bundle size, fonts, images, caching and compression, prefetching and navigation, hydration and long tasks, perceived speed (instant feedback, loading states, smooth streaming text, animation), long-session memory, mobile and slow networks, and real-user measurement. Use when asked to "get Lighthouse to 100", "make the frontend faster or lighter", "reduce bundle size", "why is LCP/INP/CLS bad", "why does the app feel slow", for a frontend performance audit, or before shipping a change that adds a dependency, a font, an image, an animation or a new route. Lists measured findings and waits for approval before editing. Per-frame render rules while a reply streams live in truex-frontend; server latency behind /api lives in truex-backend-performance.
---

# Truex Frontend Performance

## Core rule

No measurement, no change. A performance claim is a number with its mode, machine and run count, or it is marked **unverified**. A change that does not move its number beyond run-to-run noise is reverted, however sure the reasoning was.

Speed has two halves and the skill covers both:

| Half | Question | Measured by |
|---|---|---|
| **Load** | How fast does the page arrive and become usable? | Lighthouse (lab), Web Vitals from real sessions (field), bytes per route |
| **Feel** | Does every action answer at once, and does nothing flash, jump or stutter? | Traces in a real browser, interaction timings, frame rate, the feel checklist |

A Lighthouse 100 with a composer that lags while typing is not done. Neither is a smooth chat behind a 4-second login page.

## Targets

Targets differ by route class, because Lighthouse can only judge what it can load cold.

| Route class | Routes | Target |
|---|---|---|
| Public | `/login`, `/invite/[token]`, `/_not-found`, `/` | Lighthouse **mobile** Performance, Accessibility and Best Practices 100 (median of 5 runs, `next start`). SEO 100 only on pages meant to be indexed: an invite page should carry `noindex`, which correctly costs SEO points. |
| Signed in | `/t/[tenantId]/chat`, `/t/[tenantId]/connected-tools`, `/select-tenant`, `/connected-tools` | Lighthouse mobile Performance ≥ 90 as a regression guard, with a scripted sign-in ([measure.md](references/measure.md)). Real targets are Web Vitals at p75: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, plus the feel targets below. |
| Every route | all | First-load JS and CSS never grow more than 1% (gzip) without a named reason. Budgets ratchet down after each win. |

Feel targets (from [feel.md](references/feel.md)), checked on a throttled mid-range phone profile (4× CPU, Slow 4G):

- Visible response to any click, key or send within 100 ms.
- Typing in the composer never drops or delays a character, including while a reply streams.
- No layout shift, theme flash or font jump on first paint.
- Steady frame rate while scrolling and while text streams: no frame over 50 ms (no long animation frame).
- A 500-message chat scrolls and types like a 5-message chat. The heap returns to its baseline after opening and closing 20 chats.

Stricter "aim" numbers (LCP ≤ 1.2 s, INP ≤ 100 ms, CLS ≤ 0.02) are proposals. Confirm them with the user before treating a miss as a finding.

## Scope and hand-offs

| Topic | Owner |
|---|---|
| Load path, bytes, fonts, CSS, images, caching, prefetch, navigation, hydration, long tasks on load, motion, paint stability, long-session memory, mobile, slow network, RUM | **this skill** |
| Re-renders and parse cost per stream frame, React and Next idioms, accessibility rules (R, X, N, E, A rules) | `truex-frontend`: cite its rule IDs, do not restate them |
| Anything behind `/api` (platform-next, runtime-adapter, model gateway latency) | `truex-backend-performance` |
| Driving Chrome, traces, network panel | `truex-browser-testing-with-devtools` |
| Shipping RUM data: endpoint, storage, dashboards, alerts | `truex-observability-and-instrumentation` |
| A performance change that touches the CSP, tokens, cookies, a service worker or a third-party origin | flag it, and have `truex-secure` look before merge |

Not for the old-stack frontend code. Before editing any file, run the reachability check from `truex-frontend`:

```bash
node .claude/skills/truex-frontend/scripts/reachable.mjs <file>
```

## Truex frontend facts that shape performance work

Checked 2026-10-29:

| Fact | Consequence |
|---|---|
| Next 16.3.5 with Turbopack, React 19, Strict Mode, no React Compiler | Read the Next page under `frontend/node_modules/next/dist/docs/` before touching any Next API or config option (`frontend/AGENTS.md`). |
| First-load JS (uncompressed, `next build` 2026-10-29): `/t/[tenantId]/chat` 998,611 bytes; `/t/[tenantId]/connected-tools` 530,223; `/` 493,202; `/login` 489,701; `/_not-found` and `/invite/[token]` 463,341 | The chat route ships about twice the base. The base itself (about 463 KB) is the floor every public page pays. Measure gzip and brotli with `scripts/route-weight.mjs`. |
| Live code has no `next/dynamic` or `import()` | Every component a route can show is in its first load. |
| `react-markdown` + `remark-gfm` (the unified chain) and `motion` are the large runtime dependencies | Check which routes carry them, and whether each route needs them for first paint. |
| Fonts load from a render-blocking Google Fonts stylesheet in `app/layout.tsx` (three families, variable axes), on purpose not `next/font` because it renames families and breaks the `--f-*` tokens | This is likely the largest single cost on public routes (two extra origins before text paints). Self-hosting the same families keeps the token names. Measure it before claiming it. |
| A theme boot script runs inline in `<head>` (`lib/theme-boot.ts`) | No theme flash today. Keep it first in `<head>`, small, and free of imports. |
| The icon sprite is inline in every page's HTML (`components/tx/icon.tsx`) | It costs HTML bytes on each navigation but no request. Compare with a cached external sprite only if HTML size matters in the trace. |
| Styles: Tailwind 4 plus plain CSS in `styles/system/*.css` and `styles/app/*.css`, imported by `app/globals.css` (about 256 KB of source) | Unused rules ship to every route. Coverage in DevTools shows how much. |
| The access token lives only in tab memory. The refresh cookie rotates on every refresh, and a replayed old cookie is treated as stolen after 30 s (`lib/auth.ts`) | Signed-in pages cannot be server-rendered with user data. Lighthouse on them must reuse one live browser profile, never a copied cookie ([measure.md](references/measure.md)). |
| Production runs `next start` in Docker (`frontend/Dockerfile`), and Next compresses with gzip by default | Brotli and HTTP/2 or HTTP/3 depend on whatever proxy sits in front. That is unknown from the repo, so ask or test the deployed URL. |
| CSP is set in `next.config.ts` (`frame-src`, `object-src`, `base-uri` only) | Adding a third-party script, font host or worker is a CSP and privacy decision, not just a performance one. |

## Process

### Step 1: Frame

Pick the mode and say it:

- **Audit:** the whole frontend, every route class. The output is a ranked findings list.
- **Review:** one diff. Measure only what it can affect: bytes for imports, LCP and CLS for layout and fonts, INP for handlers, feel for UI.
- **Fix:** one approved finding.

Name the routes, the device profile (mobile Lighthouse default, or the throttled phone) and the target from the table above.

### Step 2: Baseline before the first edit

Follow [measure.md](references/measure.md):

1. Production build (`next build`, restore `next-env.d.ts`), then `scripts/route-weight.mjs --save`.
2. Lighthouse 5 runs per route on `next start`, summarized with `scripts/lh-summary.mjs`.
3. A DevTools performance trace of each feel scenario that applies.
4. Field data, if RUM exists. It does not today (rule U1).

For a diff that already exists, build the baseline in a separate worktree. Never stash or check out in the user's tree.

### Step 3: Locate

Use the triage table, then the matching rules in [rules.md](references/rules.md) and [feel.md](references/feel.md). Confirm the cause in a trace, the network waterfall, coverage or the module graph before proposing a fix.

| Symptom | Look at | Rules |
|---|---|---|
| Low FCP / LCP | Waterfall before first paint: render-blocking CSS, the font stylesheet, third-party origins, TTFB, LCP element discovery and priority | L, S, W |
| High TBT, slow INP | Long tasks: hydration, large chunks parsed on load, handlers doing layout or parse work | J, and `truex-frontend` R, X |
| CLS above 0 | Layout shift entries: font swap, late panels, images without size, skeletons that don't match | P, M, L4 |
| A route's JS grew | `next experimental-analyze` module graph, duplicate packages, client boundary too high | J |
| Slow navigation between screens | Prefetch, client cache, waterfalls in the next screen's data fetches | V, S |
| "Feels sluggish" with good scores | Interaction traces, missing optimistic UI, late spinners, input waiting on render | F, T |
| Text stutters while streaming | Commits per frame, long animation frames during the stream | T, `truex-frontend` R1–R5 |
| Slower after an hour, or in long chats | Heap snapshots, DOM node count, listeners, timers | G |
| Fine on a laptop, bad on a phone | 4× CPU throttle, Slow 4G, virtual keyboard, touch | D |

### Step 4: Propose, then stop

Write the findings in the format in [report-template.md](references/report-template.md). Rank them by **measured gain × share of users affected ÷ cost and risk**. Each finding has a rule ID, `file:line`, evidence (**measured**, **read** or **unverified**), the predicted gain in the metric it moves, the fix, its cost, and the guard.

**Wait for the user to approve which fixes to make.** Do not edit before that.

### Step 5: Change one thing, re-measure

- One finding per change, so each number can be attributed.
- Same build mode, same machine, same run count. Keep the change only if the median moves beyond the spread of the baseline runs.
- Log every attempt, kept or reverted, in the attempts ledger, so nobody tries a disproven idea again.
- Prefer removing work over speeding it up: fewer bytes, fewer requests, fewer origins, fewer renders, less JS on first load.

### Step 6: Guard

Add at least one guard, as close to the cause as possible:

- A saved byte baseline compared with `route-weight.mjs --compare`, run after builds.
- A `node:test` test asserting a work count (markup size, a module not in a route's chunks, a component not mounted until opened).
- A RUM metric with a p75 alert, once RUM exists.

### Step 7: Verify

Run from the repository root:

```bash
npm --prefix frontend run typecheck
npm --prefix frontend test
cp frontend/next-env.d.ts /tmp/next-env.d.ts.orig && npm --prefix frontend run build; cp /tmp/next-env.d.ts.orig frontend/next-env.d.ts
npx prettier --check <each changed file under frontend/>
```

Then look at every visible change in a browser. Check both themes, a narrow width, reduced motion, keyboard only, and a throttled phone profile. Report the counts each command printed. Do not commit.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Lighthouse says 100, we're done" | Lighthouse loads one cold page and clicks nothing. INP, streaming smoothness and long sessions are invisible to it. |
| "One Lighthouse run is enough" | Scores move several points between identical runs. Use the median of 5, and report the spread. |
| "It's fast on my machine" | A laptop is several times faster than the median phone. Throttle CPU 4× and the network to Slow 4G. |
| "`next dev` shows it's slow" | Dev builds are unminified, Strict Mode doubles effects, and nothing is cached. Measure `next start`. |
| "Lazy-load everything" | Each split adds a request and a wait when the code is needed. Split what is rare and heavy; preload what is needed soon. |
| "Add `will-change` / a spinner / a skeleton everywhere" | Each costs memory, paint or attention. Use them where a trace or the feel check shows a gap. |
| "A service worker will make it instant" | With in-memory tokens and rotating cookies, a caching mistake serves one person's data to another or breaks sign-in. Hashed static assets are already cached immutably. |
| "Self-hosting fonts is obviously faster" | Probably, but prove it with a waterfall and LCP before and after, and keep the family names the tokens use. |
| "The bundle grew 3%, that's noise" | Bytes are deterministic. A growth with no reason is a finding. |

## Red Flags

- A claim of "faster" with no before/after number, mode and run count
- A Lighthouse number from `next dev`, from one run, or from desktop when the target is mobile
- A new dependency, font family, font axis range, third-party origin or script added without the user's agreement
- `next/dynamic` on something needed for first paint, or a split with no measured saving
- An image or late panel with no reserved size; a skeleton that does not match the final layout
- An animation of `top`, `left`, `width`, `height` or `margin`, or one that ignores reduced motion
- Prefetch or speculation that could trigger a request with side effects
- A service worker that caches `/api` or `/auth`, or HTML for signed-in pages
- A copied refresh cookie used to script Lighthouse
- A RUM payload carrying message text, file names, emails or tokens
- `frontend/next-env.d.ts` left changed by a build
- An edit made during audit or review before the user approved it

## Verification

- [ ] Mode, routes, device profile and targets were named
- [ ] Baseline recorded before the first edit (bytes, Lighthouse median of 5, traces for the feel scenarios that apply)
- [ ] Every finding has a rule ID, evidence label and predicted gain; nothing was edited before approval
- [ ] Each kept change moved its metric beyond baseline spread; reverted attempts are in the ledger
- [ ] A guard was added for each kept change
- [ ] `typecheck`, `npm test`, `build` and Prettier on changed files passed, with counts reported; `next-env.d.ts` unchanged
- [ ] Visible changes were checked in both themes, narrow width, reduced motion, keyboard only and on a throttled phone profile, or the report says why not
- [ ] Security-relevant changes (CSP, origins, workers, cookies, RUM payloads) are named for review
- [ ] Nothing committed; no old-stack files changed

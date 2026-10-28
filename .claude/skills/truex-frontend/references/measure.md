# Measuring the Frontend

Prefer **work counts** (bytes shipped, characters parsed, components rendered, reducer calls) over timings. Work counts are the same on every machine and every run, so a test can assert them. Timings vary with the machine and its load: report them as medians with the machine and mode, and never assert them in `npm test`.

Every comparison is before and after on the same machine, same mode, same fixture. Record the baseline **before the first edit**. For a diff that already exists, build the baseline in a separate worktree; never use `git stash`, `git checkout` or `git restore` in the user's tree:

```bash
git worktree add --detach /tmp/truex-fe-base <base-commit>
npm --prefix /tmp/truex-fe-base/frontend ci
# ... measure there, then:
git worktree remove /tmp/truex-fe-base
```

## Bundle size

`next build` writes the first-load JavaScript of every route to `frontend/.next/diagnostics/route-bundle-stats.json`. `next build` also rewrites `frontend/next-env.d.ts` (it switches the `.next/dev/types` imports to `.next/types`), so copy it first and put it back after:

```bash
cp frontend/next-env.d.ts /tmp/next-env.d.ts.orig
npm --prefix frontend run build
cp /tmp/next-env.d.ts.orig frontend/next-env.d.ts && cmp /tmp/next-env.d.ts.orig frontend/next-env.d.ts
node -e 'for (const r of require("./frontend/.next/diagnostics/route-bundle-stats.json")) console.log(r.route, r.firstLoadUncompressedJsBytes)'
```

Baseline on 2026-10-28: `/t/[tenantId]/chat` 914,766 bytes; `/t/[tenantId]/connected-tools` 506,516; `/` 482,326; the rest 455,898–482,326. Report the change for each route the diff affects.

To see which import pulled a module in: `cd frontend && npx next experimental-analyze --output` writes the module graph to `frontend/.next/diagnostics/analyze` (`npx next experimental-analyze` without `--output` opens the interactive view).

## Markdown parse work

`docs/performance/t3-chat/benchmark-streaming-markdown.mjs` streams 80 appends through the real react-markdown + remark-gfm pipeline, with and without the incremental plugin, and prints `parsedChars` (deterministic) and median render/parse times (machine-dependent):

```bash
node --experimental-strip-types docs/performance/t3-chat/benchmark-streaming-markdown.mjs --repo . --mode full
node --experimental-strip-types docs/performance/t3-chat/benchmark-streaming-markdown.mjs --repo . --mode incremental
```

Use `--repo /tmp/truex-fe-base` for the baseline. Its fixtures are a code-heavy reply and a prose reply; for a change to streaming text, compare `parsedChars` for both.

## Render tests in Node

The frontend has no DOM test environment. Components are tested by server rendering them: `component("<path under components/>")` from `frontend/test/next-details-runtime.ts` compiles the real TSX, and `renderToStaticMarkup` renders it. Examples: `frontend/test/follow-up-rows.test.ts`, `frontend/test/login-render.test.ts`.

What they can prove:

- **What is mounted:** markup size, and that hidden content is absent. `frontend/test/next-details.test.ts` ("closed reasoning excludes the full body and never joins or counts it") renders 900,000 characters closed and asserts the markup stays under 1,200 bytes.
- **What is not computed:** make the unwanted work throw. The same test redefines `parts.map` to throw, proving the closed view never walks the parts.
- **Roles and labels:** assert `role`, `aria-*` and accessible names in the markup, as `login-render.test.ts` does.
- **Before and after:** set `NEXT_DETAILS_BASELINE_DIR` to a directory holding the original copies of changed component files (same relative paths under `components/`, exported with `git show <base>:frontend/components/<file>`). The same tests then run against the originals. A regression test should fail there and pass on the change.

What they cannot prove: effects, event handlers, re-render counts, layout, scrolling, focus. Those need a browser.

## Reducer and stream work

Pure functions in `frontend/lib/` (`applyStreamEvent` and the rest of `tenant-chat.ts`, `createSseParser` and `followRun` in `tenant-chat-stream.ts`) are tested directly in `frontend/test/*.test.ts`.

- **Identity:** after a frame that changes one item, assert every other item is the same object (`assert.equal(after.items[0], before.items[0])`). Memoized rows depend on it.
- **Scaling:** apply N frames for N = 100, 1,000, 10,000 and assert a count that must not grow with history (items copied, reducer calls, publishes), never a time.
- **Streams:** `followRun` takes `auth`, `sleep` and `silenceMs` dependencies; `frontend/test/tenant-chat-stream.test.ts` drives reconnects and silence without real waiting.

## In the browser

Runtime behaviour (re-renders per frame, long tasks, INP, heap growth, focus, scroll) is measured in a real browser with DevTools (Performance panel, React DevTools Profiler, Memory).

- Run `npm run dev:next` at the root and sign in at `http://localhost:3000` with a test-only Google account. There is no credential-free demo for the new stack.
- A reply needs a model. Real model replies cost money: ask before running them, and use the same prompt for before and after.
- `next dev` is a development build with Strict Mode (effects run twice). Its numbers can only be compared with other `next dev` numbers. Say which mode you measured.

Scenarios and what to read:

| Scenario | Read | Target |
|---|---|---|
| A reply streams in a chat with 20+ saved exchanges | Profiler: which components commit per frame | Saved exchanges: 0 renders per frame |
| A long prose reply (no code fence) streams | Performance: scripting time per frame, long tasks | No task over 50 ms; time per frame does not keep growing with reply length |
| Typing in the composer while a reply streams | INP of keystrokes | Under 200 ms (Web Vitals "good") |
| Reconnect (network offline, then online) mid-reply | Commits after the snapshot | One commit for the snapshot, not one per replayed item |
| Open and close 20 chats, then collect garbage | Memory: heap snapshot comparison | Heap returns near the first snapshot; no detached transcript nodes |
| Scroll up while streaming, then load earlier messages | The view | Position holds; nothing jumps |

Record the browser, viewport, mode and the number for each scenario run. A scenario you could not run is reported as not measured, with the reason.

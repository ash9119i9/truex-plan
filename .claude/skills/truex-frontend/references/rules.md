# Frontend Rules

Each rule has an ID for review findings (`R3`, `A2`), the reason it matters in this app, and how to check it. A rule is a default: break it when a measurement says so, and write down the measurement.

Rules marked **(today)** describe something the live code does not do yet. They apply to new code; changing the existing code is a separate, measured task.

## R: Rendering while streaming

The chat receives one SSE frame per delta. Whatever a frame touches renders once per frame, for the whole reply.

| ID | Rule | Why here | Check |
|---|---|---|---|
| R1 | Work per stream frame is proportional to the frame, not to the transcript. | `setLive` runs on every frame (`components/tenant/tenant-chat.tsx`, the `followRun` effect). Anything that walks every exchange on every frame grows with chat length. | Count what one frame re-renders (React Profiler, browser), or count calls in a render test. |
| R2 | Saved exchanges do not re-render while another reply streams. Memoize the row component, and pass it props that keep their identity between frames. | `Exchange` in `chat-transcript.tsx` is not memoized and receives `filesOfRun(...)`, a new array per render **(today)**. | Profiler "why did this render"; a memoized row with an inline array or object prop is still a finding. |
| R3 | Markdown that has stopped changing is not parsed again. | `StreamingMarkdown` is `memo` on `text` and `streaming`; keep both props primitive and stable. | A saved reply's `StreamingMarkdown` gets the same `text` string every render. |
| R4 | The streaming reply's parse cost does not grow with the square of its length, for the reply sizes the product allows (reply text is capped at 1,000,000 characters in `applyStreamEvent`). | The incremental remark plugin only switches on when the text contains a code fence (`streaming-markdown.tsx`); prose is re-parsed in full each frame **(today)**. | Measure a long fenced and a long unfenced reply; see [measure.md](measure.md). Options: per-frame batching, `useDeferredValue` on the text, or widening the incremental path. |
| R5 | Many frames between two paints cause one state update, not one each. | The old stack batched frames per animation frame (`lib/ordered-batch.ts`); the new chat applies each frame on arrival **(today)**. | Reducer-level test: N frames, one publish. Browser: a burst does not produce N commits. |
| R6 | Stream reducers copy only what changed. | `applyStreamEvent` (`lib/tenant-chat.ts`) returns a new reply per frame; an unchanged item must keep its object identity so memoized children skip it. | Unit test: after a delta to item B, item A is the same object (`assert.equal`). |
| R7 | Scroll position is written in a layout effect keyed on what changes height, and only when the reader is at the end. | `Transcript` keeps `stick` within `STICK_PX` of the end and an `anchor` when older messages load. A new height source (card, image, file chip) that is not in the effect's dependencies leaves the view jumping. | Add the new height source to the effect's dependency list; check in a browser while streaming and while scrolled up. |
| R8 | Long histories stay paged ("Load earlier messages"), not fully mounted. | The new transcript has no list virtualization **(today)**. Paging is what bounds the DOM. | A change that loads all history at once is a finding unless measured. |

## X: React 19

React 19.3, Strict Mode on (App Router default: effects run twice in development), **no React Compiler** (`next.config.ts` has no `reactCompiler`), so memoization is manual.

| ID | Rule | Check |
|---|---|---|
| X1 | Derive values during render; do not copy props or other state into state with an effect. | An effect whose only job is `setX(f(props))` is a finding. |
| X2 | Reset a subtree with a `key`, not with effects that clear state. | Existing pattern: `<TenantWorkspace key={tenantId}>` in `app/t/[tenantId]/layout.tsx`. |
| X3 | Callbacks passed to memoized children are stable (`useCallback` with honest dependencies). Objects and arrays passed to them are memoized or hoisted. | `tenant-chat.tsx` keeps `loadOlder`, `navigate` and `fileActions` stable for this reason. |
| X4 | Read external mutable state with `useSyncExternalStore`. | Existing pattern: `lib/use-theme.ts`. |
| X5 | Async results check they still belong to the current request before writing state. | Existing patterns: the request counter in `CopyTextButton` (`streaming-markdown.tsx`), `identityGeneration()` in `lib/tenant-chat-stream.ts`, `mine(current)` in the `followRun` effect. |
| X6 | List keys are stable IDs, never array indexes for rows that can be inserted, removed or reordered. | `exchangeKey(exchange)` in `chat-transcript.tsx`. |
| X7 | Non-urgent updates that are expensive to render (filtering, large markdown) may use `startTransition` or `useDeferredValue`; urgent input (typing in the composer) never waits on them. | Measure before and after; neither is used in live code yet. |
| X8 | An event handler read inside an effect, that should not re-run the effect when it changes, uses `useEffectEvent` (React 19.2+) or a ref, not a missing dependency. | A disabled exhaustive-deps comment, or a dependency left out on purpose, is a finding. |
| X9 | Use React 19 forms: `ref` as an ordinary prop (no new `forwardRef`), `<Context value>` as the provider. | New `forwardRef` or `Context.Provider` in new code. |

## N: Next 16 (App Router, Turbopack)

Next 16.3 differs from older Next. Before using any Next API, read its page under `frontend/node_modules/next/dist/docs/` (the instruction in `frontend/AGENTS.md`).

| ID | Rule | Check / doc |
|---|---|---|
| N1 | `page.tsx` and `layout.tsx` stay server components that render one client root. Put `"use client"` on the component that needs it, not on a layout. | `01-app/01-getting-started/05-server-and-client-components.md`, `02-guides/server-and-client-boundary.md` |
| N2 | `params` and `searchParams` are Promises: `await` them in server components. | `app/t/[tenantId]/layout.tsx` |
| N3 | Platform data is fetched in the browser through `lib/api.ts`. The access token lives only in the tab's memory (`lib/auth.ts`), so a server component cannot call the platform as the user. Adding server-side platform fetches is a design decision, not a refactor. | Any `fetch` to the platform from a server component or route handler other than the forwarders. |
| N4 | The browser calls only this origin: `/api/*` and `/auth/*` are forwarded by `lib/forward.ts`. Never call `platform-next` or `PLATFORM_INTERNAL_URL` from client code. | `PLATFORM_INTERNAL_URL` or port 4100 in a client file. |
| N5 | Route-level errors land in `app/error.tsx` (uses `retry ?? reset`, Next 16.3+); root layout errors in `app/global-error.tsx`. A component that can fail on bad data shows its own inline error and keeps the rest of the chat usable. | `01-app/01-getting-started/10-error-handling.md` |
| N6 | Fonts load from the stylesheet link in `app/layout.tsx` on purpose (its comment: `next/font` renames families and breaks the `--font-*` tokens). Do not switch to `next/font` without changing the tokens. | `01-app/01-getting-started/13-fonts.md` |
| N7 | User images are shown from object or blob URLs with plain `<img>` and real `alt` text. `next/image` does not apply to them. | `01-app/01-getting-started/12-images.md` |
| N8 | Security headers are set in `next.config.ts`. A frontend change that needs a new source (image host, frame, script) is a CSP change: name it in the report. | `02-guides/content-security-policy.md` |

## B: Bundle and loading

Measured 2026-10-28 (`next build`): the chat route's first load is 914,766 bytes of uncompressed JavaScript; every other route is 455,898–506,516. Live code has no `next/dynamic` or `import()`.

| ID | Rule | Check |
|---|---|---|
| B1 | A new dependency or a new import of a large module reports the change in `firstLoadUncompressedJsBytes` for each affected route. | [measure.md](measure.md), bundle section |
| B2 | Code needed only after an interaction (file viewer, agent dialog, connected tools forms) or only for some replies may be loaded with `next/dynamic`, if the measured saving is worth the delay. | `02-guides/lazy-loading.md` |
| B3 | Import named members from icon and utility packages; check with the analyzer that the whole package is not bundled. | `02-guides/package-bundling.md`, `optimizePackageImports` |
| B4 | No new dependency without the user's agreement. Pin it exactly. | `frontend/package.json` diff |

## E: Effects and resources

| ID | Rule | Check |
|---|---|---|
| E1 | Every effect that subscribes, listens, opens a stream, starts a timer or creates an object URL returns a cleanup that undoes it. | `followRun` returns its stop function; `URL.createObjectURL` pairs with `revokeObjectURL` (`components/tenant/file-card.tsx`, `file-viewer.tsx`). |
| E2 | Stream reads use `fetch` with an `AbortController` (EventSource cannot send the bearer token). Leaving a chat aborts the read. | `lib/tenant-chat-stream.ts` |
| E3 | Reconnects back off and stop: `RECONNECT_DELAYS_MS` and `MAX_RECONNECTS`, then the person chooses Reconnect. No new unbounded retry loop. | A `while`/`setInterval` retry without a cap. |
| E4 | State that grows with the session (events, items, helpers, files) has a cap. | Existing caps: `MAX_HELPERS`, the 1,000,000-character text bound. A new collection without one is a finding. |
| E5 | Timers and listeners created outside React (module scope, `window`) are created once and released on sign-out or tenant change. | `identityGeneration()` changes on identity change. |

## A: Accessibility

| ID | Rule | Check |
|---|---|---|
| A1 | Streamed text is not announced token by token. The transcript is `role="log"` with `aria-live="off"`; outcomes ("Reply finished.", errors) go to the one polite status region in `tenant-chat.tsx` (`setAnnouncement`). | A new `aria-live` on content that updates per frame. |
| A2 | Every control is a real `<button>` (with `type="button"` outside forms) or link, reachable by Tab, with a visible `:focus-visible` style. | `div`/`span` with `onClick`; a new control with no focus style in the CSS. |
| A3 | Icon-only buttons have an `aria-label`; toggles use `aria-pressed` or `aria-expanded`. | Existing pattern: "Wrap lines" uses `aria-pressed`. |
| A4 | Dialogs and drawers: focus moves in when opened, Escape closes, focus returns to the control that opened it. Modal dialogs also have `role="dialog"`, `aria-modal="true"` and a label. | Dialog: `tenant-agent-dialog.tsx` (`aria-labelledby`). Drawer: the mobile drawer effect in `tenant-chat.tsx` (focus in, Escape, focus back to the toggle). Check focus return in a browser. |
| A5 | Hidden panels are `inert` and `aria-hidden`, so Tab cannot reach them. | `components/v2/shell.tsx` |
| A6 | Errors are text near what failed, announced (`role="alert"` for blocking errors, `role="status"` for progress), and say what to do next. | "Couldn’t copy. Select the text and copy it." in `CopyTextButton`. |
| A7 | Motion respects `prefers-reduced-motion` in CSS and in `motion` animations. | `@media (prefers-reduced-motion` in the CSS that styles the component. |
| A8 | Text and focus indicators meet WCAG AA contrast (4.5:1 text, 3:1 large text and UI) in both `data-theme` values, using the tokens in `frontend/styles/v2/tokens.css`. | Check both themes in a browser. |
| A9 | A new window-level shortcut (other than Escape to close) does not fire while the person is typing in an input, textarea or contenteditable. | The handler checks `event.target`. |

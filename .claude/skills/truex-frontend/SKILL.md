---
name: truex-frontend
description: Writes and reviews code in the Truex frontend (frontend/, Next 16 App Router, React 19) for rendering performance while replies stream, React and Next practices, bundle size and accessibility. Use when building or changing anything under frontend/, when the chat is slow, janky or jumps while streaming, when a route's JavaScript grows, or when asked to review frontend code, "why does this re-render", "is this idiomatic React/Next", or whether a screen is accessible. Reviews list findings and wait for approval before editing. Not for backend latency or trust-boundary abuse.
---

# Truex Frontend

## Overview

The chat screen does its hardest work while a reply streams: one server-sent event per delta, each one a state update. Code that is fine for a static page re-renders the whole transcript, re-parses the whole reply or grows without bound when it runs on every frame of a long reply in a long chat. This skill holds the frontend to written rules ([rules.md](references/rules.md)), measures what can be counted, and checks the rest in a real browser.

## When to Use

- Building or changing anything under `frontend/` in the new stack
- The chat stutters, freezes, jumps while scrolling, or slows down as a chat grows
- A change adds a dependency, a heavy import, a list, an effect, a stream handler, a dialog or a form
- Reviewing a frontend diff

**NOT for:**
- Platform, adapter or gateway latency: those are measured on the server.
- Tokens, tenant crossing, injected content in rendered model output, CSP weakening: note the suspicion in the report and stop there.
- The old-stack frontend code (see below): stop and ask.

## Truex New Stack

```text
frontend (3000, tenant chat in app/t/[tenantId])
   → platform-next (4100, NestJS + MongoDB: auth, tenants, agents, chats)
   → runtime-adapter (4400, one pinned Codex app-server per chat)
   → codex app-server (vendor/codex, never modified)
   → model-gateway (4200, Responses ↔ provider APIs)
```

Frontend facts that change how code is written:

| Fact | Consequence |
|---|---|
| Next 16.3 (Turbopack), React 19.3, Strict Mode on, no React Compiler | Memoization is manual. Effects run twice in development. |
| `frontend/AGENTS.md`: "This is NOT the Next.js you know" | Before using any Next API, read its page under `frontend/node_modules/next/dist/docs/`. Do not write Next code from memory. |
| The access token lives only in the tab's memory (`lib/auth.ts`); the browser calls only this origin's `/api` and `/auth` forwarders (`lib/forward.ts`) | Pages are thin server components; the app below them is client code that fetches through `lib/api.ts`. |
| Replies stream over `fetch` + SSE (`lib/tenant-chat-stream.ts`), each frame applied with `applyStreamEvent` (`lib/tenant-chat.ts`) | Per-frame cost is the main performance budget. |
| Styles are plain CSS in `frontend/app/*.css` and `frontend/styles/v2/*.css` (Tailwind 4 is imported first in `app/globals.css`); tokens in `styles/v2/tokens.css`, light and dark via `data-theme` | Follow the CSS files a component already uses. |

**Live code vs old code.** `frontend/` still holds the old stack's chat (`legacy/chat.tsx`, `components/chat-messages.tsx`, `lib/chat.ts`, `lib/transport.ts`, `lib/ordered-batch.ts`, most of `components/v2/` and others). No route imports it. Check any file before editing or copying from it:

```bash
node .claude/skills/truex-frontend/scripts/reachable.mjs frontend/components/tenant/chat-transcript.tsx   # reached
node .claude/skills/truex-frontend/scripts/reachable.mjs --unreached                                      # all old files
```

The live chat:

| File | Role |
|---|---|
| `app/t/[tenantId]/layout.tsx`, `chat/page.tsx` | Server components; render `TenantWorkspace` (keyed by tenant) and `TenantChat` |
| `components/tenant/tenant-chat.tsx` | Screen state: chats, open thread, live reply, drafts, the `followRun` effect, the status announcement |
| `components/tenant/chat-transcript.tsx` | `Transcript` (memoized), `Exchange`, saved and live reply bodies, scroll stick and anchor |
| `components/streaming-markdown.tsx` + `lib/markdown-incremental.ts` | Memoized markdown; incremental parse only when the streaming text has a code fence |
| `components/tenant/chat-composer.tsx`, `file-viewer.tsx`, `tenant-agent-dialog.tsx` | Composer, file panel, agent dialog |

Rules marked **(today)** in [rules.md](references/rules.md) are places where the live chat does not meet the rule yet (R2, R4, R5, R8). They were found by reading the code, not measured. Do not fix them inside an unrelated task; propose them as their own measured change.

## Process

### Step 1: Scope

1. List the changed or target files and the routes that load them. Run `reachable.mjs` on every file you will edit; an unreached file is old-stack code.
2. Name what the change does at runtime: renders on stream frames, adds a list or collection, adds an effect or listener, adds an import, adds a control or dialog. This picks the rule groups to apply (R, X, N, B, E, A).

### Step 2: Read before writing

- For every Next API you will use or change (routing, `params`, error files, metadata, `next/dynamic`, images, fonts, config, route handlers), open its page under `frontend/node_modules/next/dist/docs/01-app/` and follow it. The rule table in [rules.md](references/rules.md) names the pages.
- Read the neighbouring component and the CSS file it uses; copy their patterns.

### Step 3: Apply the rules

**Building:** write the code to the rules in the groups from Step 1. Where you break one on purpose, say which and why in the report.

**Reviewing:** check each changed file against those groups. Each finding gets a rule ID, `file:line`, evidence (**measured**, **read**, or **unverified**), a fix and a test, in the format in [report-template.md](references/report-template.md). **Stop and wait for the user to approve which fixes to make.** Do not edit before that.

### Step 4: Measure what the change can affect

Measure when the change touches stream handling, a transcript row, markdown, a collection that grows, a dependency or a route's imports. Record the baseline before the first edit. [measure.md](references/measure.md) has the commands:

- **Bundle:** `firstLoadUncompressedJsBytes` per route from `next build`.
- **Markdown:** `parsedChars` from the streaming-markdown benchmark.
- **Render:** server-render tests with `component()` from `frontend/test/next-details-runtime.ts`, run against the original files with `NEXT_DETAILS_BASELINE_DIR`.
- **Reducers:** identity and counts in `frontend/test/*.test.ts`.
- **Runtime:** re-renders per frame, long tasks, INP, heap and focus in a real browser.

A number goes in the report with its mode and machine. Wall-clock times never go into assertions.

### Step 5: Test

- Logic in `frontend/lib/`: unit tests in `frontend/test/<name>.test.ts`, `node:test` with `node:assert/strict`, matching the neighbours.
- Components: server-render tests (markup, absence of hidden content, roles and labels).
- Interaction, focus, scroll and re-render behaviour: a browser check, written as steps in the report. Unit tests cannot prove them.
- A test for a fix fails against the baseline files first.

### Step 6: Verify

Run from the repository root:

```bash
npm --prefix frontend run typecheck
npm --prefix frontend test
cp frontend/next-env.d.ts /tmp/next-env.d.ts.orig && npm --prefix frontend run build; cp /tmp/next-env.d.ts.orig frontend/next-env.d.ts
npx prettier --check <each changed file under frontend/>
```

Root `npm run format:check` covers `frontend/{app,components,lib}` (not `frontend/test`), but on 2026-10-28 it already failed on 14 files unrelated to any frontend change, including `frontend/app/chat.css`. Check the files you changed; do not reformat files you did not touch.

For any visible or interactive change, look at it in a browser (`npm run dev:next`, `http://localhost:3000`, a test-only Google account): the console is clean, the change looks and behaves right in both themes and at a narrow width, and keyboard and screen-reader behaviour matches the A rules. If you could not, say so. Report the counts each command printed. Do not commit.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "React is fast; one more re-render is nothing" | It happens on every stream frame, for every row. Count it in a 50-exchange chat. |
| "`memo` is on the component, so it won't re-render" | Not if a prop is a new array, object or function every render. Check the props. |
| "I know Next's API" | Next 16 differs from older versions. Read the page in `node_modules/next/dist/docs/`. |
| "This file looks like the chat, I'll fix it here" | It may be old-stack code no route loads. Run `reachable.mjs`. |
| "It felt smooth on my machine" | Feel is not a measurement. Report a count, or a timing with its mode. |
| "The dev build shows 40 ms, that's slow" | `next dev` with Strict Mode is not production. Compare only like with like. |
| "Screen readers will read the new text as it streams, that helps" | Token-by-token announcements make the screen unusable. Announce outcomes in the status region. |
| "I'll add `next/dynamic` everywhere to cut the bundle" | Each split adds a delay when the code is needed. Measure the saving per route first. |

## Red Flags

- An edit to a file `reachable.mjs` reports as unreached
- A Next API used without reading its page in `node_modules/next/dist/docs/`
- New per-frame work that walks the whole transcript, or a new prop identity that changes every frame
- An effect that copies props into state, or that has no cleanup for what it opened
- A new collection that grows with the session and has no cap
- A new dependency, unpinned, or added without the user's agreement
- `aria-live` on content that updates per frame; a clickable `div`; an icon-only button with no name
- A `fetch` to the platform from client code that does not go through `lib/api.ts`, or a call to port 4100 from the browser
- `next-env.d.ts` left changed by a build
- A timing asserted in a test, or a measurement with no baseline
- A fix made during review before the user approved it

## Verification

- [ ] Every edited file is reached by a route
- [ ] The Next docs for every Next API used were read
- [ ] Each applicable rule group was applied; deliberate exceptions are named with a reason
- [ ] Changes to streaming, rows, markdown, collections or imports were measured before and after, with mode and machine
- [ ] New logic has `node:test` tests; fixes have a test that failed against the baseline
- [ ] `typecheck`, `npm test`, `build` and Prettier on the changed files passed, with counts reported
- [ ] `frontend/next-env.d.ts` is unchanged
- [ ] Visible or interactive changes were checked in a browser, or the report says why not
- [ ] In review mode, nothing was edited before the user approved
- [ ] Nothing committed; no old-stack files changed

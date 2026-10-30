# Todo: Chat observability card (DESIGN-SPEC 12.8)

Plan: `tasks/chat-observability-plan.md` · Idea: `docs/ideas/chat-observability-card.md`

Standard checks for a package `<pkg>`: `npm --prefix <pkg> test`, `npm --prefix <pkg> run typecheck`, and `npm --prefix <pkg> run format:check` where the package has it (runtime-adapter, platform-next). Frontend also runs `npm --prefix frontend run build`. model-gateway runs `npm --prefix model-gateway test` and `npm --prefix model-gateway run build`. Root `npm test` is not evidence.

---

## Phase 0: Probes

## Task 1: Probe the pin for item timing and compaction behaviour

**Description:** Settle the Slice A assumptions against the pinned app-server before building on them. Record, for one turn with reasoning, a tool call, a command and a message, which item types send `item/started` and `item/completed`, and in what order. Then call `thread/compact/start` on an idle thread, on a running turn, twice in a row, and on a thread with one short turn, and record each response and notification.

**Acceptance criteria:**
- [ ] A probe test in `runtime-adapter/test/codex/` asserts the observed item lifecycle per type.
- [ ] The four compaction cases are recorded with their response or error and whether `thread/compacted` follows.
- [ ] Findings are appended under this task, and Tasks 6 and 9 are corrected if a finding contradicts them.

**Verification:**
- [ ] `npm --prefix runtime-adapter test -- test/codex/<probe>.test.ts` passes against the pin with the test gateway (no real model).

**Dependencies:** None

**Files likely touched:** `runtime-adapter/test/codex/trace-probe.test.ts`

**Estimated scope:** Small

## Task 2: Probe how a gateway request maps to a run and to request sections

**Description:** Settle the Slice B assumptions. Capture one request per provider adapter (Anthropic, OpenAI-compatible chat, Gemini) for a turn with workspace docs and tools, and identify how the system prompt, tool list, workspace docs and conversation can be told apart. Check how many gateway instances run in each deploy target, to decide whether an in-memory preview is reachable.

**Acceptance criteria:**
- [ ] A note under this task names, per adapter, the marker or field that separates each of the four sections, or says it can't be separated.
- [ ] The decision on where the masked preview lives (gateway memory vs. platform-next memory) is written down with the instance count behind it.
- [ ] Tasks 15–18 are corrected if a finding contradicts them.

**Verification:**
- [ ] Fixture requests saved under `model-gateway/test/fixtures/` with no secrets or personal data.

**Dependencies:** None

**Files likely touched:** `model-gateway/test/fixtures/*`, this file

**Estimated scope:** Small

## Checkpoint: Probes
- [ ] Findings recorded; dependent tasks corrected
- [ ] Review with human before Phase 1

---

## Phase 1: Slice A, run trace record

## Task 3: Receipt copy, Rate, turn number and number format

**Description:** Add the parts of 12.8 that need no new data. The receipt gets a copy button that copies the receipt line as text. The trace head shows "T‹n› · ‹time› · ‹steps› steps · ‹helpers›", where n is the turn's position in the chat. The Timing list gets **Rate** (output tokens ÷ stream seconds, shown only when both exist). Counts at or above 1000 show as "18.4k" with no ".0".

**Acceptance criteria:**
- [ ] Copy writes the receipt text and announces "Copied" through `announce()`; a failed write shows no false success.
- [ ] Rate is absent when stream time is zero or output tokens are missing.
- [ ] `compactCount(1000)` is "1k" and `compactCount(18400)` is "18.4k".

**Verification:**
- [ ] Standard checks for frontend; `receipt` and `turn` tests pass

**Dependencies:** None

**Files likely touched:** `frontend/components/tenant/receipt.tsx`, `frontend/lib/turn.ts`, `frontend/test/receipt.test.ts`, `frontend/test/turn.test.ts`

**Estimated scope:** Small

## Task 4: Store the context snapshot the adapter already sends

**Description:** Keep `usage.last.inputTokens` (tokens in the last model call, which is the fill) and `usage.contextWindow` instead of dropping them in `turnUsageOf`. Store them as `RunDoc.context {used, window}` at settle, return them in the run payload, and parse them in the frontend. The contract doesn't change: runtime-adapter already sends both.

**Acceptance criteria:**
- [ ] A settled run has `context.used` and `context.window`; a run whose adapter sent no window has no `context` field.
- [ ] Non-integer, negative or `used > window` values are dropped, not clamped into a false reading.
- [ ] The frontend parses a run with and without `context`.

**Verification:**
- [ ] Standard checks for platform-next and frontend
- [ ] Manual: send a message, reload, and see `context` in `GET /chats/:id/messages`

**Dependencies:** None

**Files likely touched:** `platform-next/src/modules/chats/run-executor.ts`, `platform-next/src/modules/chats/chat.ts`, `platform-next/src/modules/chats/chat-store.ts`, `platform-next/src/modules/chats/chats.controller.ts`, `frontend/lib/tenant-chat.ts`

**Estimated scope:** Medium

## Task 5: Context jar fill with 75% / 90% lines and tip

**Description:** Draw the jar from `context` alone: used vs. free against the window, with the 75% warn line (`--warn`), the 90% full line (`--bad`), the signal fill line, "‹n›% full" in the serif accent, and the tip text (under 75% / at or over 75%). Layers wait for Task 18. The chart is `role="img"` with a label giving used, window and percent.

**Acceptance criteria:**
- [ ] 74%, 75% and 90% runs show the right tip and line states.
- [ ] A run without `context` shows no jar and no placeholder.
- [ ] The accessible label reads, for example, "Context 61% full: 157k of 258k tokens".

**Verification:**
- [ ] Standard checks for frontend; a render test per threshold
- [ ] Manual: light and dark against spec 12.8

**Dependencies:** Task 4

**Files likely touched:** `frontend/components/tenant/context-jar.tsx`, `frontend/components/tenant/receipt.tsx`, `frontend/styles/app/trace.css`, `frontend/test/receipt.test.ts`

**Estimated scope:** Small

## Task 6: runtime-adapter step timings in the contract

**Description:** Record a step for each lead-thread item (reasoning, mcpToolCall, commandExecution, fileChange, webSearch, agentMessage) as `{itemId, kind, startMs, endMs}`, with times relative to run start. Send them in `run.completed.steps`, and add `turnCompletedAt` and `longestGapMs` (the largest gap between text deltas) to `run.completed.timings`. Cap the list at `STEPS_PER_RUN`; extra steps fold into one `{kind: "more", count}` step. Document the fields in `runtime-adapter/README.md`.

**Acceptance criteria:**
- [ ] A re-sent `item/started` doesn't create a second step; an item that never completes ends at turn completion.
- [ ] Helper-thread items are not steps (helpers stay a count).
- [ ] Steps carry no text, arguments, commands or paths.

**Verification:**
- [ ] Standard checks for runtime-adapter; unit tests for ordering, duplicates, the cap and missing completion

**Dependencies:** Task 1

**Files likely touched:** `runtime-adapter/src/runtime/run.ts`, `runtime-adapter/src/runtime/chat.ts`, `runtime-adapter/README.md`, `runtime-adapter/test/unit/run-steps.test.ts`

**Estimated scope:** Medium

## Task 7: platform-next stores steps, Longest gap and Finalize

**Description:** Validate `steps`, `longestGapMs` and `turnCompletedAt` from `run.completed` in the runtime client, store them on `RunDoc` at settle, and return them in the run payload. **Finalize** is platform-next's settle time minus `turnCompletedAt`. Invalid entries are dropped one by one, so one bad step doesn't lose the rest.

**Acceptance criteria:**
- [ ] A run settled from an adapter without these fields (old adapter during a deploy) settles normally without them.
- [ ] Steps with an unknown kind, `endMs < startMs` or a non-integer time are dropped.
- [ ] A 500-item turn's run document size is measured and noted under this task.

**Verification:**
- [ ] Standard checks for platform-next; contract tests on the platform-next side for valid, missing and invalid fields
- [ ] Manual: settled run returns steps after reload

**Dependencies:** Task 6

**Files likely touched:** `platform-next/src/modules/chats/runtime-client.ts`, `platform-next/src/modules/chats/run-executor.ts`, `platform-next/src/modules/chats/chat.ts`, `platform-next/src/modules/chats/chat-store.ts`, `platform-next/src/modules/chats/chats.controller.ts`

**Estimated scope:** Medium

## Checkpoint: Record in place
- [ ] Standard checks pass in runtime-adapter, platform-next and frontend
- [ ] A reloaded run returns steps, context and the new timing fields

## Task 8: Steps waterfall, legend, table twin and summary sentence

**Description:** Draw "Steps · ‹dur› wall time" from `steps`: rows with an 11.5rem label, a track with a 0.75rem bar placed in real time and a 3.5rem duration, gridlines at 25/50/75%, the agent's lifetime bar in `--id-main` at 22% opacity, step colours by kind, a legend, and a table twin inside `details` with a hidden caption. Add the summary sentence built from step counts ("9 steps over 1m 52s, all in the main agent. It made 3 tool calls and wrote the answer. No helpers were spawned."), leaving file counts out until backlog 05. Add Longest gap and Finalize to the Timing list.

**Acceptance criteria:**
- [ ] A 0 ms step still shows a visible bar; a step that ends at the run's end reaches the track's end.
- [ ] The overflow step reads "and ‹n› more".
- [ ] A run without steps shows the Timing list only, with no waterfall placeholder.

**Verification:**
- [ ] Standard checks for frontend; render tests for empty, single, overflow and helper runs
- [ ] Manual: light and dark against spec 12.8; screen reader reads the table twin

**Dependencies:** Task 7

**Files likely touched:** `frontend/components/tenant/steps-waterfall.tsx`, `frontend/components/tenant/receipt.tsx`, `frontend/lib/turn.ts`, `frontend/styles/app/trace.css`, `frontend/test/receipt.test.ts`

**Estimated scope:** Medium

## Task 9: Compact route through runtime-adapter and platform-next

**Description:** Add a runtime-adapter route that calls `thread/compact/start` for a thread, and a platform-next route `POST /chats/:id/compact` for the chat's owner. platform-next refuses while a run is active, refuses when nothing was sent since the last compaction, and refuses a chat with no thread yet. Each refusal has its own error code. Use Task 1's findings for the pin's real behaviour.

**Acceptance criteria:**
- [ ] Results map to `compacted`, `run_active`, `already_compacted` and `nothing_to_compact`.
- [ ] Another member's chat and another tenant's chat return 404.
- [ ] Two simultaneous requests compact once.

**Verification:**
- [ ] Standard checks for runtime-adapter and platform-next; contract tests on both sides

**Dependencies:** Task 1

**Files likely touched:** `runtime-adapter/src/http/*`, `runtime-adapter/README.md`, `platform-next/src/modules/chats/chats.controller.ts`, `platform-next/src/modules/chats/chats.service.ts`, `platform-next/src/modules/chats/runtime-client.ts`

**Estimated scope:** Medium

## Task 10: Compact button with its four states

**Description:** Add the Compact button under the jar. It shows "Compacted", "Wait for the reply", "Already compacted" or "Nothing to compact" for the matching result and reverts after 1.8 s. While a request is in flight it is disabled and `aria-busy`, so a double press sends once. Point the `/compact` slash command at the same route.

**Acceptance criteria:**
- [ ] Each result shows its own text and reverts after 1.8 s.
- [ ] A network failure shows an error the member can retry, never "Compacted".
- [ ] `/compact` and the button call the same function.

**Verification:**
- [ ] Standard checks for frontend; tests for each state and the double press

**Dependencies:** Tasks 5, 9

**Files likely touched:** `frontend/components/tenant/context-jar.tsx`, `frontend/lib/tenant-chat.ts`, `frontend/lib/slash-commands.ts`, `frontend/test/receipt.test.ts`

**Estimated scope:** Small

## Task 11: Token slip artwork

**Description:** Restyle "Billed as" as the printed slip from spec 12.8 and 19.1: role colours (input `--cx-r1`, cache `--cx-r2`, output `--cx-r3`, reasoning `--cx-r4`), total and stamp. The artwork is decoration; the table stays the accessible content. "Where it went" waits for Task 19.

**Acceptance criteria:**
- [ ] The slip's rotation is turned off under `prefers-reduced-motion`.
- [ ] Every colour comes from a token (design-system test passes).

**Verification:**
- [ ] Standard checks for frontend; `design-system` test passes
- [ ] Manual: light and dark against spec

**Dependencies:** None

**Files likely touched:** `frontend/components/tenant/receipt.tsx`, `frontend/styles/app/trace.css`

**Estimated scope:** Small

## Checkpoint: Slice A complete
- [ ] Standard checks pass in all three packages
- [ ] The Trace view matches spec 12.8 for every Slice A element in light and dark
- [ ] Review with human before Slice C

---

## Phase 2: Slice C, privacy

## Task 12: runtime-adapter privacy scan and `privacy` contract field

**Description:** Scan MCP tool results and command output with the patterns in `shared/privacy.ts` as items complete, before the text is dropped. Report findings on the step as `privacy: [{kind, count}]` and mark the run `privacy.scanned: true` in `run.completed`. First check whether runtime-adapter can import `shared/`; if it can't, port the scanner with a test that keeps both copies in agreement. Document the fields in the README.

**Acceptance criteria:**
- [ ] No matched value appears in events, `run.completed`, logs or errors.
- [ ] Input past `MAX_SCAN_CHARS` is scanned up to the limit and the step is marked `truncated`.
- [ ] A run where scanning threw has `scanned: false`, and the run itself isn't affected.

**Verification:**
- [ ] Standard checks for runtime-adapter; tests with a fixture containing an email, a phone number and a card number

**Dependencies:** Task 6

**Files likely touched:** `runtime-adapter/src/runtime/run.ts`, `runtime-adapter/src/runtime/chat.ts`, `runtime-adapter/src/runtime/privacy.ts`, `runtime-adapter/README.md`

**Estimated scope:** Medium

## Task 13: platform-next stores findings per step

**Description:** Validate the `privacy` fields in the runtime client, store them on the run's steps and as `RunDoc.privacy {scanned, findings}`, and return them in the run payload. Unknown kinds are dropped.

**Acceptance criteria:**
- [ ] A run from an adapter without the field has no `privacy`, which the frontend reads as "not checked".
- [ ] Only kinds and counts are stored.

**Verification:**
- [ ] Standard checks for platform-next; contract tests on the platform-next side

**Dependencies:** Tasks 7, 12

**Files likely touched:** `platform-next/src/modules/chats/runtime-client.ts`, `platform-next/src/modules/chats/chat.ts`, `platform-next/src/modules/chats/chat-store.ts`, `platform-next/src/modules/chats/chats.controller.ts`

**Estimated scope:** Small

## Task 14: Receipt privacy pill and trace Privacy section

**Description:** Show the `tx-pill-warn tx-pill-sm` "‹n› privacy" pill on the receipt when any step has a finding. The trace's Privacy section shows a finding card (kind label and the step it came from), or the agreed empty state in `--ok-ink` when `scanned` is true. Show nothing when the run wasn't scanned.

**Acceptance criteria:**
- [ ] The empty state appears only when `scanned` is true.
- [ ] The summary sentence adds "One step read a file with a privacy finding." when there is one.

**Verification:**
- [ ] Standard checks for frontend; render tests for scanned-clean, scanned-with-findings and not-scanned

**Dependencies:** Tasks 8, 13

**Files likely touched:** `frontend/components/tenant/receipt.tsx`, `frontend/lib/tenant-chat.ts`, `frontend/lib/turn.ts`, `frontend/test/receipt.test.ts`

**Estimated scope:** Small

## Checkpoint: Slice C complete
- [ ] Findings appear for a fixture with personal data
- [ ] No matched value in MongoDB, events or logs (grep the test output and the stored document)

---

## Phase 3: Slice B, gateway meter

## Task 15: Gateway token carries the run id

**Description:** Add a run id claim to the gateway token that platform-next signs per run, and have model-gateway read it. Tokens without the claim stay valid, since old and new versions run together during a deploy. Update both token modules and test both sides.

**Acceptance criteria:**
- [ ] Old-format tokens still verify.
- [ ] A run id is an ObjectId string; anything else is ignored, not trusted.

**Verification:**
- [ ] Standard checks for platform-next and model-gateway

**Dependencies:** Task 2

**Files likely touched:** `shared/gateway-token.ts`, `platform-next/src/modules/chats/gateway-token.ts`, `platform-next/src/modules/chats/chats.service.ts`, `model-gateway/src/server.ts`

**Estimated scope:** Small

## Task 16: Gateway counts request sections and keeps a masked preview

**Description:** In each provider adapter, measure the system, tools, workspace docs and conversation sections of a request, using the separators found in Task 2. Scale the counts so they sum to the provider's reported input tokens. Keep a masked preview (via `maskText`) of the run's latest request in memory with a time limit, keyed by tenant and run. Send the layer counts to platform-next as Task 2 decided.

**Acceptance criteria:**
- [ ] On each adapter fixture, layers sum to reported input tokens within rounding.
- [ ] The preview is never logged and expires after its time limit.
- [ ] A request without a run id is metered nowhere.

**Verification:**
- [ ] `npm --prefix model-gateway test`, `npm --prefix model-gateway run build`; one test per adapter

**Dependencies:** Tasks 2, 15

**Files likely touched:** `model-gateway/src/adapters/*.ts`, `model-gateway/src/context-meter.ts`, `model-gateway/src/server.ts`, `model-gateway/test/context-meter.test.ts`

**Estimated scope:** Medium

## Task 17: platform-next stores layers and serves the Dev preview to admins

**Description:** Store the layer counts as `RunDoc.context.layers` and return them in the run payload. Add a route that returns a run's masked preview only to workspace admins; the role check runs in platform-next, not the browser. Return "not captured" when the preview has expired or was never captured.

**Acceptance criteria:**
- [ ] A member who isn't an admin gets 403; another tenant's run gets 404.
- [ ] An expired preview returns "not captured", not an error.

**Verification:**
- [ ] Standard checks for platform-next; tests for admin, member, other tenant and expired

**Dependencies:** Tasks 4, 16

**Files likely touched:** `platform-next/src/modules/chats/chat.ts`, `platform-next/src/modules/chats/chat-store.ts`, `platform-next/src/modules/chats/chats.controller.ts`, `platform-next/src/modules/chats/chats.service.ts`

**Estimated scope:** Medium

## Task 18: Jar layers, Trace / Model context tabs and the Dev tab

**Description:** Stack the jar's layers (system r1, tools r2, docs r3, conversation r4, free `--well-2`), and use the docs share in the tip. Add the segmented Trace / Model context tabs, with the second tagged "Dev" and shown only to admins. The tabs use roving ←/→ keys. The Model context tab shows the composition bar, the sentence, one `details` per section (Workspace docs open by default) with a share meter and masked preview, and the footer "Masked on the server. Captured for live turns only." with Copy masked.

**Acceptance criteria:**
- [ ] Non-admins see no tabs, only the Trace view.
- [ ] ←/→ switch tabs; Esc still closes and returns focus to Details.
- [ ] A run without layers falls back to the fill-only jar from Task 5.

**Verification:**
- [ ] Standard checks for frontend; render and keyboard tests
- [ ] Manual: light and dark against spec 12.8

**Dependencies:** Tasks 5, 17

**Files likely touched:** `frontend/components/tenant/context-jar.tsx`, `frontend/components/tenant/model-context.tsx`, `frontend/components/tenant/receipt.tsx`, `frontend/lib/tenant-chat.ts`, `frontend/test/receipt.test.ts`

**Estimated scope:** Medium

## Task 19: "Where it went" estimate by step kind

**Description:** In runtime-adapter, credit each model call's output tokens (from `usage.last`) to the steps that call produced, and send per-step output tokens with the steps. The token slip's "Where it went / by step kind" sums them by kind and is labelled "estimated". Input tokens aren't split by step.

**Acceptance criteria:**
- [ ] Per-step output tokens sum to the run's output tokens.
- [ ] The slip shows "estimated" next to the section title.

**Verification:**
- [ ] Standard checks for runtime-adapter, platform-next and frontend

**Dependencies:** Tasks 7, 11

**Files likely touched:** `runtime-adapter/src/runtime/chat.ts`, `runtime-adapter/src/runtime/run.ts`, `platform-next/src/modules/chats/runtime-client.ts`, `frontend/components/tenant/receipt.tsx`

**Estimated scope:** Medium

## Checkpoint: Complete
- [ ] Every 12.8 element is on screen with real data
- [ ] Jar layers sum to reported input tokens within rounding on each adapter
- [ ] Model context hidden from non-admin members, enforced by the server
- [ ] Ready for review

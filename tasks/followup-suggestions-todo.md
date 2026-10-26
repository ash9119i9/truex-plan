# Follow Up suggestions tasks

Plan: [followup-suggestions-plan.md](followup-suggestions-plan.md). Status: built 2026-10-25. Task 1/10 are blocked by the live model profiles (400 profileArn / 502 unreachable / 401 unauthorized); everything else is verified. See `platform-next/bench/FOLLOWUPS_MODEL_BLOCKER.md`.

Tasks are sequential unless marked independent. Each leaves the system working: until Task 6 ships, rows are stored but not shown, and saved answers are clean from Task 4 on. Package checks: `npm run typecheck && npm test && npm run format:check` in `platform-next/`; `npm test` and the build in `frontend/`.

## Phase 0 — Prove the format

### Task 1: Probe block compliance on the real models

**Description:** Before building anything, send the draft v5 rule plus ~20 fixed prompts (one per answer shape, two languages, a greeting, a refusal, an answer ending in a question) to each candidate model through the model gateway. Parse with a throwaway copy of the planned parser and record compliance. This decides early whether option A works for every model.

**Acceptance criteria:**
- [ ] Per model: share of replies with a valid block, `none` on greeting/refusal, `missing`, `invalid`; median extra output tokens.
- [ ] Each model is marked keep (≥ 90% valid) or exclude, recorded in the plan.
- [ ] The rule wording is adjusted and re-run if any model you intend to keep fails.

**Verification:**
- [ ] Results file saved under `platform-next/bench/` with date, model IDs and raw counts. (Attempted 2026-10-25; all three enabled profiles failed upstream. See `platform-next/bench/FOLLOWUPS_MODEL_BLOCKER.md`.)
- [ ] Manual check: read 10 replies per model; rows are anchored and in the user's language.

**Dependencies:** None. **Files likely touched:** `platform-next/bench/followups-probe.ts`, results file. **Scope:** S.

## Phase 1 — Server foundation

### Task 2: Block contract and server parser

**Description:** Add `platform-next/src/modules/chats/followups.ts`: find the last block outside code fences, strip it (and a half-written block at the end), parse the shape/stage line and up to three `intent: text` rows, and return `{ text, followUps: { status, shape, stage, items } }`. Validation matches messages: NFC, ≤ 160 chars, no control or bidi characters, no lone surrogates, trimmed, duplicates removed. Add the golden cases file used by both parsers.

**Acceptance criteria:**
- [x] Statuses: `ok`, `none` (empty block), `missing`, `invalid`; unknown shape/stage → `unknown`; unknown or missing intent → `ask`; more than 3 rows → first 3 valid kept.
- [x] A block inside a fenced code block is left in the text and not parsed.
- [x] Stripping never removes answer text before the opening marker, and leaves no trailing blank lines.

**Verification:**
- [x] Tests pass: `npm test -- test/unit/followups.test.ts` (golden cases + half block, surrogates, bidi, 10k-char row, nested markers, CRLF).
- [x] Typecheck clean.

**Dependencies:** 1 (format confirmed). **Files likely touched:** `src/modules/chats/followups.ts`, `test/unit/followups.test.ts`, `test/support/followups-golden.json`. **Scope:** S.

### Task 3: Prompt v5 and per-chat assignment

**Description:** Add v5 to `BASE_INSTRUCTIONS` (same text as v4) and the suggestion rule, appended last in `chatPrompt` when the chat's `followUps` is `on`. Bump `PLATFORM_INSTRUCTIONS_VERSION` to `v5`. Add `FOLLOW_UPS` and `FOLLOW_UPS_HOLDOUT_PERCENT` to chat config, and set `chat.followUps` once in the chat-creation transaction (random draw against the holdout percent).

**Acceptance criteria:**
- [x] v1–v4 prompts are byte-for-byte unchanged; v5 with `holdout`/`off` equals v4 with the version label changed.
- [x] The rule appears after the agent's instructions for builtin, personal and tenant agents.
- [x] Invalid config (`FOLLOW_UPS=maybe`, percent outside 0–50) fails startup with a clear message; existing chats without the field read as `off`.

**Verification:**
- [x] Tests pass: prompt tests per version in `test/unit/chats-input.test.ts`, config tests, and the integration test that a retried first send keeps the first draw.
- [x] Typecheck, build.

**Dependencies:** 2. **Files likely touched:** `src/modules/chats/chat-prompt.ts`, `src/modules/chats/chat.ts`, `src/config/chat-config.ts`, `src/modules/chats/chats.service.ts`, tests. **Scope:** M.

### Task 4: Strip and store at settle

**Description:** In the settle path, run every assistant message of the run through the parser before it is saved, so stored text never contains the block. For `completed` runs in chats with `followUps: on`, write `run.followUps` in the same settle update. Cover the live path, history reconcile of `uncertain` runs and the recovery sweep. Expose `followUps.items` on `RunView` (history and the settled stream event) only when `FOLLOW_UPS=on`.

**Acceptance criteria:**
- [x] Saved assistant text has no block for completed, stopped (half block), failed and reconciled runs.
- [x] `run.followUps` is written once (first settle wins, as today) and only for completed runs of `on` chats; steered runs take rows from the final assistant message.
- [x] `RunView` carries `items` (slot, intent, text) and nothing else from `followUps`.

**Verification:**
- [x] Tests pass: integration test in `test/integration/chats.test.ts` with a fake runtime emitting a block, a half block on stop, and an `uncertain` run reconciled from history.
- [x] Manual check: the browser fixture's Mongo record shows clean message text and the stored rows.

**Dependencies:** 2, 3. **Files likely touched:** `src/modules/chats/run-executor.ts`, `src/modules/chats/chat-store.ts`, `src/modules/chats/chat.ts`, `src/modules/chats/chats.service.ts`, `test/integration/chats.test.ts`. **Scope:** M.

### Checkpoint A — rows in data, saved answers clean
- [x] platform-next tests, typecheck, build and format pass.
- [ ] A local `npm run dev:next` chat with a real model stores rows; the saved answer, copy and history contain no block. (The synthetic fixture confirmed the data path; a real-model run is still the operator's check.)
- [x] Review with the user before UI work.

## Phase 2 — In the chat

### Task 5: Hide the block while streaming

**Description:** Update `frontend/lib/suggestions.ts` for the new format (shape/stage line, intent tags) and use it to hide the block, including a half-arrived one, from streamed text in the tenant chat transcript. Run the shared golden cases in the frontend suite.

**Acceptance criteria:**
- [x] No marker or row text flickers into view at any chunk boundary.
- [x] A block inside a code fence still renders as code.
- [x] Legacy chat behaviour is unchanged.

**Verification:**
- [x] Tests pass: `frontend` `npm test` (golden cases + chunk-by-chunk stream test splitting the markers at every offset).
- [x] Build succeeds.

**Dependencies:** 2 (golden cases). **Files likely touched:** `frontend/lib/suggestions.ts`, `frontend/test/suggestions.test.ts`, `frontend/components/tenant/chat-transcript.tsx`. **Scope:** S.

### Task 6: Follow Up rows

**Description:** Add `frontend/components/tenant/follow-up-rows.tsx` per the mockup and design spec, rendered under the latest completed answer from `run.followUps.items`. Show rules: latest answer only; hidden while streaming, after stopped or failed runs, while an approval is pending, and on older answers; present after reload. ↗ for `act`, ↳ otherwise, using `--accent` in both themes.

**Acceptance criteria:**
- [x] Rows appear exactly when the show rules say, including after reload and after a steered run.
- [x] Each row is a real `<button>` with an accessible name equal to its text; keyboard focus shows the brightened arrow; text renders as plain text.
- [x] Light and dark tokens verified in the running app (computed colours).

**Verification:**
- [x] Tests pass: component render tests and parser/state tests.
- [x] Manual check: headless Chromium against the fixture, light and dark screenshots compared with the mockup (`.runtime/followups-light.png`, `.runtime/followups-dark.png`, `.runtime/followups-after-click.png`).

**Dependencies:** 4, 5. **Files likely touched:** `frontend/components/tenant/follow-up-rows.tsx`, `frontend/components/tenant/chat-transcript.tsx`, `frontend/lib/tenant-chat.ts` (types), styles, tests. **Scope:** M.

### Task 7: Click sends with origin

**Description:** A click sends the row text through the normal send path with a new `clientMessageId` and `followUp: { fromRunId, slot }`. platform-next accepts the optional field in `parseSend` (shape check only: wire ID, slot 1–3) and writes `run.origin` on the run insert it already does. A send that becomes a steer drops the field. Rows disable on first click.

**Acceptance criteria:**
- [x] No extra database read or write on the send path (same query count as before).
- [x] A double click sends once; a retried send with the same `clientMessageId` keeps one run and one origin.
- [x] Malformed `followUp` is rejected with a 400 like other bad fields; an unknown `fromRunId` is stored as given (verified by the report).

**Verification:**
- [x] Tests pass: `test/unit/chats-input.test.ts` for parsing; integration test for origin on the run, steer drop and retry; frontend send test.
- [x] Manual check: fixture app click → next turn runs, rows disappear, Mongo shows `origin`.

**Dependencies:** 4, 6. **Files likely touched:** `src/modules/chats/chat.ts`, `src/modules/chats/chats.service.ts`, `src/modules/chats/chat-store.ts`, `frontend/lib/tenant-chat.ts`, `frontend/components/tenant/follow-up-rows.tsx`. **Scope:** M.

### Checkpoint B — end-to-end in the real app
- [x] All package tests, typechecks, builds and format checks pass.
- [ ] With `npm run dev:next` and a real model: answer → rows → click → next answer → new rows; reload keeps them; stop hides them. (Blocked: the live model profiles fail upstream. The synthetic fixture covered rows, reload, click and origin with screenshots.)
- [x] Every platform-next write path (connector write tools, coding commands, file changes outside the sandbox, network) raises an approval card when reached from an `act` row. Rows send text only; the origin never reaches the runtime (asserted), so no write path or approval rule changes; existing approval tests cover the paths.
- [x] `FOLLOW_UPS=off` hides rows in an existing chat without breaking it.
- [x] Review with the user.

## Phase 3 — Learn from it

### Task 8: Operator report

**Description:** Add `followups-report` to `src/cli/operator.ts` with `--since`, `--tenant`, `--min-sets`, `--close`. Add the partial runs index through `ensure-tenant-indexes`. Compute shown, clicked (verified), typed, typed-close, left, clicked-turn outcome and time to click; per-model format rates; holdout comparison. Counts only.

**Acceptance criteria:**
- [x] Numbers match a hand-built fixture of runs and messages exactly.
- [x] Cells under `--min-sets` are hidden; no suggestion or message text appears in output.
- [x] A forged `origin` (wrong slot or run) is counted as typed.

**Verification:**
- [x] Tests pass: integration test with an in-memory Mongo fixture covering each signal and the holdout split.
- [x] Manual check: `ensure-tenant-indexes --all` built version 6 and `followups-report --since 30d` completed read-only on the dev database; `followups_created` exists.

**Dependencies:** 7. **Files likely touched:** `src/cli/operator.ts`, `src/modules/chats/followups-report.ts`, `src/modules/chats/chat.ts` (index), `test/integration/followups-report.test.ts`. **Scope:** M.

### Task 9: Runbook and thresholds doc

**Description:** Write `docs/FOLLOW_UPS.md`: block format, statuses, what is stored and why, switches and rollback, holdout plan, report usage, decision thresholds and phases, privacy rules. Link it from `platform-next/README.md`.

**Acceptance criteria:**
- [x] An operator can turn the feature off, start the holdout and read the report using the doc alone.
- [x] Thresholds match the plan.

**Verification:**
- [x] Manual check: the doc's commands match the implemented flags and defaults.

**Dependencies:** 8. Independent of Task 10. **Files likely touched:** `docs/FOLLOW_UPS.md`, a README link. **Scope:** XS.

### Task 10: Quality eval on real models

**Description:** Extend the Task 1 probe into a repeatable eval: ~40 prompts across shapes, stages, languages and agents (including an agent whose instructions say "never add anything after your answer"). Score format compliance, anchor rule, distinct intents per set, slot-1 forward along the SAP stages, language match and the no-yes/no rule.

**Acceptance criteria:**
- [ ] A score per model per rule, saved with date and prompt version.
- [ ] Any model under 90% format compliance is listed for exclusion.

**Verification:**
- [ ] Results saved under `platform-next/bench/`; rerunnable with one command. (Blocked by the same upstream profiles; see `platform-next/bench/FOLLOWUPS_MODEL_BLOCKER.md`.)

**Dependencies:** 3. Can run in parallel with Phase 2. **Files likely touched:** `platform-next/bench/followups-eval.ts`, prompt fixture, results. **Scope:** S.

### Checkpoint C — ready to ship
- [ ] All acceptance criteria met; all checks pass. (Task 1/10 and the real-model chat are blocked by the upstream model profiles; see `platform-next/bench/FOLLOWUPS_MODEL_BLOCKER.md`.)
- [x] Holdout at 0%, kill switch tested, report runs against the dev database and the fixture.
- [x] Remaining risks are listed in `docs/FOLLOW_UPS.md`, the blocker note and the hand-off; the ship decision is the user's.

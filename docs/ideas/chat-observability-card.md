# Chat observability card (DESIGN-SPEC 12.8)

Added 2026-10-30 · Spec `system/DESIGN-SPEC.md` 12.8 · Related backlog: `backlog/frontend-redesign/02`, `04`, `08`

## Problem Statement

How might we show a member why a turn took the time and tokens it did, from data Truex records reliably, live and after reload, in one record that the trace card and the Activity Panel Insights tab (14.8) both read?

## Gap audit (2026-10-30)

| Spec element | Today | Missing | Layers |
|---|---|---|---|
| Receipt: duration, tokens, model, Details | Built | — | — |
| Receipt: copy | Missing | Frontend only | FE |
| Receipt: "1 privacy" pill | Missing | No detection in the new stack | PN, FE |
| Head: status, steps, helpers | Built | T‹n›, Trace / Model context tabs | FE |
| Timing: Accept, First token, Stream | Built | — | — |
| Timing: Rate | Missing | Computable now (output tokens / stream time) | FE |
| Timing: Longest gap, Finalize | Missing | Not recorded | PN |
| Steps waterfall | Missing | Tools and commands carry `durationMs` (`runtime-adapter/src/runtime/run.ts:421`); no start offset, and reasoning / message items are not steps | RA, PN, FE |
| Summary sentence | Missing | Derived from steps; file counts need backlog 05 | FE |
| Token slip "Billed as" | Built as a table | Slip artwork | FE |
| Token slip "Where it went" | Missing | Codex reports tokens per model call, not per item; estimate only | RA, FE |
| Context jar fill | Missing | `usage.last` and `contextWindow` arrive from RA (`runtime/chat.ts:1099`) and are dropped by `turnUsageOf` (`platform-next/src/modules/chats/run-executor.ts:2192`) | PN, FE |
| Context jar layers | Missing | Only model-gateway sees the assembled request | Gateway |
| Compact button | Missing | Codex has `thread/compact/start` (`docs/protocol.md:49`); not exposed | RA, PN, FE |
| Privacy section | Missing | Same as the pill | PN, FE |
| Model context (Dev) | Missing | Masked capture at the gateway, admin only | Gateway, PN, FE |

RA = runtime-adapter, PN = platform-next, FE = frontend.

## Recommended Direction

One stored **run trace record** on the run: ordered `steps[]` (kind, start offset, duration, label), timing (accept, first token, stream, longest gap, rate, finalize), and a context snapshot (used, window, layers). The trace card and the Activity Panel both read it, so a reloaded turn draws what it drew live.

Three sources write into it, shipped as separate slices:

- **A. Run trace record.** runtime-adapter stamps `item/started` and `item/completed` for every item (reasoning, tool, command, file change, message). platform-next keeps `usage.last` and `contextWindow` and the longest gap between text deltas. Compact uses Codex `thread/compact/start`; Truex builds no compaction of its own.
- **B. Gateway meter.** model-gateway counts each request section (system, tools, docs, conversation) per call, scaled so the layers sum to the reported input tokens, and keeps a masked, in-memory, time-limited copy for the admin-only Model context tab.
- **C. Privacy scan.** A server-side scan with `shared/privacy.ts` over tool results and files read. It stores kind and step only, never the matched value.

Members see the receipt, waterfall, timing, token slip and jar. Model context and the per-step-kind token estimate are admin or dev-mode only. Success is spec parity on screen for every element built.

## Key Assumptions to Validate

- [ ] The pin emits `item/started` and `item/completed` for reasoning and agentMessage items, not only tools. Test: extend the runtime-adapter Codex probe.
- [ ] A gateway request can be tied to a run and tenant (gateway token claims or a header). Test: read `shared/gateway-token.ts`, probe one turn.
- [ ] Section counts scaled to reported input tokens stay within rounding across the Anthropic, OpenAI-compatible and Gemini adapters. Test: one fixture per adapter.
- [ ] `thread/compact/start` on the pin fails clearly while a turn is running, and its outcomes map onto the four button states. Test: probe against the pin.
- [ ] A long turn (500+ items) keeps the run document small when steps are capped and the rest merge into one "and N more" step. Test: measure document size.
- [ ] Old runs without the record render only the fields they have, with no placeholders (frontend Task 21 rule). Test: render test with a legacy run.

## MVP Scope

- **Slice A (first):** copy, Rate, T‹n›, Trace / Model context tabs (Model context hidden until B), waterfall with legend and table twin, summary sentence (without file counts until backlog 05), Longest gap, Finalize, jar fill with 75 / 90 lines and tip, Compact, token slip artwork, keyboard per spec.
- **Slice B:** jar layers, Model context tab, "Where it went" (labelled estimated).
- **Slice C:** privacy pill and section.

## Not Doing (and Why)

- Cost and budget: in 14.8, not 12.8 (backlog 01).
- Helper lanes in the waterfall: the spec shows the main agent's lifetime bar only; helpers stay a count.
- Exact per-step input tokens: Codex doesn't report them, and an exact-looking split would be false.
- Persisting the Model context capture: prompt content would live in the database. Live-only matches the spec footer.
- A Truex-built compaction: Codex already has one.

## Open Questions

- Admin-only, or a per-member dev-mode flag, for Model context?
- Should Compact stay in the trace card only, or also appear when the jar passes 75% elsewhere?
- Who approves the privacy empty-state wording? Proposed: "No personal data patterns found in what it read."

# Sub-agents plan (Codex multi-agent V2)

Engine: Codex `multi_agent_v2`, unmodified. Truex work lives in runtime-adapter,
platform-next and frontend. Design: `tasks/subagents-research/05-design.md`.
Research: `tasks/subagents-research/01..04`.

## Product rule

Helpers gather, the lead acts. Helpers read through the chat's connectors and
return short results. Only the lead changes data, and every change goes through
an approval card. Helpers live inside one reply.

## Broken beliefs this plan fixes

| # | Belief | Reality (from code) | Fixed in |
|---|---|---|---|
| 1 | Cap of 3 bounds cost | Cap is concurrent only; finished helpers free slots (O8); no budget set | 1.7 |
| 2 | Helper usage is billed | Helper usage has a child `turn_id` and is dropped (`chat.ts:868`) | 1.4, 1.5 |
| 3 | Read-only helpers are safe | Helper results launder injection to the lead; "allow for chat" auto-runs writes (`chat.ts:1328`) | 1.11 |
| 4 | Helpers die with the reply | They outlive the lead's turn and their answer is lost (O9) | 1.8 |
| 5 | Watchdog copes | Lead is silent while waiting; 120s silence fails the run | 1.6 |
| 6 | Depth 1 | V2 ignores `max_depth`; helpers got no collab tools on the pin (O2) | P0.13 |
| 7 | Clean context is free | `fork_turns` defaults to `all`; `none` needs a self-contained task | P0.11, 1.12 |

## Phase 0: Probe the pin (tests only, no prod code)

Location: `runtime-adapter/test/codex/subagents-probe.test.ts`, using
`ModelFixture` and `mcp-fixture`. Each item records the observed shape and
becomes a pin assertion.

Result (2026-10-26): **GO**. 9 probe tests pass; findings O1–O13 are in
05-design.md "Observed on the pin".

- [x] P0.1 Config accepted; lead offered six collab tools, no `close_agent` (O1).
- [x] P0.2 V2 runs with our provider setup; helpers get no collab tools (O1, O2).
- [x] P0.3 Child stream on the same connection under its own ids; **no child
      `thread/started`**, link is `subAgentActivity.agentThreadId` (O5, O6).
- [x] P0.4 Helper gets the lead's MCP tools and nothing else (O2).
- [x] P0.5 Result reaches the lead as an `agent_message` (O4). Found and fixed
      the gateway dropping these items (model-gateway `agent-message.ts`).
- [x] P0.6 Late answer is lost, not leaked; finished helpers free their slot (O8, O9).
- [x] P0.7 Lead interrupt does not stop helpers; child interrupt + archive does (O10).
- [x] P0.8 Helper approvals carry the child thread/turn (O11).
- [x] P0.9 Cap returns a tool error (O7).
- [x] P0.10 Budget: `features.rollout_budget` is tree-wide; spent → every turn
      fails `sessionBudgetExceeded` (O13). Under development upstream.
- [x] P0.11 Fork: `none` ≈ 5 KB, `all` resends the whole chat (O12).
- [x] P0.12 Helper rules reach the child after the lead's base prompt (O3).
      Whether a real model drops the Follow Up block needs a real-model run.
- [x] P0.13 Real gateway model end to end — Chat profile, 2026-10-27.
      `test/codex/subagents-real.test.ts` (skipped unless `REAL_GATEWAY_URL`,
      `REAL_GATEWAY_SECRET`, `REAL_MODEL_ID`, `REAL_MODEL_NAME` are set): 6/6
      pass on `nvidia/nemotron-3-ultra-550b-a55b` through the dev gateway.
      Observed: 2 helpers in parallel, ~18 s, both with `fork_turns: "none"`;
      a helper told to write was declined (`helper_write`), nothing written;
      an injected "call create_issue" in a helper result did not run the write
      even with `create_issue` allowed for the chat; Stop settled the lead and
      the helper; helpers off offers no collab tools; a 10-helper storm ended
      `SUBAGENT_LIMIT` with 6 helpers done and the 7th stopped before any
      usage. Anthropic and Gemini profiles: not run — the only Anthropic
      profile fails upstream (`profileArn is required`), no Gemini profile is
      enabled. Re-run this file per profile before enabling it for helpers.
      Platform end to end: `platform-next/test/integration/subagents-real.test.ts`
      (same env vars, in-memory Mongo): 4/4 pass — 2 helper rows saved once
      and read back, run usage covers helper usage, `helperCount` set; a
      dropped stream reconnects to the same helpers; Stop saves helpers as
      `stopped`; an agent without helpers starts none.
      Latency (input to Phase 5), same two-part prompt, timed per request:
      adapter 12.3 s with helpers (6 model requests) vs 3.3 s without (1);
      platform 23 s vs ~6 s, with one earlier platform run at 80 s. The
      helpers do run in parallel; the cost is the extra serial lead turns
      (spawn → wait → answer, ~4 lead requests instead of 1) plus provider
      variance (one helper request 16.5 s, one lead request 13.7 s).
      Adapter/platform overhead between requests is under 0.2 s. On this
      model helpers only pay off when each helper's work is slower than ~2
      extra lead turns; small tasks are faster without them.

## Phase 1: Adapter correctness (off by default) — done 2026-10-26

Tests: `test/unit/unit.test.ts` ("sub-agents contract and config") and
`test/codex/subagents.test.ts` (10 tests on the real pin).

- [x] 1.1 `contract.ts`: `subAgents?: { maxConcurrent: 1..3 }`; unknown fields
      rejected. Coding runtimes refuse it (`SUBAGENTS_DISABLED`, 409).
- [x] 1.2 `codex/config.ts`: V2 block only when set (lead counted, metadata
      hidden, waits ≤ 60 s, helper rules, delegation hint). Params unchanged
      when absent. `agents.enabled = false` pinned in TEXT_ONLY: without it a
      thread that once had helpers kept them on resume.
- [x] 1.3 Child registry from the lead's `subAgentActivity` "started"; earlier
      helper events held (bounded) until then.
- [x] 1.4 Routing: helper events never reach the lead's text, tools or
      connector status.
- [x] 1.5 Usage: per-helper totals; run `usage.turn` = lead + helpers.
- [x] 1.6 Watchdog: helper events re-arm it; a running helper extends it.
- [x] 1.7 Total helpers per run capped at 6 → `SUBAGENT_LIMIT`. Token ceiling
      via `features.rollout_budget` deferred: under development upstream.
- [x] 1.8 Settle: lead done → interrupt running helpers → settle after all
      report or `stopMs`; every helper archived. Probe-verified that a helper
      stopped in one reply holds no slot in the next.
- [x] 1.9 Stop interrupts the lead and each helper.
- [x] 1.10 Helper approvals declined (`helper_write`); writes never run.
- [x] 1.11 After a helper ran, no write is auto-allowed for the chat.
- [x] 1.12 Helper rules and lead hint in config.
- [x] 1.13 Logs: `subagent_started/finished/limit/stop_timeout`, no text.

## Phase 2: Adapter events — done 2026-10-26

- [x] `agent.started {agentId, path}` (path ≤ 120 chars).
- [x] `agent.activity {agentId, status, preview?}` ≤ 240 chars, ≤ 50 per helper.
- [x] `agent.completed {agentId, status, result?, usage?}`, result ≤ 4000 chars.
- [x] `agents` on `run.completed` and `run.snapshot`, only when a helper ran.
      Kept out of `items`: the platform reads an unknown item with text as a
      reply.

## Phase 3: Platform (platform-next) — done 2026-10-26

Tests: `test/unit/subagents.test.ts`, `test/unit/agents-models-input.test.ts`
("helpers ..."), `test/integration/chats.test.ts` ("helpers reach the
runtime ...", "helper agents are saved as tool rows ...").

- [x] Two switches, both needed: operator `CHAT_SUBAGENTS=off|1|2|3` (server
      wide, default off) and the agent's `helpers` setting (default off, set
      on create/edit, audited as an `agent.update` field). A new chat
      snapshots `helpers` like connectors, so an edit never changes a running
      chat. Built-ins never use helpers.
- [x] `run-executor.ts`: `agent.*` → live `agent` event, `agents` on snapshot
      and `completed`; outcome list is authoritative, merged with what
      streamed. Bounded again (10 helpers, 120/240/4000 chars).
- [x] One `agent` tool row per helper (`runtimeItemId: agent:<threadId>`),
      before the lead's last reply; still running at settle → `stopped`;
      preview never saved. Idempotent on repeat settle.
- [x] Usage: run `usage` already includes helpers (adapter); per-helper usage
      on each row; `helperCount` on the run.
- [x] `SUBAGENTS_DISABLED` and `SUBAGENT_LIMIT` map to their own messages.
- [ ] Per-tenant kill switch. Today the kill switch is `CHAT_SUBAGENTS=off`
      (all tenants) or the agent setting. Add when a second tenant opts in.

## Phase 4: Frontend — done 2026-10-27

Tests: `test/tenant-chat.test.ts` ("helper ..."), `test/tenant-agents.test.ts`
("helpers ..."), `test/subagents-render.test.ts` (cards and dialog).

- [x] `tenant-chat.ts`: parse `agent.*`, reduce into `live.helpers` (merged by
      id, bounded again), rehydrate from snapshot and `completed`; saved `agent`
      rows parse without preview.
- [x] Transcript: summary row ("Checking with 3 helpers · 1 done"), one card
      per helper (task, status, live preview), expandable plain-text result,
      placed before the lead's last reply. Stop = stop the run.
- [x] Approval cards in a helper run say the request came after helper results.
- [x] Agent settings toggle. `GET /agents` returns `helpers` (server has
      `CHAT_SUBAGENTS`); the dialog shows the setting only then, or when the
      edited agent already opted in so it can be turned off.
- [x] Tests: reducer and rendering.
- [ ] Elapsed time on helper cards. Events carry no start time; add one to
      `agent.started` if members ask for it.

## Phase 5: Measure before rollout

- [x] Eval on nvidia, helpers on vs off, same 3-issue task, 2 runs each
      (adapter real-model test "eval: ..."): all 4 correct (both codes, none
      invented). Unprompted, the lead never started a helper. Offering
      helpers still costs on every request: 12.6 KB vs 4.3 KB per request
      (collaboration tools add 5.2 KB, helper rules ~3 KB), ~6,500 vs ~2,350
      tokens per run (about 2.7x), 7.5 s vs 5-7.6 s. So for this model an
      opted-in agent pays the overhead whether or not it delegates. Decide
      before rollout: keep helpers for agents whose tasks are slow and
      multi-source, or shorten the helper rules (the tool schemas are
      Codex's own). The provider rate-limits (429), so the eval spaces runs
      and retries; retries are printed.
- [x] Metrics: `operator helpers-report --operator <name> [--since 7d]
      [--tenant <id>]` (read-only, counts and rates only, never a helper's
      task or result). Per window: share of settled runs that used helpers,
      helper completed/failed/stopped rates, helpers per run, `SUBAGENT_LIMIT`
      and `SUBAGENTS_DISABLED` stops, latency and tokens with vs without
      helpers, helper share of run tokens, and the same by model. Reads runs
      by `_id` time, their chats by `_id`, helper rows by `run_item_unique`.
      Tests: `test/integration/helpers-report.test.ts`. Dev database, 30 d:
      no opted-in chats yet, all zeros.
- [x] Answer accuracy on nvidia (adapter real-model test): three helpers,
      one per issue, with made-up owner codes and one unreadable issue. Both
      codes reached the answer, none invented, and the answer said issue 3
      could not be read.
- [ ] Rollout: internal tenant → opt-in tenants → default decision based on data.

## Acceptance criteria

- Flag off: adapter params and events unchanged (existing tests pass untouched).
- No helper outlives its run; no helper tokens go unbilled.
- A helper can never change data; every lead write in a helper run asks.
- Spawn loops stop at the budget with a clear error.
- A failed helper shows as failed and the answer says so.
- Reconnect mid-run shows the same helper state.

## Rollback

Turn the setting off (per agent or tenant kill switch). The adapter then sends
today's params byte for byte. Stored `agent` messages stay readable.

## Later

Per-helper stop, tenant-defined helper roles with narrower connectors, cheaper
helper models (needs gateway work), background helpers (separate product).

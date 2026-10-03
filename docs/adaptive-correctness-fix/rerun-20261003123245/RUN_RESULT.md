# Live rerun: Direct vs Omni vs Adaptive V2

**All 15 responses completed. Neither Qlik task completed in any mode.** No Qlik business tool executed successfully, no applications or app details were retrieved, and no response projection occurred. The correctness gate remains unsuccessful; these counters do not establish successful-task optimization.

Run: October 3, 2026. Direct, Omni required projection and Adaptive ran sequentially. Within each fresh thread, every response was awaited before submitting the next exact message. All modes used the supplied model/MCP, 30-second startup and 120-second business timeout, 600-second turn budget, 180-second provider header/idle budget, and the same declared approval/sandbox controls. Actual approval prompts differed: 0 Direct, 0 Omni, 2 Adaptive discovery confirmations.

## Input and output tokens for every turn

Each cell is **reported input / output / provider calls**.

| Turn      | Exact message                         |               Direct |        Omni required |          Adaptive V2 |
| --------- | ------------------------------------- | -------------------: | -------------------: | -------------------: |
| 1         | hi this is ashok ?                    |      7,953 / 111 / 1 |      8,581 / 112 / 1 |      3,068 / 179 / 1 |
| 2         | What is the capital of India ?        |       8,067 / 47 / 1 |       8,696 / 56 / 1 |       3,241 / 56 / 1 |
| 3         | what are the Qlik apps ?              |     24,965 / 148 / 3 |     35,763 / 157 / 4 |     11,756 / 189 / 3 |
| 4         | What is the capital of tamilnadu ?    |       8,630 / 43 / 1 |       9,243 / 51 / 1 |       3,798 / 55 / 1 |
| 5         | Explain this qlik app T_DCF_BANKREC_P |     17,580 / 127 / 2 |     18,749 / 178 / 2 |      4,291 / 108 / 1 |
| **Total** | Five messages                         | **67,195 / 476 / 8** | **81,032 / 554 / 9** | **26,154 / 587 / 7** |

All three modes together consumed **174,381 reported input + 1,617 reported output = 175,998 reported tokens**, over 24 provider calls. These are upstream counters, not independently verified billing.

## Latency and execution

These are complete user-turn timings, including platform recovery before inference.

| Turn | Direct seconds | Omni seconds | Adaptive seconds | Qlik evidence             |
| ---- | -------------: | -----------: | ---------------: | ------------------------- |
| 1    |           5.05 |         4.23 |             4.84 | Not required              |
| 2    |           2.43 |         3.43 |             3.23 | Not required              |
| 3    |           9.66 |        72.36 |            69.18 | Unavailable in every mode |
| 4    |           2.22 |         3.63 |             2.43 | Not required              |
| 5    |           5.83 |        37.31 |            63.95 | Unavailable in every mode |

Captured whole-arm wall time, including setup and initial MCP discovery: **Direct 64.57s, Omni 125.14s, Adaptive 208.88s**.

## What happened

- **Direct:** fresh MCP startup failed after 30 seconds; zero Qlik schemas loaded. Six resource/template queries reused the same cached startup error. They were not six new connections or business-tool invocations.
- **Omni:** its local four-tool gateway responded, but three discover_tools attempts failed after approximately 30 seconds each. No invoke_tool business execution occurred.
- **Adaptive:** the downstream registry stayed explicitly failed. Six genuine initialization attempts occurred: two at startup, two before the app-list turn and two before the explanation turn. Each waited approximately 30 seconds without HTTP headers. Both Qlik routes used discovery with fallbackCode=registry_unavailable. This run did not exercise the healthy direct Top-K path.
- **Pruning persisted:** Direct exposed 25 native and zero Qlik schemas per provider request; Omni exposed 25 native plus four gateway schemas; Adaptive exposed two mandatory controls on general turns, plus four fallback schemas on Qlik turns.
- **Input composition:** Direct repeatedly sent 24,142 native-schema JSON bytes and 12,624 system-text bytes. Omni's complete schema array was 26,310 bytes. The detailed report records Adaptive's actual smaller schemas/system text and each request's accumulated history. These byte counts are not exact component token charges. An empty MCP schema array serializes to two bytes; it contains no loaded Qlik schema.
- **Latency matters:** Adaptive's app-list runtime trace is 8.90s, while the complete turn is 69.18s. Its explanation runtime trace is 3.80s, while the complete turn is 63.95s. Approximately 60 seconds of pre-inference recovery must be included in both.
- **Answer correctness:** New Delhi and Chennai were correct. No mode fabricated app metadata, but some replies overstate fresh reconnection or infer a temporary/server-side cause without service logs.
- **Accounting:** all 24 provider responses were HTTP 200, with input/output counters present. One Omni response generated a tool call while reporting zero output tokens. Its 554 output total is therefore an anomalous upstream total, not independently verified billing. Missing cache/reasoning counters remain unknown.
- **Projection:** no successful business result reached the gateway, so before/after bytes and projection savings are not measurable.
- **Checker caveat:** the strict operation-scope check rejects Direct's resource/template queries outside its expected business-tool set. They failed before returning data; that check is not evidence of a successful unauthorized business action. Missing actual application and technical evidence independently blocks acceptance.

## Full input, output and raw payloads

[Detailed per-call report and every turn](comparison.md) includes full model inputs/outputs, system/schema/history byte tables, tool arguments/results, timings and links to every captured boundary. [Comparison JSON](comparison.json) and [call ledger](call-ledger.json) retain machine-readable measurements.

[Correctness gate](CORRECTNESS_GATE.md) · [Catalog and transport health](catalog-health.json) · [Run validation](validation.json).

The first launcher attempt failed schema resolution before any provider call. It is retained in [setup failure](setup-failure-direct/direct-capture.json) and excluded from these mode totals. Corrected launches explicitly set PROJECT_ROOT. No production environment file, production database record, or pinned Codex file was modified. Benchmark/runtime code is unchanged.

## Reproduce

```sh
PROJECT_ROOT=/Users/ashok/truex-plan platform/node_modules/.bin/tsx platform/scripts/benchmark-five-message-mcp-v2.ts --mode direct --out NEW_DIRECTORY/direct
PROJECT_ROOT=/Users/ashok/truex-plan platform/node_modules/.bin/tsx platform/scripts/benchmark-five-message-mcp-v2.ts --mode omni --out NEW_DIRECTORY/omni
PROJECT_ROOT=/Users/ashok/truex-plan platform/node_modules/.bin/tsx platform/scripts/benchmark-five-message-mcp-v2.ts --mode adaptive --out NEW_DIRECTORY/adaptive
```

Restore fresh Qlik initialization before interpreting another run as a successful business-task cost comparison.

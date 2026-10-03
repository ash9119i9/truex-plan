# Live correctness and parity gate

**Status: blocked. Performance claims allowed: false.**

This verifier performed no model, MCP, database or network call. Missing or unsuccessful live business evidence blocks an equivalent-work optimization claim. Cached descriptors and local fixture results are not counted as a live replay.

[Read-only endpoint diagnostics and root-cause boundaries](../ROOT_CAUSE.md). The [earlier five-message report and complete raw payloads](../../five-message-mcp-v2/comparison.md) remain historical evidence; their failed connector arms are not a new successful live run.

| Turn        | Exact user message                    | Direct reported input / output / calls | Omni reported input / output / calls | Adaptive reported input / output / calls |
| ----------- | ------------------------------------- | -------------------------------------: | -----------------------------------: | ---------------------------------------: |
| 1           | hi this is ashok ?                    |                                not run |                              not run |                                  not run |
| 2           | What is the capital of India ?        |                                not run |                              not run |                                  not run |
| 3           | what are the Qlik apps ?              |                                not run |                              not run |                                  not run |
| 4           | What is the capital of tamilnadu ?    |                                not run |                              not run |                                  not run |
| 5           | Explain this qlik app T_DCF_BANKREC_P |                                not run |                              not run |                                  not run |
| **Overall** | All five prompts                      |                                not run |                              not run |                                  not run |

| Check                                      | Status  | Evidence / limit                                                                                                                      |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| direct: capture present                    | blocked | No new live capture exists. Local fixtures and historical benchmark files are not a live rerun.                                       |
| omni: capture present                      | blocked | No new live capture exists. Local fixtures and historical benchmark files are not a live rerun.                                       |
| adaptive: capture present                  | blocked | No new live capture exists. Local fixtures and historical benchmark files are not a live rerun.                                       |
| Direct/Adaptive: equal listing page        | blocked | Compare actual page size/limit/offset/returned/total and every app name/GUID/stream; reload timestamps are not a stable equality key. |
| Direct/Adaptive: same named-app identities | blocked | Preserve duplicate-name alternatives and compare the actual GUID selected for details.                                                |
| All modes: same pinned runtime             | blocked | Use the same pinned Codex revision; do not modify vendor code.                                                                        |

Every unsuccessful technical read is labeled unverified, including a timeout. A successful general answer or an idle thread does not establish business task completion. If live captures are absent, no input/output cost or speed improvement is measured.

[Machine-readable verification and actual source identities](correctness-verification.json). When capture files exist, run the companion offline reporter to retain every full model input/output and raw payload:

```sh
platform/node_modules/.bin/tsx platform/scripts/report-five-message-mcp-v2.ts --dir docs/adaptive-correctness-fix/live
```

Do not rerun model threads until read-only connector initialization/catalog health is restored. Missing provider usage remains unknown; actual component token charges and output billing cannot be inferred from JSON bytes.

# Live correctness and parity gate

**Status: failed. Performance claims allowed: false.**

This verifier performed no model, MCP, database or network call. Missing or unsuccessful live business evidence blocks an equivalent-work optimization claim. Cached descriptors and local fixture results are not counted as a live replay.

[Read-only endpoint diagnostics and root-cause boundaries](../ROOT_CAUSE.md). The [earlier five-message report and complete raw payloads](../../five-message-mcp-v2/comparison.md) remain historical evidence; their failed connector arms are not a new successful live run.

| Turn        | Exact user message                    | Direct reported input / output / calls | Omni reported input / output / calls | Adaptive reported input / output / calls |
| ----------- | ------------------------------------- | -------------------------------------: | -----------------------------------: | ---------------------------------------: |
| 1           | hi this is ashok ?                    |                         7953 / 111 / 1 |                       8581 / 112 / 1 |                           3068 / 179 / 1 |
| 2           | What is the capital of India ?        |                          8067 / 47 / 1 |                        8696 / 56 / 1 |                            3241 / 56 / 1 |
| 3           | what are the Qlik apps ?              |                        24965 / 148 / 3 |                      35763 / 157 / 4 |                          11756 / 189 / 3 |
| 4           | What is the capital of tamilnadu ?    |                          8630 / 43 / 1 |                        9243 / 51 / 1 |                            3798 / 55 / 1 |
| 5           | Explain this qlik app T_DCF_BANKREC_P |                        17580 / 127 / 2 |                      18749 / 178 / 2 |                           4291 / 108 / 1 |
| **Overall** | All five prompts                      |                        67195 / 476 / 8 |                      81032 / 554 / 9 |                          26154 / 587 / 7 |

| Check                                      | Status  | Evidence / limit                                                                                                                      |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| direct: live provenance                    | pass    | Requires this phase's live marker plus actual correlated captures; markers are not cryptographic attestation.                         |
| direct: exact messages                     | pass    | All five exact prompts must occur in order.                                                                                           |
| direct: same thread and raw user payload   | pass    | Five actual root turn/start RPCs, one thread ID, matching user text.                                                                  |
| direct: completed sequential turns         | pass    | Every previous turn must finish before the next starts.                                                                               |
| direct: specified model                    | pass    | Same supplied model profile and actual translated provider model.                                                                     |
| direct: timeout controls                   | pass    | Turn=600s and upstream header/body timeout=180s for every mode.                                                                       |
| direct: configured permission controls     | pass    | Approval/sandbox settings must match the authorized read-only scenario.                                                               |
| direct: approval and operation scope       | fail    | Only authorized Qlik reads, scoped discovery and turn-5 plan approval; no blanket grants.                                             |
| direct: full boundary correlation          | pass    | Original Responses, actual Responses and provider requests correlate one-to-one.                                                      |
| direct: complete provider accounting       | pass    | Failed/unknown provider attempts are not assumed free; zero tool-output anomalies remain billing limitations.                         |
| direct: correct general answers            | pass    | Capital answers must match the expected facts.                                                                                        |
| direct: actual listing evidence            | blocked | Successful live get_apps with name/GUID/stream rows visible in actual provider history.                                               |
| direct: explanation source identity        | blocked | Named-app lookup and get_app_details must return the selected matching GUID, visible in actual provider history.                      |
| direct: explanation reply claims           | pass    | A failed sheet read is unverified, not evidence of zero sheets; script retry counts must match actual calls.                          |
| direct: full technical task evidence       | blocked | Script, lineage and sheets must be successfully retrieved for this strict full-task gate. Metadata-only work is explicitly partial.   |
| direct: technical source identity          | pass    | Every script/lineage/sheet invocation must target one of the named app GUIDs actually returned by details.                            |
| omni: live provenance                      | pass    | Requires this phase's live marker plus actual correlated captures; markers are not cryptographic attestation.                         |
| omni: exact messages                       | pass    | All five exact prompts must occur in order.                                                                                           |
| omni: same thread and raw user payload     | pass    | Five actual root turn/start RPCs, one thread ID, matching user text.                                                                  |
| omni: completed sequential turns           | pass    | Every previous turn must finish before the next starts.                                                                               |
| omni: specified model                      | pass    | Same supplied model profile and actual translated provider model.                                                                     |
| omni: timeout controls                     | pass    | Turn=600s and upstream header/body timeout=180s for every mode.                                                                       |
| omni: configured permission controls       | pass    | Approval/sandbox settings must match the authorized read-only scenario.                                                               |
| omni: approval and operation scope         | pass    | Only authorized Qlik reads, scoped discovery and turn-5 plan approval; no blanket grants.                                             |
| omni: full boundary correlation            | pass    | Original Responses, actual Responses and provider requests correlate one-to-one.                                                      |
| omni: complete provider accounting         | pass    | Failed/unknown provider attempts are not assumed free; zero tool-output anomalies remain billing limitations.                         |
| omni: correct general answers              | pass    | Capital answers must match the expected facts.                                                                                        |
| omni: actual listing evidence              | blocked | Successful live get_apps with name/GUID/stream rows visible in actual provider history.                                               |
| omni: explanation source identity          | blocked | Named-app lookup and get_app_details must return the selected matching GUID, visible in actual provider history.                      |
| omni: explanation reply claims             | pass    | A failed sheet read is unverified, not evidence of zero sheets; script retry counts must match actual calls.                          |
| omni: full technical task evidence         | blocked | Script, lineage and sheets must be successfully retrieved for this strict full-task gate. Metadata-only work is explicitly partial.   |
| omni: technical source identity            | pass    | Every script/lineage/sheet invocation must target one of the named app GUIDs actually returned by details.                            |
| adaptive: live provenance                  | pass    | Requires this phase's live marker plus actual correlated captures; markers are not cryptographic attestation.                         |
| adaptive: exact messages                   | pass    | All five exact prompts must occur in order.                                                                                           |
| adaptive: same thread and raw user payload | pass    | Five actual root turn/start RPCs, one thread ID, matching user text.                                                                  |
| adaptive: completed sequential turns       | pass    | Every previous turn must finish before the next starts.                                                                               |
| adaptive: specified model                  | pass    | Same supplied model profile and actual translated provider model.                                                                     |
| adaptive: timeout controls                 | pass    | Turn=600s and upstream header/body timeout=180s for every mode.                                                                       |
| adaptive: configured permission controls   | pass    | Approval/sandbox settings must match the authorized read-only scenario.                                                               |
| adaptive: approval and operation scope     | pass    | Only authorized Qlik reads, scoped discovery and turn-5 plan approval; no blanket grants.                                             |
| adaptive: full boundary correlation        | pass    | Original Responses, actual Responses and provider requests correlate one-to-one.                                                      |
| adaptive: complete provider accounting     | pass    | Failed/unknown provider attempts are not assumed free; zero tool-output anomalies remain billing limitations.                         |
| adaptive: correct general answers          | pass    | Capital answers must match the expected facts.                                                                                        |
| adaptive: actual listing evidence          | blocked | Successful live get_apps with name/GUID/stream rows visible in actual provider history.                                               |
| adaptive: explanation source identity      | blocked | Named-app lookup and get_app_details must return the selected matching GUID, visible in actual provider history.                      |
| adaptive: explanation reply claims         | pass    | A failed sheet read is unverified, not evidence of zero sheets; script retry counts must match actual calls.                          |
| adaptive: full technical task evidence     | blocked | Script, lineage and sheets must be successfully retrieved for this strict full-task gate. Metadata-only work is explicitly partial.   |
| adaptive: technical source identity        | pass    | Every script/lineage/sheet invocation must target one of the named app GUIDs actually returned by details.                            |
| Direct/Adaptive: equal listing page        | blocked | Compare actual page size/limit/offset/returned/total and every app name/GUID/stream; reload timestamps are not a stable equality key. |
| Direct/Adaptive: same named-app identities | blocked | Preserve duplicate-name alternatives and compare the actual GUID selected for details.                                                |
| All modes: same pinned runtime             | pass    | Use the same pinned Codex revision; do not modify vendor code.                                                                        |
| Omni: required projection                  | pass    | Omni is the required-projection comparison arm.                                                                                       |

Every unsuccessful technical read is labeled unverified, including a timeout. A successful general answer or an idle thread does not establish business task completion. If live captures are absent, no input/output cost or speed improvement is measured.

[Machine-readable verification and actual source identities](correctness-verification.json). When capture files exist, run the companion offline reporter to retain every full model input/output and raw payload:

```sh
platform/node_modules/.bin/tsx platform/scripts/report-five-message-mcp-v2.ts --dir docs/adaptive-correctness-fix/rerun-20261003123245
```

Do not rerun model threads until read-only connector initialization/catalog health is restored. Missing provider usage remains unknown; actual component token charges and output billing cannot be inferred from JSON bytes.

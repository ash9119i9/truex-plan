# Captured-catalog-only routing trace

**No live execution: 0 model calls, 0 network calls, 0 business tool calls.** This demonstrates routing against the historical healthy fourteen-tool Qlik descriptors. It is not a current catalog probe, live benchmark, or performance result.

Source: [historical sanitized capture](../adaptive-mcp-v2/adaptive/adaptive-capture.json). Source SHA-256 and every candidate/selected schema are retained in [JSON](captured-catalog-routing-trace.json).

| Turn | Exact user message                    | Mode         | Observed route score / threshold | Captured MCP schemas | Captured selected schema JSON bytes | Selected tools                                                         |
| ---- | ------------------------------------- | ------------ | -------------------------------: | -------------------: | ----------------------------------: | ---------------------------------------------------------------------- |
| 1    | hi this is ashok ?                    | no_tools     |                    0.2000 / 0.85 |                    0 |                                   2 | none                                                                   |
| 2    | What is the capital of India ?        | no_tools     |                    0.0000 / 0.85 |                    0 |                                   2 | none                                                                   |
| 3    | what are the Qlik apps ?              | direct_tools |                    1.0000 / 0.85 |                    1 |                                 994 | get_apps                                                               |
| 4    | What is the capital of tamilnadu ?    | no_tools     |                    0.0000 / 0.85 |                    0 |                                   2 | none                                                                   |
| 5    | Explain this qlik app T_DCF_BANKREC_P | direct_tools |                    1.0000 / 0.85 |                    5 |                                3499 | get_apps, get_app_details, get_app_script, get_lineage, get_app_sheets |

Schema bytes are compact JSON of the captured name/description/parameters arrays. The empty schema array is 2 bytes. They are not exact token charges or measured final provider payload bytes.

| App explanation                       | Original app-details anchor score | Expanded app-details anchor score | Original best score | Expanded best score |
| ------------------------------------- | --------------------------------: | --------------------------------: | ------------------: | ------------------: |
| Explain this qlik app T_DCF_BANKREC_P |                            0.4761 |                            1.0000 |              0.7132 |              1.0000 |
| Explain SAP Data Replication Tracker  |                            0.0000 |                            1.0000 |              0.3867 |              1.0000 |

Expansion: `Explain this qlik app T_DCF_BANKREC_P qlik app details`. Recognized app explanation adds the resolved server and app-details capability to metadata retrieval; no model call or invented score. The actual expanded app-details score must meet the unchanged configured threshold; a low-confidence/custom retriever is not overridden.

Expansion: `Explain SAP Data Replication Tracker qlik app details`. Recognized app explanation adds the resolved server and app-details capability to metadata retrieval; no model call or invented score. The actual expanded app-details score must meet the unchanged configured threshold; a low-confidence/custom retriever is not overridden.

Authorization, unavailable-registry handling, ambiguous server/vendor selection, missing capabilities, Top-K limits, extra output tasks, and strict/custom retriever thresholds are exercised by focused router tests. This descriptor demonstration does not assert that those permissions or remote conditions currently hold.

The complete model inputs, provider outputs and business evidence needed for a live comparison remain unavailable until connector initialization recovers. [Live correctness gate](live/CORRECTNESS_GATE.md).

# Live omni MCP benchmark

Projection policy: **required**.

Captured 2026-10-03T01:23:26.083Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | Hi bro ? | 1 | 8578 | 127 | 5032 | completed |
| 2 | Can you list down the apps in the qlik ? | 5 | 47961 | 936 | 34875 | completed |
| 3 | What is the capital of india ? | 1 | 12696 | 9 | 1620 | completed |
| **Total known usage** | | **7** | **69235** | **1072** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 8578 | 127 | 4776 |
| 2 | 2 | 29 | 8710 | 0 | 1943 |
| 3 | 2 | 29 | 8815 | 0 | 2101 |
| 4 | 2 | 29 | 9130 | 0 | 2237 |
| 5 | 2 | 29 | 9441 | 0 | 3148 |
| 6 | 2 | 29 | 11865 | 936 | 16884 |
| 7 | 3 | 29 | 12696 | 9 | 1546 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: Hi bro ?

Status: completed. Thread: `01a0ff5b-eec4-7880-b69e-7fadf2ebd7f8`.

Hey! I'm your Truex assistant, here to help with business questions, data from your connected systems, documents, research, and general consulting-type work.

A few things I can do:
- Pull insights from your connected business data (right now I have a Qlik connector available)
- Research current information on the web with citations
- Create or revise documents (PDF, Word, Excel, PowerPoint)
- Build interactive visualizations when they'd help explain something
- Help plan and execute multi-step projects

What are you working on today?

Tool exchanges:

```json
[]
```

### Turn 2: Can you list down the apps in the qlik ?

Status: completed. Thread: `01a0ff5b-eec4-7880-b69e-7fadf2ebd7f8`.

Here are the first 50 published Qlik Sense apps (there are 1,324 total, so this is just a slice — let me know if you want more pages or want me to filter by name/stream):

| App Name | Stream |
|---|---|
| E_Snowflake_SO DN DATA | QVD Generator |
| Regional P&L Dashboard v2 | PRO Finance Executives |
| FI-COPA Reconciliation Dashboard | CORP FIN21 Development |
| Regional P&L Dashboard | PRO Finance Executives |
| T_FI_COPA_Reconciliation | QVD Generator |
| E_SF_GSSC_SAP_HMP_SG&A | QVD Generator |
| Auto Finance CBU Reporting Summary | AUTO Finance CBU SBU |
| T_Finance_RegionalP&L v2 | QVD Generator |
| HCON Flexible Live | LS Consumer Sales&Finance |
| T_Finance_RegionalP&L | QVD Generator |
| E_Snowflake_FIN2021_RECON_SAP_HCP | QVD Generator |
| Pro Cost Center Report | PRO Shared Services |
| Lease Identification and Reconciliation Monitor (LEASEIDRECON) | CORP Shared Services |
| T_HMP_Pro_Cost_Center_Report | QVD Generator |
| T_GSSC_REFX_IDNFCN_RECONCLN_LEASEIDRECON_02 | QVD Generator |
| T_GSSC_REFX_IDNFCN_RECONCLN_LEASEIDRECON_01 | QVD Generator |
| Accounts Receivable (FBL5N_ZFI0180) | CORP Shared Services |
| Project CLEAR Analysis | AUTO Engineering Resources |
| E_SF_RegionalP&L v2 | QVD Generator |
| E_SF_RegionalP&L | QVD Generator |
| T_FI_FunctionalAreaP&L | QVD Generator |
| E_SF_GSSC_REFX_ID_RECON_LEASEIDRECON | QVD Generator |
| T_HCON_Flexible | QVD Generator |
| E_SF_GSSC_SAP_Cost_Center | QVD Generator |
| SAP Data Replication Tracker | Everyone |
| SAP Data Replication Tracker Dashboard (Internal) | CORP CoE |
| T_SAP_Data_Replication_Tracker | QVD Generator |
| E_SAP_Data_Replication_Tracker | QVD Generator |
| T_FBL5N | QVD Generator |
| E_Snowflake_HCPFAGLFXA | QVD Generator |
| T_FIN21_COPA | QVD Generator |
| GM Customer Scorecard | AUTO Customer Scorecard |
| T_GM_Customer_Scorecard | QVD Generator |
| E_HCON_Flexible | QVD Generator |
| Hardware Design Quality | AUTO Quality |
| E_File_GM_Customer_Scorecard | QVD Generator |
| DECAF - Demand Current vs. Accepted Freeze | AUTO Business Operations |
| Synergy Tracking | LS Global SIOP |
| T_Samsung_Synergy_Tracking | QVD Generator |
| E_Samsung_Synergy_Tracking | QVD Generator |
| E_COA_SALES_DB | QVD Generator |
| T_COA_SALES_DB_BRAZILSF | QVD Generator |
| ET_SS_Hardware Design Quality | QVD Generator |
| E_SFV_FBL5N | QVD Generator |
| Toyota Warranty | AUTO Quality |
| T_ToyotaWarranty | QVD Generator |
| E_FIN21_COPA | QVD Generator |
| NPI Demand vs Supply | LS Supply Chain |
| T_COA_SALES_DB_MATERIAL_LIST | QVD Generator |
| T_NPI_Demand vs Supply | QVD Generator |

Source: Qlik connector (`get_apps`).

[truex-suggestions]
- Show the next page of Qlik apps
- Filter apps by a specific stream name
- Search for an app by name
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01HVUQHYVp8hGvoopPJKGoQ4",
    "server": "omni",
    "tool": "discover_server",
    "status": "completed",
    "arguments": {
      "query": "qlik"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"servers\":[{\"name\":\"qlik\"}]}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 4
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_013rKYGxb4Uzf2LwHUZjTmgv",
    "server": "omni",
    "tool": "discover_tools",
    "status": "completed",
    "arguments": {
      "server": "qlik",
      "query": "list apps"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"server\":\"qlik\",\"tools\":[{\"name\":\"get_apps\",\"description\":\"Get list of Qlik Sense applications with essential fields and filters (name, stream, published) and pagination.\"},{\"name\":\"get_app_details\",\"description\":\"Get compact application info with filters by guid or name (case-insensitive). Returns metainfo, tables/fields list, master items, sheets and objects with used fields. You must provide at least one of app_id or name.\"},{\"name\":\"get_app_sheets\",\"description\":\"Get list of sheets from application with title and description.\"},{\"name\":\"get_app_sheet_objects\",\"description\":\"Get list of objects from specific sheet with object ID, type and description.\"},{\"name\":\"get_upstream_lineage\",\"description\":\"Fetch the load script of a Qlik Sense app and identify all upstream data dependencies using AWS Bedrock AI. Returns a textual report listing all upstream QVD file dependencies and Snowflake table dependencies found in the app's load script.\"}],\"totalMatched\":5,\"truncated\":false}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 1696
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_018afcMXLQP97pCvNRC34e3V",
    "server": "omni",
    "tool": "get_tool_schema",
    "status": "completed",
    "arguments": {
      "server": "qlik",
      "tool": "get_apps"
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"server\":\"qlik\",\"tool\":\"get_apps\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"limit\":{\"type\":\"integer\",\"description\":\"Maximum number of apps to return (default: 25, max: 50)\",\"default\":25},\"offset\":{\"type\":\"integer\",\"description\":\"Number of apps to skip for pagination (default: 0)\",\"default\":0},\"name\":{\"type\":\"string\",\"description\":\"Wildcard case-insensitive search in application name\"},\"stream\":{\"type\":\"string\",\"description\":\"Wildcard case-insensitive search in stream name\"},\"published\":{\"type\":\"string\",\"description\":\"Filter by published status (true/false or 1/0). Default: true\",\"default\":\"true\"}}},\"responseProjection\":\"invoke_tool.fields is required: choose only needed dotted response paths (arrays traversed automatically), such as apps.name, apps.guid, pagination. ['*'] alone intentionally returns the full result. If outputSchema is absent, use tool documentation to infer paths; non-JSON responses require ['*'].\"}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 3
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01QXYBPWFvcwVgANjToZxK8b",
    "server": "omni",
    "tool": "invoke_tool",
    "status": "completed",
    "arguments": {
      "server": "qlik",
      "tool": "get_apps",
      "arguments": {
        "limit": 50,
        "offset": 0
      },
      "fields": [
        "apps.name",
        "apps.stream",
        "apps.published",
        "apps.guid",
        "pagination"
      ]
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": false,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\"apps\":[{\"name\":\"E_Snowflake_SO DN DATA\",\"stream\":\"QVD Generator\",\"guid\":\"5d149b7a-9664-4f25-ba65-5430c1cf3e79\"},{\"name\":\"Regional P&L Dashboard v2\",\"stream\":\"PRO Finance Executives\",\"guid\":\"86f8dd43-c67d-463f-b728-28c134e7f987\"},{\"name\":\"FI-COPA Reconciliation Dashboard\",\"stream\":\"CORP FIN21 Development\",\"guid\":\"5bbcfef1-9143-48fb-8aea-a85db47d77df\"},{\"name\":\"Regional P&L Dashboard\",\"stream\":\"PRO Finance Executives\",\"guid\":\"3b1adccd-8729-4cc5-9c1e-9c68238fc1f4\"},{\"name\":\"T_FI_COPA_Reconciliation\",\"stream\":\"QVD Generator\",\"guid\":\"fa81d159-e574-4530-888e-859cc81012a9\"},{\"name\":\"E_SF_GSSC_SAP_HMP_SG&A\",\"stream\":\"QVD Generator\",\"guid\":\"4287a76d-b622-40a7-95df-8dbc64a9b996\"},{\"name\":\"Auto Finance CBU Reporting Summary\",\"stream\":\"AUTO Finance CBU SBU\",\"guid\":\"b6be951b-e482-476d-b82c-b5d34a449371\"},{\"name\":\"T_Finance_RegionalP&L v2\",\"stream\":\"QVD Generator\",\"guid\":\"27557aa0-c24f-4152-aca2-39769e7ddf6e\"},{\"name\":\"HCON Flexible Live\",\"stream\":\"LS Consumer Sales&Finance\",\"guid\":\"2cabb10a-f706-4398-ba19-b208cb033e2e\"},{\"name\":\"T_Finance_RegionalP&L\",\"stream\":\"QVD Generator\",\"guid\":\"8f92d542-ebbd-492c-b052-23da337f2eb3\"},{\"name\":\"E_Snowflake_FIN2021_RECON_SAP_HCP\",\"stream\":\"QVD Generator\",\"guid\":\"9a04b42e-fe36-4ec7-9c8d-1cc4d3dd24b3\"},{\"name\":\"Pro Cost Center Report\",\"stream\":\"PRO Shared Services\",\"guid\":\"3e372876-6590-4fee-af3f-1f5c0c75cc61\"},{\"name\":\"Lease Identification and Reconciliation Monitor (LEASEIDRECON)\",\"stream\":\"CORP Shared Services\",\"guid\":\"7ccff50a-a022-46b1-9dce-cf7869fc5aba\"},{\"name\":\"T_HMP_Pro_Cost_Center_Report\",\"stream\":\"QVD Generator\",\"guid\":\"fbc1630e-d625-4327-92f8-18e2c2fdb889\"},{\"name\":\"T_GSSC_REFX_IDNFCN_RECONCLN_LEASEIDRECON_02\",\"stream\":\"QVD Generator\",\"guid\":\"9aa084db-008a-419f-bd9a-4d260964f40b\"},{\"name\":\"T_GSSC_REFX_IDNFCN_RECONCLN_LEASEIDRECON_01\",\"stream\":\"QVD Generator\",\"guid\":\"67022f38-a8c2-413d-a473-2f1a08301925\"},{\"name\":\"Accounts Receivable (FBL5N_ZFI0180)\",\"stream\":\"CORP Shared Services\",\"guid\":\"483bd369-8b05-4cd7-9876-0cae523a61ec\"},{\"name\":\"Project CLEAR Analysis\",\"stream\":\"AUTO Engineering Resources\",\"guid\":\"6593fce6-0168-40db-b993-1a9e4ba8dc89\"},{\"name\":\"E_SF_RegionalP&L v2\",\"stream\":\"QVD Generator\",\"guid\":\"89be13dc-27ae-401f-8e8a-f28d15a91f20\"},{\"name\":\"E_SF_RegionalP&L\",\"stream\":\"QVD Generator\",\"guid\":\"9d2b4ea5-d3b4-40b1-a9d5-4f5d3290a542\"},{\"name\":\"T_FI_FunctionalAreaP&L\",\"stream\":\"QVD Generator\",\"guid\":\"c15a6e38-3a0b-4f8a-b5a4-8addc2a1445d\"},{\"name\":\"E_SF_GSSC_REFX_ID_RECON_LEASEIDRECON\",\"stream\":\"QVD Generator\",\"guid\":\"3e4165bd-89a5-4b82-8376-ba2a14c8e1cf\"},{\"name\":\"T_HCON_Flexible\",\"stream\":\"QVD Generator\",\"guid\":\"d517f317-f27f-4858-89d1-2248b708e115\"},{\"name\":\"E_SF_GSSC_SAP_Cost_Center\",\"stream\":\"QVD Generator\",\"guid\":\"bc3c4eee-189d-4ede-8576-5d8ff86ed52f\"},{\"name\":\"SAP Data Replication Tracker\",\"stream\":\"Everyone\",\"guid\":\"4d072a42-76cf-40eb-86ab-e46f9530250f\"},{\"name\":\"SAP Data Replication Tracker Dashboard (Internal)\",\"stream\":\"CORP CoE\",\"guid\":\"592a4a8a-0f82-498b-9430-e91e86d6e320\"},{\"name\":\"T_SAP_Data_Replication_Tracker\",\"stream\":\"QVD Generator\",\"guid\":\"cd080b04-d172-4622-a874-3d6a3df1805b\"},{\"name\":\"E_SAP_Data_Replication_Tracker\",\"stream\":\"QVD Generator\",\"guid\":\"4c6a8252-5fb3-47cc-a26c-9f53b2fd9976\"},{\"name\":\"T_FBL5N\",\"stream\":\"QVD Generator\",\"guid\":\"275aa070-4dae-489c-869e-36c5ee361b0a\"},{\"name\":\"E_Snowflake_HCPFAGLFXA\",\"stream\":\"QVD Generator\",\"guid\":\"28f11f2f-e3bc-4abd-8533-04269eef7fae\"},{\"name\":\"T_FIN21_COPA\",\"stream\":\"QVD Generator\",\"guid\":\"91c2a6f5-f733-43df-a062-c09553519477\"},{\"name\":\"GM Customer Scorecard\",\"stream\":\"AUTO Customer Scorecard\",\"guid\":\"f8ce643e-7e27-46a4-890b-6f8d4a886a70\"},{\"name\":\"T_GM_Customer_Scorecard\",\"stream\":\"QVD Generator\",\"guid\":\"ea322007-2dbf-4887-8e14-99509b7e9cc6\"},{\"name\":\"E_HCON_Flexible\",\"stream\":\"QVD Generator\",\"guid\":\"3f065ddd-f9b3-4618-8e23-119dd59eab54\"},{\"name\":\"Hardware Design Quality\",\"stream\":\"AUTO Quality\",\"guid\":\"3b07b0ce-3164-437e-8deb-72b435a0910d\"},{\"name\":\"E_File_GM_Customer_Scorecard\",\"stream\":\"QVD Generator\",\"guid\":\"6d9cb61a-c591-40de-82c8-abbea3e893bc\"},{\"name\":\"DECAF - Demand Current vs. Accepted Freeze\",\"stream\":\"AUTO Business Operations\",\"guid\":\"cf5e27c3-38d9-4891-9115-2d1d5c56b034\"},{\"name\":\"Synergy Tracking\",\"stream\":\"LS Global SIOP\",\"guid\":\"0ef6e9ea-2f3d-4475-adb9-ac75964ee958\"},{\"name\":\"T_Samsung_Synergy_Tracking\",\"stream\":\"QVD Generator\",\"guid\":\"821c11a6-b1e1-4140-b0d8-685cd4397018\"},{\"name\":\"E_Samsung_Synergy_Tracking\",\"stream\":\"QVD Generator\",\"guid\":\"07f7672c-dd6a-4690-9234-f6b3a5e13e09\"},{\"name\":\"E_COA_SALES_DB\",\"stream\":\"QVD Generator\",\"guid\":\"678a3cc6-922a-4979-ad73-0a17fa4ecd84\"},{\"name\":\"T_COA_SALES_DB_BRAZILSF\",\"stream\":\"QVD Generator\",\"guid\":\"8d2d5498-6b2b-44a7-8589-f37574bcf621\"},{\"name\":\"ET_SS_Hardware Design Quality\",\"stream\":\"QVD Generator\",\"guid\":\"3334ff26-814d-4d65-a41b-552a0c4a43fd\"},{\"name\":\"E_SFV_FBL5N\",\"stream\":\"QVD Generator\",\"guid\":\"8580145e-3113-46fd-a2db-1e3be561e504\"},{\"name\":\"Toyota Warranty\",\"stream\":\"AUTO Quality\",\"guid\":\"a67ac486-0115-4160-be46-2e682e87a45f\"},{\"name\":\"T_ToyotaWarranty\",\"stream\":\"QVD Generator\",\"guid\":\"87c37506-51d9-46b9-a2ec-b8f1c8b8913b\"},{\"name\":\"E_FIN21_COPA\",\"stream\":\"QVD Generator\",\"guid\":\"1243689b-42fc-4294-8a81-218c20dbcd4a\"},{\"name\":\"NPI Demand vs Supply\",\"stream\":\"LS Supply Chain\",\"guid\":\"1fb74ee4-4109-492a-8901-b85e40bf4364\"},{\"name\":\"T_COA_SALES_DB_MATERIAL_LIST\",\"stream\":\"QVD Generator\",\"guid\":\"2229bf36-ea36-4125-9c30-320d6313b2b1\"},{\"name\":\"T_NPI_Demand vs Supply\",\"stream\":\"QVD Generator\",\"guid\":\"df6e26d7-d1bd-4540-ad7f-3246a02cc9f6\"}],\"pagination\":{\"limit\":50,\"offset\":0,\"returned\":50,\"total_found\":1324,\"has_more\":true,\"next_offset\":50}}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 6278
  }
]
```

### Turn 3: What is the capital of india ?

Status: completed. Thread: `01a0ff5b-eec4-7880-b69e-7fadf2ebd7f8`.

The capital of India is New Delhi.

Tool exchanges:

```json
[]
```

## Payload and observability files

- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](omni-capture.json)
- [Exact JSON-RPC messages written to Codex stdin](omni-codex-input.jsonl)
- [Exact Responses bodies generated by Codex](omni-responses-requests.jsonl)
- [Exact Anthropic request bodies sent upstream](omni-provider-requests.jsonl)

The Codex `turn/start` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.

## Run conditions and limits

The configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness can approve only the explicitly authorized Qlik `get_apps` action or read-only Omni discovery. It refuses writes and unrelated approval prompts. Calls capped at 24, timeout 600000 ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.

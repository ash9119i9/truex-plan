# Live omni MCP benchmark

Captured 2026-10-03T01:54:08.202Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | Hi bro ? | 1 | 8578 | 74 | 3422 | completed |
| 2 | Can you list down the apps in the qlik ? | 5 | 47685 | 438 | 147798 | completed |
| 3 | What is the capital of india ? | 1 | 12145 | 9 | 2018 | completed |
| **Total known usage** | | **7** | **68408** | **521** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 29 | 8578 | 74 | 3325 |
| 2 | 2 | 29 | 8664 | 0 | 2133 |
| 3 | 2 | 29 | 8773 | 0 | 1986 |
| 4 | 2 | 29 | 9092 | 0 | 2187 |
| 5 | 2 | 29 | 9409 | 0 | 123784 |
| 6 | 2 | 29 | 11747 | 438 | 8663 |
| 7 | 3 | 29 | 12145 | 9 | 1947 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: Hi bro ?

Status: completed. Thread: `01a0ff78-0a4d-7242-9ab7-8db4150155d4`.

Hey! I'm Truex, your assistant for working with your business data and getting things done — analysis, documents, research, you name it.

Right now I have a connection to Qlik available, so I can help pull and analyze data from there if you need it. What can I help you with today?

Tool exchanges:

```json
[]
```

### Turn 2: Can you list down the apps in the qlik ?

Status: completed. Thread: `01a0ff78-0a4d-7242-9ab7-8db4150155d4`.

This is a short lookup, not a multi-step task, so here are the first 50 Qlik apps (there are 1,324 total, published apps by default). Grouped by stream:

**LS FIN21**
- Functional Area P&L Dashboard
- Consumer FIN21 COPA Dashboard

**PRO Finance Executives**
- Regional P&L Dashboard
- Regional P&L Dashboard v2

**CORP FIN21 Development**
- FI-COPA Reconciliation Dashboard

**LS Customer Service**
- Global CX Case Dashboard
- Customer Experience - NPS Dashboard
- Reported Event Dashboard
- Bazaarvoice Dashboard

**CORP Shared Services**
- Bank Reconciliation App

**CORP Advanced Manufacturing Engineering Management**
- Archive - Capacity Report AME

**LS Supply Chain**
- LS SKU Liability

**CORP Ariba**
- Corp Ariba Approver Matrix

**PRO Shared Services**
- Pro SG&A Report

**AUTO Sales**
- Auto 5 Year Plan

**LS Global SIOP**
- Spare Parts Dashboard

**LS EMEA Operations**
- Delivery Notes Sent and On Hand

**Monitoring apps**
- Connector Logs Analyzer

**QVD Generator** (many backend/technical apps, e.g. T_FI_COPA_Reconciliation, T_LS_Consumer1b_MainApp, T_Finance_RegionalP&L, E_Demand Current vs. Accepted Freeze_DECAF, and ~25 more)

Since there are 1,324 apps total, want me to pull the next page, filter by a specific stream (e.g. only "LS FIN21" or exclude the QVD Generator technical apps), or search by name?

[truex-suggestions]
- Show the next 50 Qlik apps
- Filter apps by stream name
- Search for an app by name
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01ExkomUeYU9NnTbEU6Pf1Sd",
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
    "id": "toolu_bdrk_01Q4fLP3KWfK15FggJmWxV6L",
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
    "durationMs": 1676
  },
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01PN7DbgQBCuXPbgf6tH7oPz",
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
    "id": "toolu_bdrk_01WEP4C89KNjWhW7dL7HunYc",
    "server": "omni",
    "tool": "invoke_tool",
    "status": "completed",
    "arguments": {
      "server": "qlik",
      "tool": "get_apps",
      "arguments": {
        "limit": 50
      },
      "fields": [
        "apps.name",
        "apps.guid",
        "apps.stream",
        "apps.published",
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
          "text": "{\"apps\":[{\"name\":\"Functional Area P&L Dashboard\",\"guid\":\"73df82fa-600d-42dd-801c-ac10a2bd4bc4\",\"stream\":\"LS FIN21\"},{\"name\":\"Regional P&L Dashboard\",\"guid\":\"3b1adccd-8729-4cc5-9c1e-9c68238fc1f4\",\"stream\":\"PRO Finance Executives\"},{\"name\":\"FI-COPA Reconciliation Dashboard\",\"guid\":\"5bbcfef1-9143-48fb-8aea-a85db47d77df\",\"stream\":\"CORP FIN21 Development\"},{\"name\":\"T_FI_COPA_Reconciliation\",\"guid\":\"fa81d159-e574-4530-888e-859cc81012a9\",\"stream\":\"QVD Generator\"},{\"name\":\"Regional P&L Dashboard v2\",\"guid\":\"86f8dd43-c67d-463f-b728-28c134e7f987\",\"stream\":\"PRO Finance Executives\"},{\"name\":\"T_LS_Consumer1b_MainApp\",\"guid\":\"c2f7ea56-cf5f-424b-b528-ef451a8224d3\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Finance_RegionalP&L\",\"guid\":\"8f92d542-ebbd-492c-b052-23da337f2eb3\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Demand Current vs. Accepted Freeze_DECAF\",\"guid\":\"4253a117-c6c5-4249-aee8-04a6f61dac49\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Finance_RegionalP&L v2\",\"guid\":\"27557aa0-c24f-4152-aca2-39769e7ddf6e\",\"stream\":\"QVD Generator\"},{\"name\":\"Connector Logs Analyzer\",\"guid\":\"d219dad5-e890-4fef-8138-e432d2bbaadc\",\"stream\":\"Monitoring apps\"},{\"name\":\"E_Snowflake_FIN2021_RECON_SAP_HCP\",\"guid\":\"9a04b42e-fe36-4ec7-9c8d-1cc4d3dd24b3\",\"stream\":\"QVD Generator\"},{\"name\":\"Global CX Case Dashboard\",\"guid\":\"22fb8a39-acc5-48e5-85dd-6f550cc10888\",\"stream\":\"LS Customer Service\"},{\"name\":\"T_ProductDashboard (new version)\",\"guid\":\"9f5663f4-d26c-4462-b7c1-1f168b91e27d\",\"stream\":\"QVD Generator\"},{\"name\":\"T_FI_FunctionalAreaP&L Consol\",\"guid\":\"8c5893e9-10a5-4d79-beb0-45ff61e2c30c\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_RegionalP&L\",\"guid\":\"9d2b4ea5-d3b4-40b1-a9d5-4f5d3290a542\",\"stream\":\"QVD Generator\"},{\"name\":\"Customer Experience - NPS Dashboard\",\"guid\":\"2d88ab72-6bc4-477f-acb3-e41b69b168ec\",\"stream\":\"LS Customer Service\"},{\"name\":\"E_SF_RegionalP&L v2\",\"guid\":\"89be13dc-27ae-401f-8e8a-f28d15a91f20\",\"stream\":\"QVD Generator\"},{\"name\":\"Bank Reconciliation App\",\"guid\":\"c4792818-4c1e-4e8b-b082-4333c7ea92ba\",\"stream\":\"CORP Shared Services\"},{\"name\":\"T_DCF_BANKREC_T\",\"guid\":\"30d68613-60a9-466f-8a55-53cc96c4f923\",\"stream\":\"QVD Generator\"},{\"name\":\"T_CustomerServiceNPSDashboard\",\"guid\":\"98f222f1-da80-44e7-9d80-220ab3c113ed\",\"stream\":\"QVD Generator\"},{\"name\":\"T_DCF_BANKREC_P\",\"guid\":\"a3cf67e1-8c4e-4ef5-b016-8f173e1e9ec9\",\"stream\":\"QVD Generator\"},{\"name\":\"Archive - Capacity Report AME\",\"guid\":\"8021a88b-8814-4039-9376-cf8812fc7fad\",\"stream\":\"CORP Advanced Manufacturing Engineering Management\"},{\"name\":\"LS SKU Liability\",\"guid\":\"9f512315-8880-4d7a-bc01-33ae26330e21\",\"stream\":\"LS Supply Chain\"},{\"name\":\"T_LS_SKULiability\",\"guid\":\"9f58c6d7-c6fe-40ab-83b7-cdc6524d750d\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Archive_CapacityReporting\",\"guid\":\"807af6eb-c38f-4045-9ef1-0887fb6de50d\",\"stream\":\"QVD Generator\"},{\"name\":\"E_HMP_Quality\",\"guid\":\"4e0bfd81-ec3b-41e9-a5ba-a715d31b12ac\",\"stream\":\"QVD Generator\"},{\"name\":\"Reported Event Dashboard\",\"guid\":\"a27e6097-337c-49fb-a364-14203ef7d887\",\"stream\":\"LS Customer Service\"},{\"name\":\"T_ProductDashboard\",\"guid\":\"863e871d-5498-4555-9ff3-e2a657e35135\",\"stream\":\"QVD Generator\"},{\"name\":\"T_ReportedEvent\",\"guid\":\"946b0608-644b-4896-9591-e48d5bce4343\",\"stream\":\"QVD Generator\"},{\"name\":\"Corp Ariba Approver Matrix\",\"guid\":\"fed09212-9a6d-4c3b-a3b9-4b54cfd36423\",\"stream\":\"CORP Ariba\"},{\"name\":\"T_CorpAriba_ApproverMatrix\",\"guid\":\"07ecadd6-fd2e-4acc-8118-3167409320dd\",\"stream\":\"QVD Generator\"},{\"name\":\"Bazaarvoice Dashboard\",\"guid\":\"05259c58-2f0e-4e9e-910d-862c239a33ef\",\"stream\":\"LS Customer Service\"},{\"name\":\"T_GF_Surveys\",\"guid\":\"fafb50b1-eba6-4536-aef4-7e0e877ce0fd\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Bazaarvoice\",\"guid\":\"8311bff8-bfbc-4fc1-9e6f-e0b410089ffb\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Snowflake_SalesforceData\",\"guid\":\"d3c82c51-ca42-4ada-ac4d-c5a6aab6fce6\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Auto_Salesforce_ProductManagement\",\"guid\":\"a0f30401-e657-4712-94b4-3715fa45e08e\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Snowflake_LS_SKULiability_Snapshot\",\"guid\":\"e703446e-59cd-455c-b8de-e940e8b20215\",\"stream\":\"QVD Generator\"},{\"name\":\"E_QVD_ADAriba\",\"guid\":\"26387b33-1f99-40f7-963e-7d0940c8580e\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Auto_Salesforce_ProductManagement\",\"guid\":\"5b4e7dfb-cb0b-429b-87f4-811ffbf20f84\",\"stream\":\"QVD Generator\"},{\"name\":\"Pro SG&A  Report\",\"guid\":\"def9a777-b44f-4186-9d46-5ea9c0ed46ef\",\"stream\":\"PRO Shared Services\"},{\"name\":\"Auto 5 Year Plan\",\"guid\":\"850ee796-cdc0-43c0-800b-f6ce47ecfced\",\"stream\":\"AUTO Sales\"},{\"name\":\"T_Auto_5_Year_Plan\",\"guid\":\"3528b872-89b5-43ee-b2d6-f49b6693a3fc\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_Auto_5_Year_Plan\",\"guid\":\"fa1919ef-7ca3-4438-9cc7-1040fb7e02ec\",\"stream\":\"QVD Generator\"},{\"name\":\"T_HMP_Pro_SG&A_Report\",\"guid\":\"fe53e978-11dd-44ff-b1c7-d6d998258d15\",\"stream\":\"QVD Generator\"},{\"name\":\"Spare Parts Dashboard\",\"guid\":\"4f5ff4e9-bde9-4194-90ba-47a9458b9848\",\"stream\":\"LS Global SIOP\"},{\"name\":\"T_Spare Parts Dashboard\",\"guid\":\"eb5f302a-e2dd-4193-a1de-12fc25b69046\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Snowflake_Current year of FA P&L\",\"guid\":\"b74dfb39-76f3-4059-837b-d3e0df84a746\",\"stream\":\"QVD Generator\"},{\"name\":\"Delivery Notes Sent and On Hand\",\"guid\":\"5746b096-0f3c-40cf-b1a7-df5258464e5a\",\"stream\":\"LS EMEA Operations\"},{\"name\":\"Consumer FIN21 COPA Dashboard\",\"guid\":\"ba902446-47c0-41c8-a35d-f75244b98458\",\"stream\":\"LS FIN21\"},{\"name\":\"T_DN Data\",\"guid\":\"8a7919c9-c541-49d7-bf9c-281746360b0a\",\"stream\":\"QVD Generator\"}],\"pagination\":{\"limit\":50,\"offset\":0,\"returned\":50,\"total_found\":1324,\"has_more\":true,\"next_offset\":50}}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 6972
  }
]
```

### Turn 3: What is the capital of india ?

Status: completed. Thread: `01a0ff78-0a4d-7242-9ab7-8db4150155d4`.

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

# Live adaptive MCP V2 benchmark

Captured 2026-10-03T01:59:42.651Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | Hi bro ? | 1 | 3065 | 128 | 4436 | completed |
| 2 | Can you list down the apps in the qlik ? | 2 | 9155 | 642 | 19538 | completed |
| 3 | What is the capital of india ? | 1 | 6079 | 52 | 3029 | completed |
| **Total known usage** | | **4** | **18299** | **822** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 3065 | 128 | 4186 |
| 2 | 2 | 3 | 3425 | 0 | 1940 |
| 3 | 2 | 3 | 5730 | 642 | 11022 |
| 4 | 3 | 2 | 6079 | 52 | 2815 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: Hi bro ?

Status: completed. Thread: `01a0ff7d-2f36-7232-a730-c71a9b022c17`.

Hey! I'm your Truex assistant, here to help as a senior consultant on whatever you're working on.

I can help with things like:
- Answering questions and summarizing documents you share with me
- Pulling and analyzing business data through connected tools (I have Qlik available right now)
- Researching current info with web search
- Creating documents (PDF, Word, Excel, PowerPoint) or interactive visualizations
- Working through multi-step projects with a clear plan you approve first

What are you looking to get done today?

Tool exchanges:

```json
[]
```

### Turn 2: Can you list down the apps in the qlik ?

Status: completed. Thread: `01a0ff7d-2f36-7232-a730-c71a9b022c17`.

There are 1,324 published apps total in Qlik, so here's the first batch (50 of them), grouped by stream:

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

**QVD Generator** (data prep/backend apps feeding the dashboards above)
- T_FI_COPA_Reconciliation, T_LS_Consumer1b_MainApp, T_Finance_RegionalP&L, T_Finance_RegionalP&L v2, E_Demand Current vs. Accepted Freeze_DECAF, E_Snowflake_FIN2021_RECON_SAP_HCP, T_ProductDashboard (new and old), T_FI_FunctionalAreaP&L Consol, E_SF_RegionalP&L (and v2), T_DCF_BANKREC_T/P, T_CustomerServiceNPSDashboard, T_LS_SKULiability, T_Archive_CapacityReporting, E_HMP_Quality, T_ReportedEvent, T_CorpAriba_ApproverMatrix, T_GF_Surveys, T_Bazaarvoice, E_Snowflake_SalesforceData, T_Auto_Salesforce_ProductManagement, E_Snowflake_LS_SKULiability_Snapshot, E_QVD_ADAriba, E_Auto_Salesforce_ProductManagement, T_Auto_5_Year_Plan, E_SF_Auto_5_Year_Plan, T_HMP_Pro_SG&A_Report, T_Spare Parts Dashboard, E_Snowflake_Current year of FA P&L, T_DN Data

Want me to pull the next page, or narrow this down (by stream, name keyword, or published/unpublished status)?

[truex-suggestions]
- Show me the next 50 apps
- Filter apps by stream name
- Search for apps with a specific keyword
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01JgiL2Er9hWH3Dd6NjzqPnL",
    "server": "adaptive",
    "tool": "qlik__get_apps",
    "status": "completed",
    "arguments": {
      "limit": 50
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
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
    "durationMs": 6418
  }
]
```

### Turn 3: What is the capital of india ?

Status: completed. Thread: `01a0ff7d-2f36-7232-a730-c71a9b022c17`.

New Delhi is the capital of India.

[truex-suggestions]
- What is the capital of France?
- List down the apps in Qlik
- What is the population of New Delhi?
[/truex-suggestions]

Tool exchanges:

```json
[]
```

## Payload and observability files

- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](adaptive-capture.json)
- [Exact JSON-RPC messages written to Codex stdin](adaptive-codex-input.jsonl)
- [Exact Responses bodies generated by Codex](adaptive-responses-requests.jsonl)
- [Exact Anthropic request bodies sent upstream](adaptive-provider-requests.jsonl)

The Codex `turn/start` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.

## Run conditions and limits

The configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness can approve only the explicitly authorized Qlik `get_apps` action or read-only Omni discovery. It refuses writes and unrelated approval prompts. Calls capped at 24, timeout 600000 ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.

## Actual model-boundary selection and first-token timing

Arm: **adaptive**. Effective projection: **platform default for get_apps**.

| Call | Turn | Codex schemas before filter | Schemas sent | Schema JSON bytes before | Schema JSON bytes after | First provider body byte ms | First text delta ms | First tool block ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 43 | 2 | 37701 | 2102 | 2289 | 2290 | no tool |
| 2 | 2 | 43 | 3 | 37701 | 3148 | 1753 | no text | 1937 |
| 3 | 2 | 43 | 3 | 37701 | 3148 | 2319 | 2319 | no tool |
| 4 | 3 | 43 | 2 | 37701 | 2102 | 2206 | 2207 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](adaptive-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[
  {
    "at": "2026-10-03T01:59:49.365Z",
    "turn": 1,
    "query": "Hi bro ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.39325000000008004
  },
  {
    "at": "2026-10-03T01:59:53.805Z",
    "turn": 2,
    "query": "Can you list down the apps in the qlik ?",
    "confidence": 1,
    "candidates": [
      {
        "tool": {
          "id": "[\"qlik\",\"get_apps\"]",
          "serverId": "qlik",
          "toolName": "get_apps",
          "sourceType": "mcp",
          "name": "get_apps",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "integer",
                "description": "Maximum number of apps to return (default: 25, max: 50)",
                "default": 25
              },
              "offset": {
                "type": "integer",
                "description": "Number of apps to skip for pagination (default: 0)",
                "default": 0
              },
              "name": {
                "type": "string",
                "description": "Wildcard case-insensitive search in application name"
              },
              "stream": {
                "type": "string",
                "description": "Wildcard case-insensitive search in stream name"
              },
              "published": {
                "type": "string",
                "description": "Filter by published status (true/false or 1/0). Default: true",
                "default": "true"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            }
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get list of Qlik Sense applications with essential fields and filters (name, stream, published) and pagination.",
          "bindingName": "qlik__get_apps",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 1,
        "reason": "BM25=0.181; title=app; explicit server/vendor; exact tool phrase"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_script\"]",
          "serverId": "qlik",
          "toolName": "get_app_script",
          "sourceType": "mcp",
          "name": "get_app_script",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application ID"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get load script from app",
          "bindingName": "qlik__get_app_script",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.7000000000000001,
        "reason": "BM25=0.229; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_field\"]",
          "serverId": "qlik",
          "toolName": "get_app_field",
          "sourceType": "mcp",
          "name": "get_app_field",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "field_name": {
                "type": "string",
                "description": "Field name"
              },
              "limit": {
                "type": "integer",
                "description": "Max values to return (default: 10, max: 100)",
                "default": 10
              },
              "offset": {
                "type": "integer",
                "description": "Offset for pagination (default: 0)",
                "default": 0
              },
              "search_string": {
                "type": "string",
                "description": "Wildcard text search mask (* and % supported), case-insensitive by default"
              },
              "search_number": {
                "type": "string",
                "description": "Wildcard numeric search mask (* and % supported)"
              },
              "case_sensitive": {
                "type": "boolean",
                "description": "Case sensitive matching for search_string",
                "default": false
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "field_name",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Return values of a single field from app with pagination and wildcard search (supports * and %).",
          "bindingName": "qlik__get_app_field",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.6846748670085994,
        "reason": "BM25=0.206; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_details\"]",
          "serverId": "qlik",
          "toolName": "get_app_details",
          "sourceType": "mcp",
          "name": "get_app_details",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID (preferred if known)"
              },
              "name": {
                "type": "string",
                "description": "Case-insensitive fuzzy search by app name"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get compact application info with filters by guid or name (case-insensitive). Returns metainfo, tables/fields list, master items, sheets and objects with used fields. You must provide at least one of app_id or name.",
          "bindingName": "qlik__get_app_details",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.6561219456322096,
        "reason": "BM25=0.162; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_sheets\"]",
          "serverId": "qlik",
          "toolName": "get_app_sheets",
          "sourceType": "mcp",
          "name": "get_app_sheets",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get list of sheets from application with title and description.",
          "bindingName": "qlik__get_app_sheets",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.575292621075909,
        "reason": "BM25=0.191; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_variables\"]",
          "serverId": "qlik",
          "toolName": "get_app_variables",
          "sourceType": "mcp",
          "name": "get_app_variables",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "limit": {
                "type": "integer",
                "description": "Max variables to return (default: 10, max: 100)",
                "default": 10
              },
              "offset": {
                "type": "integer",
                "description": "Offset for pagination (default: 0)",
                "default": 0
              },
              "created_in_script": {
                "type": "string",
                "description": "Return only variables created in script (true/false). If omitted, return both"
              },
              "search_string": {
                "type": "string",
                "description": "Wildcard search by variable name or text value (* and % supported), case-insensitive by default"
              },
              "search_number": {
                "type": "string",
                "description": "Wildcard search among numeric variable values (* and % supported)"
              },
              "case_sensitive": {
                "type": "boolean",
                "description": "Case sensitive matching for search_string",
                "default": false
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Return variables split by source (script/ui) with pagination and wildcard search.",
          "bindingName": "qlik__get_app_variables",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.5579030081635926,
        "reason": "BM25=0.165; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_object\"]",
          "serverId": "qlik",
          "toolName": "get_app_object",
          "sourceType": "mcp",
          "name": "get_app_object",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "object_id": {
                "type": "string",
                "description": "Object ID to retrieve"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "object_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get specific object layout by calling GetObject and GetLayout sequentially via WebSocket.",
          "bindingName": "qlik__get_app_object",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.5554634282194669,
        "reason": "BM25=0.161; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_field_statistics\"]",
          "serverId": "qlik",
          "toolName": "get_app_field_statistics",
          "sourceType": "mcp",
          "name": "get_app_field_statistics",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application ID"
              },
              "field_name": {
                "type": "string",
                "description": "Field name"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "field_name",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get comprehensive statistics for a field",
          "bindingName": "qlik__get_app_field_statistics",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.4919592877425755,
        "reason": "BM25=0.191; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_app_sheet_objects\"]",
          "serverId": "qlik",
          "toolName": "get_app_sheet_objects",
          "sourceType": "mcp",
          "name": "get_app_sheet_objects",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "sheet_id": {
                "type": "string",
                "description": "Sheet GUID"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "sheet_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get list of objects from specific sheet with object ID, type and description.",
          "bindingName": "qlik__get_app_sheet_objects",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.47980385347457594,
        "reason": "BM25=0.173; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_qvd_app_id\"]",
          "serverId": "qlik",
          "toolName": "get_qvd_app_id",
          "sourceType": "mcp",
          "name": "get_qvd_app_id",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "qvd_path": {
                "type": "string",
                "description": "Complete file path to the QVD file (e.g., '\\\\server\\share\\file.qvd' or 'C:\\path\\to\\file.qvd')"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "qvd_path",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Extract the creator application ID from a QVD file by reading the CreatorDoc tag from the file header. This tool reads the QVD file directly from the filesystem and does not require Qlik Sense API access.",
          "bindingName": "qlik__get_qvd_app_id",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.45118551728612727,
        "reason": "BM25=0.129; title=app; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_upstream_lineage\"]",
          "serverId": "qlik",
          "toolName": "get_upstream_lineage",
          "sourceType": "mcp",
          "name": "get_upstream_lineage",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID to fetch the load script from and identify upstream dependencies"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Fetch the load script of a Qlik Sense app and identify all upstream data dependencies using AWS Bedrock AI. Returns a textual report listing all upstream QVD file dependencies and Snowflake table dependencies found in the app's load script.",
          "bindingName": "qlik__get_upstream_lineage",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.35664024049117093,
        "reason": "BM25=0.163; title=none; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_lineage\"]",
          "serverId": "qlik",
          "toolName": "get_lineage",
          "sourceType": "mcp",
          "name": "get_lineage",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get complete data lineage for a Qlik Sense app. Returns the origin and flow of data including LOAD/STORE statements, external connectors, file sources, inline data, resident tables, and auto-generated data. Each lineage entry shows the discriminator (data origin type), the script statement, and the source path.",
          "bindingName": "qlik__get_lineage",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.3265487571161496,
        "reason": "BM25=0.117; title=none; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"get_connections\"]",
          "serverId": "qlik",
          "toolName": "get_connections",
          "sourceType": "mcp",
          "name": "get_connections",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "lib_path": {
                "type": "string",
                "description": "Full lib:// path as it appears in the Qlik script, e.g. 'lib://30_AUTO_Quality\\30_Automotive\\file.qvd'. The tool extracts the first segment after 'lib://' as the connection name."
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "lib_path",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get the data connection for a specific lib:// path in a Qlik Sense app via the Engine API (GetConnections). Strips the 'lib://' prefix, extracts the first path segment (the connection name), calls GetConnections on the document handle, and returns the single connection object whose qName matches that segment. Example: lib_path='lib://30_AUTO_Quality\\30_Automotive\\file.qvd' → looks up connection with qName='30_AUTO_Quality'.",
          "bindingName": "qlik__get_connections",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.3130281094533428,
        "reason": "BM25=0.096; title=none; explicit server/vendor"
      },
      {
        "tool": {
          "id": "[\"qlik\",\"engine_get_visualization_data\"]",
          "serverId": "qlik",
          "toolName": "engine_get_visualization_data",
          "sourceType": "mcp",
          "name": "engine_get_visualization_data",
          "source": "mcp",
          "inputSchema": {
            "type": "object",
            "properties": {
              "app_id": {
                "type": "string",
                "description": "Application GUID"
              },
              "object_id": {
                "type": "string",
                "description": "Object ID to retrieve data from"
              },
              "fields": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "uniqueItems": true,
                "items": {
                  "type": "string"
                },
                "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
              }
            },
            "required": [
              "app_id",
              "object_id",
              "fields"
            ]
          },
          "scope": "tenant",
          "enabled": true,
          "available": true,
          "tenantId": "default",
          "description": "Get actual data from a visualization object (chart, KPI, table, filter pane, etc.). Returns dimension values, measure values, and complete data structure with the actual data displayed in the visualization.",
          "bindingName": "qlik__engine_get_visualization_data",
          "readOnly": false,
          "destructive": false,
          "requiresApproval": true
        },
        "score": 0.1701947188520797,
        "reason": "BM25=0.031; title=none; explicit server/vendor"
      }
    ],
    "mode": "direct_tools",
    "selected": [
      {
        "id": "[\"qlik\",\"get_apps\"]",
        "serverId": "qlik",
        "toolName": "get_apps",
        "sourceType": "mcp",
        "name": "get_apps",
        "source": "mcp",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "description": "Maximum number of apps to return (default: 25, max: 50)",
              "default": 25
            },
            "offset": {
              "type": "integer",
              "description": "Number of apps to skip for pagination (default: 0)",
              "default": 0
            },
            "name": {
              "type": "string",
              "description": "Wildcard case-insensitive search in application name"
            },
            "stream": {
              "type": "string",
              "description": "Wildcard case-insensitive search in stream name"
            },
            "published": {
              "type": "string",
              "description": "Filter by published status (true/false or 1/0). Default: true",
              "default": "true"
            },
            "fields": {
              "type": "array",
              "minItems": 1,
              "maxItems": 64,
              "uniqueItems": true,
              "items": {
                "type": "string"
              },
              "description": "Response JSON paths only (not downstream arguments). Include answer fields and identifiers/pagination; ['*'] alone intentionally returns full output."
            }
          }
        },
        "scope": "tenant",
        "enabled": true,
        "available": true,
        "tenantId": "default",
        "description": "Get list of Qlik Sense applications with essential fields and filters (name, stream, published) and pagination.",
        "bindingName": "qlik__get_apps",
        "readOnly": false,
        "destructive": false,
        "requiresApproval": true
      }
    ],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.40645799999947485
  },
  {
    "at": "2026-10-03T02:00:13.365Z",
    "turn": 3,
    "query": "What is the capital of india ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.7325000000018917
  }
]
```

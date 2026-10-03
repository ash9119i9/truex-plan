# Live adaptive MCP V2 benchmark

Captured 2026-10-03T02:12:43.739Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | Hi bro ? | 1 | 3065 | 125 | 4026 | completed |
| 2 | Can you list down the apps in the qlik ? | 2 | 9148 | 484 | 22975 | completed |
| 3 | What is the capital of india ? | 1 | 5997 | 59 | 2625 | completed |
| **Total known usage** | | **4** | **18210** | **668** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 3065 | 125 | 3944 |
| 2 | 2 | 3 | 3392 | 0 | 3386 |
| 3 | 2 | 3 | 5756 | 484 | 10208 |
| 4 | 3 | 2 | 5997 | 59 | 2584 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: Hi bro ?

Status: completed. Thread: `01a0ff89-1cfd-7120-9530-11d95635dd92`.

Hey! I'm your Truex assistant, acting as your senior consultant here.

Here's what I can help with:
- Answering questions and summarizing documents you share with me
- Pulling and analyzing business data through connected tools (I have access to a Qlik connector for data analysis)
- Researching current information from the web
- Creating documents (Word, Excel, PowerPoint, PDF) and interactive visualizations
- Working through multi-step projects with a clear plan you approve first

What can I help you tackle today?

Tool exchanges:

```json
[]
```

### Turn 2: Can you list down the apps in the qlik ?

Status: completed. Thread: `01a0ff89-1cfd-7120-9530-11d95635dd92`.

There are **1,324 apps** total in Qlik — here are the first 50, grouped by stream:

**LS Executive / LS FIN21**
- Sales and Margin Key Category Report
- Consumer Audio Sales Dashboard
- Functional Area P&L Dashboard

**PRO Finance Executives**
- Regional P&L Dashboard
- Regional P&L Dashboard v2

**CORP CoE / CORP Shared Services / CORP FIN21 Development**
- SAP Data Replication Tracker Dashboard (Internal)
- GR IR Clearing Report
- FI-COPA Reconciliation Dashboard
- Bank Reconciliation App

**LS Customer Service**
- Global CX Case Dashboard
- Customer Experience - NPS Dashboard

**LS EMEA Operations**
- OPS EMEA Dashboard Spare Parts
- Exception Log Status_prod

**AUTO Business Operations**
- DECAF - Demand Current vs. Accepted Freeze

**CORP Central Marketing Control**
- Lifestyle Calendar

**Monitoring apps**
- Connector Logs Analyzer

**Everyone**
- SAP Data Replication Tracker

**QVD Generator (data prep/backend apps)** — a large batch of T_ / E_ prefixed extraction and transformation apps (e.g. T_SAP_Data_Replication_Tracker, E_SAP_Data_Replication_Tracker, T_O&O_Global, E_SnowFlake_O&O_Global_FACTs, E_HMP_CAPEX, E_SF_DCF_SAP_HMP_BSAK/BSIK/BSAD/BSID, T_FI_COPA_Reconciliation, T_Finance_RegionalP&L, and others)

This is just a slice — there are 1,274 more apps beyond this first page. Want me to pull more, filter by a specific stream (e.g. only "LS FIN21" or published business dashboards), or search by name?

[truex-suggestions]
- Show me the next 50 apps
- Filter apps by stream LS FIN21
- List only published dashboards, not QVD Generator apps
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_012FuTQfGQriPeTBSzt64XwX",
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
          "text": "{\"apps\":[{\"name\":\"SAP Data Replication Tracker\",\"guid\":\"4d072a42-76cf-40eb-86ab-e46f9530250f\",\"stream\":\"Everyone\"},{\"name\":\"SAP Data Replication Tracker Dashboard (Internal)\",\"guid\":\"592a4a8a-0f82-498b-9430-e91e86d6e320\",\"stream\":\"CORP CoE\"},{\"name\":\"T_SAP_Data_Replication_Tracker\",\"guid\":\"cd080b04-d172-4622-a874-3d6a3df1805b\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SAP_Data_Replication_Tracker\",\"guid\":\"4c6a8252-5fb3-47cc-a26c-9f53b2fd9976\",\"stream\":\"QVD Generator\"},{\"name\":\"T_O&O_Global\",\"guid\":\"f15657c4-ca40-4545-a35e-162632b369de\",\"stream\":\"QVD Generator\"},{\"name\":\"Sales and Margin Key Category Report\",\"guid\":\"3f2de5ea-523a-4099-831e-dea7b58a044e\",\"stream\":\"LS Executive\"},{\"name\":\"E_SnowFlake_O&O_Global_FACTs\",\"guid\":\"5cb777dc-7498-45db-ae92-4c176c84243b\",\"stream\":\"QVD Generator\"},{\"name\":\"DECAF - Demand Current vs. Accepted Freeze\",\"guid\":\"cf5e27c3-38d9-4891-9115-2d1d5c56b034\",\"stream\":\"AUTO Business Operations\"},{\"name\":\"Consumer Audio Sales Dashboard\",\"guid\":\"f708d127-90f3-4b45-9c2f-ad906efb8584\",\"stream\":\"LS FIN21\"},{\"name\":\"E_HMP_CAPEX\",\"guid\":\"abbb6f0f-e817-4881-993b-bcbce6881113\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_DCF_SAP_HMP_BSAK\",\"guid\":\"ed93fcb1-6e6c-437c-a245-8edabb456f10\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_DCF_SAP_HMP_BSIK\",\"guid\":\"c28b337c-87c4-40b0-b6b3-f4ef29a68d1d\",\"stream\":\"QVD Generator\"},{\"name\":\"GR IR Clearing Report\",\"guid\":\"e588d79b-a5bb-4af3-8051-fdb921504c90\",\"stream\":\"CORP Shared Services\"},{\"name\":\"E_SF_DCF_SAP_HMP_BSAD\",\"guid\":\"034c84fd-1c5b-43de-930a-e6cd38e09300\",\"stream\":\"QVD Generator\"},{\"name\":\"Global CX Capacity Dashboard\",\"guid\":\"74caffce-8261-4148-8e13-e59171d86069\",\"stream\":\"LS Customer Service\"},{\"name\":\"T_GlobalCXCapacityDashboard\",\"guid\":\"7c3fa4c6-680d-4971-b15d-49b90ec05ec4\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Demand Current vs. Accepted Freeze_DECAF\",\"guid\":\"201e6a78-e70e-4782-b274-4c3ee27189f7\",\"stream\":\"QVD Generator\"},{\"name\":\"E_GlobalCXCapacityDashboard\",\"guid\":\"e8b0ff71-6373-4775-96a0-96db7388f8a6\",\"stream\":\"QVD Generator\"},{\"name\":\"E_AD_PAMDomainAccounts\",\"guid\":\"30a5b77a-8138-4523-b984-bfec359838f8\",\"stream\":\"QVD Generator\"},{\"name\":\"OPS EMEA Dashboard Spare Parts\",\"guid\":\"15bef648-d9df-46ed-9968-6d3d7bf82c2c\",\"stream\":\"LS EMEA Operations\"},{\"name\":\"E_Snowflake_Brazil Data from LS Sales SA database\",\"guid\":\"85cc469e-4997-4c5c-9cfe-9d60e02ecd40\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_DCF_SAP_HMP_BSID\",\"guid\":\"d5a51e48-b60d-4029-8f86-e45bc91d1264\",\"stream\":\"QVD Generator\"},{\"name\":\"ET_OPS EMEA Dashboard Spare Parts\",\"guid\":\"5e0912f3-e08e-4089-bbda-79027935e33d\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Snowflake_HCPTCURR\",\"guid\":\"c7ebcdfd-1eee-4b4b-8c6f-f2e8f66124dc\",\"stream\":\"QVD Generator\"},{\"name\":\"T_COA_SALES_DB\",\"guid\":\"a4c25a4b-87a1-4c26-8b12-b0f1d2212e68\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SnowFlake_O&O_Global_DIMs\",\"guid\":\"c4e1b985-5be2-4cee-921f-460d07684cfc\",\"stream\":\"QVD Generator\"},{\"name\":\"Lifestyle Calendar\",\"guid\":\"be6b654c-50c8-4487-b32e-373567842b33\",\"stream\":\"CORP Central Marketing Control\"},{\"name\":\"Exception Log Status_prod\",\"guid\":\"e985a2f4-6dba-4560-a5ec-1925183a5b1a\",\"stream\":\"LS EMEA Operations\"},{\"name\":\"00001_E_Costing_ProX_Extracts_PASS\",\"guid\":\"c3f9e0c7-2f39-4665-ba1f-4b8c0b207624\",\"stream\":\"QVD Generator\"},{\"name\":\"T_File_Exception Log Status\",\"guid\":\"d7900cb2-1d44-4de8-896b-5e3f1666a43a\",\"stream\":\"QVD Generator\"},{\"name\":\"00001_E_App_Notes_ProX_Extracts\",\"guid\":\"f97e854c-0e90-447b-9f44-12692e03086d\",\"stream\":\"QVD Generator\"},{\"name\":\"Functional Area P&L Dashboard\",\"guid\":\"73df82fa-600d-42dd-801c-ac10a2bd4bc4\",\"stream\":\"LS FIN21\"},{\"name\":\"Regional P&L Dashboard\",\"guid\":\"3b1adccd-8729-4cc5-9c1e-9c68238fc1f4\",\"stream\":\"PRO Finance Executives\"},{\"name\":\"FI-COPA Reconciliation Dashboard\",\"guid\":\"5bbcfef1-9143-48fb-8aea-a85db47d77df\",\"stream\":\"CORP FIN21 Development\"},{\"name\":\"T_FI_COPA_Reconciliation\",\"guid\":\"fa81d159-e574-4530-888e-859cc81012a9\",\"stream\":\"QVD Generator\"},{\"name\":\"Regional P&L Dashboard v2\",\"guid\":\"86f8dd43-c67d-463f-b728-28c134e7f987\",\"stream\":\"PRO Finance Executives\"},{\"name\":\"T_LS_Consumer1b_MainApp\",\"guid\":\"c2f7ea56-cf5f-424b-b528-ef451a8224d3\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Finance_RegionalP&L\",\"guid\":\"8f92d542-ebbd-492c-b052-23da337f2eb3\",\"stream\":\"QVD Generator\"},{\"name\":\"E_Demand Current vs. Accepted Freeze_DECAF\",\"guid\":\"4253a117-c6c5-4249-aee8-04a6f61dac49\",\"stream\":\"QVD Generator\"},{\"name\":\"T_Finance_RegionalP&L v2\",\"guid\":\"27557aa0-c24f-4152-aca2-39769e7ddf6e\",\"stream\":\"QVD Generator\"},{\"name\":\"Connector Logs Analyzer\",\"guid\":\"d219dad5-e890-4fef-8138-e432d2bbaadc\",\"stream\":\"Monitoring apps\"},{\"name\":\"E_Snowflake_FIN2021_RECON_SAP_HCP\",\"guid\":\"9a04b42e-fe36-4ec7-9c8d-1cc4d3dd24b3\",\"stream\":\"QVD Generator\"},{\"name\":\"Global CX Case Dashboard\",\"guid\":\"22fb8a39-acc5-48e5-85dd-6f550cc10888\",\"stream\":\"LS Customer Service\"},{\"name\":\"T_ProductDashboard (new version)\",\"guid\":\"9f5663f4-d26c-4462-b7c1-1f168b91e27d\",\"stream\":\"QVD Generator\"},{\"name\":\"T_FI_FunctionalAreaP&L Consol\",\"guid\":\"8c5893e9-10a5-4d79-beb0-45ff61e2c30c\",\"stream\":\"QVD Generator\"},{\"name\":\"E_SF_RegionalP&L\",\"guid\":\"9d2b4ea5-d3b4-40b1-a9d5-4f5d3290a542\",\"stream\":\"QVD Generator\"},{\"name\":\"Customer Experience - NPS Dashboard\",\"guid\":\"2d88ab72-6bc4-477f-acb3-e41b69b168ec\",\"stream\":\"LS Customer Service\"},{\"name\":\"E_SF_RegionalP&L v2\",\"guid\":\"89be13dc-27ae-401f-8e8a-f28d15a91f20\",\"stream\":\"QVD Generator\"},{\"name\":\"Bank Reconciliation App\",\"guid\":\"c4792818-4c1e-4e8b-b082-4333c7ea92ba\",\"stream\":\"CORP Shared Services\"},{\"name\":\"T_DCF_BANKREC_T\",\"guid\":\"30d68613-60a9-466f-8a55-53cc96c4f923\",\"stream\":\"QVD Generator\"}],\"pagination\":{\"limit\":50,\"offset\":0,\"returned\":50,\"total_found\":1324,\"has_more\":true,\"next_offset\":50}}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 9020
  }
]
```

### Turn 3: What is the capital of india ?

Status: completed. Thread: `01a0ff89-1cfd-7120-9530-11d95635dd92`.

The capital of India is **New Delhi**.

[truex-suggestions]
- What is the population of New Delhi?
- List the apps in the Qlik QVD Generator stream
- What is the capital of Pakistan?
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
| 1 | 1 | 43 | 2 | 37701 | 2102 | 2111 | 2113 | no tool |
| 2 | 2 | 43 | 3 | 37701 | 2978 | 2186 | no text | 3384 |
| 3 | 2 | 43 | 3 | 37701 | 2978 | 2860 | 2861 | no tool |
| 4 | 3 | 43 | 2 | 37701 | 2102 | 1773 | 1774 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](adaptive-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[
  {
    "at": "2026-10-03T02:12:51.082Z",
    "turn": 1,
    "permissionRejectedToolIds": [],
    "query": "Hi bro ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.4344170000003942
  },
  {
    "at": "2026-10-03T02:12:55.121Z",
    "turn": 2,
    "permissionRejectedToolIds": [],
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
    "routingLatencyMs": 0.9900419999994483
  },
  {
    "at": "2026-10-03T02:13:18.104Z",
    "turn": 3,
    "permissionRejectedToolIds": [],
    "query": "What is the capital of india ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.26312500000494765
  }
]
```

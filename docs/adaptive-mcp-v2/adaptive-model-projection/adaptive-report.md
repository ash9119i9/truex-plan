# Live adaptive MCP V2 benchmark

Captured 2026-10-03T02:06:17.212Z. Outcome: **completed**. One fresh thread; each turn started after its predecessor completed. Codex revision: `4a942885c8b4745757a9f86ad2075e16c42483c5`. No Codex source modifications.

## Measured turn totals

| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |
|---|---|---:|---:|---:|---:|---|
| 1 | Hi bro ? | 1 | 3065 | 123 | 3812 | completed |
| 2 | Can you list down the apps in the qlik ? | 2 | 11331 | 906 | 22160 | completed |
| 3 | What is the capital of india ? | 1 | 8413 | 46 | 2425 | completed |
| **Total known usage** | | **4** | **22809** | **1075** | | |

## Every provider request

| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |
|---|---:|---:|---:|---:|---:|
| 1 | 1 | 2 | 3065 | 123 | 3759 |
| 2 | 2 | 3 | 3458 | 0 | 1997 |
| 3 | 2 | 3 | 7873 | 906 | 12336 |
| 4 | 3 | 2 | 8413 | 46 | 2205 |

Token totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.

## Complete messages, answers and tool results

### Turn 1: Hi bro ?

Status: completed. Thread: `01a0ff83-38ba-7761-95f1-3826a0a9ce4e`.

Hey! I'm your Truex assistant, here to help as a senior consultant.

Here's what I can do for you:
- Answer questions and summarize documents you share with me
- Pull current business data through our connected Qlik integration
- Search the web for up-to-date information
- Build interactive visualizations or charts when they'd help explain something
- Create downloadable PDF, Word, Excel, or PowerPoint documents
- Help plan and work through multi-step projects with you

What can I help you with today?

Tool exchanges:

```json
[]
```

### Turn 2: Can you list down the apps in the qlik ?

Status: completed. Thread: `01a0ff83-38ba-7761-95f1-3826a0a9ce4e`.

There are **1,324 published apps** total in Qlik. Here's the first batch (30 of them), with name, stream, and last modified date:

| App Name | Stream | Last Modified |
|---|---|---|
| DECAF - Demand Current vs. Accepted Freeze | AUTO Business Operations | 2026-10-03 |
| Consumer Audio Sales Dashboard | LS FIN21 | 2026-10-03 |
| E_HMP_CAPEX | QVD Generator | 2026-10-03 |
| E_SF_DCF_SAP_HMP_BSAK | QVD Generator | 2026-10-03 |
| E_SF_DCF_SAP_HMP_BSIK | QVD Generator | 2026-10-03 |
| GR IR Clearing Report | CORP Shared Services | 2026-10-03 |
| E_SF_DCF_SAP_HMP_BSAD | QVD Generator | 2026-10-03 |
| Global CX Capacity Dashboard | LS Customer Service | 2026-10-03 |
| T_GlobalCXCapacityDashboard | QVD Generator | 2026-10-03 |
| T_Demand Current vs. Accepted Freeze_DECAF | QVD Generator | 2026-10-03 |
| E_GlobalCXCapacityDashboard | QVD Generator | 2026-10-03 |
| E_AD_PAMDomainAccounts | QVD Generator | 2026-10-03 |
| OPS EMEA Dashboard Spare Parts | LS EMEA Operations | 2026-10-03 |
| E_Snowflake_Brazil Data from LS Sales SA database | QVD Generator | 2026-10-03 |
| E_SF_DCF_SAP_HMP_BSID | QVD Generator | 2026-10-03 |
| ET_OPS EMEA Dashboard Spare Parts | Monitoring apps | 2026-10-03 |
| E_Snowflake_FIN2021_RECON_SAP_HCP | QVD Generator | 2026-10-03 |
| Global CX Case Dashboard | LS Customer Service | 2026-10-03 |
| T_ProductDashboard (new version) | QVD Generator | 2026-10-03 |
| T_FI_FunctionalAreaP&L Consol | QVD Generator | 2026-10-03 |
| E_SF_RegionalP&L | QVD Generator | 2026-10-03 |
| Customer Experience - NPS Dashboard | LS Customer Service | 2026-10-03 |
| E_SF_RegionalP&L v2 | QVD Generator | 2026-10-03 |
| Bank Reconciliation App | CORP Shared Services | 2026-10-03 |
| T_DCF_BANKREC_T | QVD Generator | 2026-10-03 |
| T_CustomerServiceNPSDashboard | QVD Generator | 2026-10-03 |
| T_DCF_BANKREC_P | QVD Generator | 2026-10-03 |
| Archive - Capacity Report AME | CORP Advanced Manufacturing Engineering Management | 2026-10-03 |
| LS SKU Liability | LS Supply Chain | 2026-10-03 |
| T_LS_SKULiability | QVD Generator | 2026-10-03 |

That's a lot of apps (1,324 total), so showing all of them isn't practical in one response. I'd suggest narrowing it down — for example by stream, by name keyword, or just viewing more pages. Let me know how you'd like to proceed.

[truex-suggestions]
- Show me the next page of Qlik apps
- Filter Qlik apps by a specific stream
- Search Qlik apps by name keyword
[/truex-suggestions]

Tool exchanges:

```json
[
  {
    "type": "mcpToolCall",
    "id": "toolu_bdrk_01WQrariKTdgMUbk1tDLDHXE",
    "server": "adaptive",
    "tool": "qlik__get_apps",
    "status": "completed",
    "arguments": {
      "fields": [
        "*"
      ],
      "limit": 50
    },
    "appContext": null,
    "pluginId": null,
    "readOnlyHint": null,
    "result": {
      "content": [
        {
          "type": "text",
          "text": "{\n  \"apps\": [\n    {\n      \"guid\": \"cf5e27c3-38d9-4891-9115-2d1d5c56b034\",\n      \"name\": \"DECAF - Demand Current vs. Accepted Freeze\",\n      \"description\": \"DECAF is an internal analytics application designed to provide a unified, end‑to‑end view of project‑level demand, cost, budget, freeze history, and time‑booking data across Demand Planning.\",\n      \"stream\": \"AUTO Business Operations\",\n      \"modified_dttm\": \"2026-10-03T02:05:34.650Z\",\n      \"reload_dttm\": \"2026-10-03T02:05:28.460Z\"\n    },\n    {\n      \"guid\": \"f708d127-90f3-4b45-9c2f-ad906efb8584\",\n      \"name\": \"Consumer Audio Sales Dashboard\",\n      \"description\": \"This app is designed to provide sale overview and portfolio analysis by products to standard contribution margin level.\",\n      \"stream\": \"LS FIN21\",\n      \"modified_dttm\": \"2026-10-03T02:04:21.665Z\",\n      \"reload_dttm\": \"2026-10-03T02:04:00.920Z\"\n    },\n    {\n      \"guid\": \"abbb6f0f-e817-4881-993b-bcbce6881113\",\n      \"name\": \"E_HMP_CAPEX\",\n      \"description\": \"Extract application for CapEx report\\nExtracted tables from SAP HMP: PRPS; PROJ, COEP; EKPO;EKKO;EKKN; EBAN; EBKN\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:03:47.945Z\",\n      \"reload_dttm\": \"2026-10-03T02:03:47.691Z\"\n    },\n    {\n      \"guid\": \"ed93fcb1-6e6c-437c-a245-8edabb456f10\",\n      \"name\": \"E_SF_DCF_SAP_HMP_BSAK\",\n      \"description\": \"HMP AND HCP\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:01:51.626Z\",\n      \"reload_dttm\": \"2026-10-03T02:01:51.417Z\"\n    },\n    {\n      \"guid\": \"c28b337c-87c4-40b0-b6b3-f4ef29a68d1d\",\n      \"name\": \"E_SF_DCF_SAP_HMP_BSIK\",\n      \"description\": \"HMP AND HCP\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:01:21.404Z\",\n      \"reload_dttm\": \"2026-10-03T02:01:21.159Z\"\n    },\n    {\n      \"guid\": \"e588d79b-a5bb-4af3-8051-fdb921504c90\",\n      \"name\": \"GR IR Clearing Report\",\n      \"description\": \"\",\n      \"stream\": \"CORP Shared Services\",\n      \"modified_dttm\": \"2026-10-03T02:01:09.926Z\",\n      \"reload_dttm\": \"2026-10-03T02:01:08.968Z\"\n    },\n    {\n      \"guid\": \"034c84fd-1c5b-43de-930a-e6cd38e09300\",\n      \"name\": \"E_SF_DCF_SAP_HMP_BSAD\",\n      \"description\": \"HMP AND HCP\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:01:07.561Z\",\n      \"reload_dttm\": \"2026-10-03T02:01:07.391Z\"\n    },\n    {\n      \"guid\": \"74caffce-8261-4148-8e13-e59171d86069\",\n      \"name\": \"Global CX Capacity Dashboard\",\n      \"description\": \"Tracks Global CX Capacity, updated on a weekly basis by FoundEver.\",\n      \"stream\": \"LS Customer Service\",\n      \"modified_dttm\": \"2026-10-03T02:01:01.416Z\",\n      \"reload_dttm\": \"2026-10-03T02:01:01.238Z\"\n    },\n    {\n      \"guid\": \"7c3fa4c6-680d-4971-b15d-49b90ec05ec4\",\n      \"name\": \"T_GlobalCXCapacityDashboard\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:56.863Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:56.674Z\"\n    },\n    {\n      \"guid\": \"201e6a78-e70e-4782-b274-4c3ee27189f7\",\n      \"name\": \"T_Demand Current vs. Accepted Freeze_DECAF\",\n      \"description\": \"Transform layer for DECAF where DECAF is an internal analytics application designed to provide a unified, end‑to‑end view of project‑level demand, cost, budget, freeze history, and time‑booking data across Demand Planning.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:53.198Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:52.600Z\"\n    },\n    {\n      \"guid\": \"e8b0ff71-6373-4775-96a0-96db7388f8a6\",\n      \"name\": \"E_GlobalCXCapacityDashboard\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:52.079Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:51.947Z\"\n    },\n    {\n      \"guid\": \"30a5b77a-8138-4523-b984-bfec359838f8\",\n      \"name\": \"E_AD_PAMDomainAccounts\",\n      \"description\": \"Download the domain users list to PAM account that can be used for all dashboards if necessary.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:49.367Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:49.182Z\"\n    },\n    {\n      \"guid\": \"15bef648-d9df-46ed-9968-6d3d7bf82c2c\",\n      \"name\": \"OPS EMEA Dashboard Spare Parts\",\n      \"description\": \"This Dashboard gives an overview on the main KPIs and Figures regarding EMEA Spare Sparts Supply Chain.\\nFor content related questions, please contact serena.iacomoni@harman.com.\",\n      \"stream\": \"LS EMEA Operations\",\n      \"modified_dttm\": \"2026-10-03T02:00:44.231Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:43.918Z\"\n    },\n    {\n      \"guid\": \"85cc469e-4997-4c5c-9cfe-9d60e02ecd40\",\n      \"name\": \"E_Snowflake_Brazil Data from LS Sales SA database\",\n      \"description\": \"the main tables from SF LS Sales SA\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:43.667Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:43.081Z\"\n    },\n    {\n      \"guid\": \"d5a51e48-b60d-4029-8f86-e45bc91d1264\",\n      \"name\": \"E_SF_DCF_SAP_HMP_BSID\",\n      \"description\": \"HMP AND HCP\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:41.289Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:41.154Z\"\n    },\n    {\n      \"guid\": \"5e0912f3-e08e-4089-bbda-79027935e33d\",\n      \"name\": \"ET_OPS EMEA Dashboard Spare Parts\",\n      \"description\": \"Extract and Transform Layer for OPS EMEA Spare parts Dashboard.\\nFor content related questions regarding OPS EMEA Spare parts Dashboard, please contact Serena.Iacomoni@harman.com.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:39.694Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:39.131Z\"\n    },\n    {\n      \"guid\": \"c7ebcdfd-1eee-4b4b-8c6f-f2e8f66124dc\",\n      \"name\": \"E_Snowflake_HCPTCURR\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:36.762Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:36.540Z\"\n    },\n    {\n      \"guid\": \"a4c25a4b-87a1-4c26-8b12-b0f1d2212e68\",\n      \"name\": \"T_COA_SALES_DB\",\n      \"description\": \"Sales data after CY21\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:34.950Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:34.481Z\"\n    },\n    {\n      \"guid\": \"c4e1b985-5be2-4cee-921f-460d07684cfc\",\n      \"name\": \"E_SnowFlake_O&O_Global_DIMs\",\n      \"description\": \"- Customer\\n- Product\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:22.069Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:21.917Z\"\n    },\n    {\n      \"guid\": \"be6b654c-50c8-4487-b32e-373567842b33\",\n      \"name\": \"Lifestyle Calendar\",\n      \"description\": \"The Lifestyle Division Calendar serves the Lifestyle Team by providing a centralized, single source of truth for key dates, meetings, reports, and deliverable deadlines. This application enables team members to quickly identify what is due, when it is due, and owners of each task/meetings.\",\n      \"stream\": \"CORP Central Marketing Control\",\n      \"modified_dttm\": \"2026-10-03T02:00:19.382Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:19.263Z\"\n    },\n    {\n      \"guid\": \"e985a2f4-6dba-4560-a5ec-1925183a5b1a\",\n      \"name\": \"Exception Log Status_prod\",\n      \"description\": \"This app shows the current status of the Exception Log.\",\n      \"stream\": \"LS EMEA Operations\",\n      \"modified_dttm\": \"2026-10-03T02:00:14.578Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:14.416Z\"\n    },\n    {\n      \"guid\": \"c3f9e0c7-2f39-4665-ba1f-4b8c0b207624\",\n      \"name\": \"00001_E_Costing_ProX_Extracts_PASS\",\n      \"description\": \"An extract application that consumes databases, static files, QVDs, or other non-QVD source data and generates QVDs.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:12.329Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:12.187Z\"\n    },\n    {\n      \"guid\": \"d7900cb2-1d44-4de8-896b-5e3f1666a43a\",\n      \"name\": \"T_File_Exception Log Status\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:10.492Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:10.314Z\"\n    },\n    {\n      \"guid\": \"f97e854c-0e90-447b-9f44-12692e03086d\",\n      \"name\": \"00001_E_App_Notes_ProX_Extracts\",\n      \"description\": \"An extract application that consumes databases, static files, QVDs, or other non-QVD source data and generates QVDs.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T02:00:03.886Z\",\n      \"reload_dttm\": \"2026-10-03T02:00:03.764Z\"\n    },\n    {\n      \"guid\": \"73df82fa-600d-42dd-801c-ac10a2bd4bc4\",\n      \"name\": \"Functional Area P&L Dashboard\",\n      \"description\": \"This app is a tool set to support Consumer Finance team to get rapid view of monthly close result originating in SAP, to generate profit center view and monthly trending.\",\n      \"stream\": \"LS FIN21\",\n      \"modified_dttm\": \"2026-10-03T01:55:29.246Z\",\n      \"reload_dttm\": \"2026-10-03T01:53:35.667Z\"\n    },\n    {\n      \"guid\": \"3b1adccd-8729-4cc5-9c1e-9c68238fc1f4\",\n      \"name\": \"Regional P&L Dashboard\",\n      \"description\": \"The PRO P&L Regional Dashboard application is designed to help streamline your month-end close and financial planning processes, including distribution of regional P&Ls\",\n      \"stream\": \"PRO Finance Executives\",\n      \"modified_dttm\": \"2026-10-03T01:53:49.045Z\",\n      \"reload_dttm\": \"2026-10-03T01:53:35.761Z\"\n    },\n    {\n      \"guid\": \"5bbcfef1-9143-48fb-8aea-a85db47d77df\",\n      \"name\": \"FI-COPA Reconciliation Dashboard\",\n      \"description\": \"This application compares FI and COPA posting amounts by functional area and provides FI document level detail.\",\n      \"stream\": \"CORP FIN21 Development\",\n      \"modified_dttm\": \"2026-10-03T01:53:36.737Z\",\n      \"reload_dttm\": \"2026-10-03T01:53:33.998Z\"\n    },\n    {\n      \"guid\": \"fa81d159-e574-4530-888e-859cc81012a9\",\n      \"name\": \"T_FI_COPA_Reconciliation\",\n      \"description\": \"Transforms data extracted from Snowflake for the FI-COPA Reconciliation dashboard.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:53:22.960Z\",\n      \"reload_dttm\": \"2026-10-03T01:53:22.596Z\"\n    },\n    {\n      \"guid\": \"86f8dd43-c67d-463f-b728-28c134e7f987\",\n      \"name\": \"Regional P&L Dashboard v2\",\n      \"description\": \"The PRO P&L Regional Dashboard application is designed to help streamline your month-end close and financial planning processes, including distribution of regional P&Ls\",\n      \"stream\": \"PRO Finance Executives\",\n      \"modified_dttm\": \"2026-10-03T01:53:00.009Z\",\n      \"reload_dttm\": \"2026-10-03T01:52:45.718Z\"\n    },\n    {\n      \"guid\": \"c2f7ea56-cf5f-424b-b528-ef451a8224d3\",\n      \"name\": \"T_LS_Consumer1b_MainApp\",\n      \"description\": \"Transforms data for LS Consumer Quality - Cost Control\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:52:58.109Z\",\n      \"reload_dttm\": \"2026-10-03T01:52:57.823Z\"\n    },\n    {\n      \"guid\": \"8f92d542-ebbd-492c-b052-23da337f2eb3\",\n      \"name\": \"T_Finance_RegionalP&L\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:52:49.159Z\",\n      \"reload_dttm\": \"2026-10-03T01:52:48.993Z\"\n    },\n    {\n      \"guid\": \"4253a117-c6c5-4249-aee8-04a6f61dac49\",\n      \"name\": \"E_Demand Current vs. Accepted Freeze_DECAF\",\n      \"description\": \"Extract layer for DECAF where DECAF is an internal analytics application designed to provide a unified, end‑to‑end view of project‑level demand, cost, budget, freeze history, and time‑booking data across Demand Planning.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:52:31.859Z\",\n      \"reload_dttm\": \"2026-10-03T01:52:31.599Z\"\n    },\n    {\n      \"guid\": \"27557aa0-c24f-4152-aca2-39769e7ddf6e\",\n      \"name\": \"T_Finance_RegionalP&L v2\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:51:52.066Z\",\n      \"reload_dttm\": \"2026-10-03T01:51:51.829Z\"\n    },\n    {\n      \"guid\": \"d219dad5-e890-4fef-8138-e432d2bbaadc\",\n      \"name\": \"Connector Logs Analyzer\",\n      \"description\": \"The Connector Logs Analyzer app provides insights into usage and errors for specific Qlik connectors, including REST and ODBC.\\nv 1.0.0\",\n      \"stream\": \"Monitoring apps\",\n      \"modified_dttm\": \"2026-10-03T01:51:36.175Z\",\n      \"reload_dttm\": \"2026-10-03T01:51:35.876Z\"\n    },\n    {\n      \"guid\": \"9a04b42e-fe36-4ec7-9c8d-1cc4d3dd24b3\",\n      \"name\": \"E_Snowflake_FIN2021_RECON_SAP_HCP\",\n      \"description\": \"Extracts data from the FIN2021_RECON Snowflake database required for the FI-COPA Reconciliation Dashboard. Data is refreshed hourly, starting at the 00:45 minute mark of the hour.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:51:20.510Z\",\n      \"reload_dttm\": \"2026-10-03T01:51:19.613Z\"\n    },\n    {\n      \"guid\": \"22fb8a39-acc5-48e5-85dd-6f550cc10888\",\n      \"name\": \"Global CX Case Dashboard\",\n      \"description\": \"This application allows you to analyze customer experience cases on a product level. Plus, it gives you visibility into the survey (if any) tied to the case.\",\n      \"stream\": \"LS Customer Service\",\n      \"modified_dttm\": \"2026-10-03T01:50:33.456Z\",\n      \"reload_dttm\": \"2026-10-03T01:50:31.400Z\"\n    },\n    {\n      \"guid\": \"9f5663f4-d26c-4462-b7c1-1f168b91e27d\",\n      \"name\": \"T_ProductDashboard (new version)\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:49:51.379Z\",\n      \"reload_dttm\": \"2026-10-03T01:49:51.068Z\"\n    },\n    {\n      \"guid\": \"8c5893e9-10a5-4d79-beb0-45ff61e2c30c\",\n      \"name\": \"T_FI_FunctionalAreaP&L Consol\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:48:45.932Z\",\n      \"reload_dttm\": \"2026-10-03T01:48:45.676Z\"\n    },\n    {\n      \"guid\": \"9d2b4ea5-d3b4-40b1-a9d5-4f5d3290a542\",\n      \"name\": \"E_SF_RegionalP&L\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:47:46.340Z\",\n      \"reload_dttm\": \"2026-10-03T01:47:45.315Z\"\n    },\n    {\n      \"guid\": \"2d88ab72-6bc4-477f-acb3-e41b69b168ec\",\n      \"name\": \"Customer Experience - NPS Dashboard\",\n      \"description\": \"Dashboard showing different NPS types and their score for regions and language\",\n      \"stream\": \"LS Customer Service\",\n      \"modified_dttm\": \"2026-10-03T01:47:24.050Z\",\n      \"reload_dttm\": \"2026-10-03T01:47:14.835Z\"\n    },\n    {\n      \"guid\": \"89be13dc-27ae-401f-8e8a-f28d15a91f20\",\n      \"name\": \"E_SF_RegionalP&L v2\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:46:46.311Z\",\n      \"reload_dttm\": \"2026-10-03T01:46:45.683Z\"\n    },\n    {\n      \"guid\": \"c4792818-4c1e-4e8b-b082-4333c7ea92ba\",\n      \"name\": \"Bank Reconciliation App\",\n      \"description\": \"This app monitors the automated matching performance of the bank statement vs SAP bank ledger data in the Covarius Forecast solution\",\n      \"stream\": \"CORP Shared Services\",\n      \"modified_dttm\": \"2026-10-03T01:44:15.563Z\",\n      \"reload_dttm\": \"2026-10-03T01:44:14.964Z\"\n    },\n    {\n      \"guid\": \"30d68613-60a9-466f-8a55-53cc96c4f923\",\n      \"name\": \"T_DCF_BANKREC_T\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:44:02.362Z\",\n      \"reload_dttm\": \"2026-10-03T01:44:02.108Z\"\n    },\n    {\n      \"guid\": \"98f222f1-da80-44e7-9d80-220ab3c113ed\",\n      \"name\": \"T_CustomerServiceNPSDashboard\",\n      \"description\": \"Transform app for NPS Dashboard\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:43:19.602Z\",\n      \"reload_dttm\": \"2026-10-03T01:43:04.989Z\"\n    },\n    {\n      \"guid\": \"a3cf67e1-8c4e-4ef5-b016-8f173e1e9ec9\",\n      \"name\": \"T_DCF_BANKREC_P\",\n      \"description\": \"\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:42:39.356Z\",\n      \"reload_dttm\": \"2026-10-03T01:42:39.135Z\"\n    },\n    {\n      \"guid\": \"8021a88b-8814-4039-9376-cf8812fc7fad\",\n      \"name\": \"Archive - Capacity Report AME\",\n      \"description\": \"Global, strategic capacity analysis for Electronic manufacturing.\",\n      \"stream\": \"CORP Advanced Manufacturing Engineering Management\",\n      \"modified_dttm\": \"2026-10-03T01:42:35.963Z\",\n      \"reload_dttm\": \"2026-10-03T01:42:33.202Z\"\n    },\n    {\n      \"guid\": \"9f512315-8880-4d7a-bc01-33ae26330e21\",\n      \"name\": \"LS SKU Liability\",\n      \"description\": \"This application provides calculated Open and Uncovered Liability quantities by SKU/Plant/Vendor.\",\n      \"stream\": \"LS Supply Chain\",\n      \"modified_dttm\": \"2026-10-03T01:41:26.462Z\",\n      \"reload_dttm\": \"2026-10-03T01:41:24.851Z\"\n    },\n    {\n      \"guid\": \"9f58c6d7-c6fe-40ab-83b7-cdc6524d750d\",\n      \"name\": \"T_LS_SKULiability\",\n      \"description\": \"Combines and transforms snapshotted data for the SKU Liability dashboard.\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:41:16.938Z\",\n      \"reload_dttm\": \"2026-10-03T01:41:16.743Z\"\n    },\n    {\n      \"guid\": \"807af6eb-c38f-4045-9ef1-0887fb6de50d\",\n      \"name\": \"T_Archive_CapacityReporting\",\n      \"description\": \"Capacity Reporting (Archive)\\n- Transform\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:40:53.700Z\",\n      \"reload_dttm\": \"2026-10-03T01:40:53.489Z\"\n    },\n    {\n      \"guid\": \"4e0bfd81-ec3b-41e9-a5ba-a715d31b12ac\",\n      \"name\": \"E_HMP_Quality\",\n      \"description\": \"Snowflake Extractor\",\n      \"stream\": \"QVD Generator\",\n      \"modified_dttm\": \"2026-10-03T01:38:07.805Z\",\n      \"reload_dttm\": \"2026-10-03T01:38:07.448Z\"\n    }\n  ],\n  \"pagination\": {\n    \"limit\": 50,\n    \"offset\": 0,\n    \"returned\": 50,\n    \"total_found\": 1324,\n    \"has_more\": true,\n    \"next_offset\": 50\n  }\n}"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 7477
  }
]
```

### Turn 3: What is the capital of india ?

Status: completed. Thread: `01a0ff83-38ba-7761-95f1-3826a0a9ce4e`.

The capital of India is New Delhi.

[truex-suggestions]
- What is the population of New Delhi?
- List the apps in Qlik related to India
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
| 1 | 1 | 43 | 2 | 37701 | 2102 | 2125 | 2125 | no tool |
| 2 | 2 | 43 | 3 | 37701 | 3242 | 1810 | no text | 1996 |
| 3 | 2 | 43 | 3 | 37701 | 3242 | 2952 | 3410 | no tool |
| 4 | 3 | 43 | 2 | 37701 | 2102 | 1744 | 1745 | no tool |

All timing is measured from provider-request start. HTTP headers alone are not treated as a text token. Schema byte sizes are serialized captured JSON, not component token counts. The complete [actual Responses requests sent to the model gateway](adaptive-actual-responses-requests.jsonl) are captured separately from the original Codex requests.

Routing is performed once before each user turn, not after every tool call. The selected plan is reused for the remaining calls of that turn. The model sees filtered schemas while Codex retains a static dispatch catalog. Adaptive gateway events, registry metadata, routing plans, selection traces and full/projected results are saved in the full capture. No registry or routing trace is silently inserted into model context.

```json
[
  {
    "at": "2026-10-03T02:06:24.969Z",
    "turn": 1,
    "permissionRejectedToolIds": [],
    "query": "Hi bro ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.4675420000003214
  },
  {
    "at": "2026-10-03T02:06:28.784Z",
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
    "routingLatencyMs": 0.331292000000758
  },
  {
    "at": "2026-10-03T02:06:50.971Z",
    "turn": 3,
    "permissionRejectedToolIds": [],
    "query": "What is the capital of india ?",
    "confidence": 0,
    "candidates": [],
    "mode": "direct_tools",
    "selected": [],
    "authorizationRemoved": "[REDACTED]",
    "routingLatencyMs": 0.5831669999970472
  }
]
```

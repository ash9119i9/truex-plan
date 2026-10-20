# SAP business operations use cases

Assistants that answer business questions, investigate exceptions and help SAP users take the next action. All start read-only.

## 1. Procurement assistant

> "Which purchase orders are overdue?"

Find delayed orders, check supplier confirmations, explain exceptions and draft supplier follow-ups.

## 2. Sales order assistant

> "Why hasn't customer ABC's order shipped?"

Review order status, delivery information and available block reasons; suggest the next step.

## 3. Invoice exception assistant

> "Why is this supplier invoice blocked?"

Compare the invoice, purchase order and goods receipt to identify price or quantity differences.

## 4. Inventory and material assistant

> "Where do we have stock for this material?"

Check stock across plants, identify shortages and suggest transfers for review.

## 5. Finance reporting assistant

> "Summarize overdue customer invoices."

Explain receivables, payables and spending using authorized SAP data, with references to the underlying records.

## 6. SAP support assistant

> "Explain this integration error and how to resolve it."

Combine accessible logs, interface status, documentation and previous incident resolutions.

## 7. Master data quality assistant

> "Find suppliers with missing or inconsistent information."

Flag possible duplicates and incomplete records, then prepare proposed corrections.

## Recommended first pilot

Procurement assistant: overdue purchase orders → supporting details → explanation → draft follow-up. It has a clear business outcome and can begin with read-only access.

## Requirements

- An SAP connector; none exists yet (see [README](README.md#current-platform-status)).
- SAP APIs for the relevant objects, for example [purchase orders](https://help.sap.com/docs/SAP_S4HANA_CLOUD/0e602d466b99490187fcbb30d1dc897c/c89eec80ec2043d980cb7b8c89e0a00a.html) and [sales orders](https://help.sap.com/docs/SAP_S4HANA_CLOUD/03c04db2a7434731b7fe21dca77440da/00d244581efca007e10000000a441470.html). Availability depends on SAP edition, enabled APIs and permissions.
- Write actions (creating or changing records) only after authorization checks, approval and duplicate-action protection exist.

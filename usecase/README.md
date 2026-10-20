# SAP use cases for Truex

Proposed SAP use cases for the Truex agent platform, captured 2026-10-20. These are capabilities we could build; they are not implemented today.

| File | Scope |
| --- | --- |
| [sap-business-operations.md](sap-business-operations.md) | Assistants for day-to-day SAP business users (procurement, sales, finance, inventory, support) |
| [sap-transformation.md](sap-transformation.md) | Assistants for the team running an SAP transformation (for example ECC → S/4HANA) |

## Current platform status

Truex has the agent, chat and connector foundation. SAP-specific connectors are deferred in the current connector plan ([tasks/mcp-plan.md](../tasks/mcp-plan.md), "Agreed decisions"): v1 connectors are product-defined directory connectors, read-only, Streamable HTTP only.

Consequences for these use cases:

- Use cases that work from project artifacts (documents, transcripts, reports) can start before SAP integration.
- Use cases that read live SAP data need an SAP connector (MCP over SAP OData APIs). The exact integration depends on the SAP edition, enabled APIs and user permissions.
- Creating or changing SAP records is a later step that needs authorization checks, user approval and duplicate-action protection.

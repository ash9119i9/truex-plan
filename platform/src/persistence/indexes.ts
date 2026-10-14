import type { Db } from "mongodb";
// Tenant MCP names are unique per tenant, user MCP names per owner; the
// cross-scope rule (a tenant name is reserved) is enforced in the service.
// Same definitions as scripts/tenant.mjs and scripts/migrate-mcp-scopes.mjs.
export function mcpIndexes(db: Db) {
  const mcp = db.collection("truex_mcp");
  return [
    mcp.createIndex(
      { scope: 1, name: 1 },
      {
        name: "tenant_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "tenant" },
      },
    ),
    mcp.createIndex(
      { ownerId: 1, name: 1 },
      {
        name: "user_mcp_name",
        unique: true,
        partialFilterExpression: { scope: "user" },
      },
    ),
    mcp.createIndex({ agentIds: 1, scope: 1 }),
  ];
}
// Agent handles: one pair of index definitions per tenant mode. A private
// tenant (isUserSpecific) keys handles by creator, so one person's handle never
// blocks, or reveals, another's. A shared or unconfigured tenant keeps the
// workspace-wide unique handle it has always had. The legacy index is never
// created for a private tenant and never dropped by the application.
export function agentIndexes(db: Db, creatorHandles: boolean) {
  const agents = db.collection("truex_agents");
  return creatorHandles
    ? [
        agents.createIndex(
          { createdBy: 1, handle: 1 },
          {
            name: "agent_creator_handle",
            unique: true,
            partialFilterExpression: {
              createdBy: { $type: "string" },
              handle: { $type: "string" },
            },
          },
        ),
        agents.createIndex({ createdBy: 1, enabled: 1 }),
      ]
    : [
        // Sparse: agents seeded before handles existed have none.
        agents.createIndex({ handle: 1 }, { unique: true, sparse: true }),
      ];
}

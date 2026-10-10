import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GlobalToolRegistry,
  ToolRouter,
  createExposedBindings,
  calibrateRoutingThresholds,
  type RegisteredTool,
} from "../../agent-core/src/tool-router-v2";
import { AdaptiveModelBoundaryV2 } from "../../agent-core/src/adaptive-model-boundary-v2";

const scope = { tenantId: "fixture", userId: "fixture-user" };
const tool = (
  serverId: string,
  toolName: string,
  description: string,
  tags: string[],
): RegisteredTool => ({
  id: JSON.stringify([serverId, toolName]),
  serverId,
  serverName: serverId,
  toolName,
  description,
  tags,
  sourceType: "mcp",
  tenantId: scope.tenantId,
  enabled: true,
  available: true,
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  destructive: false,
});
const catalog = createExposedBindings([
  tool(
    "qlik",
    "get_apps",
    "List Qlik applications accessible to the authenticated user",
    ["apps", "applications", "analytics"],
  ),
  tool(
    "qlik",
    "get_app_details",
    "Get one Qlik application details by identifier",
    ["apps", "details"],
  ),
  tool(
    "qlik",
    "get_kpi",
    "Retrieve related Qlik KPI measures and revenue indicators",
    ["kpi", "revenue", "analytics"],
  ),
  tool(
    "sap",
    "get_sales_orders",
    "Retrieve SAP sales orders using customer product company country and date filters",
    ["sales", "orders", "erp"],
  ),
  tool(
    "sap",
    "get_revenue",
    "Retrieve current SAP sales revenue by customer and company",
    ["sales", "revenue"],
  ),
  tool(
    "snowflake",
    "sales_analysis",
    "Analyze historical sales data stored in Snowflake",
    ["sales", "historical", "analytics", "warehouse"],
  ),
  tool(
    "salesforce",
    "get_opportunities",
    "Retrieve current sales opportunities by customer",
    ["opportunities", "customers", "sales"],
  ),
]);
async function main() {
  const registry = new GlobalToolRegistry();
  catalog.forEach((t) => registry.upsert(t));
  const router = new ToolRouter(registry, () => true);
  const cases = [
    {
      name: "qlik",
      query: "Can you list down the apps in Qlik?",
      expected: "direct_tools",
    },
    {
      name: "unrelated",
      query: "What is the capital of India?",
      expected: "direct_tools",
    },
    {
      name: "multi-mcp",
      query:
        "Compare SAP sales with historical Snowflake sales and retrieve the related Qlik KPI.",
      expected: "direct_tools",
    },
    {
      name: "ambiguous",
      query:
        "Find why European enterprise customer margins declined and compare that with our current opportunities.",
      expected: "discovery",
    },
    {
      name: "follow-up",
      query: "Which ones were modified recently?",
      expected: "direct_tools",
      context: {
        recentServerIds: ["qlik"],
        recentToolIds: [JSON.stringify(["qlik", "get_apps"])],
      },
    },
  ];
  const boundary = new AdaptiveModelBoundaryV2(scope);
  const input = {
    tools: [
      ...["update_plan", "request_user_input"].map((name) => ({
        type: "function",
        name,
        parameters: { type: "object" },
      })),
      {
        type: "namespace",
        name: "mcp__adaptive",
        tools: [
          ...catalog.map((t) => ({
            type: "function",
            name: t.bindingName,
            description: t.description,
            parameters: t.inputSchema,
          })),
          ...[
            "discover_server",
            "discover_tools",
            "get_tool_schema",
            "invoke_tool",
          ].map((name) => ({
            type: "function",
            name,
            parameters: { type: "object" },
          })),
        ],
      },
    ],
  };
  const bindings = new Map(catalog.map((t) => [t.bindingName!, t]));
  const traces = [];
  for (const c of cases) {
    const routing = await router.route({
      query: c.query,
      ...scope,
      context: c.context,
    });
    const exposure = await boundary.filter(input, routing, bindings);
    if (routing.mode !== c.expected)
      throw new Error(`Fixture mode mismatch: ${c.name}: ${routing.mode}`);
    if (
      c.name === "multi-mcp" &&
      !["sap", "snowflake", "qlik"].every((server) =>
        routing.selected.some((t) => t.serverId === server),
      )
    )
      throw new Error("Multi-MCP routing lost a requested server");
    traces.push({
      name: c.name,
      evidence:
        "local deterministic fixture; no provider calls or live upstream execution",
      ...routing,
      candidateServers: [
        ...new Set(routing.candidates.map((t) => t.tool.serverId)),
      ],
      candidateTools: routing.candidates.map((c) => ({
        id: c.tool.id,
        server: c.tool.serverId,
        tool: c.tool.toolName,
        score: c.score,
        reason: c.reason,
      })),
      selected: routing.selected.map((t) => `${t.serverId}/${t.toolName}`),
      exposure: exposure.trace,
    });
  }
  const output = resolve(process.argv[2] || "docs/adaptive-mcp-v2");
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "fixture-traces.json"),
    JSON.stringify(
      {
        scope,
        thresholds: router.thresholds,
        calibration: calibrateRoutingThresholds(),
        catalog,
        traces,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      output,
      traces: traces.map((t) => ({
        name: t.name,
        mode: t.mode,
        selected: t.selected,
        schemas: t.exposure.exposedSchemaCount,
      })),
      calibration: calibrateRoutingThresholds().accuracy,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

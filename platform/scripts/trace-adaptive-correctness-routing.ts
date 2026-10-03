/** Captured-catalog-only routing demonstration. No network, model or business tool execution. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  GlobalToolRegistry,
  LexicalToolRetriever,
  ToolRouter,
  type RegisteredTool,
} from "../../agent-core/src/tool-router-v2";

const root = resolve(__dirname, "../..");
const { values } = parseArgs({
  options: {
    capture: {
      type: "string",
      default: join(
        root,
        "docs/adaptive-mcp-v2/adaptive/adaptive-capture.json",
      ),
    },
    out: {
      type: "string",
      default: join(
        root,
        "docs/adaptive-correctness-fix/captured-catalog-routing-trace.json",
      ),
    },
  },
});
const sourcePath = resolve(values.capture!);
const outPath = resolve(values.out!);
const messages = [
  "hi this is ashok ?",
  "What is the capital of India ?",
  "what are the Qlik apps ?",
  "What is the capital of tamilnadu ?",
  "Explain this qlik app T_DCF_BANKREC_P",
];
const bytes = (value: any) => Buffer.byteLength(JSON.stringify(value), "utf8");
const cell = (value: any) => String(value).replace(/\|/g, "\\|");
function schemas(tools: RegisteredTool[]) {
  return tools.map((tool) => ({
    name: tool.bindingName || tool.toolName,
    description: tool.description || "",
    parameters: tool.inputSchema,
  }));
}
function parsed(result: any) {
  if (result?.structuredContent != null) return result.structuredContent;
  try {
    return JSON.parse(
      result?.content?.find((block: any) => block.type === "text")?.text,
    );
  } catch {
    return;
  }
}
async function main() {
  const raw = await readFile(sourcePath, "utf8"),
    source = JSON.parse(raw);
  const tools: RegisteredTool[] = source.adaptiveRegistry;
  if (!Array.isArray(tools) || tools.length !== 14)
    throw new Error(
      "Expected the historical healthy fourteen-tool Qlik registry.",
    );
  const registry = new GlobalToolRegistry();
  for (const tool of tools) registry.upsert(tool);
  // This descriptor exercise permits captured metadata. It does not claim that
  // today's user permissions or remote connector availability were checked.
  const router = new ToolRouter(registry, async () => true);
  const originalRetriever = new LexicalToolRetriever();
  const request = (query: string, context: any = {}) => ({
    query,
    tenantId: tools[0].tenantId!,
    userId: "captured-catalog-only",
    context: {
      registryState: "ready" as const,
      allowedServerIds: ["qlik"],
      ...context,
    },
  });
  const turns: any[] = [];
  for (let index = 0; index < messages.length; index++) {
    const plan = await router.route(request(messages[index]));
    turns.push({
      turn: index + 1,
      message: messages[index],
      contextSource:
        "Historical registry marked ready for this offline descriptor exercise; no previous business tool was executed",
      plan,
      selectedCapturedSchemaCount: plan.selected.length,
      selectedCapturedSchemaJsonBytes: bytes(schemas(plan.selected)),
      selectedCapturedSchemas: schemas(plan.selected),
      originalScores: originalRetriever
        .retrieve(request(messages[index]), tools)
        .map((candidate) => ({
          tool: candidate.tool.toolName,
          score: candidate.score,
          reason: candidate.reason,
        })),
      expandedScores: plan.taskRetrieval
        ? plan.candidates.map((candidate) => ({
            tool: candidate.tool.toolName,
            score: candidate.score,
            reason: candidate.reason,
          }))
        : undefined,
    });
  }
  const capturedApps = (source.adaptiveGatewayEvents || [])
    .filter(
      (event: any) => event.type === "invoke" && event.tool === "get_apps",
    )
    .flatMap((event: any) => parsed(event.result)?.apps || []);
  const first = capturedApps[0];
  const additionalCases: any[] = [];
  if (first?.name && first.guid) {
    const query = `Explain ${first.name}`;
    const context = {
      activeServerId: "qlik",
      activeEntities: [
        {
          kind: "application",
          serverId: "qlik",
          name: first.name,
          guid: first.guid,
          stream: first.stream,
        },
      ],
    };
    const plan = await router.route(request(query, context));
    additionalCases.push({
      message: query,
      contextSource:
        "First app identity from the historical captured successful get_apps result, canonical kind=application; no fresh lookup",
      plan,
      selectedCapturedSchemaCount: plan.selected.length,
      selectedCapturedSchemaJsonBytes: bytes(schemas(plan.selected)),
    });
  }
  const result = {
    generatedAt: new Date().toISOString(),
    evidenceKind: "captured-catalog-only",
    sourceCapture: sourcePath,
    sourceSha256: createHash("sha256").update(raw).digest("hex"),
    sourceCreatedAt: source.createdAt,
    liveExecution: false,
    modelCalls: 0,
    networkCalls: 0,
    businessToolCalls: 0,
    performanceClaimsAllowed: false,
    catalogTools: tools.length,
    thresholds: router.thresholds,
    catalogSchemaJsonBytes: bytes(schemas(tools)),
    messages,
    turns,
    additionalCases,
    limitations: [
      "Uses historical sanitized descriptor/schema metadata, not current remote catalog health or current user permissions.",
      "Schema bytes reflect captured descriptor definitions only; actual gateway projection policy, namespace/provider translation, mandatory native controls and system/history are outside this demonstration.",
      "Routing scores are deterministic metadata-retrieval scores, not calibrated probabilities or LLM tokens.",
      "No assistant response, fresh business data, latency saving, token saving or end-to-end correctness is established.",
    ],
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + "\n");
  const lines = [
    "# Captured-catalog-only routing trace",
    "",
    "**No live execution: 0 model calls, 0 network calls, 0 business tool calls.** This demonstrates routing against the historical healthy fourteen-tool Qlik descriptors. It is not a current catalog probe, live benchmark, or performance result.",
    "",
    `Source: [historical sanitized capture](${relative(dirname(outPath), sourcePath)}). Source SHA-256 and every candidate/selected schema are retained in [JSON](${relative(dirname(outPath), outPath)}).`,
    "",
    "| Turn | Exact user message | Mode | Observed route score / threshold | Captured MCP schemas | Captured selected schema JSON bytes | Selected tools |",
    "|---|---|---|---:|---:|---:|---|",
  ];
  for (const turn of turns)
    lines.push(
      `| ${turn.turn} | ${cell(turn.message)} | ${turn.plan.mode} | ${turn.plan.confidence.toFixed(4)} / ${turn.plan.thresholds.highConfidenceThreshold.toFixed(2)} | ${turn.selectedCapturedSchemaCount} | ${turn.selectedCapturedSchemaJsonBytes} | ${turn.plan.selected.map((tool: RegisteredTool) => tool.toolName).join(", ") || "none"} |`,
    );
  lines.push(
    "",
    "Schema bytes are compact JSON of the captured name/description/parameters arrays. The empty schema array is 2 bytes. They are not exact token charges or measured final provider payload bytes.",
    "",
    "| App explanation | Original app-details anchor score | Expanded app-details anchor score | Original best score | Expanded best score |",
    "|---|---:|---:|---:|---:|",
  );
  for (const turn of [...turns, ...additionalCases]) {
    const t = turn.plan.taskRetrieval;
    if (t)
      lines.push(
        `| ${cell(turn.message)} | ${t.originalAnchorScore.toFixed(4)} | ${t.expandedAnchorScore.toFixed(4)} | ${t.originalBestScore.toFixed(4)} | ${t.expandedBestScore.toFixed(4)} |`,
      );
  }
  for (const turn of [...turns, ...additionalCases])
    if (turn.plan.taskRetrieval)
      lines.push(
        "",
        `Expansion: \`${cell(turn.plan.taskRetrieval.expandedQuery)}\`. ${turn.plan.taskRetrieval.reason}. The actual expanded app-details score must meet the unchanged configured threshold; a low-confidence/custom retriever is not overridden.`,
        "",
      );
  lines.push(
    "Authorization, unavailable-registry handling, ambiguous server/vendor selection, missing capabilities, Top-K limits, extra output tasks, and strict/custom retriever thresholds are exercised by focused router tests. This descriptor demonstration does not assert that those permissions or remote conditions currently hold.",
    "",
    "The complete model inputs, provider outputs and business evidence needed for a live comparison remain unavailable until connector initialization recovers. [Live correctness gate](live/CORRECTNESS_GATE.md).",
    "",
  );
  await writeFile(outPath.replace(/\.json$/, ".md"), lines.join("\n"));
  console.log(
    JSON.stringify({
      evidenceKind: result.evidenceKind,
      trace: outPath,
      modes: turns.map((turn) => turn.plan.mode),
      modelCalls: 0,
      networkCalls: 0,
    }),
  );
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});

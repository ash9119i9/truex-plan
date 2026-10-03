/** Offline report only: reads sanitized captures; performs no model, MCP or database calls. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type Json = any;
const repository = resolve(__dirname, "../..");
const { values } = parseArgs({
  options: {
    dir: {
      type: "string",
      default: join(repository, "docs/five-message-mcp-v2"),
    },
    "allow-incomplete": { type: "boolean", default: false },
  },
});
const directory = resolve(values.dir!);
const modes = ["direct", "omni", "adaptive"] as const;
const labels: Record<string, string> = {
  direct: "Direct",
  omni: "Omni required",
  adaptive: "Adaptive",
};
const compact = (value: Json) => JSON.stringify(value);
const bytes = (value: Json) => Buffer.byteLength(compact(value), "utf8");
const size = (value: string) => ({
  chars: Array.from(value).length,
  bytes: Buffer.byteLength(value, "utf8"),
});
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const display = (value: number | undefined) =>
  value === undefined ? "unknown" : value.toLocaleString("en-US");
const cell = (value: unknown) =>
  String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function fence(value: string, language = "text") {
  const longest = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (m) => m[0].length),
  );
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${value}\n${ticks}`;
}
function flattened(body: Json) {
  return (body?.tools || []).flatMap((tool: Json) =>
    tool.type === "namespace" ? tool.tools || [] : [tool],
  );
}
function usage(calls: Json[]) {
  const result = {
    input: 0,
    output: 0,
    attempts: calls.length,
    missingInput: 0,
    missingOutput: 0,
    non200: 0,
    incompleteStreams: 0,
    zeroToolOutputAnomalies: 0,
  };
  for (const call of calls) {
    const input = number(call.usage?.input_tokens),
      output = number(call.usage?.output_tokens);
    if (input === undefined) result.missingInput++;
    else result.input += input;
    if (output === undefined) result.missingOutput++;
    else result.output += output;
    if (call.status !== 200) result.non200++;
    if (
      call.parseError ||
      call.error ||
      !(call.events || []).some((event: Json) => event.type === "message_stop")
    )
      result.incompleteStreams++;
    if (
      output === 0 &&
      (call.events || []).some(
        (event: Json) =>
          event.content_block?.type === "tool_use" ||
          event.delta?.type === "input_json_delta",
      )
    )
      result.zeroToolOutputAnomalies++;
  }
  return result;
}
function usageCell(calls: Json[], turn?: Json) {
  if (!calls.length && !turn) return "not run";
  const u = usage(calls);
  return `${display(u.input)}${u.missingInput ? "+unknown" : ""} / ${display(u.output)}${u.missingOutput ? "+unknown" : ""} / ${u.attempts}${turn?.status && turn.status !== "completed" ? ` (${turn.status})` : ""}`;
}
function historyLevels(body: Json) {
  const categories: Record<string, number> = {
    userText: 0,
    assistantText: 0,
    toolCalls: 0,
    toolResults: 0,
    thinking: 0,
    otherBlocks: 0,
  };
  for (const message of body.messages || []) {
    const blocks = Array.isArray(message.content)
      ? message.content
      : [message.content];
    for (const block of blocks) {
      const type = typeof block === "string" ? "text" : block?.type;
      const key =
        type === "tool_use"
          ? "toolCalls"
          : type === "tool_result"
            ? "toolResults"
            : ["thinking", "redacted_thinking"].includes(type)
              ? "thinking"
              : type === "text"
                ? message.role === "user"
                  ? "userText"
                  : "assistantText"
                : "otherBlocks";
      if (block !== undefined) categories[key] += bytes(block);
    }
  }
  const history = bytes(body.messages || []);
  return {
    ...categories,
    messageWrappers:
      history - Object.values(categories).reduce((a, b) => a + b, 0),
    totalHistoryBytes: history,
  };
}
function inputLevels(body: Json) {
  const system = body.system ?? [];
  const text =
    typeof system === "string"
      ? system
      : system.map((block: Json) => block.text || "").join("");
  const {
    system: _system,
    tools: _tools,
    messages: _messages,
    ...envelope
  } = body;
  const tools = body.tools || [];
  const native = tools.filter(
    (tool: Json) => !String(tool.name || "").startsWith("mcp__"),
  );
  const mcp = tools.filter((tool: Json) =>
    String(tool.name || "").startsWith("mcp__"),
  );
  return {
    systemText: size(text),
    systemJson: { ...size(compact(system)) },
    schemasJson: { ...size(compact(tools)) },
    historyJson: { ...size(compact(body.messages || [])) },
    completeBodyBytes: bytes(body),
    requestEnvelopeJsonBytes: bytes(envelope),
    nativeSchemas: native.length,
    mcpSchemas: mcp.length,
    nativeSchemaJsonBytes: bytes(native),
    mcpSchemaJsonBytes: bytes(mcp),
    historyBlockJsonBytes: historyLevels(body),
  };
}
function reconstructedAssistant(call: Json) {
  const blocks = new Map<number, Json>();
  let start: Json, stop: Json;
  for (const event of call.events || []) {
    if (event.type === "message_start") start = event.message;
    if (event.type === "content_block_start")
      blocks.set(event.index, { ...event.content_block });
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index) || {};
      if (event.delta?.type === "text_delta")
        block.text = (block.text || "") + event.delta.text;
      if (event.delta?.type === "input_json_delta")
        block.rawInputJson =
          (block.rawInputJson || "") + event.delta.partial_json;
      if (event.delta?.type === "thinking_delta")
        block.thinking = (block.thinking || "") + event.delta.thinking;
      if (event.delta?.type === "signature_delta")
        block.signature = (block.signature || "") + event.delta.signature;
      blocks.set(event.index, block);
    }
    if (event.type === "message_delta") stop = event.delta;
  }
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.rawInputJson) {
        try {
          block.input = JSON.parse(block.rawInputJson);
        } catch {
          block.inputParseIncomplete = true;
        }
      }
      return block;
    });
  return {
    messageStart: start,
    content,
    stop,
    text: content
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join(""),
  };
}
function parsedResult(result: Json) {
  if (result?.structuredContent != null) return result.structuredContent;
  const texts = (result?.content || []).filter(
    (block: Json) => block.type === "text",
  );
  if (texts.length !== 1) return undefined;
  try {
    return JSON.parse(texts[0].text);
  } catch {
    return undefined;
  }
}
function isPreservedSubset(selected: Json, original: Json): boolean {
  if (selected === null || typeof selected !== "object")
    return Object.is(selected, original);
  if (Array.isArray(selected))
    return (
      Array.isArray(original) &&
      selected.length === original.length &&
      selected.every((item, index) => isPreservedSubset(item, original[index]))
    );
  return (
    original !== null &&
    typeof original === "object" &&
    !Array.isArray(original) &&
    Object.keys(selected).every(
      (key) =>
        Object.hasOwn(original, key) &&
        isPreservedSubset(selected[key], original[key]),
    )
  );
}
function projection(event: Json) {
  const original = parsedResult(event.result),
    selected = parsedResult(event.projected);
  return {
    tool: event.tool,
    server: event.server,
    fields: event.fields,
    arguments: event.arguments,
    inputBytes: event.inputBytes,
    outputBytes: event.outputBytes,
    percentBytesRemoved:
      number(event.inputBytes) && number(event.outputBytes) !== undefined
        ? 100 * (1 - event.outputBytes / event.inputBytes)
        : undefined,
    parsedDataAvailable: original !== undefined && selected !== undefined,
    selectedValuesPreserved:
      original !== undefined && selected !== undefined
        ? isPreservedSubset(selected, original)
        : undefined,
    appRowsBefore: Array.isArray(original?.apps)
      ? original.apps.length
      : undefined,
    appRowsAfter: Array.isArray(selected?.apps)
      ? selected.apps.length
      : undefined,
    paginationPreserved:
      original?.pagination !== undefined && selected?.pagination !== undefined
        ? compact(original.pagination) === compact(selected.pagination)
        : undefined,
  };
}

function answerEvidence(bundle: Json) {
  const items = bundle.logicalToolItems || bundle.fullCompletedToolItems;
  const successful = items.filter((item: Json) => item.status === "completed");
  const failed = items.filter((item: Json) => item.status === "failed");
  const appResults = successful
    .map((item: Json) => ({ tool: item.tool, data: parsedResult(item.result) }))
    .filter((item: Json) => Array.isArray(item.data?.apps));
  const details = successful.find(
    (item: Json) => item.tool === "get_app_details",
  );
  const detailsData = details && parsedResult(details.result);
  const scriptCalls = items.filter(
    (item: Json) => item.tool === "get_app_script",
  );
  return {
    successfulTools: successful.map((item: Json) => item.tool),
    failedTools: failed.map((item: Json) => ({
      tool: item.tool,
      arguments: item.arguments,
      error: item.error,
      result: item.result,
    })),
    appResults: appResults.map((item: Json) => ({
      tool: item.tool,
      returnedRows: item.data.apps.length,
      pagination: item.data.pagination,
      names: item.data.apps.map((app: Json) => app.name),
      appGuids: item.data.apps.map((app: Json) => app.guid),
    })),
    appResultPayloadSizes: successful
      .filter((item: Json) => Array.isArray(parsedResult(item.result)?.apps))
      .map((item: Json) => ({
        tool: item.tool,
        textBlocks: (item.result?.content || [])
          .filter((block: Json) => block.type === "text")
          .map((block: Json) => size(block.text)),
        fullRuntimeResultJsonBytes: bytes(item.result),
      })),
    detailsRetrieved: !!details,
    detailsTopLevelKeys: detailsData ? Object.keys(detailsData) : [],
    savedInProductVersion:
      detailsData?.appProperties?.qProp?.qSavedInProductVersion,
    scriptRetrieved: successful.some(
      (item: Json) => item.tool === "get_app_script",
    ),
    sheetsRetrieved: successful.some(
      (item: Json) => item.tool === "get_app_sheets",
    ),
    lineageRetrieved: successful.some(
      (item: Json) => item.tool === "get_lineage",
    ),
    scriptInvocationCount: scriptCalls.length,
    replyClaimsScriptTimedOutTwice: /get_app_script.*timed out twice/i.test(
      bundle.fullAssistantOutput || "",
    ),
    replyClaimsNoSheets: /no sheets available/i.test(
      bundle.fullAssistantOutput || "",
    ),
  };
}

async function main() {
  const captures: Record<string, Json> = {};
  let correctnessGate: Json;
  try {
    correctnessGate = JSON.parse(
      await readFile(join(directory, "correctness-verification.json"), "utf8"),
    );
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const mode of modes) {
    try {
      captures[mode] = JSON.parse(
        await readFile(join(directory, mode, `${mode}-capture.json`), "utf8"),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const first = modes.map((mode) => captures[mode]).find(Boolean);
  if (!first)
    throw new Error("No captures found; run the five-message benchmark first.");
  const messages: string[] = first.messages;
  if (messages.length !== 5)
    throw new Error("Expected five exact scenario messages.");
  for (const capture of Object.values(captures))
    if (compact(capture.messages) !== compact(messages))
      throw new Error(
        "Messages differ across modes; cannot present a like-for-like comparison.",
      );
  if (captures.omni && captures.omni.projection !== "required")
    throw new Error("This comparison expects Omni with required projection.");
  const unfinished = modes.filter(
    (mode) => !captures[mode] || captures[mode].outcome === "running",
  );
  if (unfinished.length && !values["allow-incomplete"])
    throw new Error(
      `Captures are missing or still running: ${unfinished.join(", ")}. Use --allow-incomplete only for a progress report.`,
    );
  await mkdir(join(directory, "turns"), { recursive: true });
  const summaries: Record<string, Json> = {};
  const callLedger: Json[] = [];
  const turnBundles: Record<string, Json[]> = {};
  const checks: Json[] = [];
  for (const mode of modes) {
    const capture = captures[mode];
    if (!capture) continue;
    const actual =
      capture.adaptiveResponsesRequests ||
      capture.actualResponsesRequests ||
      [];
    const calls = capture.providerCalls || [];
    const turns = capture.turns || [];
    const bootstrap = (capture.codexOutgoing || []).filter(
      (event: Json) => event.turn === 0,
    );
    const startupGatewayEvents = [
      ...(capture.omniGatewayEvents || []),
      ...(capture.adaptiveGatewayEvents || []),
    ].filter((event: Json) => event.turn === 0);
    await writeFile(
      join(directory, "turns", `${mode}-bootstrap.json`),
      JSON.stringify(
        {
          threadId: capture.threadId,
          configuration: capture.configuration,
          codexBootstrap: bootstrap,
          mcpStatus: capture.mcpStatus,
          startupGatewayEvents,
          runtimeEvents: (capture.runtimeEvents || []).filter(
            (event: Json) => event.turn === 0,
          ),
          gatewayLogs: (capture.gatewayLogs || []).filter(
            (event: Json) => event.turn === 0,
          ),
          adaptiveRegistry: capture.adaptiveRegistry,
          nativeRegistry: capture.nativeRegistry,
        },
        null,
        2,
      ) + "\n",
    );
    turnBundles[mode] = [];
    for (let index = 1; index <= 5; index++) {
      const turn = turns.find((entry: Json) => entry.index === index);
      const selectedCalls = calls
        .map((call: Json, callIndex: number) => ({
          ...call,
          globalCallNumber: callIndex + 1,
        }))
        .filter((call: Json) => call.turn === index);
      const correlatedCalls = selectedCalls.map((call: Json) => {
        const requestIndex = call.responsesIndex ?? call.globalCallNumber - 1;
        const entry = {
          mode,
          call: call.globalCallNumber,
          turn: index,
          status: call.status,
          reportedUsage: call.usage,
          inputLevels: inputLevels(call.body),
          outputLevels: {
            assistantText: size(reconstructedAssistant(call).text),
            toolArgumentJson: reconstructedAssistant(call)
              .content.filter((block: Json) => block.type === "tool_use")
              .map((block: Json) => ({
                name: block.name,
                ...size(block.rawInputJson || compact(block.input || {})),
              })),
            thinkingText: size(
              reconstructedAssistant(call)
                .content.filter((block: Json) => block.type === "thinking")
                .map((block: Json) => block.thinking || "")
                .join(""),
            ),
          },
          schemasBefore: flattened(
            capture.responsesRequests?.[requestIndex]?.body,
          ).length,
          schemasSent: flattened(actual[requestIndex]?.body).length,
          timing: {
            firstHeaderMs: call.firstResponseMs,
            firstBodyByteMs: call.firstByteMs,
            firstTextDeltaMs: call.firstTextTokenMs,
            firstToolBlockMs: call.firstToolTokenMs,
            streamDurationMs: call.durationMs,
          },
          streamComplete: (call.events || []).some(
            (event: Json) => event.type === "message_stop",
          ),
          zeroToolOutputAnomaly:
            call.usage?.output_tokens === 0 &&
            (call.events || []).some(
              (event: Json) => event.content_block?.type === "tool_use",
            ),
        };
        callLedger.push(entry);
        return {
          ...entry,
          codexOriginalResponsesRequest:
            capture.responsesRequests?.[requestIndex],
          actualResponsesRequest: actual[requestIndex],
          providerRequestAndRawSse: call,
          reconstructedProviderAssistant: reconstructedAssistant(call),
        };
      });
      const gatewayEvents = [
        ...(capture.omniGatewayEvents || []),
        ...(capture.adaptiveGatewayEvents || []),
      ].filter((event: Json) => event.turn === index);
      const bundle = {
        mode,
        threadId: capture.threadId,
        turn: index,
        userMessage: messages[index - 1],
        userMessageSize: size(messages[index - 1]),
        status: turn?.status || "not run",
        startedAt: turn?.startedAt,
        completedAt: turn?.completedAt,
        durationMs: turn?.durationMs,
        reportedUsage: usage(selectedCalls),
        runtimeTrace: turn?.trace,
        helperUsage: turn?.trace?.helperUsage,
        fullAssistantOutput: turn?.reply,
        assistantMessages: (turn?.snapshot?.messages || []).filter(
          (message: Json) => message.turnId === turn.turnId,
        ),
        fullCompletedToolItems: turn?.toolItems || [],
        logicalToolItems: (turn?.toolItems || []).map((item: Json) => {
          const descriptor = (capture.adaptiveRegistry || []).find(
            (tool: Json) => tool.bindingName === item.tool,
          );
          if (item.tool === "invoke_tool")
            return {
              ...item,
              server: item.arguments?.server,
              tool: item.arguments?.tool,
              arguments: item.arguments?.args || {},
            };
          return descriptor
            ? {
                ...item,
                server: descriptor.serverId,
                tool: descriptor.toolName,
              }
            : item;
        }),
        codexJsonRpcMessages: (capture.codexOutgoing || []).filter(
          (event: Json) => event.turn === index,
        ),
        correlatedModelCalls: correlatedCalls,
        runtimeEvents: (capture.runtimeEvents || []).filter(
          (event: Json) => event.turn === index,
        ),
        gatewayLogs: (capture.gatewayLogs || []).filter(
          (event: Json) => event.turn === index,
        ),
        gatewayEvents,
        projections: gatewayEvents
          .filter((event: Json) => event.type === "invoke")
          .map(projection),
        routingTraces: (capture.routingTraces || []).filter(
          (event: Json) => event.turn === index,
        ),
        modelBoundaryTraces: (capture.adaptiveBoundaryTraces || []).filter(
          (event: Json) => event.turn === index,
        ),
        approvalEvents: (capture.approvalEvents || []).filter(
          (event: Json) => event.turn === index,
        ),
        relayErrors: (capture.relayErrors || []).filter(
          (event: Json) => event.turn === index,
        ),
      };
      const completeBundle = {
        ...bundle,
        answerEvidence: answerEvidence(bundle),
      };
      turnBundles[mode].push(completeBundle);
      await writeFile(
        join(directory, "turns", `${mode}-turn-${index}.json`),
        JSON.stringify(completeBundle, null, 2) + "\n",
      );
    }
    const rootStarts = (capture.codexOutgoing || []).filter(
      (event: Json) =>
        event.payload?.method === "turn/start" &&
        event.payload.params?.threadId === capture.threadId,
    );
    const sequential = turns.every(
      (turn: Json, index: number) =>
        !index ||
        !turn.startedAt ||
        !turns[index - 1].completedAt ||
        turns[index - 1].completedAt <= turn.startedAt,
    );
    const runtimeReconciliation = turns.map((turn: Json) => {
      const measured = usage(
        calls.filter((call: Json) => call.turn === turn.index),
      );
      const main = turn.trace?.usage;
      return {
        turn: turn.index,
        providerInput: measured.input,
        providerOutput: measured.output,
        runtimeMainInput: main?.inputTokens,
        runtimeMainOutput: main?.outputTokens,
        helperUsage: turn.trace?.helperUsage,
        inputMatchesMain: main
          ? measured.input === main.inputTokens
          : undefined,
        outputMatchesMain: main
          ? measured.output === main.outputTokens
          : undefined,
      };
    });
    summaries[mode] = {
      outcome: capture.outcome,
      threadId: capture.threadId,
      reportedUsage: usage(calls),
      startupGatewayEvents,
      runConditions: capture.runConditions,
      turns: turnBundles[mode].map((bundle) => ({
        turn: bundle.turn,
        userMessage: bundle.userMessage,
        status: bundle.status,
        durationMs: bundle.durationMs,
        reportedUsage: bundle.reportedUsage,
        answerEvidence: bundle.answerEvidence,
        tools: bundle.fullCompletedToolItems.map((item: Json) => ({
          server: item.server,
          tool: item.tool,
          args: item.arguments,
          status: item.status,
        })),
      })),
      runtimeReconciliation,
    };
    checks.push({
      mode,
      sameFiveMessages: true,
      rootUserTurnStarts: rootStarts.length,
      sequentialTurnTimes: sequential,
      completedTurns: turns.filter((turn: Json) => turn.status === "completed")
        .length,
      allCallsHttp200: calls.every((call: Json) => call.status === 200),
      allCallsHaveReportedUsage: calls.every(
        (call: Json) =>
          number(call.usage?.input_tokens) !== undefined &&
          number(call.usage?.output_tokens) !== undefined,
      ),
      replyContainsNewDelhi: /new delhi/i.test(
        turns.find((turn: Json) => turn.index === 2)?.reply || "",
      ),
      replyContainsChennai: /chennai/i.test(
        turns.find((turn: Json) => turn.index === 4)?.reply || "",
      ),
      projectionSubsetChecks: turnBundles[mode].flatMap((bundle) =>
        bundle.projections.map((entry: Json) => ({
          turn: bundle.turn,
          tool: entry.tool,
          selectedValuesPreserved: entry.selectedValuesPreserved,
        })),
      ),
    });
  }
  const allCompleted = modes.every(
    (mode) =>
      captures[mode]?.outcome === "completed" &&
      summaries[mode]?.turns.every((turn: Json) => turn.status === "completed"),
  );
  const reportData = {
    generatedAt: new Date().toISOString(),
    messages,
    allCompleted,
    correctnessGate: correctnessGate
      ? {
          status: correctnessGate.status,
          performanceClaimsAllowed: correctnessGate.performanceClaimsAllowed,
        }
      : undefined,
    summaries,
    calls: callLedger,
    verification: checks,
    note: "Token counters are provider-reported. Captured character/byte categories are not component token charges. Unknown usage is excluded from numeric sums and explicitly counted; zero generated-tool output is an upstream anomaly.",
  };
  await writeFile(
    join(directory, "comparison.json"),
    JSON.stringify(reportData, null, 2) + "\n",
  );
  await writeFile(
    join(directory, "call-ledger.json"),
    JSON.stringify(callLedger, null, 2) + "\n",
  );
  const lines = [
    "# Five messages: complete MCP token and execution report",
    "",
    "Each table cell is **provider-reported input / output / upstream calls**. These are five sequential user turns in one fresh thread per mode. Omni uses required projection. Full message text, model requests, raw outputs and tool results are retained in the linked turn bundles.",
    "",
    "| Turn | Exact user message | Direct input / output / calls | Omni required input / output / calls | Adaptive input / output / calls |",
    "|---|---|---:|---:|---:|",
  ];
  for (let index = 1; index <= 5; index++)
    lines.push(
      `| ${index} | ${cell(messages[index - 1])} | ${modes
        .map((mode) =>
          usageCell(
            (captures[mode]?.providerCalls || []).filter(
              (call: Json) => call.turn === index,
            ),
            captures[mode]?.turns?.find((turn: Json) => turn.index === index),
          ),
        )
        .join(" | ")} |`,
    );
  lines.push(
    `| **Overall** | **All five messages** | ${modes.map((mode) => (captures[mode] ? usageCell(captures[mode].providerCalls || [], { status: captures[mode].outcome }) : "not run")).join(" | ")} |`,
    "",
    allCompleted
      ? "All three threads completed all five turns. The harness waited for the preceding response before submitting the next message."
      : "Some captures are incomplete or failed. Missing turns are labeled not run; unknown usage is not assumed to be zero cost.",
    "",
    "Input/output totals are the custom upstream's counters, not independently verified billing. Tool-use events with zero reported output are flagged below. Cache/reasoning counters absent upstream remain unknown. No exact system/schema/history token split or currency cost is invented.",
    "",
    "## Overall counters and accounting gaps",
    "",
    "| Mode | Status | Reported input | Reported output | Reported total | Attempts | Attempts missing input / output | Non-200 attempts | Zero tool-output anomalies |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  const incompleteBusinessModes = modes.filter(
    (mode) =>
      turnBundles[mode] &&
      !turnBundles[mode][2]?.answerEvidence.appResults.length,
  );
  if (incompleteBusinessModes.length)
    lines.splice(
      14,
      0,
      "",
      `**Business-task limitation:** ${incompleteBusinessModes.map((mode) => labels[mode]).join(" and ")} retrieved no Qlik app list. The retrieval-coverage table below distinguishes unavailable results from completed work. These counter sums do not establish equivalent end-to-end savings.`,
      "",
    );
  for (const mode of modes)
    if (summaries[mode]) {
      const s = summaries[mode],
        u = s.reportedUsage;
      lines.push(
        `| ${labels[mode]} | ${s.outcome} | ${display(u.input)} | ${display(u.output)} | ${display(u.input + u.output)} | ${u.attempts} | ${u.missingInput} / ${u.missingOutput} | ${u.non200} | ${u.zeroToolOutputAnomalies} |`,
      );
    }
  const directUsage = summaries.direct?.reportedUsage,
    adaptiveUsage = summaries.adaptive?.reportedUsage;
  if (
    correctnessGate?.performanceClaimsAllowed === true &&
    allCompleted &&
    directUsage &&
    adaptiveUsage &&
    !directUsage.missingInput &&
    !adaptiveUsage.missingInput
  )
    lines.push(
      "",
      `Adaptive's reported input counter sum changed by **${(100 * (adaptiveUsage.input / directUsage.input - 1)).toFixed(1)}%** versus direct. This comparison must be read alongside the app-explanation tool coverage and full replies; fewer tokens alone do not establish equivalent task completion.`,
    );
  else
    lines.push(
      "",
      correctnessGate
        ? `Correctness gate: **${correctnessGate.status}**. Equivalent-work performance claims are withheld. [Full gate evidence](CORRECTNESS_GATE.md).`
        : "Equivalent-work performance claims are withheld until the offline correctness/parity gate succeeds. Counter sums and payload sizes remain observable measurements.",
    );
  lines.push(
    "",
    "## Every model request: input levels",
    "",
    "The sizes below are captured system text and compact JSON Unicode characters / UTF-8 bytes. They are not model token counts. The complete request-body size includes JSON serialization that is not a billable-token attribution.",
    "",
    "| Mode | Call | Turn | Reported input / output | Native / MCP schemas | System text chars / bytes | Schema JSON chars / bytes | History JSON chars / bytes | Request body bytes |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const call of callLedger) {
    const level = call.inputLevels,
      pair = (value: Json) =>
        `${display(value.chars)} / ${display(value.bytes)}`;
    lines.push(
      `| ${labels[call.mode]} | ${call.call} | ${call.turn} | ${display(number(call.reportedUsage?.input_tokens))} / ${display(number(call.reportedUsage?.output_tokens))} | ${level.nativeSchemas} / ${level.mcpSchemas} | ${pair(level.systemText)} | ${pair(level.schemasJson)} | ${pair(level.historyJson)} | ${display(level.completeBodyBytes)} |`,
    );
  }
  lines.push(
    "",
    "## Output text and tool-argument payloads",
    "",
    "These are generated content sizes reconstructed from the complete raw provider SSE. They are not exact output-token allocations. Tool argument JSON may be emitted even when the upstream reports zero output tokens; the raw events remain authoritative.",
    "",
    "| Mode | Call | Reported output tokens | Assistant text chars / bytes | Tool argument JSON chars / bytes | Thinking chars / bytes |",
    "|---|---:|---:|---:|---|---:|",
  );
  for (const call of callLedger) {
    const out = call.outputLevels;
    lines.push(
      `| ${labels[call.mode]} | ${call.call} | ${display(number(call.reportedUsage?.output_tokens))} | ${out.assistantText.chars} / ${out.assistantText.bytes} | ${cell(out.toolArgumentJson.map((arg: Json) => `${arg.name}: ${arg.chars} / ${arg.bytes}`).join("; ") || "none")} | ${out.thinkingText.chars} / ${out.thinkingText.bytes} |`,
    );
  }
  lines.push(
    "",
    "## Native versus MCP schema burden",
    "",
    "These are complete compact JSON schema-array bytes on each actual provider request, including descriptions and parameters. They expose repeated schema size without claiming exact schema token charges. Original and sent counts refer to the captured Responses boundary; native/MCP bytes refer to the translated provider boundary.",
    "",
    "| Mode | Call | Original / sent definitions | Native schema count / bytes | MCP schema count / bytes |",
    "|---|---:|---:|---:|---:|",
  );
  for (const call of callLedger)
    lines.push(
      `| ${labels[call.mode]} | ${call.call} | ${call.schemasBefore} / ${call.schemasSent} | ${call.inputLevels.nativeSchemas} / ${display(call.inputLevels.nativeSchemaJsonBytes)} | ${call.inputLevels.mcpSchemas} / ${display(call.inputLevels.mcpSchemaJsonBytes)} |`,
    );
  lines.push(
    "",
    "## History block categories",
    "",
    "Categories measure compact JSON bytes of each actual history content block. Message wrapper bytes contain role/content framing and array/object separators. User text here includes every retained user message, not just the current question.",
    "",
    "| Mode | Call | Turn | User text | Assistant text | Tool calls | Tool results | Thinking / other | Message wrappers | History total |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const call of callLedger) {
    const h = call.inputLevels.historyBlockJsonBytes;
    lines.push(
      `| ${labels[call.mode]} | ${call.call} | ${call.turn} | ${display(h.userText)} | ${display(h.assistantText)} | ${display(h.toolCalls)} | ${display(h.toolResults)} | ${display(h.thinking)} / ${display(h.otherBlocks)} | ${display(h.messageWrappers)} | ${display(h.totalHistoryBytes)} |`,
    );
  }
  lines.push(
    "",
    "## Execution, projection and permission evidence",
    "",
    "| Mode | Turn | Completed tool calls | Gateway source / returned bytes | Projection fidelity | Approval events |",
    "|---|---:|---|---|---|---:|",
  );
  for (const mode of modes)
    for (const bundle of turnBundles[mode] || [])
      lines.push(
        `| ${labels[mode]} | ${bundle.turn} | ${cell(bundle.fullCompletedToolItems.map((item: Json) => `${item.server}/${item.tool} (${item.status})`).join(", ") || "none")} | ${bundle.projections.map((p: Json) => `${display(number(p.inputBytes))} / ${display(number(p.outputBytes))}`).join("; ") || "no gateway projection event"} | ${bundle.projections.map((p: Json) => (p.selectedValuesPreserved === undefined ? "not JSON-verifiable" : String(p.selectedValuesPreserved))).join("; ") || "not applicable"} | ${bundle.approvalEvents.length} |`,
      );
  lines.push(
    "",
    "## Answer quality and retrieval coverage",
    "",
    "A completed assistant turn can still fail the requested business task. An MCP timeout is different from a provider HTTP failure: the error may enter a successful, billed model continuation. The table reports what was actually retrieved, rather than treating unavailable data as an empty result.",
    "",
    "| Mode | Turn | Elapsed seconds | Successful Qlik data / evidence | Failed operations | Task limits |",
    "|---|---:|---:|---|---|---|",
  );
  for (const mode of modes) {
    for (const bundle of turnBundles[mode] || []) {
      const evidence = bundle.answerEvidence;
      const appFacts = evidence.appResults
        .map(
          (result: Json) =>
            `${result.returnedRows} app rows; pagination total ${result.pagination?.total_found ?? "unknown"}`,
        )
        .join("; ");
      const successful = [
        appFacts,
        evidence.detailsRetrieved ? "app details retrieved" : "",
        evidence.scriptRetrieved ? "script retrieved" : "",
        evidence.sheetsRetrieved ? "sheets retrieved" : "",
        evidence.lineageRetrieved ? "lineage retrieved" : "",
      ]
        .filter(Boolean)
        .join("; ");
      let limitation =
        bundle.turn === 3
          ? appFacts
            ? "First page only; full catalog not enumerated"
            : "No app list retrieved"
          : bundle.turn === 5
            ? evidence.detailsRetrieved
              ? "Metadata only; missing technical evidence is listed separately"
              : appFacts
                ? "Listing evidence only; no detailed app/script/lineage evidence"
                : "App explanation unavailable"
            : "General answer; no Qlik lookup required";
      if (bundle.status === "not run") limitation = "not run";
      lines.push(
        `| ${labels[mode]} | ${bundle.turn} | ${number(bundle.durationMs) === undefined ? "unknown" : (bundle.durationMs / 1000).toFixed(1)} | ${cell(successful || "none")} | ${cell(evidence.failedTools.map((item: Json) => item.tool).join(", ") || "none")} | ${cell(limitation)} |`,
      );
    }
  }
  const directApp = turnBundles.direct?.[4]?.answerEvidence;
  if (
    directApp?.replyClaimsScriptTimedOutTwice &&
    directApp.scriptInvocationCount === 1
  )
    lines.push(
      "",
      "Direct turn 5 says the script call timed out twice, but the trace contains one `get_app_script` invocation.",
    );
  if (directApp?.replyClaimsNoSheets && !directApp.sheetsRetrieved)
    lines.push(
      "",
      'Direct labels "no sheets available" as confirmed even though the sheet read did not succeed; a timeout does not establish that an app has no sheets.',
    );
  if (directApp?.savedInProductVersion)
    lines.push(
      "",
      "The captured version field is the app's `qSavedInProductVersion`, not an independently verified current server version. Interpret naming-based purpose descriptions as inferences unless the returned description, script or lineage supports them.",
    );
  const hydrationFailure = summaries.adaptive?.startupGatewayEvents.find(
    (event: Json) =>
      event.type === "unavailable" && event.phase === "hydration",
  );
  const hydratedRegistry = summaries.adaptive?.startupGatewayEvents.find(
    (event: Json) => event.type === "registry",
  );
  if (hydrationFailure)
    lines.push(
      "",
      `Adaptive registry initialization reported \"${cell(hydrationFailure.message)}\" before turn 1; its registry event reports ${hydratedRegistry?.tools ?? "unknown"} tools${number(hydratedRegistry?.durationMs) === undefined ? "" : ` after ${(hydratedRegistry.durationMs / 1000).toFixed(1)} seconds`}. Its Qlik turns therefore exercised unavailable-catalog discovery fallback. This run does not measure the healthy catalog's app-specific direct routing or projection. [Full startup evidence](turns/adaptive-bootstrap.json).`,
    );
  const firstDirectCall = callLedger.find(
    (call: Json) => call.mode === "direct",
  );
  if (firstDirectCall) {
    const native = firstDirectCall.inputLevels.nativeSchemaJsonBytes;
    const mcp = firstDirectCall.inputLevels.mcpSchemaJsonBytes;
    const system = firstDirectCall.inputLevels.systemText.bytes;
    const afterList = callLedger.find(
      (call: Json) => call.mode === "direct" && call.turn === 4,
    );
    const appSource =
      turnBundles.direct?.[2]?.answerEvidence.appResultPayloadSizes?.[0];
    lines.push(
      "",
      `Direct's first request carries **${display(native)} native schema bytes** and **${display(mcp)} Qlik schema bytes**; native definitions comprise **${((100 * native) / (native + mcp)).toFixed(1)}%** of the sum of those separate compact arrays. The **${display(system)}-byte system text** is repeated on model requests. Native schema selection therefore addresses a larger observed schema component than Qlik catalog pruning alone; system instructions remain a material fixed input cost. These byte shares are not token shares.`,
    );
    if (afterList)
      lines.push(
        "",
        `Direct turn 4 sends **${display(afterList.inputLevels.historyJson.bytes)} history JSON bytes** after the app listing, although its new user question is only ${size(messages[3]).bytes} bytes. Retained business results and answers continue consuming input on subsequent unrelated questions.`,
      );
    if (appSource)
      lines.push(
        "",
        `The direct app-list runtime text block is **${display(appSource.textBlocks[0]?.bytes)} bytes**; its complete runtime result JSON is **${display(appSource.fullRuntimeResultJsonBytes)} bytes**. The provider request adds Codex output text and tool-result framing, measured separately in the history ledger. ${["omni", "adaptive"].some((mode) => (turnBundles[mode] || []).some((bundle) => bundle.projections.length)) ? "Actual gateway projection measurements and preservation checks appear in the execution table." : "This run has **no successful gateway invocation/projection event** in Omni or adaptive, so no measured projection savings or fidelity claim can be made."}`,
      );
  }
  lines.push(
    "",
    "Before evaluating end-to-end savings, repeat under healthy connector initialization with comparable Qlik evidence. Separately, preflight analysis identified that an app explanation needs an appropriate app-detail/script/lineage/sheet tool set, rather than a listing-only route; the unavailable adaptive catalog in this run does not test that healthy-route limitation. Review authorization and projection for the broader intent before expanding exposure. [Read-only connector health evidence](catalog-health.json) · [Validation evidence](validation.json).",
  );
  lines.push(
    "",
    "## What the logs establish",
    "",
    "- Direct mode carries the native and attached connector schemas on ordinary questions; adaptive selection keeps only relevant definitions plus mandatory runtime controls. Exact counts appear above.",
    "- Omni discovery adds model round trips when schemas must be discovered. Count every discovery, invocation and answer request, rather than comparing only the greeting.",
    "- Turn 4 follows the Qlik listing attempt. Its request retains the earlier answer and any returned results or errors. In a successful listing mode, the business data continues to consume input on the unrelated capital question.",
    "- Turn 5 is an app explanation rather than another listing. Inspect the actual tools and raw data before treating any token reduction as an equivalent explanation. The current adaptive router's selected set is recorded verbatim; this report does not invent missing app-script or app-detail evidence.",
    "- Projection fidelity checks compare every selected parsed JSON value with the actual source. Full-result selections can correctly preserve values while saving no bytes.",
    "- Approvals include the harness's existing authorization for read-only Qlik operations and any captured turn-5 plan confirmation. No permission answer is silently omitted from the turn bundles.",
    "- Routing traces with `authorizationRemoved: [REDACTED]` do not reveal the number of rejected tools; the redactor masks that metadata key. Its value is not assumed to be an empty list.",
    "",
    "## Timing and routing",
    "",
    "HTTP response headers are recorded separately from the first provider body byte, text delta and tool block. A tool-only call may emit no text token. Single sequential runs do not establish a stable latency improvement.",
    "",
    "| Turn | Direct elapsed seconds | Omni required elapsed seconds | Adaptive elapsed seconds |",
    "|---|---:|---:|---:|",
  );
  for (let index = 1; index <= 5; index++)
    lines.push(
      `| ${index} | ${modes.map((mode) => (number(turnBundles[mode]?.[index - 1]?.durationMs) === undefined ? "unknown" : (turnBundles[mode][index - 1].durationMs / 1000).toFixed(1))).join(" | ")} |`,
    );
  lines.push(
    `| **Five-turn elapsed sum** | ${modes.map((mode) => (turnBundles[mode] ? (turnBundles[mode].reduce((sum, turn) => sum + (number(turn.durationMs) || 0), 0) / 1000).toFixed(1) : "unknown")).join(" | ")} |`,
    "",
    "The elapsed sum excludes startup. Startup spans include database reads, relay/runtime setup and connector hydration; it is separate from model first-token latency.",
    "",
    "| Mode | Harness creation to first user turn seconds | Registry hydration seconds | Registry tools | Hydration status |",
    "|---|---:|---:|---:|---|",
  );
  for (const mode of modes) {
    if (!captures[mode]) continue;
    const startupMs =
      Date.parse(captures[mode].turns?.[0]?.startedAt) -
      Date.parse(captures[mode].createdAt);
    const registry = summaries[mode].startupGatewayEvents.find(
      (event: Json) => event.type === "registry",
    );
    const error = summaries[mode].startupGatewayEvents.find(
      (event: Json) =>
        event.type === "unavailable" && event.phase === "hydration",
    );
    lines.push(
      `| ${labels[mode]} | ${Number.isFinite(startupMs) ? (startupMs / 1000).toFixed(1) : "unknown"} | ${number(registry?.durationMs) === undefined ? "not recorded" : (registry.durationMs / 1000).toFixed(1)} | ${registry?.tools ?? "not recorded"} | ${cell(error?.message || (registry ? "available" : "no registry event"))} |`,
    );
  }
  lines.push(
    "",
    "| Mode | Call | Turn | First body byte ms | First text delta ms | First tool block ms | Full stream ms |",
    "|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const call of callLedger) {
    const time = (key: string) =>
      number(call.timing[key]) === undefined
        ? "not emitted"
        : String(Math.round(call.timing[key]));
    lines.push(
      `| ${labels[call.mode]} | ${call.call} | ${call.turn} | ${time("firstBodyByteMs")} | ${time("firstTextDeltaMs")} | ${time("firstToolBlockMs")} | ${time("streamDurationMs")} |`,
    );
  }
  lines.push(
    "",
    "## Full messages, assistant outputs and tool arguments",
    "",
    "Assistant text is reproduced verbatim without truncation. A turn's JSON bundle contains all original and transformed model inputs, provider SSE outputs, reconstructed assistant content, runtime events, approvals and complete tool results. Runtime placeholder text, if present, is retained rather than silently removed.",
  );
  for (let index = 1; index <= 5; index++) {
    lines.push("", `### Turn ${index}: ${messages[index - 1]}`, "");
    for (const mode of modes) {
      const bundle = turnBundles[mode]?.[index - 1];
      if (!bundle) {
        lines.push(`**${labels[mode]}:** not run.`, "");
        continue;
      }
      lines.push(
        `**${labels[mode]}** — status ${bundle.status}; ${usageCell(
          (captures[mode].providerCalls || []).filter(
            (call: Json) => call.turn === index,
          ),
          { status: bundle.status },
        )}. [Complete turn JSON](turns/${mode}-turn-${index}.json).`,
        "",
        "<details>",
        `<summary>Full ${labels[mode]} assistant output and tool arguments</summary>`,
        "",
        fence(bundle.fullAssistantOutput || "No assistant output captured."),
        "",
        "Tool arguments and execution status (full results are in the turn JSON):",
        "",
        fence(
          JSON.stringify(
            bundle.fullCompletedToolItems.map((item: Json) => ({
              id: item.id,
              server: item.server,
              tool: item.tool,
              arguments: item.arguments,
              status: item.status,
              durationMs: item.durationMs,
              error: item.error,
            })),
            null,
            2,
          ),
          "json",
        ),
        "",
        "</details>",
        "",
      );
    }
  }
  lines.push(
    "## Raw payloads at every boundary",
    "",
    "| Mode | Full capture | Into Codex JSON-RPC | Original Codex Responses requests | Actual Responses requests sent | Anthropic provider requests | Bootstrap |",
    "|---|---|---|---|---|---|---|",
  );
  for (const mode of modes)
    if (captures[mode])
      lines.push(
        `| ${labels[mode]} | [JSON](${mode}/${mode}-capture.json) | [JSONL](${mode}/${mode}-codex-input.jsonl) | [JSONL](${mode}/${mode}-responses-requests.jsonl) | [JSONL](${mode}/${mode}-actual-responses-requests.jsonl) | [JSONL](${mode}/${mode}-provider-requests.jsonl) | [JSON](turns/${mode}-bootstrap.json) |`,
      );
  lines.push(
    "",
    "The new-message `turn/start` payload into Codex and the full-history request generated by Codex are different boundaries. Adaptive model filtering happens between that raw request and the actual model gateway request. Both are captured; provider translation is a third captured boundary. Credentials and connector HTTP headers are redacted in the source captures. Diagnostic copies of full source results are not secretly appended to projected model history.",
    "",
    "[Machine-readable comparison and verification](comparison.json) · [All request-level categories](call-ledger.json).",
    "",
    "## Run conditions and reproducibility",
    "",
    "This offline reporter reads only the sanitized capture files and performs no model, MCP or database call. The live harness used the supplied model/MCP profiles, explicit scenario attachment and temporary runtime storage, without database writes or changes to Codex. Implementation/version context belongs to the captured configuration, routing traces and companion validation; the reporter changes no runtime behavior.",
    "",
    fence(
      "platform/node_modules/.bin/tsx platform/scripts/report-five-message-mcp-v2.ts\n# Use --dir PATH for another capture directory; --allow-incomplete creates a labeled progress report.",
      "sh",
    ),
    "",
    "Actual run conditions, request failures, raw usage fields and per-turn runtime reconciliation are retained in comparison.json and the source captures. This report does not replace absent upstream cache/reasoning counters with runtime zeros, claim zero-cost failed attempts, or independently certify output billing.",
    "",
  );
  await writeFile(join(directory, "comparison.md"), lines.join("\n"));
  console.log(
    JSON.stringify({
      report: join(directory, "comparison.md"),
      allCompleted,
      modes: Object.fromEntries(
        Object.entries(summaries).map(([mode, summary]) => [
          mode,
          { outcome: summary.outcome, ...summary.reportedUsage },
        ]),
      ),
    }),
  );
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});

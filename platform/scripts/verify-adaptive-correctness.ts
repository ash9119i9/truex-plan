/** Offline correctness gate. Reads sanitized captures only; never connects to any service. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type Json = any;
type Check = {
  name: string;
  status: "pass" | "fail" | "blocked";
  detail: string;
};
const exactMessages = [
  "hi this is ashok ?",
  "What is the capital of India ?",
  "what are the Qlik apps ?",
  "What is the capital of tamilnadu ?",
  "Explain this qlik app T_DCF_BANKREC_P",
];
const modes = ["direct", "omni", "adaptive"] as const;
const root = resolve(__dirname, "../..");
const { values } = parseArgs({
  options: {
    dir: {
      type: "string",
      default: join(root, "docs/adaptive-correctness-fix/live"),
    },
  },
});
const directory = resolve(values.dir!);
const checks: Check[] = [];
const compact = (value: Json) => JSON.stringify(value);
const equal = (a: Json, b: Json) => compact(a) === compact(b);
const numeric = (value: Json) =>
  typeof value === "number" && Number.isFinite(value);
const textCell = (value: Json) =>
  String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const add = (name: string, valid: boolean, detail: string, blocked = false) =>
  checks.push({
    name,
    status: valid ? "pass" : blocked ? "blocked" : "fail",
    detail,
  });
const readNames = new Set([
  "get_apps",
  "get_app_details",
  "get_app_script",
  "get_app_sheets",
  "get_app_sheet_objects",
  "get_app_object",
  "get_app_variables",
  "get_app_field",
  "get_app_field_statistics",
  "get_connections",
  "get_lineage",
  "get_upstream_lineage",
  "get_qvd_app_id",
  "engine_get_visualization_data",
]);
const discoveryNames = new Set([
  "discover_server",
  "discover_tools",
  "get_tool_schema",
]);

function dataFromResult(result: Json): Json | undefined {
  if (result?.structuredContent != null) return result.structuredContent;
  const content = result?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text"
  )
    return;
  try {
    return JSON.parse(content[0].text);
  } catch {
    return;
  }
}
function dataFromProviderResult(block: Json): Json | undefined {
  if (block.type !== "tool_result") return;
  if (typeof block.content !== "string")
    return dataFromResult({ content: block.content });
  const text = block.content;
  try {
    return JSON.parse(text);
  } catch {
    /* Codex wraps MCP text in an output envelope. */
  }
  const marker = text.indexOf("Output:\n");
  if (marker < 0) return;
  try {
    const value = JSON.parse(text.slice(marker + "Output:\n".length));
    return Array.isArray(value) ? dataFromResult({ content: value }) : value;
  } catch {
    return;
  }
}
function logicalTool(capture: Json, item: Json) {
  if (item.tool === "invoke_tool")
    return {
      server: item.arguments?.server,
      tool: item.arguments?.tool,
      args: item.arguments?.args || {},
    };
  const descriptor = (capture.adaptiveRegistry || []).find(
    (tool: Json) => tool.bindingName === item.tool,
  );
  if (descriptor)
    return {
      server: descriptor.serverId,
      tool: descriptor.toolName,
      args: item.arguments || {},
    };
  if (item.server === "adaptive" && String(item.tool).startsWith("qlik__"))
    return {
      server: "qlik",
      tool: item.tool.slice("qlik__".length),
      args: item.arguments || {},
    };
  return { server: item.server, tool: item.tool, args: item.arguments || {} };
}
function operations(capture: Json, turn: number) {
  const record = (capture.turns || []).find(
    (entry: Json) => entry.index === turn,
  );
  return (record?.toolItems || []).map((item: Json) => ({
    ...logicalTool(capture, item),
    id: item.id,
    status: item.status,
    data: dataFromResult(item.result),
    resultIsError: item.result?.isError === true,
    error: item.error,
    durationMs: item.durationMs,
    rawResult: item.result,
  }));
}
function successful(op: Json) {
  return op.status === "completed" && !op.resultIsError && !op.data?.error;
}
function modelSawResult(capture: Json, turn: number, id: string) {
  return (capture.providerCalls || [])
    .filter((call: Json) => call.turn === turn)
    .some((call: Json) =>
      (call.body?.messages || []).some(
        (message: Json) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block: Json) =>
              block.type === "tool_result" &&
              block.tool_use_id === id &&
              (typeof block.content === "string"
                ? block.content.trim().length > 0
                : block.content?.length > 0),
          ),
      ),
    );
}
function appRows(data: Json) {
  if (!Array.isArray(data?.apps)) return;
  return data.apps.map((app: Json) => ({
    name: app.name,
    guid: app.guid,
    stream: typeof app.stream === "string" ? app.stream : app.stream?.name,
  }));
}
function rowKey(row: Json) {
  return compact([row.name, row.guid, row.stream]);
}
function rowsEqual(a: Json[], b: Json[]) {
  return equal(a.map(rowKey).sort(), b.map(rowKey).sort());
}
function modelResults(capture: Json, turn: number) {
  return (capture.providerCalls || [])
    .filter((call: Json) => call.turn === turn)
    .flatMap((call: Json) =>
      (call.body?.messages || []).flatMap((message: Json) =>
        (Array.isArray(message.content) ? message.content : [])
          .map(dataFromProviderResult)
          .filter((data: Json) => data !== undefined),
      ),
    );
}
function usage(calls: Json[]) {
  let input = 0,
    output = 0,
    unknownInput = 0,
    unknownOutput = 0,
    zeroToolOutputAnomalies = 0;
  for (const call of calls) {
    if (numeric(call.usage?.input_tokens)) input += call.usage.input_tokens;
    else unknownInput++;
    if (numeric(call.usage?.output_tokens)) output += call.usage.output_tokens;
    else unknownOutput++;
    if (
      call.usage?.output_tokens === 0 &&
      (call.events || []).some(
        (event: Json) => event.content_block?.type === "tool_use",
      )
    )
      zeroToolOutputAnomalies++;
  }
  return {
    input,
    output,
    calls: calls.length,
    unknownInput,
    unknownOutput,
    zeroToolOutputAnomalies,
  };
}
function listing(capture: Json) {
  const op = operations(capture, 3).find(
    (entry: Json) =>
      entry.server === "qlik" &&
      entry.tool === "get_apps" &&
      successful(entry) &&
      appRows(entry.data)?.length,
  );
  if (!op) return;
  const rows = appRows(op.data)!;
  const actualModelData = modelResults(capture, 3).find(
    (data: Json) => appRows(data) && rowsEqual(appRows(data)!, rows),
  );
  return {
    rows,
    pagination: op.data.pagination,
    args: op.args,
    actualModelInputContainsRows: !!actualModelData,
    modelPagination: actualModelData?.pagination,
  };
}
function explanation(capture: Json) {
  const ops = operations(capture, 5);
  const lookups = ops.filter(
    (op: Json) =>
      op.server === "qlik" && op.tool === "get_apps" && successful(op),
  );
  const matchedApps = lookups
    .flatMap((op: Json) => appRows(op.data) || [])
    .filter((row: Json) => row.name?.toLowerCase() === "t_dcf_bankrec_p");
  const details = ops.filter(
    (op: Json) =>
      op.server === "qlik" &&
      op.tool === "get_app_details" &&
      successful(op) &&
      op.data,
  );
  const detailsRecords = details.map((op: Json) => ({
    requestedGuid: op.args.app_id,
    returnedGuid:
      op.data.metainfo?.app_id ||
      op.data.appLayout?.qLayout?.qFileName ||
      op.data.guid,
    returnedName:
      op.data.metainfo?.name ||
      op.data.appLayout?.qLayout?.qTitle ||
      op.data.name,
    stream:
      op.data.metainfo?.stream || op.data.appLayout?.qLayout?.stream?.name,
    sourceKeys: Object.keys(op.data),
    savedInProductVersion: op.data.appProperties?.qProp?.qSavedInProductVersion,
  }));
  const technical = ["get_app_script", "get_lineage", "get_app_sheets"].map(
    (tool) => {
      const attempts = ops.filter(
        (op: Json) => op.server === "qlik" && op.tool === tool,
      );
      const retrieved = attempts.some(
        (op: Json) =>
          successful(op) &&
          (op.data !== undefined ||
            (op.rawResult?.content || []).some(
              (block: Json) => block.type === "text" && block.text?.trim(),
            )) &&
          modelSawResult(capture, 5, op.id),
      );
      return {
        tool,
        attempts: attempts.length,
        successful: retrieved,
        failed: attempts.filter((op: Json) => !successful(op)).length,
        observedStatuses: attempts.map((op: Json) => op.status),
        guidArguments: attempts.map((op: Json) => op.args.app_id),
        verification: retrieved ? "retrieved" : "unverified",
      };
    },
  );
  const reply =
    (capture.turns || []).find((turn: Json) => turn.index === 5)?.reply || "";
  const scriptAttempts = technical.find(
    (tool) => tool.tool === "get_app_script",
  )!.attempts;
  const sheetsRetrieved = technical.find(
    (tool) => tool.tool === "get_app_sheets",
  )!.successful;
  const sourceGuidsMatch =
    detailsRecords.length > 0 &&
    detailsRecords.every(
      (record: Json) =>
        record.returnedGuid &&
        (!record.requestedGuid ||
          record.requestedGuid === record.returnedGuid) &&
        record.returnedName?.toLowerCase() === "t_dcf_bankrec_p" &&
        matchedApps.some((app: Json) => app.guid === record.returnedGuid),
    );
  const falseTwiceClaim =
    /get_app_script.*timed out twice/i.test(reply) && scriptAttempts !== 2;
  const falseEmptySheetsClaim =
    /no sheets available/i.test(reply) && !sheetsRetrieved;
  const modelDetailsVisible = modelResults(capture, 5).some((data: Json) =>
    detailsRecords.some(
      (record: Json) =>
        (data.metainfo?.app_id ||
          data.appLayout?.qLayout?.qFileName ||
          data.guid) === record.returnedGuid,
    ),
  );
  return {
    matchedApps,
    detailsRecords,
    sourceGuidsMatch,
    modelDetailsVisible,
    technicalGuidsMatch: technical.every((tool) =>
      tool.guidArguments.every((guid: string) =>
        detailsRecords.some((record: Json) => record.returnedGuid === guid),
      ),
    ),
    technical,
    falseTwiceClaim,
    falseEmptySheetsClaim,
    reply,
    fullTechnicalEvidence: technical.every((tool) => tool.successful),
  };
}
function authorizedRead(turn: number, server: Json, tool: Json) {
  return (
    server === "qlik" &&
    ((turn === 3 && tool === "get_apps") || (turn === 5 && readNames.has(tool)))
  );
}
function approvalsSafe(capture: Json) {
  return (capture.approvalEvents || []).every((event: Json) => {
    if (event.kind === "plan")
      return event.turn === 5 && event.answer === "Approve";
    if (event.kind !== "tool" || event.answer !== "Allow") return false;
    if (discoveryNames.has(event.tool))
      return (
        [3, 5].includes(event.turn) &&
        ["adaptive", "omni"].includes(event.server)
      );
    const op = logicalTool(capture, {
      server: event.server,
      tool: event.tool,
      arguments: event.args,
    });
    return authorizedRead(event.turn, op.server, op.tool);
  });
}

async function main() {
  const captures: Record<string, Json> = {},
    summary: Record<string, Json> = {};
  for (const mode of modes) {
    try {
      captures[mode] = JSON.parse(
        await readFile(join(directory, mode, `${mode}-capture.json`), "utf8"),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const mode of modes) {
    const capture = captures[mode];
    if (!capture) {
      add(
        `${mode}: capture present`,
        false,
        "No new live capture exists. Local fixtures and historical benchmark files are not a live rerun.",
        true,
      );
      continue;
    }
    const turns = capture.turns || [],
      calls = capture.providerCalls || [];
    const starts = (capture.codexOutgoing || []).filter(
      (event: Json) =>
        event.payload?.method === "turn/start" &&
        event.payload.params?.threadId === capture.threadId,
    );
    const provenance =
      capture.evidenceKind === "live" &&
      capture.correctnessPhase === "adaptive-correctness-fix" &&
      !capture.fixture &&
      !/\b(mock|fixture|synthetic|cached)\b/i.test(capture.scenario || "");
    add(
      `${mode}: live provenance`,
      provenance,
      "Requires this phase's live marker plus actual correlated captures; markers are not cryptographic attestation.",
      !provenance,
    );
    add(
      `${mode}: exact messages`,
      equal(capture.messages, exactMessages) &&
        equal(
          turns.map((turn: Json) => turn.message),
          exactMessages,
        ),
      "All five exact prompts must occur in order.",
    );
    add(
      `${mode}: same thread and raw user payload`,
      starts.length === 5 &&
        starts.every(
          (event: Json, index: number) =>
            event.payload.params.threadId === capture.threadId &&
            (event.payload.params.input || [])
              .filter((part: Json) => part.type === "text")
              .map((part: Json) => part.text)
              .join("") === exactMessages[index],
        ),
      "Five actual root turn/start RPCs, one thread ID, matching user text.",
    );
    const complete =
      capture.outcome === "completed" &&
      turns.length === 5 &&
      turns.every((turn: Json) => turn.status === "completed");
    add(
      `${mode}: completed sequential turns`,
      complete &&
        turns.every(
          (turn: Json, index: number) =>
            !index ||
            Date.parse(turn.startedAt) >=
              Date.parse(turns[index - 1].completedAt),
        ),
      "Every previous turn must finish before the next starts.",
      !complete,
    );
    add(
      `${mode}: specified model`,
      capture.configuration?.model === "claude-sonnet-5" &&
        capture.configuration?.modelProvider ===
          "profile_6ab96fa2077a84a32b05b738" &&
        calls.length > 0 &&
        calls.every((call: Json) => call.body?.model === "claude-sonnet-5"),
      "Same supplied model profile and actual translated provider model.",
      !calls.length,
    );
    add(
      `${mode}: timeout controls`,
      capture.runConditions?.turnTimeoutMs === 600000 &&
        capture.runConditions?.upstreamFirstByteTimeoutMs === 180000 &&
        capture.runConditions?.upstreamIdleTimeoutMs === 180000,
      "Turn=600s and upstream header/body timeout=180s for every mode.",
    );
    add(
      `${mode}: configured permission controls`,
      capture.configuration?.sandbox === "read-only" &&
        capture.configuration?.approvalPolicy === "on-request",
      "Approval/sandbox settings must match the authorized read-only scenario.",
    );
    add(
      `${mode}: approval and operation scope`,
      approvalsSafe(capture) &&
        turns.every((turn: Json) =>
          operations(capture, turn.index).every((op: Json) =>
            discoveryNames.has(op.tool)
              ? [3, 5].includes(turn.index)
              : authorizedRead(turn.index, op.server, op.tool),
          ),
        ),
      "Only authorized Qlik reads, scoped discovery and turn-5 plan approval; no blanket grants.",
    );
    const actual =
      capture.adaptiveResponsesRequests ||
      capture.actualResponsesRequests ||
      [];
    add(
      `${mode}: full boundary correlation`,
      calls.length > 0 &&
        calls.length === (capture.responsesRequests || []).length &&
        calls.length === actual.length &&
        calls.every(
          (call: Json, index: number) =>
            call.responsesIndex === index &&
            call.turn === capture.responsesRequests[index]?.turn &&
            call.turn === actual[index]?.turn,
        ),
      "Original Responses, actual Responses and provider requests correlate one-to-one.",
      !calls.length,
    );
    add(
      `${mode}: complete provider accounting`,
      calls.length > 0 &&
        calls.every(
          (call: Json) =>
            call.status === 200 &&
            numeric(call.usage?.input_tokens) &&
            numeric(call.usage?.output_tokens) &&
            (call.events || []).some(
              (event: Json) => event.type === "message_stop",
            ),
        ),
      "Failed/unknown provider attempts are not assumed free; zero tool-output anomalies remain billing limitations.",
      !calls.length,
    );
    add(
      `${mode}: correct general answers`,
      /new delhi/i.test(
        turns.find((turn: Json) => turn.index === 2)?.reply || "",
      ) &&
        /chennai/i.test(
          turns.find((turn: Json) => turn.index === 4)?.reply || "",
        ),
      "Capital answers must match the expected facts.",
      !complete,
    );
    const appList = listing(capture),
      appExplanation = explanation(capture);
    add(
      `${mode}: actual listing evidence`,
      !!appList &&
        appList.rows.every((row: Json) => row.name && row.guid && row.stream) &&
        appList.actualModelInputContainsRows,
      "Successful live get_apps with name/GUID/stream rows visible in actual provider history.",
      !appList,
    );
    add(
      `${mode}: explanation source identity`,
      appExplanation.sourceGuidsMatch && appExplanation.modelDetailsVisible,
      "Named-app lookup and get_app_details must return the selected matching GUID, visible in actual provider history.",
      !appExplanation.detailsRecords.length,
    );
    add(
      `${mode}: explanation reply claims`,
      !appExplanation.falseTwiceClaim && !appExplanation.falseEmptySheetsClaim,
      "A failed sheet read is unverified, not evidence of zero sheets; script retry counts must match actual calls.",
    );
    add(
      `${mode}: full technical task evidence`,
      appExplanation.fullTechnicalEvidence,
      "Script, lineage and sheets must be successfully retrieved for this strict full-task gate. Metadata-only work is explicitly partial.",
      !appExplanation.fullTechnicalEvidence,
    );
    add(
      `${mode}: technical source identity`,
      appExplanation.technicalGuidsMatch,
      "Every script/lineage/sheet invocation must target one of the named app GUIDs actually returned by details.",
      !appExplanation.detailsRecords.length,
    );
    summary[mode] = {
      outcome: capture.outcome,
      threadId: capture.threadId,
      reportedUsage: usage(calls),
      turnUsage: exactMessages.map((_, index) =>
        usage(calls.filter((call: Json) => call.turn === index + 1)),
      ),
      listing: appList,
      explanation: appExplanation,
      approvalEvents: capture.approvalEvents,
      runConditions: capture.runConditions,
      provenanceEligible: provenance,
    };
  }
  const direct = summary.direct,
    adaptive = summary.adaptive;
  const listingReady = !!direct?.listing && !!adaptive?.listing;
  add(
    "Direct/Adaptive: equal listing page",
    listingReady &&
      rowsEqual(direct.listing.rows, adaptive.listing.rows) &&
      equal(direct.listing.pagination, adaptive.listing.pagination),
    "Compare actual page size/limit/offset/returned/total and every app name/GUID/stream; reload timestamps are not a stable equality key.",
    !listingReady,
  );
  const explainReady =
    !!direct?.explanation.sourceGuidsMatch &&
    !!adaptive?.explanation.sourceGuidsMatch;
  add(
    "Direct/Adaptive: same named-app identities",
    explainReady &&
      rowsEqual(
        direct.explanation.matchedApps,
        adaptive.explanation.matchedApps,
      ) &&
      equal(
        direct.explanation.detailsRecords
          .map((record: Json) => record.returnedGuid)
          .sort(),
        adaptive.explanation.detailsRecords
          .map((record: Json) => record.returnedGuid)
          .sort(),
      ),
    "Preserve duplicate-name alternatives and compare the actual GUID selected for details.",
    !explainReady,
  );
  const loaded = Object.values(captures);
  add(
    "All modes: same pinned runtime",
    loaded.length === 3 &&
      loaded.every(
        (capture) => capture.codexRevision === loaded[0].codexRevision,
      ),
    "Use the same pinned Codex revision; do not modify vendor code.",
    loaded.length < 3,
  );
  if (captures.omni)
    add(
      "Omni: required projection",
      captures.omni.projection === "required",
      "Omni is the required-projection comparison arm.",
    );
  const status = checks.some((check) => check.status === "fail")
    ? "failed"
    : checks.some((check) => check.status === "blocked")
      ? "blocked"
      : "passed";
  const result = {
    generatedAt: new Date().toISOString(),
    sourceDirectory: directory,
    status,
    performanceClaimsAllowed: status === "passed",
    exactMessages,
    checks,
    modes: summary,
    limitations: [
      "Provider counters are not independently verified billing; tool calls with reported output=0 are anomalous.",
      "Exact per-component token attribution is unavailable; request component characters/bytes belong to the companion offline report.",
      "Fixture and historical capture evidence cannot establish a new successful live replay.",
      "This conservative gate requires full technical evidence; metadata-only parity is not complete task success.",
      "Automated checks cover source identity, evidence parity and known false-claim patterns; they do not independently certify every sentence of the assistant's prose.",
    ],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "correctness-verification.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  const lines = [
    "# Live correctness and parity gate",
    "",
    `**Status: ${status}. Performance claims allowed: ${result.performanceClaimsAllowed}.**`,
    "",
    "This verifier performed no model, MCP, database or network call. Missing or unsuccessful live business evidence blocks an equivalent-work optimization claim. Cached descriptors and local fixture results are not counted as a live replay.",
    "",
    "[Read-only endpoint diagnostics and root-cause boundaries](../ROOT_CAUSE.md). The [earlier five-message report and complete raw payloads](../../five-message-mcp-v2/comparison.md) remain historical evidence; their failed connector arms are not a new successful live run.",
    "",
    "| Turn | Exact user message | Direct reported input / output / calls | Omni reported input / output / calls | Adaptive reported input / output / calls |",
    "|---|---|---:|---:|---:|",
  ];
  for (let index = 0; index < 5; index++)
    lines.push(
      `| ${index + 1} | ${textCell(exactMessages[index])} | ${modes.map((mode) => (summary[mode] ? `${summary[mode].turnUsage[index].input} / ${summary[mode].turnUsage[index].output} / ${summary[mode].turnUsage[index].calls}${summary[mode].turnUsage[index].unknownInput || summary[mode].turnUsage[index].unknownOutput ? " + unknown usage" : ""}` : "not run")).join(" | ")} |`,
    );
  lines.push(
    `| **Overall** | All five prompts | ${modes.map((mode) => (summary[mode] ? `${summary[mode].reportedUsage.input} / ${summary[mode].reportedUsage.output} / ${summary[mode].reportedUsage.calls}` : "not run")).join(" | ")} |`,
    "",
    "| Check | Status | Evidence / limit |",
    "|---|---|---|",
  );
  for (const check of checks)
    lines.push(
      `| ${textCell(check.name)} | ${check.status} | ${textCell(check.detail)} |`,
    );
  lines.push(
    "",
    "Every unsuccessful technical read is labeled unverified, including a timeout. A successful general answer or an idle thread does not establish business task completion. If live captures are absent, no input/output cost or speed improvement is measured.",
    "",
    "[Machine-readable verification and actual source identities](correctness-verification.json). When capture files exist, run the companion offline reporter to retain every full model input/output and raw payload:",
    "",
    "```sh",
    "platform/node_modules/.bin/tsx platform/scripts/report-five-message-mcp-v2.ts --dir docs/adaptive-correctness-fix/live",
    "```",
    "",
    "Do not rerun model threads until read-only connector initialization/catalog health is restored. Missing provider usage remains unknown; actual component token charges and output billing cannot be inferred from JSON bytes.",
    "",
  );
  await writeFile(join(directory, "CORRECTNESS_GATE.md"), lines.join("\n"));
  console.log(
    JSON.stringify({
      status,
      performanceClaimsAllowed: result.performanceClaimsAllowed,
      report: join(directory, "CORRECTNESS_GATE.md"),
      captures: Object.keys(captures),
      checks: checks.length,
    }),
  );
  process.exitCode = status === "passed" ? 0 : status === "blocked" ? 2 : 1;
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});

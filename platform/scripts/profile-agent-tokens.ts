/** Operator diagnostic: reuse the platform builder, then observe Codex's Responses wire. */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { resolveRoute } from "../src/model-route";
import {
  documentStore,
  readDocuments,
  safeError,
} from "./token-profiler-documents";
import {
  isToolQuestion,
  parseToolQuestion,
  toolCandidates,
} from "../../agent-core/src/approval-modes";
import { Redactor } from "../../agent-core/src/redact";
import { maskText } from "../../shared/privacy";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Usage = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
};
type Part = {
  label: string;
  chars: number;
  estimatedTokens: number;
  data: unknown;
};
export type Call = {
  index: number;
  parts: Part[];
  usage: Usage | null;
  status?: number;
  error?: string;
  outputParts?: Part[];
  request?: unknown;
  rawRequestJson?: string;
  turnIndex?: number;
  turnId?: string;
  responseEvents?: unknown[];
  responseBody?: unknown;
};
const str = (v: unknown) =>
  typeof v === "string" ? v : (JSON.stringify(v) ?? "");
// Deliberately an estimate, not a model-specific tokenizer or billing count.
export const estimate = (text: string) => Math.ceil(text.length / 4);
const part = (label: string, value: unknown): Part => {
  const text = str(value);
  return {
    label,
    chars: text.length,
    estimatedTokens: estimate(text),
    data: value,
  };
};
export function splitRequest(body: any): Part[] {
  const parts: Part[] = [];
  if (body.instructions)
    parts.push(
      part("Instructions (platform + Codex runtime)", body.instructions),
    );
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : body.input || [];
  for (const item of input) {
    const label =
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
        ? "Tool results"
        : item.type === "function_call" || item.type === "custom_tool_call"
          ? "Tool call arguments/history"
          : item.type === "reasoning"
            ? "Reasoning history"
            : item.role === "user"
              ? "User messages / environment context"
              : item.role === "assistant"
                ? "Assistant message history"
                : item.role === "developer" || item.role === "system"
                  ? `${item.role} instructions`
                  : `Input: ${item.type || "other"}`;
    parts.push(part(label, item));
  }
  for (const tool of body.tools || [])
    parts.push(
      part(`Tool schema: ${tool.name || tool.type || "unknown"}`, tool),
    );
  if (body.previous_response_id)
    parts.push(
      part(
        "Previous response reference (server context not visible)",
        body.previous_response_id,
      ),
    );
  return parts;
}
export function usageOf(u: any): Usage | null {
  if (
    typeof u?.input_tokens !== "number" ||
    typeof u?.output_tokens !== "number"
  )
    return null;
  return {
    input: u.input_tokens,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
    output: u.output_tokens,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
    total: u.total_tokens ?? u.input_tokens + u.output_tokens,
  };
}
export async function captureProxy(
  upstream: string,
  calls: Call[],
  timeoutMs: number,
  port = 0,
) {
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    let call: Call | undefined;
    try {
      // Codex's upstream credentials arrive on this private, ephemeral listener.
      // Headers are never saved; captured payloads are credential-redacted before writing artifacts.
      if (req.method !== "POST" || req.url?.split("?")[0] !== "/responses") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const requestBody = JSON.parse(raw.toString());
      call = {
        request: requestBody,
        responseEvents: [],
        index: calls.length + 1,
        parts: splitRequest(requestBody),
        usage: null,
      };
      calls.push(call);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          [
            "host",
            "content-length",
            "connection",
            "accept-encoding",
            "transfer-encoding",
          ].includes(key)
        )
          continue;
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const response = await fetch(upstream.replace(/\/$/, "") + "/responses", {
        method: "POST",
        headers,
        body: raw,
        signal: controller.signal,
      });
      call.status = response.status;
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      });
      const sse = response.headers
        .get("content-type")
        ?.includes("text/event-stream");
      const decoder = new TextDecoder();
      let pending = "";
      if (response.body)
        for await (const chunk of response.body as any) {
          pending += decoder.decode(chunk, { stream: true });
          if (sse) {
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline).trimEnd();
              pending = pending.slice(newline + 1);
              if (line.startsWith("data:"))
                try {
                  const event = JSON.parse(line.slice(5).trim());
                  call.responseEvents!.push(event);
                  if (event.response) call.responseBody = event.response;
                  const usage = usageOf(event.response?.usage || event.usage);
                  if (
                    event.type === "response.output_item.done" &&
                    event.item
                  ) {
                    const item = event.item;
                    // Capture visible output data; hidden provider reasoning remains unavailable.
                    (call.outputParts ||= []).push(
                      part(
                        item.type === "message"
                          ? "Assistant messages"
                          : item.type === "function_call" ||
                              item.type === "custom_tool_call"
                            ? "Tool call arguments"
                            : `Output: ${item.type}`,
                        item,
                      ),
                    );
                  }
                  if (usage) call.usage = usage; // terminal snapshots replace; never sum duplicate events
                } catch {
                  /* [DONE] and non-JSON SSE frames carry no usage */
                }
            }
          }
          if (!res.write(chunk))
            await once(res, "drain", { signal: controller.signal });
        }
      pending += decoder.decode();
      if (!sse)
        try {
          const body = JSON.parse(pending);
          call.responseBody = body;
          call.usage = usageOf(body.usage);
          call.outputParts = (body.output || []).map((item: any) =>
            part(`Output: ${item.type}`, item),
          );
        } catch {}
      res.end();
    } catch {
      if (call) call.error = "Upstream transport or response parsing failed";
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const listenerPort = (server.address() as any).port;
  return {
    url: `http://127.0.0.1:${listenerPort}`,
    close: async () => {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const cell = (v: unknown) =>
  str(v)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
const table = (headers: string[], rows: unknown[][]) =>
  [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
export function report(data: any): string {
  const calls: Call[] = data.calls;
  const measured = calls.filter((c) => c.usage);
  const sums = measured.reduce<Usage>(
    (s, c) => {
      for (const key of Object.keys(s) as (keyof Usage)[])
        s[key] += c.usage![key];
      return s;
    },
    { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
  );
  const groups = new Map<
    string,
    { chars: number; tokens: number; occurrences: number }
  >();
  for (const call of calls)
    for (const p of call.parts) {
      const g = groups.get(p.label) || { chars: 0, tokens: 0, occurrences: 0 };
      g.chars += p.chars;
      g.tokens += p.estimatedTokens;
      g.occurrences++;
      groups.set(p.label, g);
    }
  const ranked = [...groups].sort((a, b) => b[1].tokens - a[1].tokens);
  const estimatedTotal = ranked.reduce((sum, [, g]) => sum + g.tokens, 0);
  const known = (value: number) => (measured.length ? value : "Unavailable");
  return `# Agent token profile\n\nGenerated: ${data.at}\n\n${table(
    ["Setting", "Value"],
    [
      ["Agent", data.agentId],
      ["Input mode", data.inputMode || "database"],
      ["Last stage", data.stage || "n/a"],
      ["Tenant", data.tenant],
      [
        "Owner (user MCP selection)",
        data.ownerId || "None — tenant connectors only",
      ],
      ["Model", data.model],
      ["Thread", data.threadId || "Not created"],
      ["Turn", data.turnId || "Not started"],
      ["Outcome", data.outcome],
      ["Duration (ms)", data.durationMs],
      [
        "Usage coverage",
        `${measured.length}/${calls.length} captured HTTP attempts`,
      ],
    ],
  )}\n\n## Sequential turns in the same thread\n\n${table(
    [
      "Turn",
      "Question",
      "Outcome",
      "HTTP attempts",
      "Input",
      "Output",
      "Total",
      "Duration ms",
    ],
    (data.turns || []).map((turn: any) => {
      const turnCalls = calls.filter((c) => c.turnIndex === turn.index);
      const usage = turnCalls
        .filter((c) => c.usage)
        .reduce(
          (sum, c) => ({
            input: sum.input + c.usage!.input,
            output: sum.output + c.usage!.output,
            total: sum.total + c.usage!.total,
          }),
          { input: 0, output: 0, total: 0 },
        );
      const observed = turnCalls.some((c) => c.usage);
      return [
        turn.index,
        maskText(turn.userMessage),
        turn.outcome,
        turnCalls.length,
        observed ? usage.input : "n/a",
        observed ? usage.output : "n/a",
        observed ? usage.total : "n/a",
        turn.durationMs,
      ];
    }),
  )}\n\n${(data.turns || []).map((turn: any) => `### Turn ${turn.index}\n\n**User:** ${maskText(turn.userMessage)}\n\n**Agent:** ${maskText(turn.response || "No reply available")}\n`).join("\n")}\n\n## Overall provider-reported usage\n\n${table(
    ["Metric", "Tokens", "Meaning"],
    [
      [
        "Input overall",
        known(sums.input),
        "Sum across measured model calls; repeated context counts again",
      ],
      ["Cached input", known(sums.cached), "Subset of input overall"],
      [
        "Uncached input",
        known(Math.max(0, sums.input - sums.cached)),
        "Input minus cached input",
      ],
      [
        "Output overall",
        known(sums.output),
        "Includes reasoning where the provider reports it",
      ],
      [
        "Reasoning output",
        known(sums.reasoning),
        "Subset of output overall; omitted provider detail defaults to zero",
      ],
      [
        "Other output",
        known(Math.max(0, sums.output - sums.reasoning)),
        "Output minus reasoning; includes reply and tool calls",
      ],
      [
        "Total",
        known(sums.total),
        "Input plus output; cached/reasoning subsets are not added again",
      ],
    ],
  )}\n\nThese are reported counts at the Codex Responses boundary. Missing usage is unavailable, not zero. Partial coverage is a lower bound, not a complete run total. Gateway routes may translate/normalize upstream usage and prompts. Failed/retried attempts can consume tokens without returning usage. No cost estimate is made.\n\n## Model calls and retries\n\n${table(
    [
      "HTTP attempt",
      "Status",
      "Input",
      "Cached",
      "Output",
      "Reasoning",
      "Total",
      "Visible input estimate",
    ],
    calls.map((c) => [
      c.index,
      c.status ?? c.error ?? "pending",
      c.usage?.input ?? "n/a",
      c.usage?.cached ?? "n/a",
      c.usage?.output ?? "n/a",
      c.usage?.reasoning ?? "n/a",
      c.usage?.total ?? "n/a",
      c.parts.reduce((s, p) => s + p.estimatedTokens, 0),
    ]),
  )}\n\n## Input split — ranked optimization targets\n\n${table(
    [
      "Component",
      "Occurrences",
      "Characters",
      "Estimated tokens",
      "% of visible estimate",
    ],
    ranked.map(([label, g]) => [
      label,
      g.occurrences,
      g.chars,
      g.tokens,
      estimatedTotal
        ? ((100 * g.tokens) / estimatedTotal).toFixed(1) + "%"
        : "0%",
    ]),
  )}\n\nSection estimates use ceil(JavaScript string length / 4), including visible JSON wrappers. They are rough size indicators, especially for SAP identifiers, code and non-English text; they are NOT exact tokenizer counts, billing attribution, or a reconciliation to provider totals. Hidden server context, images/audio, framing and gateway-added content cannot be attributed here. The user/context group includes Codex environment messages. Tool schemas are listed separately by name. Skill bodies only count if Codex loads them into a request.\n\n## Visible output split (estimates, not billing counts)\n\n${table(
    ["Attempt", "Component", "Characters", "Estimated tokens"],
    calls.flatMap((c) =>
      (c.outputParts || []).map((p) => [
        c.index,
        p.label,
        p.chars,
        p.estimatedTokens,
      ]),
    ),
  )}\n\nOnly completed wire output items are counted here, including JSON wrappers. Hidden reasoning cannot be measured from text. Use the provider reasoning counter above; do not add visible estimates to reported output totals.\n\n## AgentCore trace cross-check\n\n${table(
    ["Source", "Input", "Cached", "Output", "Reasoning", "Total"],
    [
      [
        "Main turn",
        data.runtimeUsage?.inputTokens ?? "n/a",
        data.runtimeUsage?.cachedInputTokens ?? "n/a",
        data.runtimeUsage?.outputTokens ?? "n/a",
        data.runtimeUsage?.reasoningOutputTokens ?? "n/a",
        data.runtimeUsage?.totalTokens ?? "n/a",
      ],
      [
        "Helper agents",
        data.helperUsage?.inputTokens ?? "n/a",
        data.helperUsage?.cachedInputTokens ?? "n/a",
        data.helperUsage?.outputTokens ?? "n/a",
        data.helperUsage?.reasoningOutputTokens ?? "n/a",
        data.helperUsage?.totalTokens ?? "n/a",
      ],
    ],
  )}\n\nThe proxy observes requests using this provider configuration, including helpers that inherit it. Runtime traces are shown separately and are not added to proxy totals. Other provider overrides and gateway-internal requests are outside capture coverage.\n\n## Platform configuration inventory (before AgentCore enrichment)\n\n${table(
    ["Component", "Characters", "Estimated tokens"],
    (data.inventory || []).map((p: Part) => [
      p.label,
      p.chars,
      p.estimatedTokens,
    ]),
  )}\n\nThis inventory is not added to the wire split: these components may already appear there, or may remain runtime configuration/files rather than model input.\n\n## Where to optimize first\n\n${ranked
    .slice(0, 5)
    .map(
      ([label, g], i) =>
        `${i + 1}. **${cell(label)}**: approximately ${g.tokens} visible tokens across ${g.occurrences} occurrences.`,
    )
    .join(
      "\n",
    )}\n\nCompare the first call with later calls to identify repeated instruction/schema cost and growing tool-result/history cost. Narrow attached connectors and verbose schemas, load skill bodies only when needed, and reduce oversized tool results before shortening the user request. Measure cached input separately: it still occupies context. Reasoning and tool-call output may explain output beyond the visible reply. Re-run the same message after one change to compare measured totals.\n\n## Agent response\n\n${data.response ? maskText(data.response) : "No completed assistant reply was available."}\n\n${
    data.error
      ? `Diagnostic: ${cell(maskText(data.error))}\n\n` +
        table(
          ["Failure detail", "Value"],
          [
            ["Code", data.failure?.code || "n/a"],
            ["HTTP status", data.failure?.status || "n/a"],
            ["Cause", data.failure?.cause || "n/a"],
          ],
        ) +
        "\n\n"
      : ""
  }The companion JSON includes actual request/response payloads, section data, platform configuration, and runtime snapshots. Known credentials are redacted and authorization headers are not saved. Section sizes are measured before redaction; visible payloads may differ in size after redaction. Response text in this Markdown is privacy-masked. The JSON preserves business content for inspection.\n`;
}

export async function runSequentialTurns(
  service: PlatformService,
  data: any,
  messages: string[],
  calls: Call[],
  timeout: number,
  allowedTools: string[] = [],
) {
  const path = `/threads/${encodeURIComponent(data.threadId)}`;
  data.turns = [];
  const addUsage = (previous: any, next: any) => {
    if (!next) return previous;
    const result = { ...(previous || {}), ...next };
    for (const key of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ])
      result[key] = (previous?.[key] || 0) + (next[key] || 0);
    return result;
  };
  for (const [index, text] of messages.entries()) {
    const entry: any = {
      index: index + 1,
      userMessage: text,
      outcome: "failed",
      callIndexes: [],
      startedAt: new Date().toISOString(),
    };
    data.turns.push(entry);
    const firstCall = calls.length;
    const started = Date.now();
    data.terminal = false;
    data.outcome = "failed";
    try {
      console.log(
        `Turn ${entry.index}/${messages.length}: sending message and waiting for completion…`,
      );
      data.stage = "turn-start";
      entry.request = { text, clientId: randomUUID() };
      data.turnRequest = entry.request;
      const accepted = await service.call(
        service.hosts[0],
        path + "/turns",
        "POST",
        entry.request,
      );
      entry.acceptance = accepted;
      data.turnResponse = accepted;
      entry.turnId = accepted.turnId || accepted.turn?.id;
      if (!entry.turnId)
        throw new Error(
          "AgentCore returned no turn ID; cannot safely sequence messages",
        );
      data.turnId = entry.turnId;
      data.stage = "turn-wait";
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const snapshot = await service.call(
          service.hosts[0],
          path + "/snapshot",
        );
        data.runtimeSnapshot = snapshot;
        const trace = snapshot.traces?.find(
          (t: any) => t.turnId === entry.turnId,
        );
        entry.response = (snapshot.messages || [])
          .filter((m: any) => m.turnId === entry.turnId)
          .map((m: any) => m.text || "")
          .join("\n\n");
        data.response = entry.response;
        if (trace) {
          entry.outcome = trace.status;
          entry.trace = trace;
          data.terminal = true;
          data.runtimeUsage = addUsage(data.runtimeUsage, trace.usage);
          data.helperUsage = addUsage(data.helperUsage, trace.helperUsage);
          break;
        }
        if (snapshot.pending?.length) {
          for (const pending of snapshot.pending) {
            const questions = pending.detail?.questions;
            const canAllow =
              pending.method === "item/tool/requestUserInput" &&
              Array.isArray(questions) &&
              questions.length &&
              questions.every((question: any) => {
                const ref = parseToolQuestion(question.question);
                return (
                  isToolQuestion(question) &&
                  question.isSecret !== true &&
                  ref &&
                  toolCandidates(ref).some(
                    (candidate) =>
                      candidate.server &&
                      allowedTools.includes(
                        `${candidate.server}:${candidate.tool}`,
                      ),
                  ) &&
                  question.options?.some(
                    (option: any) => option.label === "Allow",
                  )
                );
              });
            if (!canAllow) {
              entry.outcome = "approval or input required";
              throw new Error(
                "AgentCore is awaiting approval or user input outside --allow-tool. The message sequence has stopped.",
              );
            }
            const result = {
              answers: Object.fromEntries(
                questions.map((question: any) => [
                  question.id,
                  { answers: ["Allow"] },
                ]),
              ),
            };
            await service.call(
              service.hosts[0],
              path + `/approvals/${encodeURIComponent(pending.requestId)}`,
              "POST",
              { result },
            );
            (entry.toolApprovals ||= []).push({
              requestId: pending.requestId,
              questions,
              result,
            });
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!data.terminal)
        throw new Error(
          `No terminal trace arrived before timeout for turn ${entry.index}`,
        );
      if (entry.outcome !== "completed")
        throw new Error(
          `Turn ${entry.index} ended with status ${entry.outcome}; remaining messages were not sent`,
        );
      console.log(`Turn ${entry.index}/${messages.length}: completed.`);
    } catch (error) {
      data.outcome = entry.outcome;
      throw error;
    } finally {
      entry.durationMs = Date.now() - started;
      entry.completedAt = new Date().toISOString();
      for (const call of calls.slice(firstCall)) {
        call.turnIndex = entry.index;
        call.turnId = entry.turnId;
        entry.callIndexes.push(call.index);
      }
    }
  }
  data.outcome = "completed";
}

export async function main() {
  dotenv.config({ path: resolve(root, "platform/.env"), quiet: true });
  const { values: v } = parseArgs({
    options: {
      "agent-id": { type: "string" },
      "agent-file": { type: "string" },
      "model-file": { type: "string" },
      "mcp-file": { type: "string" },
      "skills-file": { type: "string" },
      message: { type: "string", multiple: true },
      "messages-file": { type: "string" },
      "allow-tool": { type: "string", multiple: true },
      "message-file": { type: "string" },
      tenant: { type: "string", default: "default" },
      "owner-id": { type: "string" },
      "core-url": { type: "string" },
      "proxy-url": { type: "string" },
      "proxy-port": { type: "string", default: "0" },
      cwd: { type: "string" },
      out: { type: "string" },
      "timeout-ms": { type: "string", default: "300000" },
      help: { type: "boolean" },
    },
  });
  if (v.help) {
    console.log(
      "npm run profile:tokens -- (--agent-id ID | --agent-file agent.json --model-file model.json [--mcp-file mcps.json] [--skills-file skills.json]) --message 'Hello' [--tenant default] [--owner-id USER] [--core-url http://127.0.0.1:4100] [--proxy-url http://HOST:PORT] [--message-file PATH | --messages-file messages.json] (repeat --message for sequential turns) [--allow-tool SERVER:TOOL] [--out report.md] [--timeout-ms 300000] [--cwd PATH]",
    );
    return;
  }
  const inputModes = [
    !!v.message?.length,
    !!v["message-file"],
    !!v["messages-file"],
  ].filter(Boolean).length;
  if ((!v["agent-id"] && !v["agent-file"]) || inputModes !== 1)
    throw new Error(
      "Supply an agent and exactly one input mode: repeated --message, --message-file, or --messages-file",
    );
  const messages: string[] = v["messages-file"]
    ? JSON.parse(await readFile(resolve(v["messages-file"]), "utf8"))
    : v["message-file"]
      ? [await readFile(resolve(v["message-file"]), "utf8")]
      : v.message!;
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.some(
      (text) => typeof text !== "string" || !text.trim() || text.length > 50000,
    )
  )
    throw new Error(
      "Messages must be a nonempty array of strings, each containing 1–50000 characters",
    );
  const text = messages[0];
  const timeout = Number(v["timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout < 1000)
    throw new Error("timeout-ms must be an integer >= 1000");
  const proxyPort = Number(v["proxy-port"]);
  if (!Number.isInteger(proxyPort) || proxyPort < 0 || proxyPort > 65535)
    throw new Error("Invalid proxy-port");
  const out = resolve(
    v.out || resolve(root, `benchmark-reports/agent-tokens-${Date.now()}.md`),
  );
  if (!!v["agent-file"] !== !!v["model-file"])
    throw new Error(
      "Document mode requires both --agent-file and --model-file",
    );
  if (!v["agent-file"] && (v["mcp-file"] || v["skills-file"]))
    throw new Error("MCP/skill files require document mode");
  const redactor = new Redactor();
  redactor.remember({
    secret: process.env.MODEL_GATEWAY_SECRET,
    api_key: process.env.MCP_ENCRYPTION_KEY,
  });
  let documents: any;
  if (v["agent-file"]) {
    const [agents, models, mcps, skills] = await Promise.all([
      readDocuments(v["agent-file"]),
      readDocuments(v["model-file"]!),
      v["mcp-file"] ? readDocuments(v["mcp-file"]) : [],
      v["skills-file"] ? readDocuments(v["skills-file"]) : [],
    ]);
    if (agents.length !== 1 || models.length !== 1)
      throw new Error("Supply exactly one agent and one model document");
    documents = { agent: agents[0], model: models[0], mcps, skills };
    redactor.remember(documents);
    if (v["agent-id"] && v["agent-id"] !== String(documents.agent._id))
      throw new Error("agent-id must match the supplied agent document");
  }
  const agentId = v["agent-id"] || String(documents.agent._id);
  const store = documents
    ? documentStore(
        documents.agent,
        documents.model,
        documents.mcps,
        documents.skills,
      )
    : new Store();
  const service = new PlatformService(store, [
    v["core-url"] ||
      (
        process.env.AGENT_CORE_URLS ||
        process.env.AGENT_CORE_URL ||
        "http://127.0.0.1:4100"
      ).split(",")[0],
  ]);
  const calls: Call[] = [];
  const data: any = {
    at: new Date().toISOString(),
    agentId,
    inputMode: documents ? "documents" : "database",
    stage: "connect",
    tenant: v.tenant,
    ownerId: v["owner-id"],
    calls,
    userMessage: text,
    messages,
    allowedTools: v["allow-tool"] || [],
    sourceDocuments: documents,
    dataCapture: {
      payloads: "captured",
      credentials: "redacted",
      sectionCounts: "computed before redaction",
      headers: "not stored",
    },
    outcome: "failed",
    inventory: [],
  };
  let proxy: Awaited<ReturnType<typeof captureProxy>> | undefined;
  let gateway: import("node:http").Server | undefined;
  const started = Date.now();
  try {
    await store.connect();
    await store.withTenant(await store.resolveTenant(v.tenant!), async () => {
      data.stage = "configuration";
      const previousGatewayUrl = process.env.MODEL_GATEWAY_URL;
      const previousGatewaySecret = process.env.MODEL_GATEWAY_SECRET;
      let config: any;
      try {
        if (documents && resolveRoute(documents.model).route === "gateway") {
          data.stage = "document-gateway";
          const { createGateway } =
            await import("../../model-gateway/src/server");
          const secret = randomBytes(32).toString("hex");
          redactor.remember({ secret });
          gateway = createGateway({
            secret,
            findProfile: async (id) =>
              id === String(documents.model._id) ? documents.model : null,
          });
          gateway.listen(0, "127.0.0.1");
          await once(gateway, "listening");
          process.env.MODEL_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as any).port}`;
          process.env.MODEL_GATEWAY_SECRET = secret;
        }
        data.stage = "configuration";
        config = await service.configuration(agentId, {
          ownerId: v["owner-id"],
          cwd: v.cwd,
        });
      } finally {
        if (previousGatewayUrl === undefined)
          delete process.env.MODEL_GATEWAY_URL;
        else process.env.MODEL_GATEWAY_URL = previousGatewayUrl;
        if (previousGatewaySecret === undefined)
          delete process.env.MODEL_GATEWAY_SECRET;
        else process.env.MODEL_GATEWAY_SECRET = previousGatewaySecret;
      }
      if (service.approvalModes.enabled)
        Object.assign(config, {
          approvalMode: service.approvalModes.defaultMode,
          approvalNameHeuristic: service.approvalModes.nameHeuristic,
        });
      redactor.remember(config);
      data.platformConfiguration = structuredClone(config);
      data.model = config.model;
      data.inventory = [
        part(
          "Base instructions + connector instructions",
          config.baseInstructions,
        ),
        ...(config.persona ? [part("Persona", config.persona)] : []),
        ...(config.skills || []).map((s: any) =>
          part(`Skill body: ${s.name}`, s.body),
        ),
        part(
          "Attached connector names (configuration only)",
          Object.keys(config.config).filter((k) =>
            k.startsWith("mcp_servers."),
          ),
        ),
      ];
      const provider = config.config[`model_providers.${config.modelProvider}`];
      data.stage = "capture-listener";
      proxy = await captureProxy(provider.base_url, calls, timeout, proxyPort);
      // --proxy-url must route to this listener when AgentCore is in another network namespace.
      provider.base_url = v["proxy-url"] || proxy.url;
      console.log(
        `Capture listener: ${proxy.url}. Building ${data.model} through AgentCore…`,
      );
      data.agentCoreRequest = structuredClone(config);
      data.stage = "thread-create";
      const thread = await service.call(
        service.hosts[0],
        "/threads",
        "POST",
        config,
      );
      data.agentCoreResponse = thread;
      data.threadId = thread.threadId;
      await runSequentialTurns(
        service,
        data,
        messages,
        calls,
        timeout,
        v["allow-tool"],
      );
    });
    if (data.outcome !== "completed") process.exitCode = 1;
  } catch (e) {
    data.failure = safeError(e, redactor);
    data.error = `${data.stage}: ${data.failure.message}`;
    console.error(
      `Token profile failed (${data.stage}): ${data.failure.code || "ERROR"}: ${data.failure.message}`,
    );
    process.exitCode = 1;
  } finally {
    if (data.threadId) {
      const path = `/threads/${encodeURIComponent(data.threadId)}`;
      if (!["completed", "interrupted"].includes(data.outcome))
        await service
          .call(service.hosts[0], path + "/interrupt", "POST", {})
          .catch(() => {});
      // Only the fresh diagnostic thread is removed; no platform chat is created.
      await service.call(service.hosts[0], path, "DELETE").catch(() => {
        data.error = (data.error || "") + " Diagnostic thread cleanup failed.";
      });
    }
    await proxy?.close();
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise<void>((r) => gateway!.close(() => r()));
    }
    await store.client.close();
    data.response = redactor.clean(data.response || "");
    data.durationMs = Date.now() - started;
    await mkdir(dirname(out), { recursive: true });
    const artifactData = redactor.clean(data);
    for (const call of artifactData.calls)
      call.rawRequestJson = JSON.stringify(call.request);
    const sumCalls = (selected: Call[]) => {
      const measured = selected.filter((call) => call.usage);
      const totals = measured.reduce(
        (sum, call) => {
          for (const key of Object.keys(sum) as (keyof Usage)[])
            sum[key] += call.usage![key];
          return sum;
        },
        { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
      );
      return {
        measuredAttempts: measured.length,
        capturedAttempts: selected.length,
        completeCoverage:
          selected.length > 0 && measured.length === selected.length,
        totals: measured.length ? totals : null,
      };
    };
    artifactData.providerUsage = sumCalls(artifactData.calls);
    for (const turn of artifactData.turns || [])
      turn.providerUsage = sumCalls(
        artifactData.calls.filter(
          (call: Call) => call.turnIndex === turn.index,
        ),
      );
    const payloadArtifact = {
      boundaryNotes: {
        agentCore:
          "Actual HTTP bodies submitted to AgentCore; AgentCore enriches configuration before its internal Codex JSON-RPC calls (not captured here).",
        codexProvider:
          "Complete actual Responses request bodies emitted by Codex, before gateway translation if used; credentials redacted. rawRequestJson serializes this redacted body without truncation, not original byte-for-byte transport.",
      },
      threadId: artifactData.threadId,
      threadCreate: artifactData.agentCoreRequest,
      turns: (artifactData.turns || []).map((turn: any) => ({
        index: turn.index,
        turnId: turn.turnId,
        request: turn.request,
        acceptance: turn.acceptance,
      })),
      codexProviderRequests: artifactData.calls.map((call: any) => ({
        attempt: call.index,
        turnIndex: call.turnIndex,
        turnId: call.turnId,
        body: call.request,
        rawRequestJson: call.rawRequestJson,
      })),
    };
    await writeFile(
      out.replace(/\.md$/i, "") + ".payloads.json",
      JSON.stringify(payloadArtifact, null, 2),
      { mode: 0o600 },
    );
    await writeFile(out, report(artifactData), { mode: 0o600 });
    await writeFile(
      out.replace(/\.md$/i, "") + ".json",
      JSON.stringify(
        { ...artifactData, response: maskText(artifactData.response || "") },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`Token report: ${out}`);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      safeError(error, new Redactor()).message + ". Use --help for usage.",
    );
    process.exitCode = 1;
  });

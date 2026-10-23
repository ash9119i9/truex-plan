import { randomUUID } from "node:crypto";
import { UpstreamTimeoutError } from "../upstream";
import type { AdapterContext, GatewayProfile } from "../adapter";
import { ResponsesStream, sendError, sseData, type Usage } from "../responses";
import { customToolAsFunction, ToolNames, systemPrompt } from "../tool-names";
import { isContextError } from "./chat";

// Google Gemini (generativelanguage.googleapis.com, v1beta generateContent).
// Codex resends the whole conversation each turn, so every request is
// translated on its own. Gemini's thought signatures are carried through
// Codex inside reasoning items (see SIGNATURE_PREFIX).

type Part = Record<string, any>;
interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface GeminiRequest {
  body: Record<string, any>;
  tools: ToolNames;
}

// Reasoning items written by this adapter. Codex returns them unchanged, and
// the signatures inside are re-attached to the parts Gemini issued them on.
export const SIGNATURE_PREFIX = "gemini:v1:";

interface SignatureState {
  signatures: Record<string, string>;
  textSignature?: string;
}

export function encodeSignatures(state: SignatureState) {
  return (
    SIGNATURE_PREFIX +
    Buffer.from(JSON.stringify(state), "utf8").toString("base64")
  );
}

export function decodeSignatures(value: unknown): SignatureState | null {
  if (typeof value !== "string" || !value.startsWith(SIGNATURE_PREFIX))
    return null;
  try {
    const state = JSON.parse(
      Buffer.from(value.slice(SIGNATURE_PREFIX.length), "base64").toString(
        "utf8",
      ),
    );
    return state && typeof state === "object"
      ? {
          signatures: state.signatures ?? {},
          textSignature: state.textSignature,
        }
      : null;
  } catch {
    return null;
  }
}

const INTERRUPTED = "No output: the call was interrupted.";
// Ids this adapter invents when Gemini returns a call without one. They are
// never sent back to Gemini, which did not issue them.
const GENERATED_ID = /^call_[0-9a-f]{32}$/;
const newCallId = () => "call_" + randomUUID().replace(/-/g, "");

export function toGeminiRequest(
  input: any,
  profile: Pick<GatewayProfile, "modelName" | "maxOutputTokens" | "thinking">,
): GeminiRequest {
  const tools = new ToolNames();
  const declarations: any[] = [];
  for (const tool of input.tools ?? []) {
    if (tool?.type === "function") declarations.push(declaration(tools, tool));
    else if (tool?.type === "namespace") {
      for (const inner of tool.tools ?? [])
        if (inner?.type === "function")
          declarations.push(declaration(tools, inner, tool.name));
    } else if (tool?.type === "custom" && typeof tool.name === "string")
      declarations.push(
        declaration(tools, customToolAsFunction(tool), undefined, true),
      );
    // web_search and tool_search run only on OpenAI's Responses backend, so
    // they are not offered to the provider.
  }
  const { system, contents } = toContents(input, tools);
  const body: Record<string, any> = { contents };
  if (system.length)
    body.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  if (declarations.length) {
    body.tools = [{ functionDeclarations: declarations }];
    const mode = { auto: "AUTO", none: "NONE", required: "ANY" }[
      String(input.tool_choice) as "auto"
    ];
    if (mode) body.toolConfig = { functionCallingConfig: { mode } };
  }
  const generationConfig: Record<string, any> = {};
  if (profile.maxOutputTokens)
    generationConfig.maxOutputTokens = profile.maxOutputTokens;
  const thinking = thinkingConfig(
    profile.modelName,
    input.reasoning?.effort,
    profile.thinking,
  );
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (Object.keys(generationConfig).length)
    body.generationConfig = generationConfig;
  return { body, tools };
}

function declaration(
  names: ToolNames,
  tool: any,
  namespace?: string,
  custom?: boolean,
) {
  return {
    name: names.toProvider({
      name: tool.name,
      namespace,
      ...(custom ? { custom } : {}),
    }),
    ...(tool.description ? { description: tool.description } : {}),
    // parametersJsonSchema takes standard JSON Schema (additionalProperties
    // included), unlike the OpenAPI-subset `parameters` field.
    parametersJsonSchema: tool.parameters ?? {
      type: "object",
      properties: {},
    },
  };
}

// thinkingLevel is for Gemini 3 and later and errors on older models, which
// take a token budget instead. The two cannot be combined.
const LEVELS: Record<string, string> = {
  minimal: "LOW",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
};
const BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

function thinkingConfig(model: string, effort: unknown, enabled?: boolean) {
  if (enabled === false) return undefined;
  // Only Gemini models take a thinking config; Gemma and tuned models reject it.
  if (enabled !== true && !/gemini/i.test(model)) return undefined;
  const config: Record<string, any> = { includeThoughts: true };
  const key = String(effort ?? "");
  if (/(^|\/)gemini-[12](\.|-|$)/i.test(model)) {
    if (BUDGETS[key]) config.thinkingBudget = BUDGETS[key];
  } else if (LEVELS[key]) config.thinkingLevel = LEVELS[key];
  return config;
}

interface Turn {
  calls: { id: string; name: string }[];
  outputs: Map<string, string>;
}

function toContents(input: any, tools: ToolNames) {
  const system: string[] = systemPrompt(input);
  const contents: Content[] = [];
  const items: any[] = input.input ?? [];
  const signatures = new Map<string, string>();
  for (const item of items) {
    const state =
      item?.type === "reasoning" && decodeSignatures(item.encrypted_content);
    if (state)
      for (const [id, sig] of Object.entries(state.signatures))
        if (typeof sig === "string") signatures.set(id, sig);
  }

  // Gemini rejects a functionResponse without the call before it, and wants
  // every response for one model turn in a single user content.
  let turn: Turn | null = null;
  const flush = () => {
    if (!turn) return;
    contents.push({
      role: "user",
      parts: turn.calls.map((call) => ({
        functionResponse: {
          ...(GENERATED_ID.test(call.id) ? {} : { id: call.id }),
          name: call.name,
          response: { output: turn!.outputs.get(call.id) ?? INTERRUPTED },
        },
      })),
    });
    turn = null;
  };

  for (const item of items) {
    const type = item?.type ?? (item?.role ? "message" : undefined);
    if (type === "message") {
      if (item.role === "developer" || item.role === "system") {
        const text = plainText(item.content);
        if (text) system.push(text);
        continue;
      }
      const parts =
        item.role === "user"
          ? userParts(item.content)
          : plainText(item.content)
            ? [{ text: plainText(item.content) }]
            : [];
      if (!parts.length) continue;
      flush();
      contents.push({ role: item.role === "user" ? "user" : "model", parts });
    } else if (type === "function_call" || type === "custom_tool_call") {
      if (turn && (turn as Turn).outputs.size) flush();
      const name = tools.toProvider({
        name: item.name,
        namespace: item.namespace,
      });
      const part: Part = {
        functionCall: {
          ...(GENERATED_ID.test(item.call_id) ? {} : { id: item.call_id }),
          name,
          args:
            type === "function_call"
              ? parseArgs(item.arguments)
              : { input: item.input ?? "" },
        },
      };
      const sig = signatures.get(item.call_id);
      if (sig) part.thoughtSignature = sig;
      if (!turn) {
        turn = { calls: [], outputs: new Map() };
        contents.push({ role: "model", parts: [] });
      }
      contents.at(-1)!.parts.push(part);
      (turn as Turn).calls.push({ id: item.call_id, name });
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      // Outputs without a pending call (compaction, interrupted turns) are dropped.
      if (turn && (turn as Turn).calls.some((c) => c.id === item.call_id))
        (turn as Turn).outputs.set(item.call_id, outputText(item.output));
    } else if (type === "reasoning") {
      // A text signature belongs to the model text just before this item.
      const sig = decodeSignatures(item.encrypted_content)?.textSignature;
      const last = contents.at(-1);
      if (sig && !turn && last?.role === "model") {
        const text = [...last.parts].reverse().find((p) => "text" in p);
        if (text && !text.thoughtSignature) text.thoughtSignature = sig;
      }
    }
    // Compaction and hosted-tool items have no Gemini equivalent.
  }
  flush();
  return { system, contents: mergeRoles(contents) };
}

function mergeRoles(contents: Content[]): Content[] {
  const out: Content[] = [];
  for (const content of contents) {
    if (!content.parts.length) continue;
    const last = out.at(-1);
    if (last?.role === content.role) last.parts.push(...content.parts);
    else out.push({ role: content.role, parts: [...content.parts] });
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { value };
  } catch {
    return { arguments: raw };
  }
}

function plainText(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function userParts(content: any): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: Part[] = [];
  for (const part of content ?? []) {
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url);
      parts.push(
        data
          ? { inlineData: { mimeType: data[1], data: data[2] } }
          : { text: "[Image not sent: only inline images are supported.]" },
      );
    } else if (typeof part?.text === "string" && part.text)
      parts.push({ text: part.text });
  }
  return parts;
}

function outputText(output: any): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output))
    return output
      .map((part: any) =>
        typeof part?.text === "string"
          ? part.text
          : part?.type === "input_image"
            ? "[image omitted]"
            : part?.type === "input_audio"
              ? "[audio omitted]"
              : "",
      )
      .filter(Boolean)
      .join("\n");
  return output == null ? "" : JSON.stringify(output);
}

const NORMAL_FINISH = new Set(["STOP", "MAX_TOKENS"]);
const POLICY_FINISH = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "ESCALATION",
  "PUP_LIMITED_DISABLED",
]);

export async function streamGemini(
  upstream: Response,
  out: ResponsesStream,
  tools: ToolNames,
) {
  const calls: { callId: string; name: string; args: unknown }[] = [];
  const state: SignatureState = { signatures: {} };
  let summary = "";
  let usage: Usage | undefined;
  let finish: string | undefined;
  for await (const data of sseData(upstream.body!)) {
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      const message = String(
        chunk.error.message || "The model provider reported an error.",
      );
      out.fail(
        isGeminiContextError(String(chunk.error.status || ""), message)
          ? "context_length_exceeded"
          : "server_error",
        message,
      );
      return;
    }
    if (chunk.promptFeedback?.blockReason) {
      out.fail(
        "cyber_policy",
        `The model provider blocked the prompt (${chunk.promptFeedback.blockReason}).`,
      );
      return;
    }
    if (chunk.usageMetadata) usage = geminiUsage(chunk.usageMetadata);
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        const callId = part.functionCall.id || newCallId();
        calls.push({
          callId,
          name: String(part.functionCall.name || ""),
          args: part.functionCall.args ?? {},
        });
        if (part.thoughtSignature)
          state.signatures[callId] = part.thoughtSignature;
      } else if (part.thought) {
        if (typeof part.text === "string") summary += part.text;
      } else {
        if (typeof part.text === "string") out.textDelta(part.text);
        if (part.thoughtSignature) state.textSignature = part.thoughtSignature;
      }
    }
    if (
      candidate?.finishReason &&
      candidate.finishReason !== "FINISH_REASON_UNSPECIFIED"
    )
      finish = candidate.finishReason;
  }
  if (!finish) {
    out.fail("server_error", "The model provider closed the stream early.");
    return;
  }
  if (POLICY_FINISH.has(finish)) {
    out.fail(
      "cyber_policy",
      `The model provider stopped the response (${finish}).`,
    );
    return;
  }
  if (!NORMAL_FINISH.has(finish)) {
    out.fail(
      "server_error",
      finish === "MALFORMED_FUNCTION_CALL"
        ? "The model produced a malformed function call."
        : `The model provider stopped the response (${finish}).`,
    );
    return;
  }
  if (
    summary.trim() ||
    state.textSignature ||
    Object.keys(state.signatures).length
  )
    out.reasoning(encodeSignatures(state), summary.trim() || undefined);
  for (const call of calls) {
    if (!call.name) continue;
    out.functionCall({
      callId: call.callId,
      ...tools.fromProvider(call.name),
      arguments: JSON.stringify(call.args),
    });
  }
  out.complete(usage);
}

function geminiUsage(meta: any): Usage {
  const input = Number(meta.promptTokenCount) || 0;
  const thoughts = Number(meta.thoughtsTokenCount) || 0;
  // Responses output_tokens include reasoning tokens; Gemini counts them apart.
  const output = (Number(meta.candidatesTokenCount) || 0) + thoughts;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(meta.totalTokenCount) || input + output,
    cached_tokens: Number(meta.cachedContentTokenCount) || 0,
    reasoning_tokens: thoughts,
  };
}

function isGeminiContextError(status: string, message: string) {
  return (
    isContextError(status, message) ||
    /input token count|exceeds the maximum number of tokens|token limit|tokens? exceeds?/i.test(
      message,
    )
  );
}

export async function proxyGemini(ctx: AdapterContext) {
  const { profile, apiKey, res, signal, log } = ctx;
  const { body, tools } = toGeminiRequest(ctx.input, profile as any);
  let upstream: Response;
  try {
    upstream = await ctx.fetch(geminiUrl(profile), {
      method: "POST",
      headers: {
        ...profile.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    const timedOut = error instanceof UpstreamTimeoutError;
    log(
      `upstream ${timedOut ? "timed out" : "unreachable"}: ${(error as Error).message}`,
    );
    // 502/504 are retried by Codex.
    return sendError(
      res,
      timedOut ? 504 : 502,
      timedOut
        ? "The model provider did not respond in time."
        : "The model provider is unreachable.",
      "server_error",
    );
  }
  if (!upstream.ok) return relayUpstreamError(upstream, ctx);
  const out = new ResponsesStream(res);
  try {
    await streamGemini(upstream, out, tools);
  } catch (error) {
    if (signal.aborted) return;
    log(`upstream stream failed: ${(error as Error).message}`);
    out.fail(
      "server_error",
      "The connection to the model provider was interrupted.",
    );
  }
}

// Google errors look like {error: {code, message, status, details}}.
async function relayUpstreamError(upstream: Response, ctx: AdapterContext) {
  if (ctx.signal.aborted) return;
  const text = await upstream.text().catch(() => "");
  let error: any = {};
  try {
    const parsed = JSON.parse(text);
    error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error ?? {};
  } catch {}
  const message = String(
    (typeof error === "string" ? error : error.message) ||
      `The model provider returned HTTP ${upstream.status}.`,
  );
  const status = String(error.status || "");
  ctx.log(`upstream HTTP ${upstream.status}`);
  if (upstream.status === 400 && isGeminiContextError(status, message)) {
    new ResponsesStream(ctx.res).fail("context_length_exceeded", message);
    return;
  }
  const headers: Record<string, string> = {};
  const retryAfter =
    upstream.headers.get("retry-after") ?? retryDelay(error.details);
  if (retryAfter) headers["Retry-After"] = retryAfter;
  const code =
    upstream.status === 503
      ? "server_is_overloaded"
      : upstream.status === 429
        ? "rate_limit_exceeded"
        : status.toLowerCase() || "upstream_error";
  sendError(
    ctx.res,
    upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
    message,
    code,
    headers,
  );
}

// google.rpc.RetryInfo: {"@type": ".../google.rpc.RetryInfo", "retryDelay": "34s"}.
function retryDelay(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    if (!String(detail?.["@type"] || "").endsWith("google.rpc.RetryInfo"))
      continue;
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(String(detail.retryDelay || ""));
    if (seconds) return String(Math.ceil(Number(seconds[1])));
  }
  return undefined;
}

function geminiUrl(profile: GatewayProfile) {
  const base = (profile.baseUrl || "https://generativelanguage.googleapis.com")
    .replace(/\/+$/, "")
    .replace(/\/v1beta$/, "");
  const model = profile.modelName.replace(/^models\//, "");
  return `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

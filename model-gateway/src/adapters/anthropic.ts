import Anthropic from "@anthropic-ai/sdk";
import type { AdapterContext, GatewayProfile } from "../adapter";
import { ResponsesStream, sendError, type Usage } from "../responses";
import { customToolAsFunction, ToolNames, systemPrompt } from "../tool-names";
import { isContextError } from "./chat";

// Anthropic Messages API via the official SDK. Like the Chat adapter, every
// Codex request carries the full conversation (store=false) and is translated
// on its own. Thinking blocks are round-tripped through Codex reasoning items
// (encrypted_content) so their signatures reach the next request unchanged.

const DEFAULT_MAX_TOKENS = 64000;
const REASONING_PREFIX = "anthropic:v1:";
const INTERRUPTED = "No output: the call was interrupted.";

type Block = Anthropic.ContentBlockParam;
type ThinkingBlock =
  Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam;
type Effort = NonNullable<Anthropic.OutputConfig["effort"]>;

export interface AnthropicRequest {
  params: Anthropic.MessageCreateParamsStreaming;
  tools: ToolNames;
}

export function toAnthropicRequest(
  input: any,
  profile: Pick<
    GatewayProfile,
    "modelName" | "maxOutputTokens" | "thinking" | "promptCache"
  >,
): AnthropicRequest {
  const tools = new ToolNames();
  const anthropicTools: Anthropic.Tool[] = [];
  for (const tool of input.tools ?? []) {
    if (tool?.type === "function")
      anthropicTools.push(anthropicTool(tools, tool));
    else if (tool?.type === "namespace") {
      for (const inner of tool.tools ?? [])
        if (inner?.type === "function")
          anthropicTools.push(anthropicTool(tools, inner, tool.name));
    } else if (tool?.type === "custom" && typeof tool.name === "string")
      anthropicTools.push(
        anthropicTool(tools, customToolAsFunction(tool), undefined, true),
      );
    // web_search and tool_search run only on OpenAI's Responses backend, so
    // they are not offered to the provider.
  }
  const { system, messages } = toMessages(input, tools);
  const policy =
    profile.promptCache?.type === "anthropic" ? profile.promptCache : undefined;
  const cache =
    policy?.enabled === false
      ? undefined
      : {
          type: "ephemeral" as const,
          ...(policy?.ttl ? { ttl: policy.ttl } : {}),
        };
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: profile.modelName,
    max_tokens: profile.maxOutputTokens || DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
    ...(cache ? { cache_control: cache } : {}),
  };
  // An explicit breakpoint caches tools + system, the part every request of a
  // conversation shares. Proxies that drop top-level auto-caching keep it.
  if (system)
    params.system = [
      {
        type: "text",
        text: system,
        ...(cache ? { cache_control: cache } : {}),
      },
    ];
  // Optional fallback for proxies that omit top-level automatic caching.
  // Same TTL at every breakpoint; no changes to text or message ordering.
  if (cache && policy?.conversationBreakpoint) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i].content;
      if (!Array.isArray(content)) continue;
      const block = [...content]
        .reverse()
        .find((b) => b.type === "text" || b.type === "tool_result");
      if (block) {
        block.cache_control = cache;
        break;
      }
    }
  }
  if (anthropicTools.length) {
    params.tools = anthropicTools;
    const choice = toolChoice(input);
    if (choice) params.tool_choice = choice;
  }
  // Older models (e.g. claude-haiku-4-5) reject adaptive thinking and effort.
  if (profile.thinking !== false) {
    params.thinking = { type: "adaptive", display: "summarized" };
    const effort = mapEffort(input.reasoning?.effort);
    if (effort) params.output_config = { effort };
  }
  return { params, tools };
}

function anthropicTool(
  names: ToolNames,
  tool: any,
  namespace?: string,
  custom?: boolean,
): Anthropic.Tool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? { ...tool.parameters, type: "object" }
      : { type: "object", properties: {} };
  return {
    name: names.toProvider({
      name: tool.name,
      namespace,
      ...(custom ? { custom } : {}),
    }),
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: schema as Anthropic.Tool.InputSchema,
    // A custom tool (apply_patch) carries a whole file in one string. Without
    // eager streaming Anthropic holds the parameter until it is complete, so a
    // long file shows nothing while it is written. The input can then arrive
    // as invalid JSON; the decoder tolerates that and Codex checks the patch.
    ...(custom ? { eager_input_streaming: true } : {}),
  };
}

// Forced tool use ("required", named tools) returns 400 on newer models, so
// only auto/none are forwarded.
function toolChoice(input: any): Anthropic.ToolChoice | undefined {
  if (input.tool_choice === "none") return { type: "none" };
  if (input.parallel_tool_calls === false)
    return { type: "auto", disable_parallel_tool_use: true };
  if (input.tool_choice === "auto") return { type: "auto" };
  return undefined;
}

function mapEffort(effort: unknown): Effort | undefined {
  switch (effort) {
    case "none":
    case "minimal":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    default:
      return undefined;
  }
}

// Builds a valid Messages conversation: alternating roles, user first, every
// tool_use answered by a tool_result in the single user message right after
// it, orphan results dropped.
class Conversation {
  readonly messages: Anthropic.MessageParam[] = [];
  private awaiting: string[] = [];
  private answered = new Set<string>();

  assistant(block: Block) {
    const last = this.last();
    if (last?.role === "assistant") this.blocks(last).push(block);
    else {
      this.closeResults();
      this.messages.push({ role: "assistant", content: [block] });
    }
    if (block.type === "tool_use") this.awaiting.push(block.id);
  }

  user(block: Block) {
    this.closeResults();
    const last = this.last();
    if (last?.role === "user") this.blocks(last).push(block);
    else this.messages.push({ role: "user", content: [block] });
  }

  toolResult(block: Anthropic.ToolResultBlockParam) {
    const id = block.tool_use_id;
    if (!this.awaiting.includes(id) || this.answered.has(id)) return;
    this.answered.add(id);
    this.insertResult(block);
  }

  finish(): Anthropic.MessageParam[] {
    this.closeResults();
    if (this.messages[0]?.role === "assistant")
      this.messages.unshift({
        role: "user",
        content: [{ type: "text", text: "(earlier conversation omitted)" }],
      });
    return this.messages;
  }

  // Interrupted turns and compaction can leave calls without output.
  private closeResults() {
    for (const id of this.awaiting)
      if (!this.answered.has(id))
        this.insertResult({
          type: "tool_result",
          tool_use_id: id,
          content: INTERRUPTED,
          is_error: true,
        });
    this.awaiting = [];
    this.answered = new Set();
  }

  // tool_result blocks lead the user message, ahead of any text.
  private insertResult(block: Anthropic.ToolResultBlockParam) {
    const last = this.last();
    if (last?.role !== "user") {
      this.messages.push({ role: "user", content: [block] });
      return;
    }
    const content = this.blocks(last);
    let at = 0;
    while (at < content.length && content[at].type === "tool_result") at++;
    content.splice(at, 0, block);
  }

  private last() {
    return this.messages.at(-1);
  }

  private blocks(message: Anthropic.MessageParam): Block[] {
    if (typeof message.content === "string")
      message.content = [{ type: "text", text: message.content }];
    return message.content as Block[];
  }
}

function toMessages(input: any, tools: ToolNames) {
  const system: string[] = systemPrompt(input);
  const conversation = new Conversation();
  let started = false;
  for (const item of input.input ?? []) {
    const type = item?.type ?? (item?.role ? "message" : undefined);
    if (type === "message") {
      if (item.role === "developer" || item.role === "system") {
        const text = plainText(item.content);
        if (!text) continue;
        // Leading instructions become the system prompt; later ones are
        // sent as user text because mid-conversation system messages are
        // not supported on every model.
        if (!started) system.push(text);
        else conversation.user({ type: "text", text });
        continue;
      }
      if (item.role === "assistant") {
        const text = plainText(item.content);
        if (text) conversation.assistant({ type: "text", text });
      } else
        for (const block of userBlocks(item.content)) conversation.user(block);
    } else if (type === "reasoning") {
      for (const block of decodeReasoning(item.encrypted_content))
        conversation.assistant(block);
    } else if (type === "function_call" || type === "custom_tool_call") {
      conversation.assistant({
        type: "tool_use",
        id: item.call_id,
        name: tools.toProvider({ name: item.name, namespace: item.namespace }),
        input:
          type === "function_call"
            ? parseArguments(item.arguments)
            : { input: item.input ?? "" },
      });
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      conversation.toolResult(toolResult(item));
    }
    // Compaction and hosted-tool items have no Messages equivalent.
    started ||= conversation.messages.length > 0;
  }
  return {
    system: system.join("\n\n"),
    messages: conversation.finish(),
  };
}

function parseArguments(raw: unknown): Record<string, unknown> {
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

function userBlocks(
  content: any,
): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
  for (const part of content ?? []) {
    if (part?.type === "input_image") {
      const image = imageBlock(part.image_url);
      if (image) blocks.push(image);
    } else if (typeof part?.text === "string" && part.text)
      blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function imageBlock(url: unknown): Anthropic.ImageBlockParam | undefined {
  if (typeof url !== "string") return undefined;
  const data = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (data) {
    const mediaType = data[1].toLowerCase();
    if (!IMAGE_TYPES.includes(mediaType)) return undefined;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as Anthropic.Base64ImageSource["media_type"],
        data: data[2],
      },
    };
  }
  if (/^https?:\/\//i.test(url))
    return { type: "image", source: { type: "url", url } };
  return undefined;
}

function toolResult(item: any): Anthropic.ToolResultBlockParam {
  const block: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: item.call_id,
  };
  const output = item.output;
  if (Array.isArray(output)) {
    const parts: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [];
    for (const part of output) {
      if (part?.type === "input_image") {
        const image = imageBlock(part.image_url);
        parts.push(image ?? { type: "text", text: "[image omitted]" });
      } else if (part?.type === "input_audio")
        parts.push({ type: "text", text: "[audio omitted]" });
      else if (typeof part?.text === "string" && part.text)
        parts.push({ type: "text", text: part.text });
    }
    if (parts.length) block.content = parts;
  } else {
    const text =
      typeof output === "string"
        ? output
        : output == null
          ? ""
          : JSON.stringify(output);
    if (text) block.content = text;
  }
  return block;
}

export function encodeReasoning(blocks: ThinkingBlock[]): string {
  return (
    REASONING_PREFIX + Buffer.from(JSON.stringify(blocks)).toString("base64")
  );
}

function decodeReasoning(encrypted: unknown): ThinkingBlock[] {
  if (typeof encrypted !== "string" || !encrypted.startsWith(REASONING_PREFIX))
    return [];
  try {
    const blocks = JSON.parse(
      Buffer.from(encrypted.slice(REASONING_PREFIX.length), "base64").toString(
        "utf8",
      ),
    );
    return Array.isArray(blocks)
      ? blocks.filter(
          (b) => b?.type === "thinking" || b?.type === "redacted_thinking",
        )
      : [];
  } catch {
    return [];
  }
}

type OpenBlock =
  | { type: "text" }
  | { type: "tool_use"; id: string; name: string; json: string; input: unknown }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "other" };

interface HeldCall {
  id: string;
  name: string;
  json: string;
}

export async function streamAnthropic(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  out: ResponsesStream,
  tools: ToolNames,
) {
  const blocks = new Map<number, OpenBlock>();
  // Tool calls whose input is not valid JSON wait for the stop reason: a
  // max_tokens stop means they were cut off and are dropped.
  const held: HeldCall[] = [];
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let cacheWriteReported = false;
  let cacheReadReported = false;
  let cacheWrite5m: number | undefined;
  let cacheWrite1h: number | undefined;
  const cacheWrites = (usage: {
    cache_creation_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_5m_input_tokens: number;
      ephemeral_1h_input_tokens: number;
    } | null;
  }) => {
    if (usage.cache_creation_input_tokens != null) {
      tokens.cacheWrite = usage.cache_creation_input_tokens;
      cacheWriteReported = true;
    }
    if (usage.cache_creation) {
      cacheWrite5m = usage.cache_creation.ephemeral_5m_input_tokens;
      cacheWrite1h = usage.cache_creation.ephemeral_1h_input_tokens;
    }
  };
  let stopReason: Anthropic.StopReason | null = null;
  let stopDetails: Anthropic.RefusalStopDetails | null = null;

  const emitCall = (call: HeldCall, args: string) =>
    out.functionCall({
      callId: call.id,
      ...tools.fromProvider(call.name),
      arguments: args,
    });

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        const usage = event.message.usage;
        tokens.input = usage.input_tokens ?? 0;
        tokens.cacheRead = usage.cache_read_input_tokens ?? 0;
        cacheReadReported = usage.cache_read_input_tokens != null;
        tokens.cacheWrite = usage.cache_creation_input_tokens ?? 0;
        cacheWrites(usage);
        tokens.output = usage.output_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") {
          blocks.set(event.index, { type: "text" });
          out.textDelta(block.text);
        } else if (block.type === "tool_use")
          blocks.set(event.index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            json: "",
            input: block.input,
          });
        else if (block.type === "thinking")
          blocks.set(event.index, {
            type: "thinking",
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          });
        else if (block.type === "redacted_thinking")
          blocks.set(event.index, {
            type: "redacted_thinking",
            data: block.data,
          });
        else blocks.set(event.index, { type: "other" });
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(event.index);
        const delta = event.delta;
        if (delta.type === "text_delta") out.textDelta(delta.text);
        else if (
          delta.type === "input_json_delta" &&
          block?.type === "tool_use"
        ) {
          block.json += delta.partial_json;
          // apply_patch progress: the patch text streams to Codex as written.
          const ref = tools.fromProvider(block.name);
          if (ref.custom)
            out.customCallDelta(
              { callId: block.id, name: ref.name },
              delta.partial_json,
            );
        } else if (
          delta.type === "thinking_delta" &&
          block?.type === "thinking"
        )
          block.thinking += delta.thinking;
        else if (delta.type === "signature_delta" && block?.type === "thinking")
          block.signature += delta.signature;
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(event.index);
        blocks.delete(event.index);
        if (block?.type === "thinking")
          out.reasoning(
            encodeReasoning([
              {
                type: "thinking",
                thinking: block.thinking,
                signature: block.signature,
              },
            ]),
            block.thinking || undefined,
          );
        else if (block?.type === "redacted_thinking")
          out.reasoning(
            encodeReasoning([{ type: "redacted_thinking", data: block.data }]),
          );
        else if (block?.type === "tool_use") {
          const json = block.json.trim()
            ? block.json
            : JSON.stringify(block.input ?? {});
          const call = { id: block.id, name: block.name, json };
          if (validJson(json)) emitCall(call, json);
          else held.push(call);
        }
        break;
      }
      case "message_delta": {
        stopReason = event.delta.stop_reason ?? stopReason;
        stopDetails = event.delta.stop_details ?? stopDetails;
        const usage = event.usage;
        if (usage.input_tokens != null) tokens.input = usage.input_tokens;
        if (usage.cache_read_input_tokens != null) {
          tokens.cacheRead = usage.cache_read_input_tokens;
          cacheReadReported = true;
        }
        if (usage.cache_creation_input_tokens != null)
          tokens.cacheWrite = usage.cache_creation_input_tokens;
        cacheWrites(usage);
        if (usage.output_tokens != null) tokens.output = usage.output_tokens;
        break;
      }
      case "message_stop": {
        if (stopReason === "refusal") {
          out.fail(
            "cyber_policy",
            stopDetails?.explanation ||
              "The model declined to respond to this request.",
          );
          return;
        }
        if (stopReason === "model_context_window_exceeded") {
          out.fail(
            "context_length_exceeded",
            "The conversation exceeded the model's context window.",
          );
          return;
        }
        if (stopReason !== "max_tokens")
          for (const call of held) emitCall(call, call.json);
        const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
        const usage: Usage = {
          input_tokens: input,
          output_tokens: tokens.output,
          total_tokens: input + tokens.output,
          ...(cacheReadReported ? { cached_tokens: tokens.cacheRead } : {}),
          ...(cacheWriteReported
            ? { cache_write_tokens: tokens.cacheWrite }
            : {}),
          cache_write_5m_tokens: cacheWrite5m,
          cache_write_1h_tokens: cacheWrite1h,
        };
        out.complete(usage);
        return;
      }
    }
  }
  out.fail("server_error", "The model provider closed the stream early.");
}

function validJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function anthropicBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function errorBody(error: InstanceType<typeof Anthropic.APIError>): {
  type: string;
  message: string;
} {
  const body: any = error.error;
  const inner = body?.error ?? body;
  return {
    type: String(inner?.type || error.type || ""),
    message: String(
      inner?.message ||
        (error.status
          ? `The model provider returned HTTP ${error.status}.`
          : "The model provider reported an error."),
    ),
  };
}

export async function proxyAnthropic(ctx: AdapterContext) {
  const { profile, apiKey, res, signal, log } = ctx;
  const { params, tools } = toAnthropicRequest(ctx.input, profile);
  const client = new Anthropic({
    apiKey,
    // Never pick up ANTHROPIC_AUTH_TOKEN from the gateway's environment.
    authToken: null,
    baseURL: anthropicBaseUrl(profile.baseUrl),
    fetch: ctx.fetch,
    // Codex retries on its own; retrying here would multiply the wait.
    maxRetries: 0,
    defaultHeaders: profile.headers,
  });
  let events: AsyncIterable<Anthropic.RawMessageStreamEvent>;
  try {
    events = await client.messages.create(params, { signal });
  } catch (error) {
    return relayRequestError(error, ctx);
  }
  const out = new ResponsesStream(res);
  try {
    await streamAnthropic(events, out, tools);
  } catch (error) {
    if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return;
    if (
      error instanceof Anthropic.APIError &&
      !(error instanceof Anthropic.APIConnectionError) &&
      error.status === undefined
    ) {
      // An `event: error` inside the stream, e.g. overloaded_error.
      const { type, message } = errorBody(error);
      log(`upstream stream error: ${type || "unknown"}`);
      out.fail(
        type === "overloaded_error"
          ? "server_is_overloaded"
          : isContextError(type, message)
            ? "context_length_exceeded"
            : "server_error",
        message,
      );
      return;
    }
    log(`upstream stream failed: ${(error as Error).message}`);
    out.fail(
      "server_error",
      "The connection to the model provider was interrupted.",
    );
  }
}

// Keep the upstream status (and Retry-After) so Codex classifies rate limits,
// auth failures and bad requests correctly. Context overflow is sent as a
// failed stream because Codex only recognises it in that form.
function relayRequestError(error: unknown, ctx: AdapterContext) {
  if (ctx.signal.aborted || error instanceof Anthropic.APIUserAbortError)
    return;
  if (error instanceof Anthropic.APIConnectionError) {
    ctx.log(`upstream unreachable: ${error.message}`);
    return sendError(
      ctx.res,
      502,
      "The model provider is unreachable.",
      "server_error",
    );
  }
  if (!(error instanceof Anthropic.APIError)) throw error;
  const { type, message } = errorBody(error);
  const status = error.status ?? 502;
  ctx.log(`upstream HTTP ${status}`);
  const headers: Record<string, string> = {};
  const retryAfter = error.headers?.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  if (
    error instanceof Anthropic.BadRequestError &&
    isContextError(type, message)
  ) {
    new ResponsesStream(ctx.res).fail("context_length_exceeded", message);
    return;
  }
  if (error instanceof Anthropic.InternalServerError && status === 529)
    return sendError(ctx.res, 503, message, "server_is_overloaded", headers);
  sendError(
    ctx.res,
    status >= 400 && status < 600 ? status : 502,
    message,
    type || "upstream_error",
    headers,
  );
}

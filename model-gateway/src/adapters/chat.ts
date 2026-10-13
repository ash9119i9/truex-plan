import { randomUUID } from "node:crypto";
import { UpstreamTimeoutError } from "../upstream";
import type { AdapterContext } from "../adapter";
import { ResponsesStream, sendError, sseData, type Usage } from "../responses";
import { ToolNames, systemPrompt } from "../tool-names";
import { chatCacheOptions } from "../prompt-cache";

// OpenAI Chat Completions (and the many providers that copy it).
// Codex sends the full conversation every turn with store=false, so each
// request is translated on its own; no state is kept between requests.

type ChatMessage = Record<string, any>;

export interface ChatRequest {
  body: Record<string, any>;
  tools: ToolNames;
}

export function toChatRequest(input: any, model: string): ChatRequest {
  const tools = new ToolNames();
  const chatTools: any[] = [];
  for (const tool of input.tools ?? []) {
    if (tool?.type === "function") chatTools.push(chatTool(tools, tool));
    else if (tool?.type === "namespace")
      for (const inner of tool.tools ?? [])
        if (inner?.type === "function")
          chatTools.push(chatTool(tools, inner, tool.name));
    // web_search, tool_search and custom (freeform) tools run only on
    // OpenAI's Responses backend, so they are not offered to the provider.
  }
  const body: Record<string, any> = {
    model,
    messages: toMessages(input, tools),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (chatTools.length) {
    body.tools = chatTools;
    if (["auto", "none", "required"].includes(input.tool_choice))
      body.tool_choice = input.tool_choice;
  }
  return { body, tools };
}

function chatTool(names: ToolNames, tool: any, namespace?: string) {
  return {
    type: "function",
    function: {
      name: names.toProvider({ name: tool.name, namespace }),
      description: tool.description || undefined,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  };
}

function toMessages(input: any, tools: ToolNames): ChatMessage[] {
  const system: string[] = systemPrompt(input);
  const messages: ChatMessage[] = [];
  for (const item of input.input ?? []) {
    const type = item?.type ?? (item?.role ? "message" : undefined);
    if (type === "message") {
      const role =
        item.role === "developer" || item.role === "system"
          ? "system"
          : item.role;
      // Leading system text is merged into one message; several providers
      // reject a system message after the conversation has started.
      if (role === "system" && !messages.length) {
        const text = plainText(item.content);
        if (text) system.push(text);
        continue;
      }
      const content =
        role === "user" ? userContent(item.content) : plainText(item.content);
      if (!content || (Array.isArray(content) && !content.length)) continue;
      messages.push({ role, content });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const call = {
        id: item.call_id,
        type: "function",
        function: {
          name: tools.toProvider({
            name: item.name,
            namespace: item.namespace,
          }),
          arguments:
            type === "function_call"
              ? item.arguments || "{}"
              : JSON.stringify({ input: item.input ?? "" }),
        },
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && !last.closed)
        (last.tool_calls ??= []).push(call);
      else
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (
      type === "function_call_output" ||
      type === "custom_tool_call_output"
    ) {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: outputText(item.output),
      });
    }
    // Reasoning, compaction and hosted-tool items have no Chat equivalent.
    const last = messages.at(-1);
    if (last?.role === "tool") markClosed(messages);
  }
  return [
    ...(system.length
      ? [{ role: "system", content: system.join("\n\n") }]
      : []),
    ...pairToolCalls(messages),
  ];
}

// An assistant message followed by tool output cannot take more tool calls.
function markClosed(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "assistant") {
      messages[i].closed = true;
      return;
    }
}

// Chat APIs reject tool results without a matching call and calls without a
// result. Interrupted turns and compaction can leave either behind.
function pairToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending = new Set<string>();
  const flush = () => {
    for (const id of pending)
      out.push({
        role: "tool",
        tool_call_id: id,
        content: "No output: the call was interrupted.",
      });
    pending = new Set();
  };
  for (const { closed, ...message } of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) continue;
      out.push(message);
      continue;
    }
    flush();
    out.push(message);
    for (const call of message.tool_calls ?? []) pending.add(call.id);
  }
  flush();
  return out;
}

function plainText(content: any): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function userContent(content: any): string | any[] {
  if (typeof content === "string") return content;
  const parts = (content ?? [])
    .map((part: any) =>
      part?.type === "input_image" && part.image_url
        ? { type: "image_url", image_url: { url: part.image_url } }
        : typeof part?.text === "string"
          ? { type: "text", text: part.text }
          : null,
    )
    .filter(Boolean);
  return parts.every((p: any) => p.type === "text")
    ? parts.map((p: any) => p.text).join("\n")
    : parts;
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

interface PendingCall {
  id?: string;
  name: string;
  args: string;
}

export async function streamChat(
  upstream: Response,
  out: ResponsesStream,
  tools: ToolNames,
) {
  const calls: PendingCall[] = [];
  let usage: Usage | undefined;
  let finished = false;
  for await (const data of sseData(upstream.body!)) {
    if (data === "[DONE]") {
      finished = true;
      break;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      out.fail(
        errorCode(chunk.error),
        String(chunk.error.message || "The model provider reported an error."),
      );
      return;
    }
    if (chunk.usage) usage = chatUsage(chunk.usage);
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") out.textDelta(delta.content);
      for (const part of delta.tool_calls ?? []) {
        const call = pendingCall(calls, part);
        if (part.id) call.id = part.id;
        if (part.function?.name && !call.name) call.name = part.function.name;
        if (typeof part.function?.arguments === "string")
          call.args += part.function.arguments;
      }
      if (choice.finish_reason) finished = true;
    }
  }
  if (!finished) {
    out.fail("server_error", "The model provider closed the stream early.");
    return;
  }
  for (const call of calls) {
    if (!call.name) continue;
    out.functionCall({
      callId: call.id || "call_" + randomUUID().replace(/-/g, ""),
      ...tools.fromProvider(call.name),
      arguments: call.args || "{}",
    });
  }
  out.complete(usage);
}

// Most providers stream tool calls by index. Some omit the index and send
// each call whole, keyed only by id.
function pendingCall(calls: PendingCall[], part: any): PendingCall {
  if (typeof part.index === "number")
    return (calls[part.index] ??= { name: "", args: "" });
  const byId = part.id && calls.find((c) => c.id === part.id);
  if (byId) return byId;
  if (!part.id && calls.length) return calls[calls.length - 1];
  const call = { name: "", args: "" };
  calls.push(call);
  return call;
}

function chatUsage(usage: any): Usage {
  const input = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens) || input + output,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens,
    cache_write_tokens: usage.prompt_tokens_details?.cache_write_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

function errorCode(error: any) {
  const code = String(error?.code || error?.type || "");
  return isContextError(code, String(error?.message || ""))
    ? "context_length_exceeded"
    : "server_error";
}

export function isContextError(code: string, message: string) {
  return (
    /context_length_exceeded|context_window/i.test(code) ||
    /maximum context length|context window|context length|too many tokens|prompt is too long/i.test(
      message,
    )
  );
}

export async function proxyChat(ctx: AdapterContext) {
  const { profile, apiKey, res, signal, log } = ctx;
  const { body, tools } = toChatRequest(ctx.input, profile.modelName);
  Object.assign(
    body,
    chatCacheOptions(profile.promptCache, ctx.input, body, {
      profileId: String(profile._id),
      tenantId: ctx.tenantId,
    }),
  );
  let upstream: Response;
  try {
    upstream = await ctx.fetch(chatUrl(profile.baseUrl), {
      method: "POST",
      headers: {
        ...profile.headers,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
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
    await streamChat(upstream, out, tools);
  } catch (error) {
    if (signal.aborted) return;
    log(`upstream stream failed: ${(error as Error).message}`);
    out.fail(
      "server_error",
      "The connection to the model provider was interrupted.",
    );
  }
}

// Keep the upstream status so Codex (and shared/errors.ts) classify it as
// rate limit, auth, invalid request or outage. Context overflow is sent as a
// failed stream because Codex only recognises it in that form.
async function relayUpstreamError(upstream: Response, ctx: AdapterContext) {
  const text = await upstream.text().catch(() => "");
  let error: any = {};
  try {
    error = JSON.parse(text)?.error ?? {};
  } catch {}
  const message = String(
    (typeof error === "string" ? error : error.message) ||
      `The model provider returned HTTP ${upstream.status}.`,
  );
  ctx.log(`upstream HTTP ${upstream.status}`);
  if (
    upstream.status === 400 &&
    isContextError(String(error.code || error.type || ""), message)
  ) {
    new ResponsesStream(ctx.res).fail("context_length_exceeded", message);
    return;
  }
  const headers: Record<string, string> = {};
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  const status =
    upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
  sendError(
    ctx.res,
    status,
    message,
    String(error.code || error.type || "upstream_error"),
    headers,
  );
}

function chatUrl(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

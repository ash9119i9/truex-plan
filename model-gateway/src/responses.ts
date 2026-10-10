import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { record } from "./logging";

// Writes the subset of the Responses SSE stream that the pinned Codex parses
// (codex-api/src/sse/responses.rs): created, output_item.added/done,
// output_text.delta, completed and failed. A stream must end in completed or
// failed; Codex treats anything else as a dropped connection and retries.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
  reasoning_tokens?: number;
}

export interface FunctionCall {
  callId: string;
  name: string;
  namespace?: string;
  arguments: string;
}

const newId = (prefix: string) => prefix + "_" + randomUUID().replace(/-/g, "");

export class ResponsesStream {
  readonly id = newId("resp");
  private started = false;
  private finished = false;
  private outputIndex = 0;
  private message?: { id: string; text: string };
  private leading = "";
  constructor(private readonly res: ServerResponse) {}

  get isStarted() {
    return this.started;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // No explicit Connection header: Node keeps the connection alive, and
    // can still close it during a graceful drain.
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    record(this.res, { firstByteAt: performance.now() });
    this.emit({
      type: "response.created",
      response: { id: this.id, status: "in_progress" },
    });
  }

  textDelta(delta: string) {
    if (!delta) return;
    this.start();
    // Models often emit a bare newline before a tool call. Hold leading
    // whitespace until real text arrives so it never becomes an empty message.
    if (!this.message && !delta.trim()) {
      this.leading += delta;
      return;
    }
    if (!this.message) {
      delta = this.leading + delta;
      this.leading = "";
      this.message = { id: newId("msg"), text: "" };
      this.emit({
        type: "response.output_item.added",
        output_index: this.outputIndex,
        item: this.messageItem(""),
      });
    }
    record(this.res, { firstTextAt: performance.now() });
    this.message.text += delta;
    this.emit({
      type: "response.output_text.delta",
      item_id: this.message.id,
      output_index: this.outputIndex,
      content_index: 0,
      delta,
    });
  }

  functionCall(call: FunctionCall) {
    this.start();
    this.finishMessage();
    const item = {
      type: "function_call",
      id: newId("fc"),
      call_id: call.callId,
      name: call.name,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      arguments: call.arguments,
    };
    this.emit({
      type: "response.output_item.added",
      output_index: this.outputIndex,
      item,
    });
    this.emit({
      type: "response.output_item.done",
      output_index: this.outputIndex++,
      item,
    });
  }

  // Codex stores reasoning items and sends them back unchanged in later
  // requests (it asks for reasoning.encrypted_content), so adapters use
  // `encryptedContent` to round-trip provider state such as thinking
  // signatures. The summary is what the UI may show.
  reasoning(encryptedContent: string, summary?: string) {
    this.start();
    this.finishMessage();
    const item = {
      type: "reasoning",
      id: newId("rs"),
      summary: summary ? [{ type: "summary_text", text: summary }] : [],
      encrypted_content: encryptedContent,
    };
    this.emit({
      type: "response.output_item.added",
      output_index: this.outputIndex,
      item,
    });
    this.emit({
      type: "response.output_item.done",
      output_index: this.outputIndex++,
      item,
    });
  }

  complete(usage?: Usage) {
    if (this.finished) return;
    this.start();
    this.finishMessage();
    record(this.res, { outcome: "completed", usage });
    this.emit({
      type: "response.completed",
      response: {
        id: this.id,
        status: "completed",
        ...(usage ? { usage: responsesUsage(usage) } : {}),
      },
    });
    this.end();
  }

  // Codex maps these codes itself: context_length_exceeded and
  // insufficient_quota are fatal; anything else is retried.
  fail(code: string, message: string) {
    if (this.finished) return;
    this.start();
    record(this.res, { outcome: "failed", errorCode: code });
    this.emit({
      type: "response.failed",
      response: {
        id: this.id,
        status: "failed",
        error: { code, message },
      },
    });
    this.end();
  }

  private finishMessage() {
    if (!this.message) return;
    this.emit({
      type: "response.output_item.done",
      output_index: this.outputIndex++,
      item: this.messageItem(this.message.text),
    });
    this.message = undefined;
  }

  private messageItem(text: string) {
    return {
      type: "message",
      id: this.message!.id,
      role: "assistant",
      content: text ? [{ type: "output_text", text }] : [],
    };
  }

  private emit(event: { type: string } & Record<string, unknown>) {
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private end() {
    this.finished = true;
    this.res.end();
  }
}

function responsesUsage(usage: Usage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    // Codex requires cached_tokens / reasoning_tokens when the details objects exist.
    ...(usage.cached_tokens !== undefined ||
    usage.cache_write_tokens !== undefined
      ? {
          input_tokens_details: {
            cached_tokens: usage.cached_tokens ?? 0,
            ...(usage.cache_write_tokens !== undefined
              ? { cache_write_tokens: usage.cache_write_tokens }
              : {}),
          },
        }
      : {}),
    ...(usage.reasoning_tokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: usage.reasoning_tokens } }
      : {}),
  };
}

// Errors sent before streaming starts use the OpenAI error envelope, which is
// what Codex reads from non-2xx bodies.
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  code: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  record(res, {
    firstByteAt: performance.now(),
    outcome: code,
    errorCode: code,
  });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
}

// Yields each `data:` payload from an upstream SSE body.
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  if (data.length) yield data.join("\n");
}

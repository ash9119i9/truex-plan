import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

// A loopback Responses API provider. Each request is answered by the next
// scripted behavior (or the default), so tests can make the "model" stream
// slowly, hang, fail or overflow its context. Synthetic credentials only.

export type Behavior =
  | { kind: "reply"; text: string; chunk?: number; delayMs?: number }
  | { kind: "hangBeforeHeaders" }
  | { kind: "hangAfterCreated" }
  | { kind: "status"; status: number }
  | { kind: "failed"; code: string }
  // Emits one function call (for an MCP namespace tool), so a test can make the
  // model ask Codex to run an MCP tool. Codex runs it and feeds the result
  // back as the next request; follow that with a `reply` to finish the turn.
  | { kind: "call"; name: string; namespace?: string; args: unknown }
  // Emits one freeform (custom) tool call, the form Codex offers apply_patch
  // in. `input` is the raw tool input (the patch text). With `stream`, the
  // input is also sent in pieces of that size first
  // (custom_tool_call_input.delta), `delayMs` apart, as a model writes it.
  | {
      kind: "custom";
      name: string;
      input: string;
      stream?: number;
      delayMs?: number;
    };

export interface ModelRequest {
  readonly authorized: boolean;
  readonly body: Record<string, unknown>;
}

export class ModelFixture {
  readonly requests: ModelRequest[] = [];
  readonly script: Behavior[] = [];
  // Consulted before the script. Several Codex threads (a lead and its
  // helpers) share one fixture and their requests interleave, so a test can
  // answer by request content instead of by arrival order. Returning
  // undefined falls through to the script.
  router: ((body: Record<string, unknown>) => Behavior | undefined) | undefined;
  defaultBehavior: Behavior = {
    kind: "reply",
    text: "Hello from the fixture.",
  };
  private server!: Server;
  private readonly open = new Set<ServerResponse>();
  url = "";

  constructor(readonly token = "fixture-gateway-token-0123456789abcdef") {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (!req.url?.endsWith("/responses")) return res.writeHead(404).end();
      const body = JSON.parse(raw) as Record<string, unknown>;
      this.requests.push({
        authorized: req.headers.authorization === `Bearer ${this.token}`,
        body,
      });
      this.open.add(res);
      res.on("close", () => this.open.delete(res));
      await this.respond(
        this.router?.(body) ?? this.script.shift() ?? this.defaultBehavior,
        res,
      );
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    for (const res of this.open) res.destroy();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  lastRequest(): ModelRequest {
    const last = this.requests.at(-1);
    if (!last) throw new Error("no model request");
    return last;
  }

  private async respond(
    behavior: Behavior,
    res: ServerResponse,
  ): Promise<void> {
    const n = this.requests.length;
    const emit = (event: Record<string, unknown>) =>
      res.write(
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    switch (behavior.kind) {
      case "hangBeforeHeaders":
        return;
      case "status":
        res
          .writeHead(behavior.status, { "content-type": "application/json" })
          .end('{"error":{"message":"fixture failure"}}');
        return;
      case "hangAfterCreated":
        res.writeHead(200, { "content-type": "text/event-stream" });
        emit({ type: "response.created", response: { id: `resp_${n}` } });
        return;
      case "failed":
        res.writeHead(200, { "content-type": "text/event-stream" });
        emit({ type: "response.created", response: { id: `resp_${n}` } });
        emit({
          type: "response.failed",
          response: {
            id: `resp_${n}`,
            error: { code: behavior.code, message: "fixture failure" },
          },
        });
        res.end();
        return;
      case "call":
      case "custom": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const item =
          behavior.kind === "call"
            ? {
                type: "function_call",
                id: `fc_${n}`,
                call_id: `call_${n}`,
                name: behavior.name,
                ...(behavior.namespace
                  ? { namespace: behavior.namespace }
                  : {}),
                arguments: JSON.stringify(behavior.args),
              }
            : {
                type: "custom_tool_call",
                id: `ctc_${n}`,
                call_id: `call_${n}`,
                name: behavior.name,
                input: behavior.input,
              };
        emit({ type: "response.created", response: { id: `resp_${n}` } });
        const stream = behavior.kind === "custom" ? behavior.stream : undefined;
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: stream ? { ...item, input: "" } : item,
        });
        if (behavior.kind === "custom" && stream)
          for (let i = 0; i < behavior.input.length; i += stream) {
            if (res.destroyed) return;
            emit({
              type: "response.custom_tool_call_input.delta",
              item_id: item.id,
              call_id: item.call_id,
              output_index: 0,
              delta: behavior.input.slice(i, i + stream),
            });
            if (behavior.delayMs) await sleep(behavior.delayMs);
          }
        emit({ type: "response.output_item.done", output_index: 0, item });
        emit({
          type: "response.completed",
          response: {
            id: `resp_${n}`,
            usage: {
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 10,
              total_tokens: 30,
            },
          },
        });
        res.end();
        return;
      }
      case "reply": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const id = `resp_${n}`;
        const item = {
          type: "message",
          role: "assistant",
          id: `msg_${n}`,
          content: [{ type: "output_text", text: behavior.text }],
        };
        emit({ type: "response.created", response: { id } });
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [] },
        });
        const size = behavior.chunk ?? 8;
        for (let i = 0; i < behavior.text.length; i += size) {
          if (res.destroyed) return;
          emit({
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: behavior.text.slice(i, i + size),
          });
          if (behavior.delayMs) await sleep(behavior.delayMs);
        }
        if (res.destroyed) return;
        emit({ type: "response.output_item.done", output_index: 0, item });
        emit({
          type: "response.completed",
          response: {
            id,
            usage: {
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 5 },
              output_tokens: 10,
              total_tokens: 30,
            },
          },
        });
        res.end();
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

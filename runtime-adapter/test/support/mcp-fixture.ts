import { once } from "node:events";
import { createServer, type Server } from "node:http";

// A minimal streamable-HTTP MCP server for the real-pin MCP tests, promoted
// from the probe (.runtime/mcp-probe/mcp-fixture.ts). JSON responses only (no
// SSE). It records every request's Authorization header so a test can assert
// which token Codex sent, and can be told to answer `initialize` with a 401 so
// a startup auth failure can be exercised.
//
// Tool annotations match the probe's: `get_issue` is read-only (runs under
// Codex's `auto` approval mode), `list_unlabelled` has no annotations and
// `create_issue` is a write tool — both of the latter are refused under `auto`.

export interface McpRequestLog {
  readonly rpcMethod: string | undefined;
  readonly authorization: string | undefined;
}

export const TOOLS = [
  {
    name: "get_issue",
    description: "Read one issue.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "integer" } },
    },
    annotations: { readOnlyHint: true, title: "Get issue" },
  },
  {
    name: "list_unlabelled",
    description: "Tool with no annotations at all.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_issue",
    description: "Create an issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

export class McpFixture {
  readonly log: McpRequestLog[] = [];
  // When true, `initialize` answers 401 so a startup auth failure can be tested.
  unauthorized = false;
  // Milliseconds to delay a `tools/call` response, to exercise the tool-aware
  // watchdog (a call slower than the ordinary silence timer must not time out).
  callDelayMs = 0;
  // Milliseconds to delay the `initialize` response, to model a server slower
  // than Codex's default 1 s first-turn startup grace (GitHub takes ~4 s).
  initializeDelayMs = 0;
  // Replaces a tool's result text, to return results larger than Codex's
  // fallback 10 KB cap.
  resultText: string | undefined;
  private server!: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let msg: Record<string, unknown> = {};
      try {
        msg = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        // Non-JSON body: fall through with an empty message.
      }
      this.log.push({
        rpcMethod: msg.method as string | undefined,
        authorization: req.headers.authorization,
      });
      if (req.method !== "POST") return res.writeHead(405).end();
      if (this.unauthorized && msg.method === "initialize") {
        res
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": 'Bearer error="invalid_token"',
          })
          .end('{"error":"invalid_token"}');
        return;
      }
      const reply = (result: unknown) =>
        res
          .writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "fixture-session",
          })
          .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      switch (msg.method) {
        case "initialize":
          if (this.initializeDelayMs > 0)
            await new Promise((r) => setTimeout(r, this.initializeDelayMs));
          return reply({
            protocolVersion:
              (msg.params as { protocolVersion?: string })?.protocolVersion ??
              "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "0.0.1" },
          });
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call": {
          const name = (msg.params as { name: string }).name;
          if (this.callDelayMs > 0)
            await new Promise((r) => setTimeout(r, this.callDelayMs));
          return reply({
            content: [
              { type: "text", text: this.resultText ?? `RESULT_FROM_${name}` },
            ],
            isError: false,
          });
        }
        default:
          if (msg.id === undefined) return res.writeHead(202).end();
          return reply({});
      }
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  // The tokens (after "Bearer ") seen in Authorization headers, in order.
  bearerTokens(): string[] {
    const tokens: string[] = [];
    for (const entry of this.log) {
      const match = /^Bearer (.+)$/.exec(entry.authorization ?? "");
      if (match) tokens.push(match[1]!);
    }
    return tokens;
  }

  toolCalls(): number {
    return this.log.filter((r) => r.rpcMethod === "tools/call").length;
  }

  reset(): void {
    this.log.length = 0;
    this.initializeDelayMs = 0;
    this.resultText = undefined;
  }

  // Idempotent: a test may stop the server mid-test ("server goes down") and
  // the shared afterEach closes it again.
  async close(): Promise<void> {
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// An http loopback URL that nothing listens on, for "server down at startup".
// Binds a server only to claim a free port, then closes it.
export async function deadMcpUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

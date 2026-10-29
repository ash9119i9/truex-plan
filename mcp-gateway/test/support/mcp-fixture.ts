import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

// A minimal streamable-HTTP MCP server standing in for a provider. It records
// every request (headers included, so a test can assert what the gateway
// sent) and can answer as JSON, as an SSE stream it holds open until told to
// finish, as a redirect, or not at all.

export interface FixtureRequest {
  readonly httpMethod: string;
  readonly rpcMethod: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export type FixtureMode = "json" | "sse-hold" | "redirect" | "hang";

export const SESSION_ID = "fixture-session-1";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// What tools/list answers unless a test sets `tools`.
export const DEFAULT_TOOLS: readonly Record<string, unknown>[] = [
  { name: "get_issue", inputSchema: { type: "object" } },
];

function resultFor(
  method: unknown,
  tools: readonly unknown[],
  callText = "RESULT",
): unknown {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0.0.1" },
      };
    case "tools/list":
      return { tools };
    case "tools/call":
      return { content: [{ type: "text", text: callText }], isError: false };
    default:
      return {};
  }
}

export class McpFixture {
  readonly log: FixtureRequest[] = [];
  mode: FixtureMode = "json";
  redirectTo = "";
  tools: readonly unknown[] = DEFAULT_TOOLS;
  // The text a tools/call answers with (undefined: "RESULT").
  callText: string | undefined;
  // When set, only these bearer tokens are accepted; any other request gets a
  // 401 naming `metadataUrl`, as a provider answers a revoked token.
  tokens: Set<string> | undefined;
  metadataUrl = "";
  url = "";
  // Resolved when an SSE response held by "sse-hold" may finish.
  private held = deferred();
  // Resolved when a GET stream this fixture opened is closed by the client.
  private getClosed = deferred();
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      let msg: Record<string, unknown> = {};
      try {
        msg = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        // Recorded as is.
      }
      this.log.push({
        httpMethod: req.method ?? "",
        rpcMethod: typeof msg.method === "string" ? msg.method : undefined,
        headers: req.headers,
        body,
      });
      if (this.tokens) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
        if (!bearer || !this.tokens.has(bearer[1]!)) {
          res
            .writeHead(401, {
              "www-authenticate": `Bearer error="invalid_token", resource_metadata="${this.metadataUrl}"`,
            })
            .end();
          return;
        }
      }
      if (req.method === "GET") {
        const closed = this.getClosed;
        res.on("close", () => closed.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": open\n\n");
        return;
      }
      if (req.method === "DELETE") return void res.writeHead(200).end();
      if (this.mode === "redirect")
        return void res.writeHead(307, { location: this.redirectTo }).end();
      // Never answers; the connection is closed by the gateway or close().
      if (this.mode === "hang") return;
      // A notification, or Codex's answer to a request the server sent it.
      if (msg.id === undefined || msg.method === undefined)
        return void res.writeHead(202).end();
      const result = resultFor(msg.method, this.tools, this.callText);
      if (this.mode === "sse-hold") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": SESSION_ID,
        });
        const progress = {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: 1, progress: 1 },
        };
        res.write(`event: message\ndata: ${JSON.stringify(progress)}\n\n`);
        await this.held.promise;
        res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`,
        );
        return;
      }
      res
        .writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": SESSION_ID,
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  releaseHeld(): void {
    this.held.resolve();
  }

  getStreamClosed(): Promise<void> {
    return this.getClosed.promise;
  }

  reset(): void {
    this.log.length = 0;
    this.mode = "json";
    this.redirectTo = "";
    this.tools = DEFAULT_TOOLS;
    this.callText = undefined;
    this.tokens = undefined;
    this.metadataUrl = "";
    this.held.resolve();
    this.held = deferred();
    this.getClosed = deferred();
  }

  async close(): Promise<void> {
    this.held.resolve();
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

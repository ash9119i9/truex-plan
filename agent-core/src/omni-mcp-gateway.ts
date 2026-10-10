import Ajv, { type ValidateFunction } from "ajv";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Redactor } from "./redact";

export interface ConnectorConfig {
  url: string;
  http_headers?: Record<string, string>;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  enabled?: boolean;
  enabled_tools?: string[];
  disabled_tools?: string[];
  command?: unknown;
}
export interface OmniMcpGatewayOptions {
  /** Require callers to select response fields or explicitly request the full result. */
  requireProjection?: boolean;
}
type Tool = {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
  annotations?: any;
};
export type GatewayEvent = {
  type: string;
  at: string;
  [key: string]: unknown;
};
const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: any): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const textResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const baseSchema = (properties: any, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const serverField = {
  type: "string",
  description: "Attached logical server name.",
};
const toolField = {
  type: "string",
  description: "Exact discovered tool name.",
};

async function withSignal<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let abort: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason || new Error("MCP request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}

// Only these definitions enter the model context; connector catalogs stay here.
export const omniTools = [
  {
    name: "discover_server",
    description:
      "Find this agent's attached MCP servers by name or intent. Returns names, not tool schemas.",
    inputSchema: baseSchema({ query: { type: "string" } }, ["query"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "discover_tools",
    description:
      "Find tools on an attached server. Returns names and short descriptions, not schemas. Query is optional.",
    inputSchema: baseSchema(
      { server: serverField, query: { type: "string" } },
      ["server"],
    ),
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_tool_schema",
    description:
      "Fetch one tool's argument schema before invoking it. Schemas are cached outside the conversation.",
    inputSchema: baseSchema({ server: serverField, tool: toolField }, [
      "server",
      "tool",
    ]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "invoke_tool",
    description:
      "Call a discovered tool with validated arguments. Optional fields projects JSON results using dotted paths (arrays traversed automatically), e.g. apps.name, apps.guid, pagination. Only selected fields reach the model. Omitting fields preserves the result. Calls require approval; projection does not authorize an action.",
    inputSchema: baseSchema(
      {
        server: serverField,
        tool: toolField,
        arguments: {
          type: "object",
          description: "Arguments matching get_tool_schema.",
        },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: "string" },
        },
      },
      ["server", "tool", "arguments"],
    ),
    // A generic dispatcher must never masquerade as a universally read-only tool.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
];

export const omniInstructions = `\nAttached business connectors are accessed through the omni MCP server. Logical connector names remain unchanged. Use discover_server if the server is unknown, discover_tools to find a tool, get_tool_schema for its arguments, then invoke_tool. Reuse schemas already present in this conversation; do not rediscover on every turn. For structured results use invoke_tool.fields to select only fields needed for the answer and follow-up identifiers/pagination. Discovery and projection do not authorize external changes. General knowledge and greetings need no connector calls.`;

type ProjectionNode = { all?: boolean; children: Map<string, ProjectionNode> };
export function projectFields(value: unknown, fields: string[]): unknown {
  if (!fields.length || fields.length > 64)
    throw new Error("Select 1–64 fields");
  const root: ProjectionNode = { children: new Map() };
  for (const field of fields) {
    const parts = typeof field === "string" ? field.split(".") : [];
    if (
      !parts.length ||
      parts.length > 16 ||
      parts.some((p) => !/^[A-Za-z_][\w-]*$/.test(p) || forbidden.has(p))
    )
      throw new Error("Invalid projection field path");
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part))
        node.children.set(part, { children: new Map() });
      node = node.children.get(part)!;
    }
    node.all = true;
  }
  const visit = (v: any, node: ProjectionNode): any => {
    if (node.all) return v;
    if (Array.isArray(v)) return v.map((item) => visit(item, node));
    if (!object(v)) return v === null ? null : undefined;
    const entries: [string, any][] = [];
    for (const [key, child] of node.children) {
      if (Object.hasOwn(v, key)) {
        const projected = visit(v[key], child);
        if (projected !== undefined) entries.push([key, projected]);
      }
    }
    return Object.fromEntries(entries);
  };
  return visit(value, root);
}

function parseData(result: any): any {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const content = result?.content;
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === "text"
  ) {
    try {
      return JSON.parse(content[0].text);
    } catch {
      /* Text is not projectable. */
    }
  }
  throw new Error(
    "Downstream action completed, but its response is not projectable JSON. Do not repeat the action automatically.",
  );
}

class DownstreamRpcError extends Error {
  constructor(readonly detail: any) {
    super(String(detail.message || "Downstream MCP error"));
  }
}

function rpcValue(value: any, id: number): any | undefined {
  const match = (Array.isArray(value) ? value : [value]).find(
    (v) => v?.id === id,
  );
  if (!match) return undefined;
  if (match.error) throw new DownstreamRpcError(match.error);
  if (!Object.hasOwn(match, "result"))
    throw new Error("Invalid downstream MCP response");
  return { result: match.result };
}

async function readRpc(response: Response, id: number): Promise<any> {
  if (!response.ok) throw new Error(`Downstream MCP HTTP ${response.status}`);
  if (!response.body) throw new Error("Empty downstream MCP response");
  let bytes = 0,
    buffer = "";
  const decoder = new TextDecoder();
  const sse = response.headers
    .get("content-type")
    ?.includes("text/event-stream");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES)
        throw new Error("Downstream response exceeds 8 MiB");
      buffer += decoder.decode(value, { stream: true });
      if (sse) {
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const event = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const match = rpcValue(JSON.parse(data), id);
            if (match) return match.result;
          }
        }
      }
    }
    buffer += decoder.decode();
    if (!sse) {
      const match = rpcValue(JSON.parse(buffer), id);
      if (match) return match.result;
    }
    throw new Error("Downstream stream ended without a matching RPC result");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class NativeConnector {
  private nextId = 1;
  private sessionId?: string;
  private protocol = "2025-03-26";
  private ready?: Promise<void>;
  private catalog?: Promise<Tool[]>;
  constructor(
    readonly config: ConnectorConfig,
    private stopped: AbortSignal,
    private fetcher: typeof fetch,
  ) {}
  private headers() {
    const headers = new Headers(this.config.http_headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    headers.set("MCP-Protocol-Version", this.protocol);
    headers.delete("Mcp-Session-Id");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    return headers;
  }
  private async rpc(method: string, params: any, signal?: AbortSignal) {
    const id = this.nextId++;
    const timeout =
      method === "tools/call"
        ? this.config.tool_timeout_sec
        : this.config.startup_timeout_sec;
    const response = await this.fetcher(this.config.url, {
      method: "POST",
      headers: this.headers(),
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.any([
        this.stopped,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(Math.ceil((timeout || 120) * 1000)),
      ]),
    });
    if (method === "initialize")
      this.sessionId = response.headers.get("mcp-session-id") || undefined;
    return readRpc(response, id);
  }
  private initialize() {
    if (!this.ready)
      this.ready = (async () => {
        this.sessionId = undefined;
        const result = await this.rpc("initialize", {
          protocolVersion: this.protocol,
          capabilities: {},
          clientInfo: { name: "truex-omni-gateway", version: "0.1.0" },
        });
        if (
          !object(result) ||
          !["2024-11-05", "2025-03-26", "2025-06-18"].includes(
            result.protocolVersion,
          )
        )
          throw new Error("Unsupported downstream MCP protocol version");
        this.protocol = result.protocolVersion;
        const response = await this.fetcher(this.config.url, {
          method: "POST",
          headers: this.headers(),
          redirect: "error",
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
          signal: AbortSignal.any([this.stopped, AbortSignal.timeout(30000)]),
        });
        await response.body?.cancel();
        if (!response.ok)
          throw new Error(
            `Downstream MCP initialization HTTP ${response.status}`,
          );
      })().catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  tools(signal?: AbortSignal): Promise<Tool[]> {
    if (!this.catalog)
      this.catalog = (async () => {
        await this.initialize();
        const tools: Tool[] = [],
          cursors = new Set<string>(),
          names = new Set<string>();
        let catalogBytes = 0;
        let cursor: string | undefined;
        do {
          const page = await this.rpc("tools/list", cursor ? { cursor } : {});
          if (!Array.isArray(page.tools))
            throw new Error("Invalid downstream tool catalog");
          catalogBytes += Buffer.byteLength(JSON.stringify(page.tools));
          if (catalogBytes > MAX_BYTES)
            throw new Error("Tool catalog exceeds 8 MiB");
          for (const tool of page.tools) {
            if (
              !object(tool) ||
              typeof tool.name !== "string" ||
              !tool.name ||
              !object(tool.inputSchema) ||
              names.has(tool.name)
            )
              throw new Error(
                "Invalid or duplicate downstream tool definition",
              );
            names.add(tool.name);
          }
          tools.push(...page.tools);
          cursor = page.nextCursor;
          if (cursor && (typeof cursor !== "string" || cursors.has(cursor)))
            throw new Error("Invalid catalog pagination");
          if (cursor) cursors.add(cursor);
          if (tools.length > 10000 || cursors.size > 100)
            throw new Error("Tool catalog exceeds gateway limits");
        } while (cursor);
        return tools.filter(
          (t) =>
            typeof t.name === "string" &&
            object(t.inputSchema) &&
            (!this.config.enabled_tools ||
              this.config.enabled_tools.includes(t.name)) &&
            !this.config.disabled_tools?.includes(t.name),
        );
      })().catch((error) => {
        this.catalog = undefined;
        this.ready = undefined;
        throw error;
      });
    return withSignal(this.catalog, signal);
  }
  async call(tool: string, args: any, signal?: AbortSignal) {
    await this.initialize();
    // A failed call may have executed remotely. Never retry it automatically.
    try {
      return await this.rpc(
        "tools/call",
        { name: tool, arguments: args },
        signal,
      );
    } catch (error) {
      this.catalog = undefined;
      this.ready = undefined;
      throw error;
    }
  }
}

/** Agent-scoped registry + authenticated loopback proxy, outside the pinned Codex tree. */
export class OmniMcpGateway {
  private readonly stopped = new AbortController();
  private readonly authToken = randomBytes(32).toString("hex");
  private readonly connectors = new Map<string, NativeConnector>();
  private readonly schemas = new Map<
    string,
    { source: string; validate: ReturnType<Ajv["compile"]> }
  >();
  private readonly ajv = new Ajv({
    strict: false,
    validateFormats: false,
    allErrors: true,
  });
  private readonly redactor = new Redactor();
  private server?: Server;
  private baseUrl?: string;
  private starting?: Promise<void>;
  private readonly activeRequests = new Map<string, AbortController>();
  private readonly toolDefinitions: Tool[];
  private readonly checks: Map<string, ValidateFunction<any>>;
  constructor(
    configs: Record<string, ConnectorConfig>,
    readonly onEvent?: (event: GatewayEvent) => void,
    fetcher: typeof fetch = fetch,
    private readonly options: OmniMcpGatewayOptions = {},
  ) {
    this.toolDefinitions = structuredClone(omniTools);
    if (options.requireProjection) {
      const invoke = this.toolDefinitions.find(
        (tool) => tool.name === "invoke_tool",
      )!;
      invoke.description =
        "Call a discovered tool with validated arguments. Required fields selects only needed JSON fields using dotted paths (arrays traversed automatically), e.g. apps.name, apps.guid, pagination. Choose a minimal response for the user's question. Use fields ['*'] alone only when the full result is intentionally needed or the response is not JSON. Calls require approval; projection does not authorize an action.";
      invoke.inputSchema.required.push("fields");
      invoke.inputSchema.properties.fields.description =
        "Required response field paths. Prefer only answer fields plus follow-up IDs and pagination. ['*'] alone explicitly requests the full original result.";
      const schema = this.toolDefinitions.find(
        (tool) => tool.name === "get_tool_schema",
      )!;
      schema.description +=
        " Choose needed response paths for invoke_tool.fields; use ['*'] only for an intentionally full result.";
    }
    this.checks = new Map(
      this.toolDefinitions.map((tool) => [
        tool.name,
        this.ajv.compile<any>(tool.inputSchema),
      ]),
    );
    for (const [name, config] of Object.entries(configs)) {
      if (config.enabled === false) continue;
      const url = new URL(config.url);
      if (
        config.command ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("Omni connectors must use approved HTTP URLs");
      this.redactor.remember(config);
      this.connectors.set(
        name,
        new NativeConnector(config, this.stopped.signal, fetcher),
      );
    }
  }
  private event(type: string, data: any) {
    try {
      this.onEvent?.({
        type,
        at: new Date().toISOString(),
        ...this.redactor.clean(data),
      });
    } catch {
      /* Observability must not change the outcome of a remote action. */
    }
  }
  private connector(name: string) {
    const connector = this.connectors.get(name);
    if (!connector) throw new Error("Server is not attached to this agent");
    return connector;
  }
  private async tool(server: string, name: string, signal: AbortSignal) {
    const tool = (await this.connector(server).tools(signal)).find(
      (t) => t.name === name,
    );
    if (!tool) throw new Error("Tool is not enabled on the attached server");
    return tool;
  }
  private async execute(name: string, args: any, signal: AbortSignal) {
    const check = this.checks.get(name);
    if (!check || !check(args))
      throw new Error("Invalid gateway tool arguments");
    if (name === "discover_server") {
      const query = args.query.toLowerCase();
      return textResult({
        servers: [...this.connectors.keys()]
          .filter(
            (n) =>
              !query ||
              query.includes(n.toLowerCase()) ||
              n.toLowerCase().includes(query),
          )
          .map((name) => ({ name })),
      });
    }
    if (name === "discover_tools") {
      let tools = await this.connector(args.server).tools(signal);
      if (args.query) {
        const words = args.query.toLowerCase().split(/\W+/).filter(Boolean);
        tools = tools.filter((t) =>
          words.some((w: string) =>
            `${t.name} ${t.description || ""}`.toLowerCase().includes(w),
          ),
        );
      }
      return textResult({
        server: args.server,
        tools: tools.slice(0, 100).map((t) => ({
          name: t.name,
          description: t.description?.slice(0, 240),
        })),
        totalMatched: tools.length,
        truncated: tools.length > 100,
      });
    }
    const tool = await this.tool(args.server, args.tool, signal);
    if (name === "get_tool_schema")
      return textResult({
        server: args.server,
        tool: tool.name,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
        ...(this.options.requireProjection
          ? {
              responseProjection:
                "invoke_tool.fields is required: choose only needed dotted response paths (arrays traversed automatically), such as apps.name, apps.guid, pagination. ['*'] alone intentionally returns the full result. If outputSchema is absent, use tool documentation to infer paths; non-JSON responses require ['*'].",
            }
          : {}),
      });
    // Validate projection before executing, so invalid fields never trigger a side effect.
    const fullResult =
      this.options.requireProjection &&
      args.fields?.length === 1 &&
      args.fields[0] === "*";
    if (args.fields && !fullResult) projectFields({}, args.fields);
    const key = JSON.stringify([args.server, args.tool]);
    const source = JSON.stringify(tool.inputSchema);
    if (this.schemas.get(key)?.source !== source)
      this.schemas.set(key, {
        source,
        validate: this.ajv.compile(tool.inputSchema),
      });
    if (!this.schemas.get(key)!.validate(args.arguments))
      throw new Error("Arguments do not match the downstream tool schema");
    const started = performance.now();
    const result = await this.connector(args.server).call(
      args.tool,
      args.arguments,
      signal,
    );
    let projected = result;
    if (args.fields && !fullResult && !result.isError) {
      const original = parseData(result);
      const data = projectFields(original, args.fields);
      const hasPath = (v: any, parts: string[]): boolean =>
        !parts.length ||
        (Array.isArray(v)
          ? !v.length || v.some((item) => hasPath(item, parts))
          : object(v) &&
            Object.hasOwn(v, parts[0]) &&
            hasPath(v[parts[0]], parts.slice(1)));
      if (
        !args.fields.some((field: string) =>
          hasPath(original, field.split(".")),
        )
      )
        throw new Error(
          "Downstream action completed, but selected fields are absent. Do not repeat the action automatically.",
        );
      projected = {
        ...textResult(data),
        ...(result.structuredContent !== undefined
          ? { structuredContent: data }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
      // Original metadata may duplicate the full payload and bypass projection.
      delete projected._meta;
    }
    this.event("invoke", {
      server: args.server,
      tool: args.tool,
      arguments: args.arguments,
      fields: args.fields,
      durationMs: performance.now() - started,
      inputBytes: Buffer.byteLength(JSON.stringify(result)),
      outputBytes: Buffer.byteLength(JSON.stringify(projected)),
      result,
      projected,
    });
    return projected;
  }
  async start(): Promise<{
    url: string;
    http_headers: Record<string, string>;
    default_tools_approval_mode: string;
    tools: Record<string, any>;
  }> {
    if (this.stopped.signal.aborted) throw new Error("Omni gateway is closed");
    if (!this.starting)
      this.starting = (async () => {
        this.server = createServer(async (req, res) => {
          const auth = req.headers.authorization || "";
          const expected = `Bearer ${this.authToken}`;
          if (
            req.url !== "/mcp" ||
            req.headers.origin ||
            Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
          ) {
            res.writeHead(403).end();
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end();
            return;
          }
          let id: any = null;
          let requestKey: string | undefined;
          const aborted = new AbortController();
          res.on("close", () => {
            if (!res.writableEnded) aborted.abort();
          });
          try {
            let bytes = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) {
                res.writeHead(413).end();
                return;
              }
              chunks.push(Buffer.from(chunk));
            }
            const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!object(rpc) || rpc.jsonrpc !== "2.0")
              throw new Error("Invalid JSON-RPC message");
            if (rpc.id === undefined) {
              if (rpc.method === "notifications/cancelled")
                this.activeRequests
                  .get(JSON.stringify(rpc.params?.requestId))
                  ?.abort(new Error("MCP request cancelled"));
              res.writeHead(202).end();
              return;
            }
            id = rpc.id;
            if (id !== null && typeof id !== "number" && typeof id !== "string")
              throw new Error("Invalid JSON-RPC id");
            let result: any;
            if (rpc.method === "initialize")
              result = {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "truex-omni", version: "0.1.0" },
              };
            else if (rpc.method === "tools/list")
              result = { tools: this.toolDefinitions };
            else if (rpc.method === "ping") result = {};
            else if (rpc.method === "tools/call") {
              requestKey = JSON.stringify(id);
              if (this.activeRequests.has(requestKey))
                throw new Error("Duplicate active RPC id");
              this.activeRequests.set(requestKey, aborted);
              try {
                this.event("call", {
                  tool: rpc.params?.name,
                  arguments: rpc.params?.arguments,
                });
                result = await this.execute(
                  rpc.params?.name,
                  rpc.params?.arguments,
                  AbortSignal.any([
                    aborted.signal,
                    this.stopped.signal,
                    AbortSignal.timeout(120000),
                  ]),
                );
              } catch (error: any) {
                const message = this.redactor.clean(String(error.message));
                this.event("error", { tool: rpc.params?.name, message });
                result = {
                  ...textResult(
                    error instanceof DownstreamRpcError
                      ? { error: this.redactor.clean(error.detail) }
                      : { error: message },
                  ),
                  isError: true,
                };
              }
            } else {
              res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Method not supported" },
                }),
              );
              return;
            }
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
          } catch {
            if (!res.headersSent)
              res.writeHead(400, { "content-type": "application/json" }).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32600, message: "Invalid MCP request" },
                }),
              );
          } finally {
            if (requestKey && this.activeRequests.get(requestKey) === aborted)
              this.activeRequests.delete(requestKey);
          }
        });
        this.server.listen(0, "127.0.0.1");
        await once(this.server, "listening");
        this.baseUrl = `http://127.0.0.1:${(this.server.address() as any).port}/mcp`;
      })();
    await this.starting;
    return {
      url: this.baseUrl!,
      http_headers: { Authorization: `Bearer ${this.authToken}` },
      default_tools_approval_mode: "prompt",
      tools: Object.fromEntries(
        this.toolDefinitions.map((t) => [
          t.name,
          { approval_mode: t.name === "invoke_tool" ? "prompt" : "approve" },
        ]),
      ),
    };
  }
  close() {
    this.stopped.abort();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}

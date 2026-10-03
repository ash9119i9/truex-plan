import type { ConnectorConfig } from "./omni-mcp-gateway";

export interface TransportToolV2 {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
  outputSchema?: Record<string, any>;
  annotations?: Record<string, any>;
}
export type TransportStageV2 =
  "initialize" | "notifications/initialized" | "tools/list" | "tools/call";
export interface TransportEventV2 {
  type: string;
  stage: TransportStageV2;
  at: string;
  [key: string]: unknown;
}
export class McpTransportErrorV2 extends Error {
  constructor(
    message: string,
    readonly stage: TransportStageV2,
    readonly kind: "timeout" | "network" | "http" | "protocol" | "cancelled",
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}
const MAX_BYTES = 8 * 1024 * 1024;
const object = (value: any): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

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

export class DownstreamRpcErrorV2 extends Error {
  constructor(readonly detail: any) {
    super(String(detail.message || "Downstream MCP error"));
  }
}

function rpcValue(value: any, id: number): any | undefined {
  const match = (Array.isArray(value) ? value : [value]).find(
    (v) => v?.id === id,
  );
  if (!match) return undefined;
  if (match.error) throw new DownstreamRpcErrorV2(match.error);
  if (!Object.hasOwn(match, "result"))
    throw new Error("Invalid downstream MCP response");
  return { result: match.result };
}

async function readRpc(response: Response, id: number): Promise<any> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Downstream MCP HTTP ${response.status}`);
  }
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
    // The matched RPC result is complete. Stream cleanup must not stall or
    // reclassify a successful action if the source never settles cancellation.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Best effort transport cleanup. */
    }
  }
}

export class McpTransportV2 {
  private nextId = 1;
  private sessionId?: string;
  private protocol = "2025-03-26";
  private ready?: Promise<void>;
  private catalog?: Promise<TransportToolV2[]>;
  private epoch = 0;
  private metadata = new AbortController();
  private metadataStage: TransportStageV2 = "initialize";
  constructor(
    readonly config: ConnectorConfig,
    private stopped: AbortSignal,
    private fetcher: typeof fetch,
    private readonly onEvent?: (event: TransportEventV2) => void,
  ) {}
  private event(stage: TransportStageV2, data: Record<string, unknown>) {
    try {
      this.onEvent?.({
        type: "transport_stage",
        stage,
        at: new Date().toISOString(),
        ...data,
      });
    } catch {
      /* Tracing cannot alter an RPC outcome. */
    }
  }
  private headers() {
    const headers = new Headers(this.config.http_headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    headers.set("MCP-Protocol-Version", this.protocol);
    headers.delete("Mcp-Session-Id");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    return headers;
  }
  private async rpc(
    method: TransportStageV2,
    params: any,
    signal?: AbortSignal,
    epoch?: number,
  ) {
    if (epoch !== undefined) this.metadataStage = method;
    const id = this.nextId++;
    const started = performance.now(),
      startedAt = new Date().toISOString();
    let timeToHeadersMs: number | undefined;
    this.event(method, { phase: "started", startedAt });
    const timeout =
      method === "tools/call"
        ? this.config.tool_timeout_sec
        : this.config.startup_timeout_sec;
    const combined = AbortSignal.any([
      this.stopped,
      ...(signal ? [signal] : []),
      ...(epoch !== undefined ? [this.metadata.signal] : []),
      AbortSignal.timeout(
        Math.ceil((timeout || (method === "tools/call" ? 120 : 30)) * 1000),
      ),
    ]);
    try {
      const response = await this.fetcher(this.config.url, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: combined,
      });
      timeToHeadersMs = performance.now() - started;
      if (epoch !== undefined && epoch !== this.epoch) {
        void response.body?.cancel().catch(() => {});
        throw new McpTransportErrorV2(
          "Metadata request invalidated",
          method,
          "cancelled",
          false,
        );
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new McpTransportErrorV2(
          `Downstream MCP HTTP ${response.status}`,
          method,
          "http",
          [408, 429].includes(response.status) || response.status >= 500,
          response.status,
        );
      }
      if (method === "initialize")
        this.sessionId = response.headers.get("mcp-session-id") || undefined;
      const result = await readRpc(response, id);
      if (epoch !== undefined && epoch !== this.epoch)
        throw new McpTransportErrorV2(
          "Metadata request invalidated",
          method,
          "cancelled",
          false,
        );
      this.event(method, {
        phase: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        timeToHeadersMs,
        httpStatus: response.status,
        ...(method === "tools/list"
          ? {
              toolCount: Array.isArray(result.tools)
                ? result.tools.length
                : null,
            }
          : {}),
      });
      return result;
    } catch (error: any) {
      this.event(method, {
        phase: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        timeToHeadersMs: timeToHeadersMs ?? null,
        httpStatus:
          error instanceof McpTransportErrorV2 ? (error.status ?? null) : null,
        errorKind:
          error instanceof McpTransportErrorV2
            ? error.kind
            : combined.reason?.name === "TimeoutError" ||
                error?.name === "TimeoutError"
              ? "timeout"
              : combined.aborted
                ? "cancelled"
                : "protocol_or_network",
        timedOut:
          combined.reason?.name === "TimeoutError" ||
          error?.name === "TimeoutError",
      });
      if (
        error instanceof McpTransportErrorV2 ||
        error instanceof DownstreamRpcErrorV2
      )
        throw error;
      const reason = combined.reason;
      const timedOut =
        error?.name === "TimeoutError" || reason?.name === "TimeoutError";
      const cancelled = combined.aborted && !timedOut;
      const protocol =
        error instanceof SyntaxError ||
        /empty downstream|invalid downstream|stream ended|exceeds 8 MiB/i.test(
          String(error?.message),
        );
      throw new McpTransportErrorV2(
        String(error?.message || "MCP request failed"),
        method,
        timedOut
          ? "timeout"
          : cancelled
            ? "cancelled"
            : protocol
              ? "protocol"
              : "network",
        timedOut || (!cancelled && !protocol),
      );
    }
  }
  private initialize(signal?: AbortSignal) {
    if (!this.ready) {
      const epoch = this.epoch;
      const pending = (async () => {
        this.sessionId = undefined;
        const result = await this.rpc(
          "initialize",
          {
            protocolVersion: this.protocol,
            capabilities: {},
            clientInfo: { name: "truex-omni-gateway", version: "0.1.0" },
          },
          signal,
          epoch,
        );
        if (
          !object(result) ||
          !["2024-11-05", "2025-03-26", "2025-06-18"].includes(
            result.protocolVersion,
          )
        )
          throw new McpTransportErrorV2(
            "Unsupported downstream MCP protocol version",
            "initialize",
            "protocol",
            false,
          );
        this.protocol = result.protocolVersion;
        this.metadataStage = "notifications/initialized";
        const notificationStarted = performance.now(),
          notificationStartedAt = new Date().toISOString();
        this.event("notifications/initialized", {
          phase: "started",
          startedAt: notificationStartedAt,
        });
        const notificationSignal = AbortSignal.any([
          this.stopped,
          this.metadata.signal,
          ...(signal ? [signal] : []),
          AbortSignal.timeout(
            Math.ceil((this.config.startup_timeout_sec || 30) * 1000),
          ),
        ]);
        let response: Response;
        try {
          response = await this.fetcher(this.config.url, {
            method: "POST",
            headers: this.headers(),
            redirect: "error",
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
            }),
            signal: notificationSignal,
          });
        } catch (error: any) {
          const timedOut =
            error?.name === "TimeoutError" ||
            notificationSignal.reason?.name === "TimeoutError";
          this.event("notifications/initialized", {
            phase: "failed",
            startedAt: notificationStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: performance.now() - notificationStarted,
            timeToHeadersMs: null,
            timedOut,
            errorKind: timedOut
              ? "timeout"
              : notificationSignal.aborted
                ? "cancelled"
                : "network",
          });
          throw new McpTransportErrorV2(
            String(error?.message || "MCP initialized notification failed"),
            "notifications/initialized",
            timedOut
              ? "timeout"
              : notificationSignal.aborted
                ? "cancelled"
                : "network",
            timedOut || !notificationSignal.aborted,
          );
        }
        void response.body?.cancel().catch(() => {});
        if (!response.ok) {
          this.event("notifications/initialized", {
            phase: "failed",
            startedAt: notificationStartedAt,
            completedAt: new Date().toISOString(),
            durationMs: performance.now() - notificationStarted,
            timeToHeadersMs: performance.now() - notificationStarted,
            httpStatus: response.status,
            errorKind: "http",
            timedOut: false,
          });
          throw new McpTransportErrorV2(
            `Downstream MCP initialization HTTP ${response.status}`,
            "notifications/initialized",
            "http",
            [408, 429].includes(response.status) || response.status >= 500,
            response.status,
          );
        }
        if (epoch !== this.epoch)
          throw new McpTransportErrorV2(
            "Metadata request invalidated",
            "notifications/initialized",
            "cancelled",
            false,
          );
        this.event("notifications/initialized", {
          phase: "completed",
          startedAt: notificationStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: performance.now() - notificationStarted,
          timeToHeadersMs: performance.now() - notificationStarted,
          httpStatus: response.status,
        });
      })().catch((error) => {
        if (this.ready === pending) this.ready = undefined;
        throw error;
      });
      this.ready = pending;
    }
    return withSignal(this.ready, signal);
  }
  invalidate() {
    this.metadata.abort(new Error("Metadata invalidated"));
    this.metadata = new AbortController();
    this.epoch++;
    this.ready = undefined;
    this.catalog = undefined;
    this.sessionId = undefined;
  }
  tools(signal?: AbortSignal): Promise<TransportToolV2[]> {
    if (!this.catalog) {
      const epoch = this.epoch;
      const pending = (async () => {
        await this.initialize(signal);
        const tools: TransportToolV2[] = [],
          cursors = new Set<string>(),
          names = new Set<string>();
        let catalogBytes = 0;
        let cursor: string | undefined;
        do {
          const page = await this.rpc(
            "tools/list",
            cursor ? { cursor } : {},
            signal,
            epoch,
          );
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
        if (this.catalog === pending) {
          this.catalog = undefined;
          this.ready = undefined;
          this.sessionId = undefined;
        }
        throw error;
      });
      this.catalog = pending;
    }
    return withSignal(this.catalog, signal).catch((error: any) => {
      if (
        error instanceof McpTransportErrorV2 ||
        error instanceof DownstreamRpcErrorV2
      )
        throw error;
      const timedOut =
        error?.name === "TimeoutError" ||
        signal?.reason?.name === "TimeoutError";
      const cancelled = signal?.aborted && !timedOut;
      throw new McpTransportErrorV2(
        String(error?.message || "Metadata hydration failed"),
        this.metadataStage,
        timedOut ? "timeout" : cancelled ? "cancelled" : "protocol",
        timedOut,
      );
    });
  }
  async call(tool: string, args: any, signal?: AbortSignal) {
    await this.initialize(signal);
    // A failed call may have executed remotely. Never retry it automatically.
    try {
      return await this.rpc(
        "tools/call",
        { name: tool, arguments: args },
        signal,
      );
    } catch (error) {
      // A timed out/cancelled action does not invalidate independently usable schemas.
      if (
        error instanceof McpTransportErrorV2 &&
        !["timeout", "cancelled"].includes(error.kind)
      )
        this.invalidate();
      throw error;
    }
  }
}

// The host side of the MCP Apps bridge (spec 2026-01-26): JSON-RPC 2.0 between
// Truex and one app page, carried over postMessage. It does no I/O of its own.
//
// What Truex does: starts the app, hands it its tool call's input and result,
// follows its size, and tells it the theme. What it does not do yet: let an
// app call tools, read resources, send messages, open links or download files.
// Those are refused, and not advertised, so an app that checks capabilities
// leaves them out.

import type { McpAppToolResult } from "../../shared/mcp-apps";

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
/** Messages bigger than this are refused. */
export const MAX_MCP_APP_MESSAGE_BYTES = 256 * 1024;
export const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_MAX_HEIGHT = 2000;
export const MCP_APP_DEFAULT_HEIGHT = 320;

export interface McpAppHostContext {
  theme: "light" | "dark";
  displayMode: "inline";
  availableDisplayModes: ["inline"];
  containerDimensions: { width: number; maxHeight: number };
  platform: "web";
  locale?: string;
  timeZone?: string;
  styles: { variables: Record<string, string> };
}

export interface McpAppToolCall {
  arguments: Record<string, unknown>;
  result: McpAppToolResult | null;
}

export interface McpAppHostOptions {
  /** Posts one JSON-RPC message to the app page. */
  post: (message: unknown) => void;
  hostContext: () => McpAppHostContext;
  /** The app reported its content size. */
  onSizeChanged: (size: { width?: number; height?: number }) => void;
  /** The app finished starting and has been handed its tool call. */
  onReady?: () => void;
  hostVersion?: string;
}

export interface McpAppHost {
  /** Handles one message the app posted; the caller has checked its source. */
  receive: (data: unknown) => void;
  /** The tool call's input and result; the app gets them once it is ready. */
  setToolCall: (call: McpAppToolCall) => void;
  /** Tells the app what changed in the host context since it last looked. */
  updateHostContext: () => void;
  dispose: () => void;
}

type JsonRpcId = string | number;
const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Requests an app may make that Truex declines. They get an error, not silence.
const UNSUPPORTED = new Set([
  "tools/call",
  "tools/list",
  "resources/read",
  "resources/list",
  "resources/templates/list",
  "ui/open-link",
  "ui/message",
  "ui/request-display-mode",
  "ui/update-model-context",
  "ui/download-file",
]);

/** A frame height the host will give an app: whole pixels, within bounds. */
export function mcpAppHeight(height: unknown): number | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  return Math.min(
    MCP_APP_MAX_HEIGHT,
    Math.max(MCP_APP_MIN_HEIGHT, Math.ceil(height)),
  );
}

export function createMcpAppHost(options: McpAppHostOptions): McpAppHost {
  let disposed = false;
  let initialized = false;
  let toolCall: McpAppToolCall | undefined;
  let toolCallSent = false;
  let sentContext: McpAppHostContext | undefined;
  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) =>
    post({ jsonrpc: "2.0", method, params });
  const respond = (id: JsonRpcId, result: unknown) =>
    post({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const sendToolCall = () => {
    if (!initialized || !toolCall || toolCallSent) return;
    toolCallSent = true;
    notify("ui/notifications/tool-input", { arguments: toolCall.arguments });
    if (toolCall.result)
      notify("ui/notifications/tool-result", toolCall.result);
  };

  const handleRequest = (id: JsonRpcId, method: string) => {
    if (method === "ui/initialize") {
      sentContext = options.hostContext();
      respond(id, {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        hostInfo: { name: "truex", version: options.hostVersion ?? "1" },
        // Only what Truex does. An app that checks will leave out the rest.
        hostCapabilities: { logging: {}, sandbox: {} },
        hostContext: sentContext,
      });
    } else if (method === "ping") respond(id, {});
    else if (UNSUPPORTED.has(method))
      fail(id, -32000, "Truex does not support this for apps yet.");
    else fail(id, -32601, "Method not found.");
  };

  const handleNotification = (
    method: string,
    params: Record<string, unknown>,
  ) => {
    if (method === "ui/notifications/initialized") {
      if (initialized) return;
      initialized = true;
      sendToolCall();
      options.onReady?.();
      // The theme or size may have changed since the initialize response.
      handle.updateHostContext();
    } else if (method === "ui/notifications/size-changed") {
      const width = typeof params.width === "number" ? params.width : undefined;
      const height =
        typeof params.height === "number" ? params.height : undefined;
      if (width !== undefined || height !== undefined)
        options.onSizeChanged({
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        });
    }
    // Logging and anything unknown is ignored.
  };

  const handle: McpAppHost = {
    receive(data) {
      if (disposed || !isObject(data) || data.jsonrpc !== "2.0") return;
      if (jsonBytes(data) > MAX_MCP_APP_MESSAGE_BYTES) {
        if (isId(data.id) && typeof data.method === "string")
          fail(data.id, -32600, "Message too large.");
        return;
      }
      const method = data.method;
      // Responses to requests the host never sends need no handling.
      if (typeof method !== "string") return;
      const params = isObject(data.params) ? data.params : {};
      if (isId(data.id)) handleRequest(data.id, method);
      else handleNotification(method, params);
    },
    setToolCall(call) {
      toolCall = call;
      sendToolCall();
    },
    updateHostContext() {
      if (disposed || !initialized || !sentContext) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as (keyof McpAppHostContext)[])
        if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key]))
          changes[key] = next[key];
      if (!Object.keys(changes).length) return;
      sentContext = next;
      notify("ui/notifications/host-context-changed", changes);
    },
    dispose() {
      disposed = true;
    },
  };
  return handle;
}

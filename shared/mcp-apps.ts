// MCP Apps: a connector tool that declares a UI page (a `ui://` resource) shows
// that page in the conversation, fed the tool's input and result. These are the
// rules every service shares. See docs/MCP_APPS.md.

/** The only page type an MCP App serves. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";
/** Largest page the host will read. */
export const MAX_MCP_APP_BYTES = 1_048_576;
/** Largest tool input, and largest tool result, handed to a page. */
export const MAX_MCP_APP_DATA_BYTES = 262_144;
/** Apps remembered per conversation; the oldest are dropped. */
export const MAX_MCP_APPS = 20;

/** What the browser is told about an app in the conversation. No data. */
export interface McpAppRef {
  /**
   * A URL-safe id for the app, derived from the tool call's id (which the
   * model provider chose and the browser never sees).
   */
  id: string;
  turnId?: string;
  server: string;
  tool: string;
}
/** The finished tool call an app comes from. */
export interface McpAppCall extends Omit<McpAppRef, "id"> {
  callId: string;
}
/** An app id as the services accept it in a path. */
export const mcpAppIdPattern = /^[A-Za-z0-9_-]{16,64}$/;

/** A tool result as an MCP App accepts it. */
export interface McpAppToolResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** An app ready to show: its page and the call that produced it. */
export interface McpApp extends McpAppRef {
  html: string;
  arguments: Record<string, unknown>;
  result: McpAppToolResult | null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A call id is provider-chosen text; it is only ever compared and encoded. */
export const validCallId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value);

const validUi = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 2048 &&
  value.startsWith("ui://") &&
  value.length > "ui://".length &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f\s]/.test(value);

/**
 * The page a finished tool call declared, or null. The runtime reports it in
 * `mcpAppUi` (newer tool descriptors), `mcpAppResourceUri` (the older field,
 * which is what a tool with `_meta.ui.resourceUri` fills) or the connector
 * `appContext`. Anything but a `ui://` address is ignored.
 */
export function mcpAppResourceUri(item: unknown): string | null {
  if (!isObject(item) || item.type !== "mcpToolCall") return null;
  const ui = isObject(item.mcpAppUi) ? item.mcpAppUi.resourceUri : undefined;
  const context = isObject(item.appContext)
    ? item.appContext.resourceUri
    : undefined;
  for (const candidate of [ui, item.mcpAppResourceUri, context])
    if (validUi(candidate)) return candidate;
  return null;
}

/** The finished call, if it has a page, or null. */
export function mcpAppCall(item: unknown, turnId?: string): McpAppCall | null {
  if (!isObject(item) || item.status !== "completed") return null;
  if (!validCallId(item.id) || !mcpAppResourceUri(item)) return null;
  const name = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 120) : "";
  return {
    callId: item.id,
    ...(typeof turnId === "string" && turnId ? { turnId } : {}),
    server: name(item.server),
    tool: name(item.tool),
  };
}

/** Whether a resource's type is an MCP App page (parameters may follow). */
export function isMcpAppMime(mime: unknown): boolean {
  if (typeof mime !== "string") return false;
  const [type, ...parameters] = mime
    .toLowerCase()
    .split(";")
    .map((part) => part.trim());
  return (
    type === "text/html" &&
    parameters.some((part) => part.replace(/\s/g, "") === "profile=mcp-app")
  );
}

/**
 * A tool result in the shape the MCP Apps SDK accepts. Providers can report
 * absent fields as null (Codex sends `_meta: null`), which the SDK rejects,
 * dropping the whole message.
 */
export function mcpAppToolResult(result: unknown): McpAppToolResult | null {
  if (!isObject(result)) return null;
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(isObject(result.structuredContent)
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(isObject(result._meta) ? { _meta: result._meta } : {}),
  };
}

/** Serialized size, or Infinity for something that cannot be serialized. */
export function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

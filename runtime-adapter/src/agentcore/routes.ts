import { id, type ChatRef } from "../contract";
import { AdapterError } from "../errors";
import { MAX_FILE_BYTES } from "../runtime/files";
import { MAX_SKILL_ARCHIVE_BYTES } from "../runtime/skills";

// What one /invocations body may ask for: exactly one adapter operation,
// named by method and path, with its query, JSON body or base64 bytes.
// Anything outside the adapter's routes is refused here, before the adapter
// starts. The adapter still validates every field itself.
//
//   {"method":"POST","path":"/v1/runs","body":{...}}
//   {"method":"GET","path":"/v1/runs/r1/events","query":{"tenantId":"t","chatId":"c","after":"12"}}
//   {"method":"PUT","path":"/v1/chats/c/uploads/a.png","query":{"tenantId":"t","sha256":"..."},"bodyBase64":"..."}

export type InvocationMethod = "GET" | "POST" | "PUT";

export interface Invocation {
  readonly method: InvocationMethod;
  // Path and query string, ready to send to the adapter.
  readonly target: string;
  // The chat the request belongs to, which selects its runtime session.
  readonly chat: ChatRef;
  // POST routes.
  readonly json?: unknown;
  // PUT routes.
  readonly bytes?: { readonly data: Buffer; readonly contentType: string };
}

// Where a route names its chat.
type ChatSource = "body" | "query" | "path";

interface Route {
  readonly method: InvocationMethod;
  // Segments after /v1; "*" matches any one segment.
  readonly segments: readonly string[];
  readonly chat: ChatSource;
  readonly query: readonly string[];
  // PUT routes: the body's content type and largest decoded size.
  readonly upload?: { readonly contentType: string; readonly maxBytes: number };
}

// The adapter's routes (src/server.ts), except the unauthenticated /health.
const ROUTES: readonly Route[] = [
  { method: "POST", segments: ["runs"], chat: "body", query: [] },
  {
    method: "GET",
    segments: ["runs", "*", "events"],
    chat: "query",
    query: ["tenantId", "chatId", "after"],
  },
  { method: "POST", segments: ["runs", "*", "stop"], chat: "body", query: [] },
  { method: "POST", segments: ["runs", "*", "steer"], chat: "body", query: [] },
  {
    method: "POST",
    segments: ["runs", "*", "approvals", "*"],
    chat: "body",
    query: [],
  },
  {
    method: "GET",
    segments: ["chats", "*", "history"],
    chat: "path",
    query: ["tenantId"],
  },
  {
    method: "GET",
    segments: ["chats", "*", "files"],
    chat: "path",
    query: ["tenantId"],
  },
  {
    method: "GET",
    segments: ["chats", "*", "file"],
    chat: "path",
    query: ["tenantId", "path"],
  },
  {
    method: "PUT",
    segments: ["chats", "*", "uploads", "*"],
    chat: "path",
    query: ["tenantId", "sha256"],
    upload: {
      contentType: "application/octet-stream",
      maxBytes: MAX_FILE_BYTES,
    },
  },
  {
    method: "PUT",
    segments: ["chats", "*", "skills", "*"],
    chat: "path",
    query: ["tenantId"],
    upload: {
      contentType: "application/gzip",
      maxBytes: MAX_SKILL_ARCHIVE_BYTES,
    },
  },
];

// The largest /invocations body: the largest upload as base64, plus framing.
export const MAX_INVOCATION_BYTES =
  Math.ceil(Math.max(MAX_FILE_BYTES, MAX_SKILL_ARCHIVE_BYTES) / 3) * 4 +
  64 * 1024;

const FIELDS = ["method", "path", "query", "body", "bodyBase64"];
const MAX_PATH = 1024;
const MAX_QUERY_VALUE = 4096;
// One percent-encoded path segment (encodeURIComponent output).
const SEGMENT = /^(?:[A-Za-z0-9\-._~!*'()]|%[0-9A-Fa-f]{2})+$/;
// Encoded "/" and "\" would let one segment act as several.
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function invalid(message: string): never {
  throw new AdapterError("INVALID_REQUEST", message);
}

export function parseInvocation(value: unknown): Invocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("The invocation must be a JSON object.");
  const b = value as Record<string, unknown>;
  for (const key of Object.keys(b))
    if (!FIELDS.includes(key)) invalid(`Unknown field "${key.slice(0, 64)}".`);

  if (b.method !== "GET" && b.method !== "POST" && b.method !== "PUT")
    invalid("method must be GET, POST or PUT.");
  const method = b.method;
  const segments = pathSegments(b.path);
  const route = ROUTES.find(
    (r) =>
      r.method === method &&
      r.segments.length === segments.length &&
      r.segments.every((s, i) => s === "*" || s === segments[i]),
  );
  if (!route) invalid("Unknown route.");

  const query = queryParams(b.query, route.query);
  const json = method === "POST" ? b.body : undefined;
  if (method === "POST" && json === undefined) invalid("body is required.");
  if (method !== "POST" && b.body !== undefined)
    invalid("body is only allowed on POST.");
  if (method !== "PUT" && b.bodyBase64 !== undefined)
    invalid("bodyBase64 is only allowed on PUT.");
  const bytes = route.upload
    ? {
        data: decodeBase64(b.bodyBase64, route.upload.maxBytes),
        contentType: route.upload.contentType,
      }
    : undefined;

  const search = query.toString();
  return {
    method,
    target: `/v1/${segments.join("/")}${search ? `?${search}` : ""}`,
    chat: chatOf(route.chat, segments, query, json),
    ...(json === undefined ? {} : { json }),
    ...(bytes ? { bytes } : {}),
  };
}

function pathSegments(value: unknown): string[] {
  if (typeof value !== "string" || value.length > MAX_PATH)
    invalid(`path must be a string of at most ${MAX_PATH} characters.`);
  if (!value.startsWith("/v1/")) invalid("Unknown route.");
  const segments = value.slice("/v1/".length).split("/");
  for (const segment of segments)
    if (
      !SEGMENT.test(segment) ||
      ENCODED_SEPARATOR.test(segment) ||
      /^\.{1,2}$/.test(decodeSegment(segment))
    )
      invalid("path has an invalid segment.");
  return segments;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    invalid("path has an invalid segment.");
  }
}

function queryParams(value: unknown, allowed: readonly string[]) {
  const params = new URLSearchParams();
  if (value === undefined) return params;
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("query must be a JSON object.");
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.includes(key))
      invalid(`Unknown query field "${key.slice(0, 64)}".`);
    if (typeof v !== "string" || v.length > MAX_QUERY_VALUE)
      invalid(`query.${key} must be a string.`);
    params.set(key, v);
  }
  return params;
}

function chatOf(
  source: ChatSource,
  segments: readonly string[],
  query: URLSearchParams,
  json: unknown,
): ChatRef {
  if (source === "body") {
    if (!json || typeof json !== "object" || Array.isArray(json))
      invalid("body must be a JSON object.");
    const b = json as Record<string, unknown>;
    return {
      tenantId: id(b.tenantId, "tenantId"),
      chatId: id(b.chatId, "chatId"),
    };
  }
  const tenantId = id(query.get("tenantId") ?? undefined, "tenantId");
  if (source === "query")
    return { tenantId, chatId: id(query.get("chatId") ?? undefined, "chatId") };
  return { tenantId, chatId: id(segments[1], "chatId") };
}

function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  )
    invalid("bodyBase64 must be base64.");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maxBytes)
    throw new AdapterError("PAYLOAD_TOO_LARGE");
  return Buffer.from(value, "base64");
}

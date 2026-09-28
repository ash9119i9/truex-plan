import { randomUUID } from "node:crypto";
import { safeErrorMessage } from "./errors";

/** One JSON line per event on stderr so logs stay machine-searchable by
 * requestId, sessionId, threadId or turnId. Messages are redacted. */
export type LogLevel = "debug" | "info" | "warn" | "error";
const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = (): number =>
  rank[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? rank.info;

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (rank[level] < threshold()) return;
  try {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) +
        "\n",
    );
  } catch {
    // Logging must never take down a request (e.g. circular fields).
    process.stderr.write(`${level} ${msg}\n`);
  }
}

/** Serializable, redacted view of an error and its cause chain for logs. */
export function errorFields(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error))
    return { error: safeErrorMessage(String(error)) };
  const e = error as Error & { code?: unknown; status?: unknown; errno?: unknown };
  return {
    error: safeErrorMessage(e.message),
    errorName: e.name,
    ...(e.code !== undefined ? { errorCode: e.code } : {}),
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.errno !== undefined ? { errno: e.errno } : {}),
    ...(e.stack ? { stack: safeErrorMessage(e.stack).slice(0, 4000) } : {}),
    ...(e.cause !== undefined && depth < 3
      ? { cause: errorFields(e.cause, depth + 1) }
      : {}),
  };
}

export const REQUEST_ID_HEADER = "x-request-id";
/** Reuse a well-formed inbound request id, otherwise mint one. */
export function requestId(inbound: unknown): string {
  return typeof inbound === "string" && /^[\w.:-]{1,64}$/.test(inbound)
    ? inbound
    : randomUUID();
}

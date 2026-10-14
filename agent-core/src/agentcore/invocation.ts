import {
  runtimeWindowOption,
  runtimeSyncOption,
} from "../../../shared/runtime-read-options";
import { runtimeResumeResponse } from "../../../shared/runtime-resume-options";

type Method = "GET" | "POST" | "DELETE";
export type Invocation = {
  method: Method;
  path: string;
  body?: unknown;
  cursor?: string;
  requestId?: string;
  window?: boolean;
  sync?: "v1";
};

const segment = "[A-Za-z0-9_-]+";
const thread = `/threads/${segment}`;
const routes: ReadonlyArray<[Method, RegExp]> = [
  ["GET", /^\/(?:livez|healthz|capabilities)$/],
  ["GET", /^\/schemas\/[A-Za-z0-9_]+$/],
  ["POST", /^\/threads$/],
  ["DELETE", new RegExp(`^${thread}$`)],
  [
    "POST",
    new RegExp(
      `^${thread}/(?:resume|approval-mode|turns|steer|interrupt|capabilities)$`,
    ),
  ],
  ["POST", new RegExp(`^${thread}/records/ack$`)],
  ["POST", new RegExp(`^${thread}/approvals/${segment}$`)],
  ["POST", new RegExp(`^${thread}/agents/${segment}/interrupt$`)],
  [
    "GET",
    new RegExp(
      `^${thread}/(?:snapshot|records|items|agents|events|documents)$`,
    ),
  ],
  ["GET", new RegExp(`^${thread}/agents/${segment}$`)],
  ["GET", new RegExp(`^${thread}/turns/${segment}/context$`)],
  ["GET", new RegExp(`^${thread}/(?:documents|visualizations)/${segment}$`)],
  ["POST", new RegExp(`^${thread}/documents$`)],
];

export function parseInvocation(value: unknown): Invocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invocation must be a JSON object");
  const input = value as Record<string, unknown>;
  const method = input.method;
  const path = input.path;
  const cursor = input.cursor;
  const requestId = input.requestId;
  if (method !== "GET" && method !== "POST" && method !== "DELETE")
    throw new Error("Unsupported invocation method");
  if (
    typeof path !== "string" ||
    path.length > 512 ||
    !path.startsWith("/") ||
    path.includes("?")
  )
    throw new Error("Invalid invocation path");
  if (
    !routes.some(
      ([allowedMethod, allowedPath]) =>
        allowedMethod === method && allowedPath.test(path),
    )
  )
    throw new Error("Unsupported invocation path");
  if (
    cursor !== undefined &&
    (method !== "GET" ||
      !/\/threads\/[A-Za-z0-9_-]+\/(?:items|events)$/.test(path) ||
      typeof cursor !== "string" ||
      cursor.length > 128)
  )
    throw new Error("Invalid event cursor");
  if (input.body !== undefined && method !== "POST")
    throw new Error("Only POST invocations can have a body");
  if (method === "POST" && /\/threads\/[A-Za-z0-9_-]+\/resume$/.test(path))
    runtimeResumeResponse(
      (input.body as Record<string, unknown> | null | undefined)?.response,
    );
  const window = runtimeWindowOption(method, path, input.window);
  const sync = runtimeSyncOption(method, path, input.sync);
  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || !/^[\w.-]{1,128}$/.test(requestId))
  )
    throw new Error("Invalid request ID");
  return {
    method,
    path,
    body: input.body,
    cursor: cursor as string | undefined,
    requestId: requestId as string | undefined,
    window,
    sync,
  };
}

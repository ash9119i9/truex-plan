import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { RuntimeLimits } from "./config";
import {
  id,
  parseApproval,
  parseChatRef,
  parseSteer,
  parseStartRun,
} from "./contract";
import { AdapterError } from "./errors";
import {
  chatWorkspace,
  listWorkspace,
  MAX_FILE_BYTES,
  readWorkspaceFile,
} from "./runtime/files";
import type { Logger, RuntimeManager } from "./runtime/manager";
import {
  MAX_SKILL_ARCHIVE_BYTES,
  missingSkills,
  writeSkill,
} from "./runtime/skills";
import { writeUpload } from "./runtime/uploads";
import type { Run, RunEvent } from "./runtime/run";

// The adapter's HTTP surface: authenticated operations plus health.
// Bodies are size-limited JSON; everything else is refused before it reaches
// the runtime.

const MAX_BODY = 256 * 1024;
// A subscriber this far behind is dropped; it reconnects with its cursor.
const MAX_BUFFERED = 4 * 1024 * 1024;

export interface ServerOptions {
  readonly token: string;
  readonly limits: RuntimeLimits;
  readonly manager: RuntimeManager;
  // Where chat workspaces live (AdapterConfig.stateDir).
  readonly stateDir: string;
  readonly log: Logger;
  // Forwarded to request parsing so a body can never relax transport security.
  readonly allowLoopbackMcp: boolean;
}

export function createAdapterServer(options: ServerOptions): Server {
  const expected = digest(options.token);
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const failure =
        error instanceof AdapterError ? error : new AdapterError("INTERNAL");
      if (!(error instanceof AdapterError))
        options.log("http_error", {
          error: error instanceof Error ? error.name : typeof error,
        });
      if (res.headersSent) res.destroy();
      else sendJson(res, failure.status, failure.toBody());
    });
  });
  server.requestTimeout = 0; // runs stream for minutes
  server.headersTimeout = 30_000;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://adapter");
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/health")
      return sendJson(res, 200, {
        status: options.manager.stats.draining ? "draining" : "ok",
        ...options.manager.stats,
      });

    if (!authorized(req.headers.authorization, expected))
      throw new AdapterError("UNAUTHORIZED");

    if (parts[0] !== "v1") throw notFound();
    if (req.method === "POST" && parts.length === 2 && parts[1] === "runs") {
      const request = parseStartRun(await readJson(req), options.limits, {
        allowLoopbackMcp: options.allowLoopbackMcp,
      });
      // Attached images live in uploads/, which only coding chats have.
      if (request.input.images?.length && !options.manager.codingEnabled)
        throw new AdapterError("UPLOADS_DISABLED");
      // Checked on every run, not only the first: a resumed thread reads its
      // skills from disk, and the runtime's storage may have been reset.
      if (request.skills?.length) {
        const missing = await missingSkills(options.stateDir, request.skills);
        if (missing.length > 0)
          throw new AdapterError("SKILLS_MISSING", undefined, {
            missing: missing.map((skill) => skill.sha256),
          });
      }
      const run = options.manager.startRun(request);
      return stream(res, run, 0, options);
    }
    if (parts[1] === "runs" && parts.length === 4) {
      const runId = id(parts[2], "runId");
      if (req.method === "GET" && parts[3] === "events") {
        const ref = parseChatRef(queryRef(url));
        const after = cursor(url.searchParams.get("after"));
        return stream(res, options.manager.getRun(runId, ref), after, options);
      }
      if (req.method === "POST" && parts[3] === "stop") {
        const run = options.manager.stopRun(
          runId,
          parseChatRef(await readJson(req)),
        );
        const finished = run.finishedAt !== undefined;
        return sendJson(res, finished ? 200 : 202, {
          status: finished ? run.status : "stopping",
        });
      }
      if (req.method === "POST" && parts[3] === "steer") {
        const result = await options.manager.steerRun(
          runId,
          parseSteer(await readJson(req)),
        );
        return sendJson(res, 202, result);
      }
    }
    if (
      req.method === "POST" &&
      parts[1] === "runs" &&
      parts.length === 5 &&
      parts[3] === "approvals"
    ) {
      const decision = options.manager.answerApproval(
        id(parts[2], "runId"),
        id(parts[4], "approvalId"),
        parseApproval(await readJson(req)),
      );
      return sendJson(res, 200, { decision });
    }
    if (
      req.method === "GET" &&
      parts[1] === "chats" &&
      parts.length === 4 &&
      parts[3] === "history"
    ) {
      const ref = parseChatRef({
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        chatId: parts[2],
      });
      return sendJson(res, 200, { turns: await options.manager.history(ref) });
    }
    if (
      req.method === "GET" &&
      parts[1] === "chats" &&
      parts.length === 4 &&
      (parts[3] === "files" || parts[3] === "file")
    ) {
      const ref = parseChatRef({
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        chatId: parts[2],
      });
      const workspace = chatWorkspace(options.stateDir, ref);
      if (parts[3] === "files")
        return sendJson(res, 200, await listWorkspace(workspace));
      const data = await readWorkspaceFile(
        workspace,
        url.searchParams.get("path") ?? "",
      );
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.length,
        "cache-control": "no-store",
      });
      return res.end(data);
    }
    if (
      req.method === "PUT" &&
      parts[1] === "chats" &&
      parts.length === 5 &&
      parts[3] === "uploads"
    ) {
      const ref = parseChatRef({
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        chatId: parts[2],
      });
      if (!options.manager.codingEnabled)
        throw new AdapterError("UPLOADS_DISABLED");
      // A run could be reading or rewriting the folder.
      if (options.manager.isRunning(ref)) throw new AdapterError("CHAT_BUSY");
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/octet-stream(\s*;|$)/i.test(type))
        throw new AdapterError(
          "INVALID_REQUEST",
          "Content-Type must be application/octet-stream.",
        );
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_FILE_BYTES)
        throw new AdapterError("PAYLOAD_TOO_LARGE");
      let name: string;
      try {
        name = decodeURIComponent(parts[4]!);
      } catch {
        throw new AdapterError("INVALID_REQUEST", "name is not valid.");
      }
      const written = await writeUpload(
        chatWorkspace(options.stateDir, ref),
        name,
        url.searchParams.get("sha256") ?? "",
        req,
      );
      return sendJson(res, 200, written);
    }
    if (
      req.method === "PUT" &&
      parts[1] === "chats" &&
      parts.length === 5 &&
      parts[3] === "skills"
    ) {
      // The chat only routes the request (one AgentCore session per chat);
      // skills are stored by digest, shared by every chat on this runtime.
      parseChatRef({
        tenantId: url.searchParams.get("tenantId") ?? undefined,
        chatId: parts[2],
      });
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/gzip(\s*;|$)/i.test(type))
        throw new AdapterError(
          "INVALID_REQUEST",
          "Content-Type must be application/gzip.",
        );
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_SKILL_ARCHIVE_BYTES)
        throw new AdapterError("PAYLOAD_TOO_LARGE");
      const written = await writeSkill(options.stateDir, parts[4]!, req);
      return sendJson(res, 200, written);
    }
    throw notFound();
  }

  return server;
}

function notFound() {
  return new AdapterError("INVALID_REQUEST", "Unknown route.");
}

function queryRef(url: URL) {
  return {
    tenantId: url.searchParams.get("tenantId") ?? undefined,
    chatId: url.searchParams.get("chatId") ?? undefined,
  };
}

function cursor(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d{1,9}$/.test(value))
    throw new AdapterError("INVALID_REQUEST", "after must be an event number.");
  return Number(value);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Constant-time comparison of fixed-length digests.
function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return (
    match?.[1] !== undefined && timingSafeEqual(digest(match[1]), expected)
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type))
    throw new AdapterError(
      "INVALID_REQUEST",
      "Content-Type must be application/json.",
    );
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) throw new AdapterError("PAYLOAD_TOO_LARGE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AdapterError("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AdapterError("INVALID_REQUEST", "Body must be valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// Streams a run's events after `after`, then live until run.completed. A
// caller disconnecting does not stop the run; only an explicit stop does.
function stream(
  res: ServerResponse,
  run: Run,
  after: number,
  options: ServerOptions,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.flushHeaders();
  let closed = false;
  const heartbeat = setInterval(
    () => write(": hb\n\n"),
    options.limits.heartbeatMs,
  );
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const write = (chunk: string) => {
    if (closed) return;
    res.write(chunk);
    if (res.writableLength > MAX_BUFFERED) {
      options.log("subscriber_dropped", { runId: run.runId });
      close();
      res.destroy();
    }
  };
  const send = (event: RunEvent) =>
    write(
      `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    );
  let unsubscribe: () => void = () => undefined;
  res.on("close", close);
  unsubscribe = run.subscribe(after, {
    send,
    end: () => {
      close();
      res.end();
    },
  });
}

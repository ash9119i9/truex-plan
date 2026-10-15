import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { safeErrorMessage } from "../../../shared/errors";
import { errorFields, log } from "../../../shared/logging";
import { HttpError, RpcError } from "../errors";

// Contract used by ThreadManager; CodexClient implements the process transport.
export interface Runtime extends EventEmitter {
  // Input: RPC command and its parameters. Output: a promise for Codex's result.
  request(method: string, params?: any): Promise<any>;
  // Input: Codex's request ID and a result or error. Output: none; writes a reply.
  respond(
    id: string | number,
    result?: any,
    error?: { code: number; message: string },
  ): void;
}
const unavailable =
  "The assistant runtime is unavailable. Try again shortly; if this continues, ask your administrator to check the runtime installation.";
// Known JSON-RPC codes; the runtime's own text never reaches users.
const rpcCodes: Record<number, [number, string, string]> = {
  [-32600]: [
    400,
    "RPC_INVALID_REQUEST",
    "The assistant runtime rejected the request. Refresh the conversation and try again.",
  ],
  [-32601]: [
    400,
    "RPC_METHOD_NOT_FOUND",
    "This operation is not supported by the assistant runtime.",
  ],
  [-32602]: [
    400,
    "RPC_INVALID_PARAMS",
    "The assistant runtime rejected the request parameters. Refresh the conversation and try again.",
  ],
  [-32603]: [
    502,
    "RPC_INTERNAL",
    "The assistant runtime encountered an internal error. Try again; contact support if this continues.",
  ],
  [-32001]: [
    503,
    "RUNTIME_OVERLOADED",
    "The assistant runtime is busy. Try again shortly.",
  ],
};
/**
 * Converts a Codex error payload into an application error; does not throw it.
 * @param error - RPC error object with code, message and optional data.
 * @returns RpcError with a user-safe message and internal RPC details for debugging.
 */
export function rpcError(error: any): RpcError {
  const code = Number(error?.code);
  const [status, name, message] = rpcCodes[code] ?? [
    400,
    "RPC_ERROR",
    "The assistant runtime could not complete the request. Refresh the conversation and try again.",
  ];
  return new RpcError(
    status,
    message,
    name,
    code,
    typeof error?.message === "string" ? error.message : "",
    error?.data,
  );
}
/**
 * Input: one diagnostic line. Output: text with recognized credential patterns
 * and values handled by safeErrorMessage redacted; not a guarantee for arbitrary secrets.
 */
const redactLine = (line: string) =>
  safeErrorMessage(
    line.replace(
      /(bearer\s+|apikey["\s:=]+|experimental_bearer_token["\s:=]+)\S+/gi,
      "$1[REDACTED]",
    ),
  );
const stderrTailLimit = 50;
/**
 * Talks to a Codex app-server child process using one JSON message per line.
 * Commands go to stdin; stdout carries RPC responses/events; stderr carries logs.
 * request() starts/initializes the process, then send() and write() send a command.
 * Incoming stdout lines reach dispatch(), which resolves a request or emits an event.
 */
export class CodexClient extends EventEmitter implements Runtime {
  // One shared process per client, reused by commands for multiple conversations.
  private child?: ChildProcessWithoutNullStreams;
  // Concurrent callers share this startup promise instead of spawning extra processes.
  private starting?: Promise<any>;
  // RPC message counter, not a conversation thread ID; responses echo this number.
  private id = 0;
  // Each outstanding RPC ID owns its promise callbacks and response deadline.
  private pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  // Last redacted stderr lines of the current child, for exit diagnostics.
  private stderrTail: string[] = [];
  // Result of the initialize handshake, used as the ready marker.
  identity: any;
  // Startup timings in milliseconds, exposed in the HTTP thread creation response.
  spawnMs = 0;
  initializeMs = 0;
  /**
   * Creates the client object without launching Codex.
   * @param binary - Path to the Codex executable selected by bootstrap/core.ts.
   * @param home - Process working directory and HOME/CODEX_HOME for Codex.
   * @param timeoutMs - Deadline for each RPC response, including initialize (default 30s).
   */
  constructor(
    readonly binary: string,
    readonly home: string,
    readonly timeoutMs = 30_000,
  ) {
    super();
  }
  /**
   * Input: none. Output: a promise for Codex's initialize result.
   * Reuses a ready process or an in-progress boot; rejects if startup fails.
   */
  start(): Promise<any> {
    if (this.identity) return Promise.resolve(this.identity);
    if (this.starting) return this.starting;
    this.starting = this.boot().finally(() => {
      // Clear on success or failure so later calls can reuse readiness or retry boot.
      this.starting = undefined;
    });
    return this.starting;
  }
  /**
   * Input: none; uses the constructor settings. Output: the initialize result.
   * Launches Codex, attaches pipe/lifecycle handlers and completes the handshake.
   * Debug startup failures via RUNTIME_UNAVAILABLE logs; initialization can also time out.
   */
  private async boot() {
    const begin = performance.now();
    this.stderrTail = [];
    const child = spawn(this.binary, ["app-server", "--listen", "stdio://"], {
      cwd: this.home,
      env: {
        PATH: process.env.PATH,
        HOME: this.home,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG || "en_US.UTF-8",
        CODEX_HOME: this.home,
      },
      stdio: "pipe",
    });
    this.child = child;
    // Input: process error. Output: none; fail all pending commands for this child.
    child.on("error", (cause: NodeJS.ErrnoException) => {
      // Ignore late lifecycle events from a child replaced by a newer boot.
      if (this.child !== child) return;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause }),
        { event: "error", errno: cause.errno, code: cause.code },
      );
    });
    // Input: exit code/signal. Output: none; log diagnostics and reject pending work.
    child.on("exit", (exitCode, signal) => {
      if (this.child !== child) return;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", {
          cause: new Error(
            `Codex runtime exited (code ${exitCode}, signal ${signal})`,
          ),
        }),
        { event: "exit", exitCode, signal },
      );
    });
    // Input: pipe write error, e.g. EPIPE. Output: none; mark the runtime unavailable.
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause }),
        { event: "stdin", errno: cause.errno, code: cause.code },
      );
    });
    // Keep runtime logs off the protocol stream; redact credential-shaped values.
    // Input: stderr line. Output: diagnostic event; keep only the last 50 lines.
    createInterface({ input: child.stderr }).on("line", (line) => {
      const clean = redactLine(line);
      if (this.child === child) {
        this.stderrTail.push(clean);
        if (this.stderrTail.length > stderrTailLimit) this.stderrTail.shift();
      }
      this.emit("diagnostic", clean);
    });
    // Input: stdout line. Output: a dispatched message or protocolError event.
    // Plain-text logs on stdout break JSON parsing; Codex diagnostics belong on stderr.
    createInterface({ input: child.stdout }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        log("warn", "invalid runtime JSON frame", {
          excerpt: redactLine(line).slice(0, 200),
          length: line.length,
          ...errorFields(e),
        });
        this.emit("protocolError", "Invalid runtime JSON frame");
        return;
      }
      this.dispatch(msg);
    });
    // Input: spawn/error events. Output: a promise that settles when OS startup does.
    // Process creation is not readiness; the initialize handshake still has to finish.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((cause) => {
      throw new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause });
    });
    this.spawnMs = performance.now() - begin;
    const init = performance.now();
    try {
      // Use send() directly: request() would wait for this same unfinished boot.
      this.identity = await this.send("initialize", {
        clientInfo: {
          name: "truex_agent_core",
          title: "Truex Agent Core",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      // Notification has no ID or response; it completes the initialization handshake.
      this.write({ method: "initialized" });
      this.initializeMs = performance.now() - init;
      return this.identity;
    } catch (e) {
      child.kill();
      throw e;
    }
  }
  // Handler failures are adapter bugs, not protocol errors; they are reported
  // on the thread so the turn does not silently stall.
  /**
   * Routes one incoming Codex stdout message after the line reader parses JSON.
   * @param msg Parsed message: { id, method, params } for a Codex request,
   * { method, params } for a notification, or { id, result/error } for an RPC reply.
   * @returns Nothing (void). Side effects either notify local EventEmitter
   * listeners or settle the promise created by send() for an earlier request.
   * Text notifications reach ThreadManager and its SSE publisher through those
   * listeners; dispatch() itself does not write to an HTTP response.
   * Messages without a recognized method/ID shape are ignored. Synchronous
   * routing/listener errors are logged and reported through adapterError.
   */
  private dispatch(msg: any) {
    try {
      // Method + ID: Codex is asking us to do something (for example, approve a
      // tool). The serverRequest listener handles it and replies via respond().
      if (msg?.method && Object.hasOwn(msg, "id"))
        this.emit("serverRequest", msg);
      // Method without ID: one-way progress/output, such as an assistant text
      // delta or turn/completed. ThreadManager's listener updates thread state.
      else if (msg?.method) this.emit("notification", msg);
      else if (msg && Object.hasOwn(msg, "id")) {
        // ID without method: reply to an RPC we sent, such as turn/start.
        // send() saved resolve/reject callbacks under that same ID before writing.
        const pending = this.pending.get(msg.id);
        // Late responses after timeout, and unknown response IDs, have no waiter.
        if (!pending) return;
        // This reply settles the request once; cancel its timeout so it cannot
        // later report a timeout for an operation that already received a reply.
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        // Convert a Codex error into RpcError, or give msg.result to the awaiting
        // request() caller. A turn/start result is acceptance, not generated text.
        msg.error
          ? pending.reject(rpcError(msg.error))
          : pending.resolve(msg.result);
      }
    } catch (e) {
      // EventEmitter listeners run synchronously and can throw. Recover whatever
      // thread identity the message supplies so the manager can report the error.
      const threadId =
        msg?.params?.threadId ||
        msg?.params?.conversationId ||
        msg?.params?.thread?.id;
      log("error", "runtime message handler failed", {
        method: msg?.method,
        id: msg?.id,
        threadId,
        ...errorFields(e),
      });
      try {
        // Report the adapter failure to local listeners with available turn IDs;
        // this is separate from a Codex RPC error returned in msg.error above.
        this.emit("adapterError", {
          threadId: typeof threadId === "string" ? threadId : undefined,
          turnId: msg?.params?.turnId || msg?.params?.turn?.id,
          method: msg?.method,
          error: e,
        });
      } catch (inner) {
        // An error-reporting listener can fail too; log it instead of letting
        // that secondary exception escape into the stdout line reader.
        log("error", "adapter error report failed", errorFields(inner));
      }
    }
  }
  /**
   * @param method - Codex RPC command, e.g. "thread/start" (not an HTTP URL).
   * @param params - Parameters for that command; validated by higher layers/Codex.
   * @returns A promise for msg.result, e.g. { thread: { id, ... } } for thread/start.
   * Rejects on startup, RPC, write or timeout errors; does not automatically retry.
   */
  async request(method: string, params?: any) {
    await this.start();
    return this.send(method, params);
  }
  /**
   * Input: RPC method and parameters; assumes the process is already spawned.
   * Output: a promise settled by dispatch(), timeout, a write error or fail().
   * Allocates an RPC ID and registers its waiter before writing to avoid a reply race.
   */
  private send(method: string, params: any) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.id;
      // Timeout stops local waiting, not Codex's work; retrying may duplicate a side effect.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log("warn", "runtime request timed out", {
          method,
          timeoutMs: this.timeoutMs,
        });
        reject(
          new HttpError(
            504,
            `Runtime request timed out: ${method}; outcome may be unknown`,
            "RPC_TIMEOUT",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  /**
   * Input: request { id, method, params }, notification { method, params? },
   * or reply { id, result/error }. Output: none; queues JSON plus a newline on stdin.
   * Throws if the pipe is unavailable/overloaded or serialization/writing fails.
   * Returning means the write was queued, not that Codex accepted the operation.
   */
  private write(message: any) {
    if (!this.child?.stdin.writable)
      throw new HttpError(503, "Runtime unavailable", "RUNTIME_UNAVAILABLE");
    // Refuse new writes when the shared pipe is saturated rather than accumulating commands.
    if (this.child.stdin.writableLength > 1_048_576)
      throw new HttpError(503, "Runtime command buffer full", "CAPACITY");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  /**
   * Replies to a Codex-initiated request, such as an approval question.
   * @param id - Original ID supplied by Codex; do not allocate a new local ID.
   * @param result - Successful reply payload, used when error is absent.
   * @param error - RPC code/message for a failed reply; takes precedence over result.
   * @returns Nothing; queues a reply through write(), whose errors propagate.
   */
  respond(
    id: string | number,
    result?: any,
    error?: { code: number; message: string },
  ) {
    this.write(error ? { id, error } : { id, result });
  }
  /**
   * Input: runtime failure and diagnostic fields (event, exit code, signal, etc.).
   * Output: none; clears readiness, rejects all pending RPCs and emits exit(error).
   * A later request can boot again. This method does not itself kill the process.
   */
  private fail(error: HttpError, fields: Record<string, unknown>) {
    const wasReady = this.identity !== undefined;
    this.identity = undefined;
    log("error", "codex runtime unavailable", {
      ...fields,
      wasReady,
      pending: this.pending.size,
      stderrTail: this.stderrTail.slice(),
      ...errorFields(error),
    });
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }
  /**
   * Input: none. Output: none; requests SIGTERM if a child exists.
   * Does not wait for shutdown; the child's exit handler performs pending cleanup.
   */
  stop() {
    this.child?.kill("SIGTERM");
  }
}

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { safeErrorMessage } from "../../shared/errors";
import { errorFields, log } from "../../shared/logging";
import { HttpError, RpcError } from "./errors";
export interface Runtime extends EventEmitter {
  request(method: string, params?: any): Promise<any>;
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
const redactLine = (line: string) =>
  safeErrorMessage(
    line.replace(
      /(bearer\s+|apikey["\s:=]+|experimental_bearer_token["\s:=]+)\S+/gi,
      "$1[REDACTED]",
    ),
  );
const stderrTailLimit = 50;
export class CodexClient extends EventEmitter implements Runtime {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<any>;
  private id = 0;
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
  identity: any;
  spawnMs = 0;
  initializeMs = 0;
  constructor(
    readonly binary: string,
    readonly home: string,
    readonly timeoutMs = 30_000,
  ) {
    super();
  }
  start(): Promise<any> {
    if (this.identity) return Promise.resolve(this.identity);
    if (this.starting) return this.starting;
    this.starting = this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
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
    let acceptingFrames = true;
    child.on("error", (cause: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      acceptingFrames = false;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause }),
        { event: "error", errno: cause.errno, code: cause.code },
      );
    });
    child.on("exit", (exitCode, signal) => {
      if (this.child !== child) return;
      acceptingFrames = false;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", {
          cause: new Error(
            `Codex runtime exited (code ${exitCode}, signal ${signal})`,
          ),
        }),
        { event: "exit", exitCode, signal },
      );
    });
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      acceptingFrames = false;
      this.fail(
        new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause }),
        { event: "stdin", errno: cause.errno, code: cause.code },
      );
    });
    // Keep runtime logs off the protocol stream; redact credential-shaped values.
    createInterface({ input: child.stderr }).on("line", (line) => {
      const clean = redactLine(line);
      if (this.child === child) {
        this.stderrTail.push(clean);
        if (this.stderrTail.length > stderrTailLimit) this.stderrTail.shift();
      }
      this.emit("diagnostic", clean);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Exit can precede stdio closure. Buffered frames from a failed or
      // replaced process must not reach a new runtime generation.
      if (!acceptingFrames || this.child !== child) return;
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
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch((cause) => {
      throw new HttpError(503, unavailable, "RUNTIME_UNAVAILABLE", { cause });
    });
    this.spawnMs = performance.now() - begin;
    const init = performance.now();
    try {
      this.identity = await this.send("initialize", {
        clientInfo: {
          name: "truex_agent_core",
          title: "Truex Agent Core",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
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
  private dispatch(msg: any) {
    try {
      if (msg?.method && Object.hasOwn(msg, "id"))
        this.emit("serverRequest", msg);
      else if (msg?.method) this.emit("notification", msg);
      else if (msg && Object.hasOwn(msg, "id")) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        msg.error
          ? pending.reject(rpcError(msg.error))
          : pending.resolve(msg.result);
      }
    } catch (e) {
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
        this.emit("adapterError", {
          threadId: typeof threadId === "string" ? threadId : undefined,
          turnId: msg?.params?.turnId || msg?.params?.turn?.id,
          method: msg?.method,
          error: e,
        });
      } catch (inner) {
        log("error", "adapter error report failed", errorFields(inner));
      }
    }
  }
  async request(method: string, params?: any) {
    await this.start();
    return this.send(method, params);
  }
  private send(method: string, params: any) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.id;
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
  private write(message: any) {
    if (!this.child?.stdin.writable)
      throw new HttpError(503, "Runtime unavailable", "RUNTIME_UNAVAILABLE");
    // Refuse new writes when the shared pipe is saturated rather than accumulating commands.
    if (this.child.stdin.writableLength > 1_048_576)
      throw new HttpError(503, "Runtime command buffer full", "CAPACITY");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  respond(
    id: string | number,
    result?: any,
    error?: { code: number; message: string },
  ) {
    this.write(error ? { id, error } : { id, result });
  }
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
  stop() {
    this.child?.kill("SIGTERM");
  }
}

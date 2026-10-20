import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

// One `codex app-server` child speaking newline-delimited JSON-RPC on stdio.
// Every request has a timeout, so an unanswered call (Codex never replies to a
// second interrupt, for example) fails instead of hanging. Requests from Codex
// to the client are refused immediately unless the request handler takes them
// (MCP tool approvals); a handler must answer each request it takes exactly
// once, through `respond`.

export interface Notification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

// A request Codex sent to this client. `id` is its JSON-RPC id, echoed in
// `serverRequest/resolved` when Codex withdraws it.
export interface ServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeout extends Error {
  constructor(readonly method: string) {
    super(`Codex did not answer ${method} in time.`);
    this.name = "RpcTimeout";
  }
}

export class ProcessExited extends Error {
  constructor() {
    super("The Codex process exited.");
    this.name = "ProcessExited";
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

// Lines longer than this are a protocol fault, not something to buffer.
const MAX_LINE = 16 * 1024 * 1024;
const STDERR_TAIL = 20;

export interface SpawnOptions {
  readonly binary: string;
  readonly home: string;
  readonly workspace: string;
  readonly rpcMs: number;
}

export class CodexProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private listener: ((n: Notification) => void) | undefined;
  // Returns true when it took the request (and will `respond` to it).
  private requestHandler: ((r: ServerRequest) => boolean) | undefined;
  private readonly stderrTail: string[] = [];
  readonly exited: Promise<void>;
  private alive = true;
  onExit: (() => void) | undefined;

  constructor(private readonly options: SpawnOptions) {
    // A minimal environment: the adapter's own secrets (its bearer token) and
    // unrelated host settings never reach Codex.
    this.child = spawn(options.binary, ["app-server", "--listen", "stdio://"], {
      cwd: options.workspace,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: options.home,
        CODEX_HOME: options.home,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: "en_US.UTF-8",
        RUST_LOG: "error",
      },
      stdio: "pipe",
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => resolve());
      this.child.once("error", () => resolve());
    });
    void this.exited.then(() => this.handleExit());
    this.child.stdin.on("error", () => undefined);
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      this.stderrTail.push(line.slice(0, 500));
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => this.handleLine(line));
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  // Last stderr lines, for operator logs only.
  get diagnostics(): readonly string[] {
    return this.stderrTail;
  }

  setListener(listener: ((n: Notification) => void) | undefined): void {
    this.listener = listener;
  }

  setRequestHandler(
    handler: ((request: ServerRequest) => boolean) | undefined,
  ): void {
    this.requestHandler = handler;
  }

  // Answers a request Codex sent (see `setRequestHandler`).
  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "truex_runtime_adapter", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    timeoutMs = this.options.rpcMs,
  ): Promise<T> {
    if (!this.alive) return Promise.reject(new ProcessExited());
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeout(method));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  // SIGTERM, then SIGKILL if the process doesn't exit within `graceMs`.
  async stop(graceMs = 3000): Promise<void> {
    if (!this.alive) return;
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(force);
  }

  kill(): void {
    if (this.alive) this.child.kill("SIGKILL");
  }

  private write(message: unknown): void {
    if (this.alive) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (line.length > MAX_LINE) {
      this.kill();
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Codex writes only JSON-RPC to stdout; anything else is a fault.
      this.kill();
      return;
    }
    const { id, method } = message;
    if (typeof method === "string" && id !== undefined) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (
        (typeof id === "string" || typeof id === "number") &&
        this.requestHandler?.({ id, method, params }) === true
      )
        return;
      this.write({
        id,
        error: { code: -32601, message: "Not supported by this client." },
      });
      return;
    }
    if (typeof method === "string") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      this.listener?.({ method, params });
      return;
    }
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    const error = message.error as
      { code?: number; message?: string } | undefined;
    if (error)
      waiter.reject(
        new RpcError(Number(error.code ?? 0), String(error.message ?? "")),
      );
    else waiter.resolve(message.result ?? {});
  }

  private handleExit(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new ProcessExited());
      this.pending.delete(id);
    }
    this.onExit?.();
  }
}

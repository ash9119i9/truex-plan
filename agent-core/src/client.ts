import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { HttpError } from "./errors";
export interface Runtime extends EventEmitter {
  request(method: string, params?: any): Promise<any>;
  respond(
    id: string | number,
    result?: any,
    error?: { code: number; message: string },
  ): void;
}
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
    const child = spawn(this.binary, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: this.home },
      stdio: "pipe",
    });
    this.child = child;
    child.on("error", () =>
      this.fail(
        new HttpError(
          503,
          "Could not spawn the project-local Codex binary; run npm run codex:setup",
          "RUNTIME_UNAVAILABLE",
        ),
      ),
    );
    child.on("exit", () =>
      this.fail(
        new HttpError(503, "Codex runtime exited", "RUNTIME_UNAVAILABLE"),
      ),
    );
    child.stdin.on("error", () =>
      this.fail(
        new HttpError(503, "Codex input closed", "RUNTIME_UNAVAILABLE"),
      ),
    );
    // Keep runtime logs off the protocol stream; redact credential-shaped values.
    createInterface({ input: child.stderr }).on("line", (line) =>
      this.emit(
        "diagnostic",
        line.replace(
          /(bearer\s+|apikey["\s:=]+|experimental_bearer_token["\s:=]+)\S+/gi,
          "$1[REDACTED]",
        ),
      ),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method && Object.hasOwn(msg, "id"))
          this.emit("serverRequest", msg);
        else if (msg.method) this.emit("notification", msg);
        else if (Object.hasOwn(msg, "id")) {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          msg.error
            ? pending.reject(
                new HttpError(
                  msg.error.code === -32001 ? 503 : 400,
                  msg.error.message,
                  String(msg.error.code),
                ),
              )
            : pending.resolve(msg.result);
        }
      } catch {
        this.emit("protocolError", "Invalid runtime JSON frame");
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(() => {
      throw new HttpError(
        503,
        "Project-local Codex binary unavailable",
        "RUNTIME_UNAVAILABLE",
      );
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
  async request(method: string, params?: any) {
    await this.start();
    return this.send(method, params);
  }
  private send(method: string, params: any) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
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
  private fail(error: Error) {
    this.identity = undefined;
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

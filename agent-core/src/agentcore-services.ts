import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// AgentCore storage mounts become available on invocation, after container startup.
// Start storage-dependent processes once, on the first valid invocation.
export class AgentCoreServices {
  state: "cold" | "starting" | "ready" | "stopping" = "cold";
  readonly gatewayEnabled = Boolean(process.env.MODEL_GATEWAY_SECRET);
  private children = new Set<ChildProcess>();
  private pending?: Promise<void>;
  private failure?: Error;

  start(): Promise<void> {
    if (this.state === "stopping")
      return Promise.reject(new Error("Runtime is stopping"));
    if (this.pending) return this.pending;
    this.state = "starting";
    this.pending = this.initialize().catch(async (error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      await this.stop();
      throw this.failure;
    });
    return this.pending;
  }

  private launch(service: string, port: number) {
    const root = process.env.PROJECT_ROOT || "/app";
    const child = spawn(process.execPath, [`dist/${service}/src/index.js`], {
      cwd: join(root, service),
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: "inherit",
    });
    this.children.add(child);
    child.on("error", (error) => {
      this.failure = error;
      this.children.delete(child);
    });
    child.on("exit", (code, signal) => {
      this.children.delete(child);
      if (this.state !== "stopping") {
        this.failure = new Error(`${service} exited (${code ?? signal})`);
        console.error(this.failure.message);
        // A process that dies after startup invalidates the entire runtime.
        if (this.state === "ready") process.kill(process.pid, "SIGTERM");
      }
    });
  }

  private async initialize() {
    if (
      this.gatewayEnabled &&
      (process.env.MODEL_GATEWAY_SECRET?.length ?? 0) < 32
    )
      throw new Error(
        "MODEL_GATEWAY_SECRET must contain at least 32 characters",
      );
    this.launch("agent-core", 4100);
    if (this.gatewayEnabled) this.launch("model-gateway", 4200);
    const urls = ["http://127.0.0.1:4100/healthz"];
    if (this.gatewayEnabled) urls.push("http://127.0.0.1:4200/ready");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      this.checkRunning();
      const ready = await Promise.all(
        urls.map(async (url) => {
          try {
            return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
          } catch {
            return false;
          }
        }),
      );
      this.checkRunning();
      if (ready.every(Boolean)) {
        this.state = "ready";
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Runtime services did not become ready within 60 seconds");
  }

  private checkRunning() {
    if (this.failure) throw this.failure;
    if (this.state === "stopping") throw new Error("Runtime is stopping");
  }

  async stop() {
    this.state = "stopping";
    const children = [...this.children];
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            let force: NodeJS.Timeout;
            const done = () => {
              clearTimeout(force);
              resolve();
            };
            child.once("exit", done);
            force = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 35_000);
            child.kill("SIGTERM");
          }),
      ),
    );
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// AgentCore storage mounts become available on invocation, after container startup.
// Start storage-dependent processes once, on the first valid invocation.
export class AgentCoreServices {
  state: "cold" | "starting" | "ready" | "stopping" = "cold";
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
    this.launch("agent-core", 4100);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      this.checkRunning();
      let ready = false;
      try {
        ready = (await fetch("http://127.0.0.1:4100/healthz", {
          signal: AbortSignal.timeout(2000),
        })).ok;
      } catch {
        // The local core may still be starting. External model endpoints do
        // not participate in container readiness.
      }
      this.checkRunning();
      if (ready) {
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

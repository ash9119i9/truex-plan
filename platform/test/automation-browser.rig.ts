/** Disposable browser/API stack. Synthetic runtime, no connector actions. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { startPlatform, freePort } from "./harness";
import { insertFixtures } from "./fixtures";
import { PlatformService } from "../src/service";
import { createAutomationActivities } from "../src/automation/activities";
async function main() {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  process.env.AUTH_MODE = "poc";
  const policies = new Map<string, any>(),
    records = new Map<string, any[]>();
  const runtime = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: any) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (path === "/healthz") return json({ ok: true });
    if (path === "/threads") {
      const id = `fixture-${randomUUID()}`;
      policies.set(id, input.automationPolicy);
      records.set(id, []);
      return json({
        threadId: id,
        automationPolicy: input.automationPolicy,
        automationPolicyVersion: 1,
      });
    }
    const id = path.split("/")[2],
      policy = policies.get(id);
    if (path.endsWith("/turns")) {
      const turnId = `turn-${randomUUID()}`,
        at = new Date().toISOString();
      const event = (type: string, seq: number, data: any) => ({
        key: `${id}:${seq}`,
        event: {
          type,
          seq,
          cursor: `${id}:${seq}`,
          at,
          threadId: id,
          turnId,
          data: { ...data, automationPolicy: policy },
        },
      });
      records.set(id, [
        event("message.final", 1, {
          text: "Synthetic verification result. No business actions were performed.",
          messageIndex: 0,
        }),
        event("turn.completed", 2, {
          turn: { id: turnId, status: "completed" },
          terminationEvidence: "runtime",
        }),
      ]);
      return json({ turnId, steer: false });
    }
    if (path.endsWith("/records")) return json(records.get(id) ?? []);
    if (path.endsWith("/records/ack")) {
      records.set(
        id,
        (records.get(id) ?? []).filter((r) => !input.keys.includes(r.key)),
      );
      return json({ ok: true });
    }
    if (path.endsWith("/agents") || path.endsWith("/documents"))
      return json([]);
    return json({ automationPolicy: policy, automationPolicyVersion: 1 });
  });
  await new Promise<void>((r) => runtime.listen(0, "127.0.0.1", r));
  const runtimeUrl = `http://127.0.0.1:${(runtime.address() as any).port}`;
  const environment = await TestWorkflowEnvironment.createLocal({
    server: { executable: { type: "cached-download", version: "v1.9.1" } },
  });
  const address = (environment as any).connection.options.address,
    taskQueue = `browser-${randomUUID()}`;
  const frontendPort = await freePort();
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const harness = await startPlatform({
    env: {
      AUTH_MODE: "poc",
      FRONTEND_ORIGIN: frontendOrigin,
      APP_PUBLIC_URL: frontendOrigin,
      DEV_USER_ID: "owner",
      DEV_USER_ROLE: "user",
      AUTOMATIONS_ENABLED: "on",
      TEMPORAL_ADDRESS: address,
      TEMPORAL_TASK_QUEUE: taskQueue,
      AGENT_CORE_URLS: runtimeUrl,
    },
  });
  await insertFixtures(harness.store);
  const service = new PlatformService(harness.store, [runtimeUrl]);
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/automation/workflows"),
    activities: createAutomationActivities(harness.store, service),
  });
  const running = worker.run();
  const port = frontendPort,
    frontend = spawn(
      process.execPath,
      ["node_modules/next/dist/bin/next", "dev", "--port", String(port)],
      {
        cwd: "../frontend",
        env: {
          ...process.env,
          PLATFORM_INTERNAL_URL: harness.base,
          AUTH_MODE: "poc",
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  frontend.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  frontend.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await writeFile(
    "/tmp/truex-automation-browser.json",
    JSON.stringify({
      frontend: `http://127.0.0.1:${port}`,
      platform: harness.base,
      temporal: address,
    }),
  );
  console.log(`Synthetic browser stack: http://127.0.0.1:${port}`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    frontend.kill("SIGTERM");
    worker.shutdown();
    await running;
    await harness.stop();
    await environment.teardown();
    runtime.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

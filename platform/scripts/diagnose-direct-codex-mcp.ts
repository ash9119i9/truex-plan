/** Direct pinned-Rust catalog health probe. No model turn or business tool execution. */
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { CodexClient } from "../../agent-core/src/client";
import { Redactor } from "../../agent-core/src/redact";

dotenv.config({ path: "platform/.env", quiet: true });
dotenv.config({ path: "agent-core/.env", quiet: true });
async function main() {
  const home = await mkdtemp(join(tmpdir(), "truex-direct-catalog-"));
  const mongo = new MongoClient(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
  );
  const localRequests: any[] = [],
    notifications: any[] = [];
  const server = createServer((req, res) => {
    localRequests.push({ method: req.method, path: req.url });
    res.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const lock = JSON.parse(readFileSync("codex.lock.json", "utf8"));
  const runtime = new CodexClient(resolve(lock.binary), home, 35000);
  const redactor = new Redactor();
  runtime.on("notification", (notification) =>
    notifications.push(redactor.clean(notification)),
  );
  const started = performance.now();
  try {
    await mongo.connect();
    const mcp: any = await mongo
      .db(process.env.MONGO_DB || "truex")
      .collection("truex_mcp")
      .findOne({ _id: new ObjectId("6aaa7db671c8cc9e29e08d93") });
    if (!mcp) throw new Error("MCP profile missing");
    redactor.remember(mcp);
    const thread = await runtime.request("thread/start", {
      cwd: home,
      model: "diagnostic",
      modelProvider: "diagnostic",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      config: {
        "model_providers.diagnostic": {
          name: "diagnostic",
          base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          wire_api: "responses",
        },
        "mcp_servers.qlik": {
          url: mcp.url,
          http_headers: { [mcp.auth.headerName]: mcp.apiKey },
          startup_timeout_sec: 20,
          tool_timeout_sec: 120,
        },
      },
    });
    const status = await runtime.request("mcpServerStatus/list", {
      threadId: thread.thread.id,
    });
    const toolCount = Object.keys(
      status.data.find((server: any) => server.name === "qlik")?.tools || {},
    ).length;
    const report = redactor.clean({
      createdAt: new Date().toISOString(),
      evidence:
        "Pinned Codex Rust connected directly to configured MCP URL; no turn/start or inference request",
      revision: lock.revision,
      startupTimeoutMs: 20000,
      durationMs: performance.now() - started,
      toolCount,
      status,
      notifications,
      localRequests,
      inferenceRequestCount: localRequests.filter((request) =>
        /responses|chat\/completions/.test(request.path),
      ).length,
    });
    await mkdir("docs/adaptive-correctness-fix", { recursive: true });
    await writeFile(
      "docs/adaptive-correctness-fix/direct-rust-catalog-health.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        output: "docs/adaptive-correctness-fix/direct-rust-catalog-health.json",
        toolCount,
        durationMs: report.durationMs,
        inferenceRequestCount: report.inferenceRequestCount,
      }),
    );
  } finally {
    runtime.stop();
    await mongo.close();
    server.closeAllConnections();
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(home, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error.name, message: error.message }));
  process.exitCode = 1;
});

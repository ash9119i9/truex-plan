/** Observe pinned Codex's MCP handshake without starting a turn or calling a model. */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { CodexClient } from "../../agent-core/src/client";

async function main() {
  const home = await mkdtemp(join(tmpdir(), "truex-codex-protocol-"));
  const captured: any[] = [];
  const modelRequests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url !== "/mcp") {
      modelRequests.push({ method: req.method, path: req.url });
      res.writeHead(500).end();
      return;
    }
    const rpc = raw ? JSON.parse(raw) : {};
    captured.push({
      at: new Date().toISOString(),
      httpMethod: req.method,
      headers: req.headers,
      rpc,
    });
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "diagnostic-capture", version: "1" },
          }
        : rpc.method === "tools/list"
          ? { tools: [] }
          : {};
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const lock = JSON.parse(readFileSync("codex.lock.json", "utf8"));
  const runtime = new CodexClient(resolve(lock.binary), home, 20000);
  try {
    const thread = await runtime.request("thread/start", {
      cwd: home,
      model: "diagnostic",
      modelProvider: "diagnostic",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      config: {
        "model_providers.diagnostic": {
          name: "diagnostic",
          base_url: `${base}/v1`,
          wire_api: "responses",
        },
        "mcp_servers.handshake_capture": {
          url: `${base}/mcp`,
          startup_timeout_sec: 10,
        },
      },
    });
    const status = await runtime.request("mcpServerStatus/list", {
      threadId: thread.thread.id,
    });
    const report = {
      createdAt: new Date().toISOString(),
      evidence:
        "Pinned Codex handshakes against a local capture server; no turn/start or inference request",
      revision: lock.revision,
      actualRequests: captured,
      localModelCatalogRequests: modelRequests,
      inferenceRequestCount: modelRequests.filter((request) =>
        /responses|chat\/completions/.test(request.path),
      ).length,
      status,
    };
    await mkdir("docs/adaptive-correctness-fix", { recursive: true });
    await writeFile(
      "docs/adaptive-correctness-fix/codex-protocol-capture.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        output: "docs/adaptive-correctness-fix/codex-protocol-capture.json",
        localModelCatalogRequests: modelRequests,
        inferenceRequestCount: report.inferenceRequestCount,
        requests: captured.map((entry) => ({
          method: entry.rpc.method,
          headers: entry.headers,
          rpc: entry.rpc,
        })),
      }),
    );
  } finally {
    runtime.stop();
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

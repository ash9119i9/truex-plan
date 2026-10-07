import { createRequire } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const require = createRequire(resolve("platform/package.json"));
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const corePort = process.env.DEMO_CORE_PORT || "4100",
  platformPort = process.env.DEMO_PLATFORM_PORT || "4000",
  frontendPort = process.env.DEMO_FRONTEND_PORT || "3000";
const home = mkdtempSync(join(tmpdir(), "truex-demo-"));
mkdirSync(join(home, "workspace"));
const mongo = await MongoMemoryServer.create();
const db = new MongoClient(mongo.getUri());
await db.connect();
let sequence = 0;
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.includes("/responses")) {
    res.writeHead(404).end();
    return;
  }
  const number = ++sequence;
  if (process.env.DEMO_VISUALIZE === "1") {
    const reference = body.match(/\[truex-visualization:[a-f0-9-]{36}\]/)?.[0];
    const item = reference
      ? {
          type: "message",
          id: "visual_answer_" + number,
          role: "assistant",
          content: [
            {
              type: "output_text",
              text:
                "Explore this illustrative capacity scenario.\n\n" + reference,
            },
          ],
        }
      : {
          type: "function_call",
          id: "visual_tool_" + number,
          call_id: "visual_call_" + number,
          name: "create_visualization",
          arguments: JSON.stringify({
            title: "Capacity scenario",
            description:
              "Adjust team size to explore illustrative weekly capacity.",
            html: readFileSync(
              resolve("agent-core/test/fixtures/visualization.html"),
              "utf8",
            ),
          }),
        };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "visual_" + number } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: "visual_" + number,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
    return;
  }
  const text =
    "This is a local fixture response, streamed through the project-pinned Codex runtime. Your session, transcript, timings, and reconnect flow are real. Configure a model profile to use a live provider.";
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (x) =>
    res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
  const item = {
    type: "message",
    role: "assistant",
    id: "demo_" + number,
    content: [{ type: "output_text", text }],
  };
  emit({ type: "response.created", response: { id: "demo_" + number } });
  emit({ type: "response.output_item.added", item: { ...item, content: [] } });
  for (const word of text.split(" ")) {
    if (res.destroyed) break;
    emit({ type: "response.output_text.delta", delta: word + " " });
    await new Promise((r) => setTimeout(r, 50));
  }
  emit({ type: "response.output_item.done", item });
  emit({
    type: "response.completed",
    response: {
      id: "demo_" + number,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
await db
  .db("agent_demo")
  .collection("truex_models")
  .insertOne({
    _id: "fixture",
    provider: "Local fixture",
    modelName: "fixture-model",
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    reasoningEffort: "low",
    apikey: "demo-fixture-key",
    wireApi: "responses",
  });
await db.db("agent_demo").collection("truex_agents").insertOne({
  _id: "demo",
  name: "Local demo",
  description: "Project-local Codex · simulated provider output",
  modelProfileId: "fixture",
  systemPrompt: "Be helpful.",
  sandbox: "read-only",
  approvalPolicy: "never",
  mcpProfileIds: [],
});
const children = [];
function launch(service, env) {
  const child = spawn(
    "npm",
    service === "frontend"
      ? ["run", "dev", "--", "--port", frontendPort]
      : ["run", "dev"],
    {
      cwd: resolve(service),
      env: { ...process.env, ...env },
      stdio: "inherit",
      detached: true,
    },
  );
  children.push(child);
  return child;
}
launch("agent-core", {
  PORT: corePort,
  PROJECT_ROOT: resolve("."),
  CODEX_HOME: join(home, "codex"),
  AGENT_WORKSPACE: join(home, "workspace"),
});
launch("platform", {
  PORT: platformPort,
  MONGO_URI: mongo.getUri(),
  MONGO_DB: "agent_demo",
  AGENT_CORE_URLS: `http://127.0.0.1:${corePort}`,
  FRONTEND_ORIGIN: `http://localhost:${frontendPort}`,
  AGENT_WORKSPACE: join(home, "workspace"),
});
launch("frontend", {
  PORT: frontendPort,
  // The browser only talks to its own origin; the frontend forwards /api and
  // /auth to the platform at this address.
  PLATFORM_INTERNAL_URL: `http://localhost:${platformPort}`,
});
console.log(
  `Local demo: http://localhost:${frontendPort} — simulated provider, real project-local runtime. Data is discarded on exit.`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const child of children)
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  provider.closeAllConnections();
  provider.close();
  await new Promise((r) => setTimeout(r, 1000));
  await db.close();
  await mongo.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, close);
for (const child of children)
  child.on("exit", () => {
    if (!closing) void close();
  });

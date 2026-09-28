import { httpError } from "../../shared/errors";
import "dotenv/config";
import express from "express";
import { resolve, join } from "node:path";
import {
  mkdirSync,
  accessSync,
  constants,
  readFileSync,
  realpathSync,
} from "node:fs";
import { BusinessRuntime } from "./business-runtime";
import { startWorkspaceSweeper } from "./workspace-sweeper";
import { ThreadManager } from "./manager";
import { readItems } from "./history";
import { HttpError } from "./errors";
import { inventory, schema, validateRequest } from "./schema";
const root = resolve(process.env.PROJECT_ROOT || "..");
const pin = JSON.parse(readFileSync(join(root, "codex.lock.json"), "utf8"));
const binary = resolve(root, pin.binary);
// No PATH lookup or external CODEX_BIN override: runtime must be the project pin.
const home = join(
  resolve(process.env.CODEX_HOME || join(root, ".runtime/codex")),
  "business-v1",
);
mkdirSync(home, { recursive: true });
mkdirSync(
  resolve(process.env.AGENT_WORKSPACE || join(root, ".runtime/workspace")),
  { recursive: true },
);
const client = new BusinessRuntime(
  binary,
  home,
  Number(process.env.RPC_TIMEOUT_MS || 30000),
);
const manager = new ThreadManager(
  client,
  home,
  Number(process.env.MAX_THREADS || 20),
  Number(process.env.REPLAY_LIMIT || 500),
  Number(process.env.REQUEST_TIMEOUT_MS || 120000),
);
const stopSweeper = startWorkspaceSweeper(join(home, "business-workspaces"));
client.on("diagnostic", (line) =>
  process.stderr.write(manager.redactor.clean(line) + "\n"),
);
client.on("protocolError", (message) => process.stderr.write(message + "\n"));
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.get("/livez", (_req, res) => res.json({ ok: true }));
app.get("/healthz", async (_req, res) => {
  let writable = true;
  try {
    accessSync(home, constants.W_OK);
  } catch {
    writable = false;
  }
  const identity = await client.start();
  res.status(manager.draining ? 503 : 200).json({
    ok: !manager.draining,
    codex: identity.userAgent,
    revision: pin.revision,
    spawnMs: client.spawnMs,
    initializeMs: client.initializeMs,
    codexHome: home,
    codexHomeWritable: writable,
    unknownMethods: manager.unknownMethods,
    threads: manager.threads.size,
  });
});
app.get("/capabilities", (_req, res) => res.json(inventory));
app.get("/threads/:id/documents", async (req, res) =>
  res.json({
    available: client.documentToolsAvailable(req.params.id),
    visualizationAvailable: client.visualizationToolsAvailable(req.params.id),
    files: await client.files.list(req.params.id),
  }),
);
app.post("/threads/:id/documents", async (req, res) => {
  if (!client.documentToolsAvailable(req.params.id))
    throw new HttpError(409, "Start a new conversation to use documents");
  res
    .status(201)
    .json(
      await client.files.upload(req.params.id, req.body.name, req.body.base64),
    );
});
app.get("/threads/:id/visualizations/:fileId", async (req, res) =>
  res.json(await client.files.visualization(req.params.id, req.params.fileId)),
);
app.get("/threads/:id/documents/:fileId", async (req, res) => {
  const { data, ...file } = await client.files.get(
    req.params.id,
    req.params.fileId,
  );
  res.json({ ...file, base64: data.toString("base64") });
});
app.get("/schemas/:name", (req, res) => {
  if (!/^\w+$/.test(req.params.name))
    throw new HttpError(400, "Invalid schema");
  res.json(schema(req.params.name));
});
app.post("/threads", async (req, res) =>
  res.status(201).json({
    ...(await manager.create(req.body)),
    runtimeStartup: {
      spawnMs: client.spawnMs,
      initializeMs: client.initializeMs,
    },
  }),
);
app.post("/threads/:id/resume", async (req, res) =>
  res.json(await manager.resume(req.params.id, req.body)),
);
app.post("/threads/:id/turns", async (req, res) =>
  res
    .status(202)
    .json(
      await manager.message(req.params.id, req.body.text, req.body.clientId),
    ),
);
app.post("/threads/:id/steer", async (req, res) =>
  res
    .status(202)
    .json(
      await manager.message(
        req.params.id,
        req.body.text,
        req.body.clientId,
        true,
      ),
    ),
);
app.post("/threads/:id/interrupt", async (req, res) =>
  res.json(await manager.interrupt(req.params.id)),
);
app.get("/threads/:id/events", (req, res) =>
  manager.subscribe(
    req.params.id,
    res,
    req.get("Last-Event-ID") || String(req.query.cursor || "") || undefined,
  ),
);
app.get("/threads/:id/snapshot", (req, res) =>
  res.json(manager.snapshot(req.params.id)),
);
app.get("/threads/:id/records", (req, res) =>
  res.json(manager.records(req.params.id)),
);
app.post("/threads/:id/records/ack", (req, res) => {
  if (!Array.isArray(req.body.keys))
    throw new HttpError(400, "keys must be an array");
  manager.ack(req.params.id, req.body.keys);
  res.json({ ok: true });
});
app.post("/threads/:id/approvals/:requestId", (req, res) =>
  res.json(
    manager.answer(req.params.id, req.params.requestId, req.body.result),
  ),
);
app.get("/threads/:id/items", async (req, res) =>
  res.json(
    manager.redactor.clean(
      await readItems(
        client,
        req.params.id,
        String(req.query.cursor || "") || undefined,
      ),
    ),
  ),
);
app.get("/threads/:id/agents", (req, res) =>
  res.json(manager.agents(req.params.id)),
);
app.get("/threads/:id/agents/:agentId", (req, res) =>
  res.json(manager.agent(req.params.id, req.params.agentId)),
);
app.post("/threads/:id/agents/:agentId/interrupt", async (req, res) =>
  res.json(await manager.interruptAgent(req.params.id, req.params.agentId)),
);
app.post("/threads/:id/capabilities", async (req, res) =>
  res.json(
    await manager.capability(
      req.params.id,
      req.body.method,
      req.body.params || {},
    ),
  ),
);
app.delete("/threads/:id", async (req, res) =>
  res.json(await manager.capability(req.params.id, "thread/delete", {})),
);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) return _next(error);
    const { status, ...body } = httpError(error, "agent-core");
    res.status(status).json(manager.redactor.clean(body));
  },
);
const server = app.listen(
  Number(process.env.PORT || 4100),
  process.env.HOST || "127.0.0.1",
  () => console.log(`agent-core listening on ${process.env.PORT || 4100}`),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    manager.draining = true;
    const deadline = Date.now() + Number(process.env.DRAIN_TIMEOUT_MS || 30000);
    while (
      [...manager.threads.values()].some((t) => t.state.kind !== "idle") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 100));
    stopSweeper();
    manager.close();
    client.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });

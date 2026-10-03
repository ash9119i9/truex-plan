/** Live, read-only A/B benchmark. Run from repository root with PROJECT_ROOT set:
 * PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-omni-mcp.ts --mode direct
 * PROJECT_ROOT="$PWD" platform/node_modules/.bin/tsx platform/scripts/benchmark-omni-mcp.ts --mode omni
 * Uses the production configuration builder, runtime and gateway; never edits Codex or database records.
 */
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { documentStore } from "./token-profiler-documents";
import { PlatformService } from "../src/service";
import { BusinessRuntime } from "../../agent-core/src/business-runtime";
import { ThreadManager } from "../../agent-core/src/manager";
import { Redactor } from "../../agent-core/src/redact";
import {
  isToolQuestion,
  parseToolQuestion,
} from "../../agent-core/src/approval-modes";
import { createGateway } from "../../model-gateway/src/server";

const root = resolve(__dirname, "../..");
const messages = [
  "Hi bro ?",
  "Can you list down the apps in the qlik ?",
  "What is the capital of india ?",
];
const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "direct" },
    out: { type: "string" },
    projection: { type: "string", default: "optional" },
    "timeout-ms": { type: "string", default: "240000" },
    "max-calls": { type: "string", default: "24" },
    "upstream-timeout-ms": { type: "string", default: "60000" },
  },
});
const mode = values.mode!;
if (!["direct", "omni"].includes(mode))
  throw new Error("--mode must be direct or omni");
const projection = values.projection!;
if (!["optional", "required"].includes(projection))
  throw new Error("--projection must be optional or required");
const deadlineMs = Number(values["timeout-ms"]);
const maxCalls = Number(values["max-calls"]);
const upstreamTimeoutMs = Number(values["upstream-timeout-ms"]);
const outDir = resolve(values.out || join(root, "docs", "omni-mcp-benchmark"));
dotenv.config({ path: join(root, "platform/.env"), quiet: true });
dotenv.config({ path: join(root, "agent-core/.env"), quiet: true });
process.env.TRUEX_MCP_GATEWAY_MODE = mode;
process.env.TRUEX_MCP_GATEWAY_PROJECTION = projection;
const redactor = new Redactor();
const clean = (value: any) => redactor.clean(value);
const now = () => new Date().toISOString();
const artifact: any = {
  version: 1,
  createdAt: now(),
  mode,
  projection,
  runConditions: {
    turnTimeoutMs: deadlineMs,
    upstreamFirstByteTimeoutMs: upstreamTimeoutMs,
    upstreamIdleTimeoutMs: upstreamTimeoutMs,
    maxCalls,
  },
  messages,
  scenario:
    "Supplied Research Agent, production BusinessRuntime, three sequential messages in one fresh thread",
  codexOutgoing: [],
  responsesRequests: [],
  providerCalls: [],
  gatewayLogs: [],
  runtimeEvents: [],
  omniGatewayEvents: [],
  turns: [],
  outcome: "running",
};
const parseTasks: Promise<void>[] = [];
let activeTurn = 0;
let runtime: BusinessRuntime | undefined;
let manager: ThreadManager | undefined;
let gateway: Server | undefined;
let relay: Server | undefined;
let home = "";
let threadId = "";
const mongo = new MongoClient(
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
);
const secretValues: string[] = [];

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}`;
}
function schemas(body: any) {
  return (body.tools || []).flatMap((tool: any) =>
    tool.type === "namespace" ? tool.tools || [] : [tool],
  );
}
function total(calls: any[]) {
  return calls.reduce(
    (sum, call) => ({
      input: sum.input + Number(call.usage?.input_tokens || 0),
      output: sum.output + Number(call.usage?.output_tokens || 0),
      calls: sum.calls + 1,
    }),
    { input: 0, output: 0, calls: 0 },
  );
}
function report() {
  const sums = total(artifact.providerCalls);
  const rows = artifact.providerCalls
    .map(
      (call: any, i: number) =>
        `| ${i + 1} | ${call.turn} | ${call.body.tools?.length || 0} | ${call.usage?.input_tokens ?? "unknown"} | ${call.usage?.output_tokens ?? "unknown"} | ${call.durationMs?.toFixed(0) ?? "unknown"} |`,
    )
    .join("\n");
  const turnRows = artifact.turns
    .map((turn: any) => {
      const s = total(
        artifact.providerCalls.filter((c: any) => c.turn === turn.index),
      );
      return `| ${turn.index} | ${turn.message} | ${s.calls} | ${s.input} | ${s.output} | ${turn.durationMs?.toFixed(0) ?? "running"} | ${turn.status} |`;
    })
    .join("\n");
  const replies = artifact.turns
    .map(
      (turn: any) =>
        `### Turn ${turn.index}: ${turn.message}\n\nStatus: ${turn.status}. Thread: \`${threadId}\`.\n\n${turn.reply || "No final reply."}\n\nTool exchanges:\n\n\`\`\`json\n${JSON.stringify(turn.toolItems, null, 2)}\n\`\`\``,
    )
    .join("\n\n");
  return `# Live ${mode} MCP benchmark\n\nCaptured ${artifact.createdAt}. Outcome: **${artifact.outcome}**. One fresh thread; each turn started after its predecessor completed. Codex revision: \`${artifact.codexRevision}\`. No Codex source modifications.\n\n## Measured turn totals\n\n| Turn | User message | Upstream attempts | Reported input tokens | Reported output tokens | Turn duration ms | Status |\n|---|---|---:|---:|---:|---:|---|\n${turnRows}\n| **Total known usage** | | **${sums.calls}** | **${sums.input}** | **${sums.output}** | | |\n\n## Every provider request\n\n| Attempt | Turn | Function schemas | Input tokens | Output tokens | Provider stream ms |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\nToken totals sum provider-reported generation usage, not character-based estimates. Failed or interrupted attempts without usage are **unknown**, excluded from known-usage totals, not assumed free. Missing cache/reasoning counters mean unknown, even if runtime reports zero. Zero output tokens alongside generated tool calls indicate an upstream accounting anomaly. Every discovery call counts toward the total.\n\n## Complete messages, answers and tool results\n\n${replies}\n\n## Payload and observability files\n\n- [All redacted wire requests, provider SSE events, runtime events, traces and gateway events](${mode}-capture.json)\n- [Exact JSON-RPC messages written to Codex stdin](${mode}-codex-input.jsonl)\n- [Exact Responses bodies generated by Codex](${mode}-responses-requests.jsonl)\n- [Exact Anthropic request bodies sent upstream](${mode}-provider-requests.jsonl)\n\nThe Codex \`turn/start\` RPC contains the new message; Codex maintains thread history and expands it into model requests. Payloads retain full instructions, schemas, history and tool results. Credentials and connector HTTP headers are redacted. Runtime MCP events show real tool results; gateway events quantify projection. No estimated component breakdown is substituted for measured billing.\n\n## Run conditions and limits\n\nThe configuration builder loads model and MCP profiles read-only from MongoDB and uses the supplied scenario agent. Explicit connector documents are normalized into that scenario without writes to tenant configuration. Native tools remain unchanged. MCP startup is awaited before the greeting. The harness can approve only the explicitly authorized Qlik \`get_apps\` action or read-only Omni discovery. It refuses writes and unrelated approval prompts. Calls capped at ${maxCalls}, timeout ${deadlineMs} ms per turn. Sequential real-world A/B trials are sensitive to model variability and live source changes; one run is directional evidence, not a statistical performance guarantee.\n`;
}
async function save() {
  await mkdir(outDir, { recursive: true });
  const body = JSON.stringify(clean(artifact), null, 2) + "\n";
  for (const secret of secretValues)
    if (secret && body.includes(secret))
      throw new Error("Credential detected in capture; refusing to persist");
  await writeFile(join(outDir, `${mode}-capture.json`), body);
  for (const [file, rows] of [
    ["codex-input", artifact.codexOutgoing.map((r: any) => r.payload)],
    ["responses-requests", artifact.responsesRequests.map((r: any) => r.body)],
    ["provider-requests", artifact.providerCalls.map((r: any) => r.body)],
  ] as const) {
    const text =
      rows.map((row: any) => JSON.stringify(clean(row))).join("\n") + "\n";
    for (const secret of secretValues)
      if (secret && text.includes(secret))
        throw new Error("Credential detected in payload; refusing to persist");
    await writeFile(join(outDir, `${mode}-${file}.jsonl`), text);
  }
  await writeFile(join(outDir, `${mode}-report.md`), clean(report()));
}
async function authorizePending(snapshot: any) {
  for (const pending of snapshot.pending || []) {
    if (pending.method !== "item/tool/requestUserInput")
      throw new Error(`Unapproved runtime request: ${pending.method}`);
    const answers: any = {};
    for (const question of pending.detail?.questions || []) {
      const ref = parseToolQuestion(question.question);
      if (!isToolQuestion(question) || !ref)
        throw new Error(
          "Unexpected clarification/approval; not authorized by benchmark",
        );
      let allowed =
        activeTurn === 2 && ref.server === "qlik" && ref.tool === "get_apps";
      if (mode === "omni") {
        const items = artifact.runtimeEvents
          .filter(
            (event: any) =>
              event.turn === activeTurn &&
              event.params?.item?.type === "mcpToolCall",
          )
          .map((event: any) => event.params.item);
        const item = [...items]
          .reverse()
          .find(
            (i: any) =>
              i.tool === ref.tool && (!ref.server || i.server === ref.server),
          );
        let args = item?.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {}
        }
        allowed =
          ["discover_server", "discover_tools", "get_tool_schema"].includes(
            ref.tool,
          ) ||
          (activeTurn === 2 &&
            ref.tool === "invoke_tool" &&
            args?.server === "qlik" &&
            args?.tool === "get_apps");
      }
      if (
        !allowed ||
        !question.options?.some((option: any) => option.label === "Allow")
      )
        throw new Error(`Unapproved action: ${ref.server}/${ref.tool}`);
      answers[question.id] = { answers: ["Allow"] };
    }
    if (!Object.keys(answers).length) throw new Error("Empty approval request");
    manager!.answer(threadId, pending.requestId, { answers });
  }
}

async function main() {
  try {
    await mongo.connect();
    const catalog = mongo.db(
      process.env.CATALOG_MONGO_DB || process.env.MONGO_DB || "truex",
    );
    const tenant = mongo.db(process.env.MONGO_DB || "truex");
    const candidates = (id: string) => ({ $in: [id, new ObjectId(id)] });
    const [model, mcp] = await Promise.all([
      catalog
        .collection<any>("truex_models")
        .findOne({ _id: candidates("6ab96fa2077a84a32b05b738") }),
      tenant
        .collection<any>("truex_mcp")
        .findOne({ _id: candidates("6aaa7db671c8cc9e29e08d93") }),
    ]);
    if (!model || !mcp)
      throw new Error("Model/MCP profile not found in configured databases");
    redactor.remember(model);
    redactor.remember(mcp);
    secretValues.push(model.apikey, mcp.apiKey);
    const agent = {
      _id: "agent_ea6007a6-aae5-4e50-824c-1480256bfeea",
      name: "Research Agent",
      handle: "researchagent",
      description: "",
      systemPrompt: "You are senior consultant",
      modelProfileId: String(model._id),
      sandbox: "read-only",
      approvalPolicy: "on-request",
      mcpProfileIds: [String(mcp._id)],
      skillIds: [],
      builtin: false,
      enabled: true,
    };
    const lock = JSON.parse(
      await readFile(join(root, "codex.lock.json"), "utf8"),
    );
    artifact.codexRevision = lock.revision;
    home = await mkdtemp(join(tmpdir(), `truex-${mode}-benchmark-`));
    const secret = randomBytes(32).toString("hex");
    secretValues.push(secret);
    redactor.remember({ secret });
    gateway = createGateway({
      secret,
      upstreamFirstByteTimeoutMs: upstreamTimeoutMs,
      upstreamIdleTimeoutMs: upstreamTimeoutMs,
      findProfile: async () => model as any,
      log: (line) => {
        try {
          artifact.gatewayLogs.push({
            turn: activeTurn,
            ...clean(JSON.parse(line)),
          });
        } catch {
          artifact.gatewayLogs.push({ turn: activeTurn, line: clean(line) });
        }
      },
      fetch: async (input, init) => {
        if (artifact.providerCalls.length >= maxCalls)
          throw new Error("Benchmark provider call limit exceeded");
        const started = performance.now();
        const call: any = {
          at: now(),
          turn: activeTurn,
          body: clean(JSON.parse(String(init?.body))),
          events: [],
          usage: {},
        };
        artifact.providerCalls.push(call);
        let response: Response;
        try {
          response = await fetch(input, init);
        } catch (error) {
          call.durationMs = performance.now() - started;
          call.error = clean(String(error));
          throw error;
        }
        call.status = response.status;
        call.firstResponseMs = performance.now() - started;
        parseTasks.push(
          (async () => {
            const text = await response.clone().text();
            for (const line of text.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5).trim());
                call.events.push(clean(event));
                if (event.type === "message_start")
                  Object.assign(call.usage, event.message?.usage);
                if (event.type === "message_delta")
                  Object.assign(call.usage, event.usage);
              } catch {
                /* SSE comments and terminal sentinels are not JSON. */
              }
            }
            call.durationMs = performance.now() - started;
            if (!call.events.length) call.rawResponse = clean(text);
          })().catch((error) => {
            call.durationMs = performance.now() - started;
            call.parseError = clean(String(error));
          }),
        );
        return response;
      },
    });
    const gatewayRoot = await listen(gateway);
    process.env.MODEL_GATEWAY_URL = gatewayRoot;
    process.env.MODEL_GATEWAY_SECRET = secret;
    relay = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        artifact.responsesRequests.push({
          at: now(),
          turn: activeTurn,
          path: req.url,
          body: clean(JSON.parse(raw)),
        });
        const response = await fetch(gatewayRoot + req.url, {
          method: req.method,
          headers: {
            authorization: String(req.headers.authorization || ""),
            "content-type": "application/json",
          },
          body: raw,
        });
        res.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") || "text/event-stream",
        });
        if (response.body)
          for await (const chunk of response.body as any) res.write(chunk);
        res.end();
      } catch (error) {
        res.writeHead(502);
        res.end(JSON.stringify(clean({ error: String(error) })));
      }
    });
    const relayRoot = await listen(relay);
    const store = documentStore(agent, model, [mcp]);
    const service = new PlatformService(store, []);
    const config: any = await store.withTenant(
      await store.resolveTenant("default"),
      () =>
        service.configuration(agent._id, {
          cwd: join(home, "requested-workspace"),
        }),
    );
    const provider = config.config[`model_providers.${config.modelProvider}`];
    provider.base_url = provider.base_url.replace(gatewayRoot, relayRoot);
    delete config.approvalMode;
    delete config.approvalNameHeuristic;
    redactor.remember(config);
    artifact.configuration = clean(config);
    runtime = new BusinessRuntime(join(root, lock.binary), home, 40000);
    const originalWrite = (runtime as any).write.bind(runtime);
    (runtime as any).write = (payload: any) => {
      redactor.remember(payload);
      artifact.codexOutgoing.push({
        at: now(),
        turn: activeTurn,
        payload: clean(payload),
      });
      return originalWrite(payload);
    };
    runtime.on("notification", (event: any) =>
      artifact.runtimeEvents.push({
        at: now(),
        turn: activeTurn,
        ...clean(event),
      }),
    );
    runtime.on("serverRequest", (event: any) =>
      artifact.runtimeEvents.push({
        at: now(),
        turn: activeTurn,
        eventType: "serverRequest",
        ...clean(event),
      }),
    );
    runtime.on("omniGatewayEvent", (event: any) =>
      artifact.omniGatewayEvents.push({
        at: now(),
        turn: activeTurn,
        ...clean(event),
      }),
    );
    manager = new ThreadManager(runtime, home, 4, 500, 120000, deadlineMs);
    const thread = await manager.create(config);
    threadId = thread.threadId;
    artifact.threadId = threadId;
    artifact.mcpStatus = clean(
      await runtime.request("mcpServerStatus/list", { threadId }),
    );
    const count = artifact.mcpStatus.data?.reduce(
      (n: number, server: any) => n + Object.keys(server.tools || {}).length,
      0,
    );
    console.log(
      JSON.stringify({ mode, stage: "mcp-ready", toolCount: count, threadId }),
    );
    for (let index = 0; index < messages.length; index++) {
      activeTurn = index + 1;
      const started = performance.now();
      const entry: any = {
        index: activeTurn,
        message: messages[index],
        startedAt: now(),
        status: "running",
      };
      artifact.turns.push(entry);
      const turn = await manager.message(
        threadId,
        messages[index],
        randomUUID(),
      );
      entry.turnId = turn.turnId;
      let snap: any;
      let lastProgress = performance.now();
      while (performance.now() - started < deadlineMs) {
        snap = manager.snapshot(threadId);
        await authorizePending(snap);
        const trace = snap.traces.find((t: any) => t.turnId === turn.turnId);
        if (performance.now() - lastProgress > 10000) {
          lastProgress = performance.now();
          console.log(
            JSON.stringify({
              mode,
              turn: activeTurn,
              stage: "waiting",
              state: snap.state.kind,
              calls: artifact.providerCalls.length,
              lastEvent: artifact.runtimeEvents.at(-1)?.method,
            }),
          );
          await save();
        }
        if (trace && snap.state.kind === "idle") {
          entry.trace = clean(trace);
          entry.status = trace.status;
          entry.reply = snap.messages
            .filter((m: any) => m.turnId === turn.turnId)
            .map((m: any) => m.text)
            .join("\n");
          entry.toolItems = artifact.runtimeEvents
            .filter(
              (event: any) =>
                event.turn === activeTurn &&
                event.method === "item/completed" &&
                event.params?.item?.type === "mcpToolCall",
            )
            .map((event: any) => event.params.item);
          entry.snapshot = clean(snap);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      entry.completedAt = now();
      entry.durationMs = performance.now() - started;
      if (!entry.trace) {
        await manager.interrupt(threadId);
        throw new Error(`Turn ${activeTurn} timed out`);
      }
      await Promise.all(parseTasks);
      console.log(
        JSON.stringify({
          mode,
          turn: activeTurn,
          status: entry.status,
          ...total(
            artifact.providerCalls.filter(
              (call: any) => call.turn === activeTurn,
            ),
          ),
          durationMs: Math.round(entry.durationMs),
        }),
      );
      if (entry.status !== "completed")
        throw new Error(`Turn ${activeTurn} ${entry.status}`);
      await save();
    }
    artifact.outcome = "completed";
  } catch (error) {
    artifact.outcome = "failed";
    artifact.error = clean({
      message: String(error),
      stack: (error as Error)?.stack,
    });
    console.error(
      JSON.stringify({
        mode,
        outcome: "failed",
        message: clean(String(error)),
      }),
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(parseTasks);
    artifact.finishedAt = now();
    await save();
    manager?.close();
    runtime?.stop();
    for (const server of [relay, gateway]) {
      server?.closeAllConnections();
      server?.close();
    }
    await mongo.close();
    if (home) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(home, { recursive: true, force: true });
    }
    console.log(
      JSON.stringify({
        mode,
        outcome: artifact.outcome,
        ...total(artifact.providerCalls),
        outDir,
      }),
    );
  }
}
void main().catch((error) => {
  console.error(clean(String(error)));
  process.exitCode = 1;
});

/**
 * MCP parity probe: what does native Codex show the model for one MCP server?
 *
 *   truex   Start the pinned Codex through TRUEX's BusinessRuntime with the
 *           server configured the way the platform configures it, run one turn
 *           against a local capture endpoint, write a report.
 *   serve   Run only the capture endpoint, for a standalone `codex` run whose
 *           config.toml stays untouched except for the model provider.
 *   compare Diff two reports (any mix of truex and serve output).
 *
 * No model is called and no MCP tool is executed: the capture endpoint answers
 * with a plain message, so the probe only initializes and lists tools. Secrets
 * come from environment variables, never arguments, and never reach a report.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BusinessRuntime } from "../../agent-core/src/runtime/business-runtime";
import { Redactor } from "../../agent-core/src/telemetry/redact";
import { attachedMcpInstructions } from "../src/mcp/profiles";

const sha = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" ? value : JSON.stringify(canonical(value)),
    )
    .digest("hex")
    .slice(0, 12);
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

// What the model was offered, reduced to comparable fingerprints.
export function summarize(body: any) {
  const tools: any[] = body.tools ?? [];
  const connectors = tools
    .filter((t) => t.type === "namespace" && String(t.name).startsWith("mcp__"))
    .map((t) => ({
      namespace: t.name,
      description: sha(t.description ?? ""),
      descriptionChars: String(t.description ?? "").length,
      tools: (t.tools ?? [])
        .map((f: any) => ({
          name: f.name,
          description: sha(f.description ?? ""),
          schema: sha(f.parameters ?? {}),
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.namespace.localeCompare(b.namespace));
  return {
    model: body.model,
    reasoningEffort: body.reasoning?.effort ?? null,
    instructionsChars: String(body.instructions ?? "").length,
    toolSearch: tools.some((t) => t.type === "tool_search"),
    otherTools: tools
      .filter((t) => !(t.type === "namespace" && t.name?.startsWith("mcp__")))
      .map((t) => t.name ?? t.type)
      .sort(),
    connectors,
  };
}

// A Responses endpoint that records each request and answers with one message.
async function capture() {
  const bodies: any[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method !== "POST" || !req.url?.includes("/responses")) {
      res.writeHead(404).end();
      return;
    }
    bodies.push(JSON.parse(raw));
    const item = {
      type: "message",
      role: "assistant",
      id: "msg_probe",
      content: [{ type: "output_text", text: "probe" }],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (event: any) =>
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({ type: "response.created", response: { id: "resp_probe" } });
    emit({ type: "response.output_item.added", item });
    emit({ type: "response.output_item.done", item });
    emit({
      type: "response.completed",
      response: {
        id: "resp_probe",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    bodies,
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const first = (bodies: any[]) => bodies.find((b) => Array.isArray(b.tools));

async function truex(values: Record<string, any>) {
  const { name, url } = values;
  if (!name || !url) throw new Error("truex needs --name and --url");
  const server: Record<string, unknown> = { url };
  const secrets = new Redactor();
  if (values["header-env"] || values["bearer-env"]) {
    const env = values["header-env"] ?? values["bearer-env"];
    const key = process.env[env];
    if (!key) throw new Error(`${env} is not set`);
    secrets.remember({ apiKey: key });
    server.http_headers = values["header-env"]
      ? { [values["header-name"] ?? "Authorization"]: key }
      : { Authorization: `Bearer ${key}` };
  }
  if (values["startup-timeout"])
    server.startup_timeout_sec = Number(values["startup-timeout"]);
  if (values["tool-timeout"])
    server.tool_timeout_sec = Number(values["tool-timeout"]);
  const lock = JSON.parse(readFileSync("codex.lock.json", "utf8"));
  const home = await mkdtemp(join(tmpdir(), "truex-parity-"));
  const model = await capture();
  const runtime = new BusinessRuntime(resolve(lock.binary), home, 60000);
  const startup: any[] = [];
  runtime.on("notification", (msg: any) => {
    if (msg?.method === "mcpServer/startupStatus/updated")
      startup.push(secrets.clean(msg.params));
  });
  try {
    await runtime.start();
    const { thread } = await runtime.request("thread/start", {
      model: values.model ?? "gpt-5",
      modelProvider: "capture",
      // The platform's own instruction text for an agent with this server.
      baseInstructions: attachedMcpInstructions([name]),
      config: {
        "model_providers.capture": {
          name: "capture",
          base_url: model.url,
          wire_api: "responses",
          experimental_bearer_token: "probe",
        },
        [`mcp_servers.${name}`]: server,
      },
    });
    const done = new Promise<void>((ok) =>
      runtime.on("notification", (msg: any) => {
        if (msg?.method === "turn/completed") ok();
      }),
    );
    await runtime.request("turn/start", {
      threadId: thread.id,
      input: [
        {
          type: "text",
          text: values.prompt ?? "List what you can do.",
          text_elements: [],
        },
      ],
    });
    await done;
    const status = await runtime.request("mcpServerStatus/list", {
      threadId: thread.id,
    });
    const listed = (status.data ?? []).find((s: any) => s.name === name);
    return {
      kind: "truex",
      createdAt: new Date().toISOString(),
      revision: lock.revision,
      startup,
      serverTools: Object.values(listed?.tools ?? {})
        .map((t: any) => ({ name: t.name, schema: sha(t.inputSchema ?? {}) }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      request: first(model.bodies) ? summarize(first(model.bodies)) : null,
    };
  } finally {
    runtime.stop();
    model.close();
    await new Promise((r) => setTimeout(r, 300));
    await rm(home, { recursive: true, force: true });
  }
}

async function serve(values: Record<string, any>) {
  const model = await capture();
  console.error(
    [
      `Capture endpoint: ${model.url}`,
      "Run the standalone Codex you want to compare, keeping its config.toml, with:",
      `  codex exec --skip-git-repo-check \\`,
      `    -c model_provider=capture \\`,
      `    -c 'model_providers.capture={name="capture",base_url="${model.url}",wire_api="responses",experimental_bearer_token="probe"}' \\`,
      `    "List what you can do."`,
      "Press Ctrl-C when it has finished; the report is then written.",
    ].join("\n"),
  );
  await new Promise<void>((ok) => {
    process.once("SIGINT", ok);
    process.once("SIGTERM", ok);
  });
  model.close();
  return {
    kind: "standalone",
    createdAt: new Date().toISOString(),
    request: first(model.bodies) ? summarize(first(model.bodies)) : null,
    requestCount: model.bodies.length,
  };
}

export function compare(a: any, b: any) {
  const x = a.request,
    y = b.request;
  if (!x || !y) return ["A report has no model request; nothing to compare."];
  // What the MCP server itself controls, then what the host around it adds.
  const mcp: string[] = [];
  const context: string[] = [];
  for (const key of ["model", "reasoningEffort", "toolSearch"] as const)
    if (x[key] !== y[key]) context.push(`${key}: ${x[key]} vs ${y[key]}`);
  context.push(
    `instructions: ${x.instructionsChars} vs ${y.instructionsChars} characters`,
  );
  const only = (p: string[], q: string[]) => p.filter((n) => !q.includes(n));
  for (const [label, p, q] of [
    ["only in A", x.otherTools, y.otherTools],
    ["only in B", y.otherTools, x.otherTools],
  ] as const)
    if (only(p, q).length)
      context.push(`non-MCP tools ${label}: ${only(p, q).join(", ")}`);
  const names = new Set([
    ...x.connectors.map((c: any) => c.namespace),
    ...y.connectors.map((c: any) => c.namespace),
  ]);
  for (const ns of names) {
    const p = x.connectors.find((c: any) => c.namespace === ns);
    const q = y.connectors.find((c: any) => c.namespace === ns);
    if (!p || !q) {
      mcp.push(`${ns}: present only in ${p ? "A" : "B"}`);
      continue;
    }
    if (p.description !== q.description)
      mcp.push(
        `${ns}: server instructions differ (${p.descriptionChars} vs ${q.descriptionChars} characters)`,
      );
    for (const t of new Set([
      ...p.tools.map((f: any) => f.name),
      ...q.tools.map((f: any) => f.name),
    ])) {
      const f = p.tools.find((e: any) => e.name === t);
      const g = q.tools.find((e: any) => e.name === t);
      if (!f || !g) mcp.push(`${ns}.${t}: present only in ${f ? "A" : "B"}`);
      else if (f.schema !== g.schema) mcp.push(`${ns}.${t}: schema differs`);
      else if (f.description !== g.description)
        mcp.push(`${ns}.${t}: description differs`);
    }
  }
  return [
    mcp.length
      ? "MCP differences:"
      : "MCP tool catalogs match (names, descriptions, schemas, server instructions).",
    ...mcp.map((l) => "  " + l),
    "Host context differences (not caused by the MCP server):",
    ...context.map((l) => "  " + l),
  ];
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      url: { type: "string" },
      "header-name": { type: "string" },
      "header-env": { type: "string" },
      "bearer-env": { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      "startup-timeout": { type: "string" },
      "tool-timeout": { type: "string" },
      out: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (command === "compare") {
    const [a, b] = await Promise.all(
      rest.slice(0, 2).map(async (f) => JSON.parse(await readFile(f, "utf8"))),
    );
    console.log(compare(a, b).join("\n"));
    return;
  }
  if (command !== "truex" && command !== "serve")
    throw new Error("Usage: truex | serve | compare A.json B.json");
  const report = await (command === "truex" ? truex(values) : serve(values));
  const text = JSON.stringify(report, null, 2) + "\n";
  if (values.out) await writeFile(values.out, text);
  else process.stdout.write(text);
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

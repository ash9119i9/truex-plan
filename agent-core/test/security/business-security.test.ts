import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../../src/business-runtime";
import { ThreadManager } from "../../src/manager";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");

test(
  "business runtime rejects forced local tools, override attempts and legacy resume",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-security-"));
    const privateFile = join(home, "private.txt"),
      marker = join(home, "executed.txt");
    const secret = "PRIVATE_CANARY_cbbd5281";
    writeFileSync(privateFile, secret);
    const attempts = [
      {
        name: "shell_command",
        args: { command: `cat ${privateFile}; touch ${marker}` },
      },
      {
        name: "exec_command",
        args: { cmd: `cat ${privateFile}; touch ${marker}` },
      },
      {
        name: "shell",
        args: { command: ["sh", "-c", `cat ${privateFile}; touch ${marker}`] },
      },
      { name: "view_image", args: { path: privateFile } },
      {
        name: "apply_patch",
        args: {
          patch: `*** Begin Patch\n*** Add File: ${marker}\n+executed\n*** End Patch`,
        },
      },
    ];
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(raw));
      const attempt = attempts[requests.length - 1];
      const item = attempt
        ? {
            type: "function_call",
            call_id: "attack_" + requests.length,
            name: attempt.name,
            arguments: JSON.stringify(attempt.args),
          }
        : {
            type: "message",
            role: "assistant",
            id: "done",
            content: [
              {
                type: "output_text",
                text: "No business connector is configured.",
              },
            ],
          };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        {
          type: "response.created",
          response: { id: "response_" + requests.length },
        },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: "response_" + requests.length,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const client = new BusinessRuntime(binary, home, 15000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    await assert.rejects(
      client.request("thread/resume", { threadId: "legacy", history: [] }),
      /new Truex conversation/,
    );
    for (const method of ["command/exec", "fs/readFile", "config/value/write"])
      await assert.rejects(client.request(method, {}), /not available/);
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      cwd: resolve(".."),
      sandbox: "danger-full-access",
      approvalPolicy: "on-request",
      environments: [{ environmentId: "local", cwd: resolve("..") }],
      config: {
        "features.shell_tool": true,
        "features.multi_agent": true,
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    });
    await manager.message(
      threadId,
      "List the connected business applications.",
    );
    const deadline = Date.now() + 20000;
    while (
      manager.snapshot(threadId).state.kind !== "idle" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.snapshot(threadId).state.kind, "idle");
    assert.equal(
      requests.length,
      attempts.length + 1,
      "Each forced tool call must return a rejection to the model",
    );
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(privateFile, "utf8"), secret);
    for (const request of requests) {
      assert.doesNotMatch(
        JSON.stringify(request.tools),
        /"(?:shell_command|shell|exec_command|apply_patch|view_image)"/,
      );
      assert.ok(!JSON.stringify(request).includes(secret));
      assert.ok(!JSON.stringify(request).includes("truex_models"));
    }
    const outputs = requests
      .at(-1)
      .input.filter((i: any) => i.type === "function_call_output");
    assert.equal(outputs.length, attempts.length);
    for (const output of outputs)
      assert.match(
        JSON.stringify(output),
        /unsupported|unknown|not found|unrecognized|not available/i,
      );
    assert.equal(manager.snapshot(threadId).pending.length, 0);
    assert.match(
      JSON.stringify(requests[0].tools),
      /spawn_agent/,
      "Collaboration remains available",
    );
    for (const params of [
      { cwd: resolve("..") },
      { sandboxPolicy: { type: "dangerFullAccess" } },
      { collaborationMode: {} },
    ])
      await assert.rejects(
        client.request("thread/settings/update", { threadId, ...params }),
        /not available/,
      );
    await assert.rejects(
      client.request("thread/fork", { threadId, path: privateFile }),
      /not available/,
    );
    const fork = await manager.capability(threadId, "thread/fork", {});
    await manager.message(fork.thread.id, "Continue this conversation");
    const forkDeadline = Date.now() + 15000;
    while (
      manager.snapshot(fork.thread.id).state.kind !== "idle" &&
      Date.now() < forkDeadline
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.snapshot(fork.thread.id).state.kind, "idle");
    assert.doesNotMatch(
      JSON.stringify(requests.at(-1).tools),
      /"(?:shell_command|exec_command|apply_patch|view_image)"/,
    );
    assert.equal(existsSync(marker), false);
  },
);

test("business connectors accept only native HTTP settings that cannot read the host", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "truex-connector-policy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = new BusinessRuntime("unused", home);
  const start = (server: unknown) =>
    runtime.request("thread/start", {
      model: "m",
      modelProvider: "p",
      config: { "mcp_servers.sap": server },
    });
  const policy = { status: 422, code: "CONNECTOR_POLICY" };
  for (const server of [
    { command: "node" },
    { url: "https://mcp.example/mcp", command: "node" },
    {
      url: "https://mcp.example/mcp",
      env_http_headers: { Authorization: "X" },
    },
    { url: "https://mcp.example/mcp", bearer_token_env_var: "MONGO_URI" },
    { url: "https://mcp.example/mcp", http_headers_helper: "/bin/sh" },
    { url: "https://mcp.example/mcp", env_vars: ["AWS_SECRET_ACCESS_KEY"] },
    { url: "https://mcp.example/mcp", required: true },
    null,
    "https://mcp.example/mcp",
  ])
    await assert.rejects(start(server), policy, JSON.stringify(server));
  await assert.rejects(
    start({ url: "https://mcp.example/mcp", env_http_headers: {} }),
    /"env_http_headers"/,
  );
});

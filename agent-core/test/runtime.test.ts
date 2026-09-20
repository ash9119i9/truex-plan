import { BusinessRuntime } from "../src/business-runtime";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexClient } from "../src/client";
import { readItems } from "../src/history";
import { ThreadManager } from "../src/manager";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
async function until(predicate: () => boolean, timeout = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout)
      throw new Error("Runtime completion timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
test(
  "pinned runtime: isolated provider keys, streaming, final persistence and same-home resume",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-runtime-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace);
    const requests: { auth: string; body: any }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (!req.url?.includes("/responses")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      requests.push({
        auth: String(req.headers.authorization),
        body: JSON.parse(body),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (x: any) =>
        res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
      const item = {
        type: "message",
        role: "assistant",
        id: "msg_" + requests.length,
        content: [
          { type: "output_text", text: "Hello from the local fixture." },
        ],
      };
      emit({
        type: "response.created",
        response: { id: "resp_" + requests.length },
      });
      emit({
        type: "response.output_item.added",
        item: { ...item, content: [] },
      });
      for (const delta of ["Hello ", "from the ", "local fixture."]) {
        emit({ type: "response.output_text.delta", delta });
        await new Promise((r) => setTimeout(r, 20));
      }
      emit({ type: "response.output_item.done", item });
      emit({
        type: "response.completed",
        response: {
          id: "resp_" + requests.length,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    let client = new BusinessRuntime(binary, home, 15000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const identity = await client.start();
    assert.ok(identity.userAgent);
    const config = (key: string) => ({
      model: "gpt-5",
      modelProvider: "fixture",
      cwd: workspace,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: key,
        },
        model_reasoning_effort: "low",
      },
    });
    const a = await manager.create(config("fixture-key-a")),
      b = await manager.create(config("fixture-key-b"));
    await Promise.all([
      manager.message(a.threadId, "Say hello", "message_a"),
      manager.message(b.threadId, "Say hello", "message_b"),
    ]);
    await until(
      () =>
        manager.snapshot(a.threadId).state.kind === "idle" &&
        manager.snapshot(b.threadId).state.kind === "idle",
    );
    assert.deepEqual(
      new Set(requests.map((r) => r.auth)),
      new Set(["Bearer fixture-key-a", "Bearer fixture-key-b"]),
    );
    assert.equal(
      manager.snapshot(a.threadId).messages[0].text,
      "Hello from the local fixture.",
    );
    assert.equal(manager.snapshot(a.threadId).timings[0].deltaCount, 3);
    assert.equal(manager.unknownMethods, 0);
    assert.ok(
      manager.records(a.threadId).some((r) => r.event.type === "message.final"),
    );
    manager.close();
    client.stop();
    await new Promise((r) => setTimeout(r, 500));
    client = new BusinessRuntime(binary, home, 15000);
    manager = new ThreadManager(client, home);
    await manager.resume(a.threadId, config("fixture-key-a"));
    await manager.message(a.threadId, "Remember the greeting", "message_c");
    await until(() => manager.snapshot(a.threadId).state.kind === "idle");
    const latest = requests.at(-1)!;
    assert.match(
      JSON.stringify(latest.body.input),
      /Hello from the local fixture/,
    );
    const history = await readItems(client, a.threadId);
    assert.ok(history.data.length >= 4);
  },
);

test(
  "pinned runtime: a real command approval can be denied without hanging",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-approval-"));
    mkdirSync(join(home, "workspace"));
    let requestCount = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (x: any) =>
        res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
      emit({
        type: "response.created",
        response: { id: "approval_" + requestCount },
      });
      if (requestCount++ === 0)
        emit({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "shell_command",
            call_id: "approval_call",
            arguments: JSON.stringify({
              command: "printf truex-approval",
              sandbox_permissions: "require_escalated",
              justification: "Exercise the approval response path.",
            }),
          },
        });
      else
        emit({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "approval_message",
            content: [{ type: "output_text", text: "The command was denied." }],
          },
        });
      emit({
        type: "response.completed",
        response: {
          id: "approval_" + requestCount,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const client = new CodexClient(binary, home, 10000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const thread = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      cwd: join(home, "workspace"),
      approvalPolicy: "on-request",
      sandbox: "read-only",
      config: {
        "features.unified_exec": false,
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-approval-key",
        },
      },
    });
    await manager.message(thread.threadId, "Exercise an approval");
    await until(
      () => manager.snapshot(thread.threadId).pending.length > 0,
      10000,
    );
    const pending = manager.snapshot(thread.threadId).pending[0];
    assert.equal(pending.method, "item/commandExecution/requestApproval");
    manager.answer(thread.threadId, pending.requestId, { decision: "decline" });
    await until(() => manager.snapshot(thread.threadId).state.kind === "idle");
    assert.equal(
      manager.snapshot(thread.threadId).messages.at(-1)?.text,
      "The command was denied.",
    );
    assert.equal(
      manager
        .records(thread.threadId)
        .filter((r) => r.event.type === "approval.resolved").length,
      1,
    );
  },
);

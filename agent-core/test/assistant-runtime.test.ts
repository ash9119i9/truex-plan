import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test(
  "pinned runtime enables web and clarification, executes document tools and retains goal controls",
  { skip: !existsSync(binary), timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-assistant-"));
    const requests: any[] = [];
    const calls = [
      {
        name: "request_user_input",
        args: {
          questions: [
            {
              id: "format",
              header: "Format",
              question: "Which format?",
              options: [
                { label: "Word", description: "Editable document" },
                { label: "PDF", description: "Portable document" },
              ],
            },
          ],
        },
      },
      { name: "conversation_files", args: {} },
      {
        name: "create_visualization",
        args: {
          title: "Sales comparison",
          description: "An interactive comparison of sales",
          html: '<div id="sales"><button type="button">Compare sales</button></div>',
        },
      },
      {
        name: "create_document",
        args: {
          name: "Summary",
          format: "docx",
          title: "Summary",
          paragraphs: ["Confirmed by the user."],
        },
      },
    ];
    const server = createServer(async (req, res) => {
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      const call = calls[requests.length - 1];
      const item = call
        ? {
            type: "function_call",
            id: "fc_" + requests.length,
            call_id: "call_" + requests.length,
            name: call.name,
            arguments: JSON.stringify(call.args),
          }
        : {
            type: "message",
            id: "done",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Summary.docx is available in Documents.",
              },
            ],
          };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "r_" + requests.length } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: "r_" + requests.length,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = new BusinessRuntime(binary, home, 15000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-key",
        },
      },
    });
    await client.files.upload(
      threadId,
      "source.txt",
      Buffer.from("Source material").toString("base64"),
    );
    await manager.message(
      threadId,
      "Ask which format, then create a document.",
    );
    await until(
      () =>
        manager.snapshot(threadId).pending.length > 0 ||
        manager.snapshot(threadId).state.kind === "idle",
    );
    const pending = manager.snapshot(threadId).pending[0];
    assert.ok(
      pending,
      "Question must reach the UI rather than be denied in default mode",
    );
    manager.answer(threadId, pending.requestId, {
      answers: { format: { answers: ["Word"] } },
    });
    await until(() => manager.snapshot(threadId).state.kind === "idle");
    assert.equal(requests.length, 5);
    const tools = JSON.stringify(requests[0].tools);
    assert.match(tools, /request_user_input/);
    assert.match(tools, /spawn_agent/);
    assert.match(tools, /create_document/);
    assert.match(tools, /create_visualization/);
    assert.match(tools, /web_search/);
    assert.match(tools, /"external_web_access":true/);
    assert.doesNotMatch(tools, /write_project_file|exec_command|shell_command/);
    const outputs = requests
      .at(-1)
      .input.filter((item: any) => item.type === "function_call_output");
    assert.match(JSON.stringify(outputs), /Summary.docx/);
    assert.match(JSON.stringify(outputs), /source.txt/);
    assert.match(JSON.stringify(outputs), /truex-visualization:/);
    assert.equal((await client.files.list(threadId)).length, 3);
    assert.equal(manager.snapshot(threadId).pending.length, 0);
    await manager.capability(threadId, "thread/goal/set", {
      objective: "Prepare a summary",
      status: "paused",
    });
    const goal = await manager.capability(threadId, "thread/goal/get", {});
    assert.equal(goal.goal.objective, "Prepare a summary");
    assert.equal(goal.goal.status, "paused");
    await manager.capability(threadId, "thread/goal/clear", {});
    assert.equal(
      (await manager.capability(threadId, "thread/goal/get", {})).goal,
      null,
    );
    const fork = await manager.capability(threadId, "thread/fork", {});
    assert.equal((await client.files.list(fork.thread.id)).length, 3);
    assert.equal(client.visualizationToolsAvailable(fork.thread.id), true);
  },
);

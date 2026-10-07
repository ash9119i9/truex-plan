import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";
import { DisabledScriptRunner } from "../src/script-runner";
import { readItems } from "../src/history";
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
    const previews: any[] = [];
    const documentHtml =
      "<!doctype html><html><head><title>Sales</title></head><body><button>Compare sales</button></body></html>";
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
        name: "html_preview",
        args: { html: documentHtml, width: 390, appearance: "dark" },
      },
      {
        name: "html_render",
        args: {
          title: "Sales document",
          height: 420,
          html: documentHtml,
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
    const screenshot = readFileSync(
      new URL("./fixtures/visual-preview.png", import.meta.url),
    ).toString("base64");
    const client = new BusinessRuntime(
        binary,
        home,
        15000,
        new DisabledScriptRunner(),
        {
          enabled: true,
          async run(input) {
            previews.push(input);
            return {
              width: 390,
              contentHeight: 300,
              capturedHeight: 300,
              durationMs: 1,
              consoleMessages: [],
              screenshot: {
                mimeType: "image/png",
                data: screenshot,
                width: 390,
                height: 300,
              },
            };
          },
        },
      ),
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
    assert.equal(requests.length, 7);
    const tools = JSON.stringify(requests[0].tools);
    assert.match(tools, /request_user_input/);
    assert.match(tools, /spawn_agent/);
    assert.match(tools, /create_document/);
    assert.match(tools, /create_visualization/);
    assert.match(tools, /html_render/);
    assert.match(tools, /html_preview/);
    assert.equal(previews.length, 1);
    assert.equal(previews[0].scope, threadId);
    assert.ok(previews[0].signal instanceof AbortSignal);
    assert.match(previews[0].html, /Content-Security-Policy/);
    assert.ok(
      JSON.stringify(requests[4].input).includes(
        `data:image/png;base64,${screenshot}`,
      ),
      "Preview screenshot must reach the next provider call as an image",
    );
    assert.match(tools, /web_search/);
    assert.match(tools, /"external_web_access":true/);
    assert.doesNotMatch(tools, /write_project_file|exec_command|shell_command/);
    const outputs = requests
      .at(-1)
      .input.filter((item: any) => item.type === "function_call_output");
    assert.match(JSON.stringify(outputs), /Summary.docx/);
    assert.match(JSON.stringify(outputs), /source.txt/);
    assert.match(JSON.stringify(outputs), /truex-visualization:/);
    assert.equal((await client.files.list(threadId)).length, 4);
    const visuals = [...manager.snapshot(threadId).visuals!];
    assert.equal(visuals.length, 1);
    assert.equal(visuals[0].callId, "call_5");
    assert.equal(visuals[0].title, "Sales document");
    const runtimeHistory = await readItems(client, threadId);
    assert.deepEqual(
      runtimeHistory.data.map((entry: any) => entry.item.type),
      ["userMessage", "agentMessage"],
      "Canonical pinned history deliberately does not retain dynamic tool calls",
    );
    assert.doesNotMatch(
      manager.snapshot(threadId).messages.at(-1)!.text,
      /truex-visualization/,
    );
    const records = manager.records(threadId);
    const publication = records.find(
      (record) => record.event.type === "visual.published",
    );
    const final = records.find(
      (record) => record.event.type === "message.final",
    );
    assert.ok(publication && final && publication.event.seq < final.event.seq);
    assert.ok(!JSON.stringify(publication).includes("<html>"));
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
    assert.equal((await client.files.list(fork.thread.id)).length, 4);
    assert.deepEqual(manager.snapshot(fork.thread.id).visuals, visuals);
    // A separate manager with no event buffer repairs committed associations
    // without depending on a surviving marker in model prose or runtime state.
    const recoveryClient = new BusinessRuntime(binary, home, 15000);
    const restarted = new ThreadManager(recoveryClient, home);
    t.after(() => {
      restarted.close();
      recoveryClient.stop();
    });
    await restarted.recoverPublications(threadId);
    assert.deepEqual(restarted.snapshot(threadId).visuals, visuals);
    await restarted.recoverPublications(threadId);
    assert.equal(restarted.snapshot(threadId).visuals!.length, 1);
    const responses: any[] = [];
    const respond = t.mock.method(client, "respond", (_id, result) => {
      responses.push(result);
    });
    for (const thread of [threadId, "unknown-helper"])
      client.emit("serverRequest", {
        id: `stale-${thread}`,
        method: "item/tool/call",
        params: {
          threadId: thread,
          turnId: visuals[0].turnId,
          callId: "stale",
          tool: "html_render",
          arguments: { title: "Stale", html: documentHtml, height: 300 },
        },
      });
    assert.equal(responses.length, 2);
    assert.ok(responses.every((result) => result.success === false));
    assert.equal((await client.files.list(threadId)).length, 4);
    const tracked = manager.threads.get(threadId)!;
    for (const phase of ["interrupting", "draining"]) {
      tracked.state = {
        kind: phase === "interrupting" ? "interrupting" : "running",
        turnId: visuals[0].turnId,
      };
      manager.draining = phase === "draining";
      for (const tool of ["html_preview", "html_render"])
        client.emit("serverRequest", {
          id: `${phase}-${tool}`,
          method: "item/tool/call",
          params: {
            threadId,
            turnId: visuals[0].turnId,
            callId: `${phase}-${tool}`,
            tool,
            arguments:
              tool === "html_render"
                ? { title: "Late", html: documentHtml, height: 300 }
                : { html: documentHtml },
          },
        });
    }
    assert.equal(responses.length, 6);
    assert.ok(responses.every((result) => result.success === false));
    assert.equal(
      previews.length,
      1,
      "Late calls must not create new preview work after Stop",
    );
    manager.draining = false;
    // Worst publication boundary: committed source followed by unavailable
    // event spool. Admission stops, and a fresh manager repairs the attachment.
    const spool = join(home, "adapter-records", threadId);
    rmSync(spool, { recursive: true, force: true });
    writeFileSync(spool, "Fixture storage unavailable");
    client.emit("serverRequest", {
      id: "spool-failure",
      method: "item/tool/call",
      params: {
        threadId,
        turnId: visuals[0].turnId,
        callId: "spool-failure",
        tool: "html_render",
        arguments: {
          title: "Saved source, failed spool",
          html: documentHtml,
          height: 300,
        },
      },
    });
    await until(() => responses.length === 7);
    assert.equal(
      responses[6].success,
      false,
      "A failed durable publication must never return success to the model",
    );
    assert.match(
      JSON.stringify(responses[6].contentItems),
      /publication could not be recorded/,
    );
    assert.equal(manager.draining, true);
    tracked.state = { kind: "idle" };
    respond.mock.restore();
    const committedVisuals = await client.files.publications(threadId);
    assert.equal(
      committedVisuals.length,
      2,
      "The failed spool retains its committed source for recovery",
    );
    const failingClient = new BusinessRuntime(binary, home, 15000);
    const failing = new ThreadManager(failingClient, home);
    t.after(() => {
      failing.close();
      failingClient.stop();
    });
    await failing.recoverPublications(threadId);
    assert.equal(failing.draining, true);
    assert.deepEqual(failing.snapshot(threadId).visuals, committedVisuals);
    assert.equal(
      (await failingClient.files.visualization(threadId, visuals[0].id)).html,
      documentHtml,
    );
    rmSync(spool, { force: true });
    const repairedClient = new BusinessRuntime(binary, home, 15000);
    const repaired = new ThreadManager(repairedClient, home);
    t.after(() => {
      repaired.close();
      repairedClient.stop();
    });
    await repaired.recoverPublications(threadId);
    assert.equal(repaired.draining, false);
    assert.deepEqual(repaired.snapshot(threadId).visuals, committedVisuals);
    assert.equal(
      repaired
        .records(threadId)
        .filter((record) => record.event.type === "visual.published").length,
      2,
    );
    assert.equal(client.visualizationToolsAvailable(fork.thread.id), true);
  },
);

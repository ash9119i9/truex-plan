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
  "pinned runtime discloses current model/provider through the identity tool after changes and forks",
  { skip: !existsSync(binary), timeout: 45000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-model-identity-"));
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      for await (const part of req) raw += part;
      requests.push(JSON.parse(raw));
      const index = requests.length;
      const item =
        index % 2 === 1
          ? {
              type: "function_call",
              id: "fc_" + index,
              call_id: "identity_" + index,
              name: "get_model_info",
              arguments: "{}",
            }
          : {
              type: "message",
              id: "answer_" + index,
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "The model information is available.",
                },
              ],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "r_" + index } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: "r_" + index,
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
    const client = new BusinessRuntime(binary, home, 15000);
    const manager = new ThreadManager(client, home);
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
      modelProvider: "fixture_identity_private",
      publicModelProvider: "OpenAI",
      config: {
        "model_providers.fixture_identity_private": {
          name: "Private internal gateway",
          base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "fixture-private-credential",
        },
      },
    });
    const check = async (id: string, model: string) => {
      await manager.message(id, "Which model and provider are you using?");
      await until(() => manager.snapshot(id).state.kind === "idle");
      const latest = requests.at(-1);
      assert.equal(latest.model, model);
      assert.match(JSON.stringify(latest.tools), /get_model_info/);
      const outputs = latest.input.filter(
        (item: any) => item.type === "function_call_output",
      );
      const identity = outputs.at(-1);
      assert.ok(
        identity,
        "Model identity call must receive a successful output",
      );
      assert.match(JSON.stringify(identity), new RegExp(model));
      assert.match(JSON.stringify(identity), /OpenAI/);
      assert.doesNotMatch(
        JSON.stringify(identity),
        /fixture_identity_private|Private internal gateway|127\.0\.0\.1|fixture-private-credential|business-threads/,
      );
    };
    await check(threadId, "gpt-5");
    await manager.capability(threadId, "thread/settings/update", {
      model: "gpt-5.1",
    });
    await check(threadId, "gpt-5.1");
    const fork = await manager.capability(threadId, "thread/fork", {});
    await check(fork.thread.id, "gpt-5.1");
    assert.equal(requests.length, 6);
  },
);

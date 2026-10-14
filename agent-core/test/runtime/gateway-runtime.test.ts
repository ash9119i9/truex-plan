import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../../src/business-runtime";
import { ThreadManager } from "../../src/manager";
import { createGateway } from "../../../model-gateway/src/server";
import { signGatewayToken } from "../../../shared/gateway-token";
const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Runtime timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const chunk = (x: unknown) => `data: ${JSON.stringify(x)}\n\n`;

test(
  "pinned runtime through the model gateway: Chat Completions text, tool calls and follow-ups",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-gateway-"));
    const requests: { auth: string; body: any }[] = [];
    // A Chat Completions-only provider: no /responses endpoint at all.
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      if (req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      requests.push({
        auth: String(req.headers.authorization),
        body: JSON.parse(raw),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requests.length === 1) {
        res.write(
          chunk({
            choices: [
              { delta: { role: "assistant", content: "Checking files. " } },
            ],
          }),
        );
        res.write(
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_files",
                      type: "function",
                      function: { name: "conversation_files", arguments: "" },
                    },
                  ],
                },
              },
            ],
          }),
        );
        res.write(
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "{}" } }],
                },
              },
            ],
          }),
        );
        res.write(
          chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        );
      } else {
        const text =
          requests.length === 2 ? "No files yet." : "Still no files.";
        for (const piece of text.split(" "))
          res.write(chunk({ choices: [{ delta: { content: piece + " " } }] }));
        res.write(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }
      res.write(
        chunk({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
      );
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const secret = "g".repeat(32);
    const gateway = createGateway({
      secret,
      findProfile: async (id) =>
        id === "chatprofile"
          ? {
              _id: id,
              baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
              modelName: "open-model",
              wireApi: "chat",
              apiKey: "real-provider-key",
            }
          : null,
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    const client = new BusinessRuntime(binary, home, 15000),
      manager = new ThreadManager(client, home);
    t.after(async () => {
      manager.close();
      client.stop();
      for (const s of [provider, gateway]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    });
    const { threadId } = await manager.create({
      model: "open-model",
      modelProvider: "profile_chatprofile",
      config: {
        web_search: "disabled",
        "model_providers.profile_chatprofile": {
          name: "Open provider",
          base_url: `http://127.0.0.1:${(gateway.address() as any).port}/p/chatprofile/v1`,
          wire_api: "responses",
          experimental_bearer_token: signGatewayToken("chatprofile", secret),
        },
      },
    });
    await manager.message(threadId, "Which files do I have?");
    await until(
      () =>
        manager.snapshot(threadId).state.kind === "idle" &&
        requests.length >= 2,
    );
    await manager.message(threadId, "And now?");
    await until(
      () =>
        manager.snapshot(threadId).state.kind === "idle" &&
        requests.length >= 3,
    );

    assert.equal(requests.length, 3);
    for (const r of requests) assert.equal(r.auth, "Bearer real-provider-key");
    assert.equal(requests[0].body.model, "open-model");
    assert.equal(requests[0].body.messages[0].role, "system");
    const names = requests[0].body.tools.map((x: any) => x.function.name);
    assert.ok(names.includes("conversation_files"));
    assert.ok(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));
    // Codex ran the tool and sent its result back as a Chat tool message.
    const second = requests[1].body.messages;
    const call = second.find((m: any) => m.tool_calls)?.tool_calls[0];
    assert.equal(call?.id, "call_files");
    assert.equal(call?.function.name, "conversation_files");
    const result = second.find((m: any) => m.role === "tool");
    assert.equal(result?.tool_call_id, "call_files");
    // The follow-up carries the whole conversation, including the earlier answer.
    assert.match(JSON.stringify(requests[2].body.messages), /No files yet\./);
    assert.match(JSON.stringify(requests[2].body.messages), /And now\?/);
    const messages = manager.snapshot(threadId).messages;
    assert.match(JSON.stringify(messages), /Still no files\./);
    assert.equal(manager.snapshot(threadId).pending.length, 0);
  },
);

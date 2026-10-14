import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BusinessRuntime } from "../../src/runtime/business-runtime";
import { ThreadManager } from "../../src/threads/manager";
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
const send = (res: ServerResponse, event: { type: string } & object) =>
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

const SIGNATURE = "EqQBCkYIBxgCKkDsig+/round-trip==";

function messageStart(res: ServerResponse) {
  send(res, {
    type: "message_start",
    message: {
      id: "msg_" + Date.now(),
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 },
    },
  });
}

function text(res: ServerResponse, index: number, value: string) {
  send(res, {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
  for (const piece of value.split(/(?<= )/))
    send(res, {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: piece },
    });
  send(res, { type: "content_block_stop", index });
}

function finish(res: ServerResponse, stop_reason: string) {
  send(res, {
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null, stop_details: null },
    usage: { output_tokens: 4 },
  });
  send(res, { type: "message_stop" });
  res.end();
}

test(
  "pinned runtime through the model gateway: Anthropic Messages thinking, tool use and follow-ups",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-gateway-anthropic-"));
    const requests: { apiKey: string; body: any }[] = [];
    // An Anthropic-only provider: just POST /v1/messages.
    const provider = createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404).end();
        return;
      }
      requests.push({
        apiKey: String(req.headers["x-api-key"]),
        body: JSON.parse(raw),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      messageStart(res);
      if (requests.length === 1) {
        send(res, {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        });
        send(res, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "The user wants files." },
        });
        send(res, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: SIGNATURE },
        });
        send(res, { type: "content_block_stop", index: 0 });
        text(res, 1, "Checking files.");
        send(res, {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "toolu_files",
            name: "conversation_files",
            input: {},
          },
        });
        send(res, {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "{" },
        });
        send(res, {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "}" },
        });
        send(res, { type: "content_block_stop", index: 2 });
        finish(res, "tool_use");
      } else {
        text(
          res,
          0,
          requests.length === 2 ? "No files yet." : "Still no files.",
        );
        finish(res, "end_turn");
      }
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    const secret = "g".repeat(32);
    const gateway = createGateway({
      secret,
      findProfile: async (id) =>
        id === "claudeprofile"
          ? {
              _id: id,
              baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
              modelName: "claude-opus-5",
              wireApi: "anthropic",
              apiKey: "real-anthropic-key",
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
      model: "claude-opus-5",
      modelProvider: "profile_claudeprofile",
      config: {
        web_search: "disabled",
        "model_providers.profile_claudeprofile": {
          name: "Anthropic",
          base_url: `http://127.0.0.1:${(gateway.address() as any).port}/p/claudeprofile/v1`,
          wire_api: "responses",
          experimental_bearer_token: signGatewayToken("claudeprofile", secret),
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
    for (const r of requests) assert.equal(r.apiKey, "real-anthropic-key");
    const first = requests[0].body;
    assert.equal(first.model, "claude-opus-5");
    // One text block with a cache breakpoint, so tools + system are cached.
    assert.equal(first.system.length, 1);
    assert.equal(first.system[0].type, "text");
    assert.ok(first.system[0].text.length > 0);
    assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" });
    assert.equal(first.messages[0].role, "user");
    const names = first.tools.map((x: any) => x.name);
    assert.ok(names.includes("conversation_files"));
    assert.ok(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));

    // Turn 2: the assistant turn replays the signed thinking block first,
    // then the tool_use; one user message answers it with the tool_result.
    const second: any[] = requests[1].body.messages;
    const at = second.findIndex(
      (m) =>
        m.role === "assistant" &&
        m.content.some((b: any) => b.type === "tool_use"),
    );
    assert.ok(at > 0, "assistant tool_use turn is present");
    const assistant = second[at].content;
    assert.deepEqual(assistant[0], {
      type: "thinking",
      thinking: "The user wants files.",
      signature: SIGNATURE,
    });
    const toolUse = assistant.find((b: any) => b.type === "tool_use");
    assert.equal(toolUse.id, "toolu_files");
    assert.equal(toolUse.name, "conversation_files");
    assert.ok(
      assistant.indexOf(toolUse) > 0,
      "tool_use comes after the thinking block",
    );
    const answer = second[at + 1];
    assert.equal(answer.role, "user");
    const results = answer.content.filter((b: any) => b.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_use_id, "toolu_files");
    assert.equal(answer.content[0].type, "tool_result");
    for (let i = 1; i < second.length; i++)
      assert.notEqual(second[i].role, second[i - 1].role, "roles alternate");

    // Turn 3 carries the whole conversation.
    const third = JSON.stringify(requests[2].body.messages);
    assert.match(third, /No files yet\./);
    assert.match(third, /And now\?/);
    assert.match(third, /toolu_files/);
    assert.ok(third.includes(SIGNATURE));
    const messages = manager.snapshot(threadId).messages;
    assert.match(JSON.stringify(messages), /Still no files\./);
    assert.equal(manager.snapshot(threadId).pending.length, 0);
  },
);

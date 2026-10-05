import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { BusinessRuntime } from "../src/business-runtime";
import { ThreadManager } from "../src/manager";

const binary = resolve("../vendor/codex/codex-rs/target/debug/codex");

function deadline<T>(promise: Promise<T>, label: string) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The native runtime still receives its abort event. Only the manager's
// helper completion notification is lost, exercising metadata reconciliation.
class MissingHelperCompletionRuntime extends BusinessRuntime {
  lostHelpers: string[] = [];
  override emit(event: string | symbol, ...args: any[]): boolean {
    const message = args[0];
    if (
      event === "notification" &&
      message?.method === "turn/completed" &&
      this.helpers.has(message.params?.threadId)
    ) {
      this.lostHelpers.push(message.params.threadId);
      return true;
    }
    return super.emit(event, ...args);
  }
}

test(
  "pinned runtime: helper Stop recovers a missing completion while the root and its goal keep running",
  { skip: !existsSync(binary), timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "truex-helper-stop-runtime-"));
    let requests = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const id = ++requests;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (event: any) =>
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({ type: "response.created", response: { id: `response_${id}` } });
      if (id === 1) {
        // This is an actual native helper tool call, not a synthetic host
        // registration. Root and helper then receive independent open streams.
        emit({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "spawn_helper_fixture",
            namespace: "multi_agent_v1",
            name: "spawn_agent",
            arguments: JSON.stringify({ message: "Inspect the report" }),
          },
        });
        emit({
          type: "response.completed",
          response: {
            id: `response_${id}`,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
        return;
      }
      emit({
        type: "response.output_item.added",
        item: {
          type: "message",
          role: "assistant",
          id: `message_${id}`,
          content: [],
        },
      });
      emit({
        type: "response.output_text.delta",
        delta: "Still investigating.",
      });
      // Deliberately keep both root and helper model responses open.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new MissingHelperCompletionRuntime(binary, home, 15000);
    const manager = new ThreadManager(client, home);
    let started = false;
    t.after(async () => {
      manager.close();
      try {
        if (started) {
          const exited = new Promise<void>((resolve) =>
            client.once("exit", resolve),
          );
          client.stop();
          await deadline(exited, "The spawned native runtime did not exit");
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(home, { recursive: true, force: true });
      }
    });
    await client.start();
    started = true;
    const { threadId } = await manager.create({
      model: "gpt-5",
      modelProvider: "fixture",
      config: {
        "model_providers.fixture": {
          name: "fixture",
          base_url: `http://127.0.0.1:${address.port}/v1`,
          wire_api: "responses",
          experimental_bearer_token: "local-helper-fixture",
        },
        model_reasoning_effort: "low",
      },
    });
    const seen = new Set<string>();
    let streamed!: () => void;
    const streams = new Promise<void>((resolve) => {
      streamed = resolve;
    });
    const onNotification = (message: any) => {
      if (message.method !== "item/agentMessage/delta") return;
      seen.add(message.params.threadId);
      if (seen.has(threadId) && [...seen].some((id) => id !== threadId))
        streamed();
    };
    client.on("notification", onNotification);
    try {
      await manager.capability(threadId, "thread/goal/set", {
        objective: "Inspect this business report with a helper",
        status: "active",
      });
      await deadline(streams, "The root and native helper did not both stream");
    } finally {
      client.off("notification", onNotification);
    }
    const helper = manager
      .agents(threadId)
      .find((agent) => agent.status === "running");
    assert.ok(helper, "The native spawn must register a running helper");
    const before = requests;
    await manager.interruptAgent(threadId, helper.threadId);
    assert.ok(
      client.lostHelpers.includes(helper.threadId),
      "The helper completion must actually be lost",
    );
    assert.ok(
      ["idle", "notLoaded"].includes(
        (await client.request("thread/read", { threadId: helper.threadId }))
          .thread.status.type,
      ),
    );
    assert.equal(manager.snapshot(threadId).state.kind, "running");
    assert.equal(manager.snapshot(threadId).goal?.status, "active");
    assert.equal(
      (await client.request("thread/read", { threadId, includeTurns: false }))
        .thread.status.type,
      "active",
    );
    assert.equal(
      requests,
      before,
      "Stopping a helper must not replay model work",
    );
    assert.equal(
      manager.agent(threadId, helper.threadId).agent.status,
      "interrupted",
    );
    await manager.interrupt(threadId);
  },
);

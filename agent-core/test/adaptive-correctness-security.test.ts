import test from "node:test";
import assert from "node:assert/strict";
import { AdaptiveModelBoundaryV2 } from "../src/adaptive-model-boundary-v2";
import { AdaptiveSessionV2 } from "../src/adaptive-session-v2";
import { McpTransportV2 } from "../src/mcp-transport-v2";

const scope = { tenantId: "tenant-a", userId: "user-a" };

test("native authorization uses each namespace's binding identity when names collide", async () => {
  const checked: string[] = [];
  const boundary = new AdaptiveModelBoundaryV2({
    ...scope,
    authorizeNative: (tool) => {
      checked.push(tool.id);
      return tool.id === JSON.stringify(["native", "permitted", "read_file"]);
    },
  });
  const body = {
    tools: ["restricted", "permitted"].map((name) => ({
      type: "namespace",
      name,
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: {} },
        },
      ],
    })),
  };
  const filtered = await boundary.filter(
    body,
    { mode: "direct_tools", query: "Read the workspace file", selected: [] },
    new Map(),
  );
  assert.deepEqual(checked, [
    JSON.stringify(["native", "restricted", "read_file"]),
    JSON.stringify(["native", "permitted", "read_file"]),
  ]);
  assert.deepEqual([...filtered.allowedNames], ["permitted::read_file"]);
  assert.deepEqual(
    filtered.body.tools.map((tool: any) => tool.name),
    ["permitted"],
  );
  const deniedAction = new Response(
    JSON.stringify({
      output: [
        { type: "function_call", namespace: "restricted", name: "read_file" },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    boundary.guard(deniedAction, filtered.allowedNames).text(),
    /outside/,
  );
});

test("routing and exposure observers cannot interrupt the authorized session lifecycle", async (t) => {
  const observed: string[] = [];
  const session = new AdaptiveSessionV2(
    {},
    {
      scope,
      authorize: () => true,
      onEvent: (event) => {
        observed.push(event.type);
        if (
          event.type === "platform_routing" ||
          event.type === "model_exposure"
        )
          throw new Error("Fixture observer failure");
      },
    },
  );
  t.after(() => session.close());
  await session.start();
  const plan = await session.beforeTurn("What is the capital of India?");
  assert.equal(plan.mode, "no_tools");
  const filtered = await session.filterModelRequest({
    tools: [
      {
        type: "function",
        name: "update_plan",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  assert.deepEqual([...filtered.allowedNames], ["update_plan"]);
  assert.ok(observed.includes("platform_routing"));
  assert.ok(observed.includes("model_exposure"));
  session.finishTurn();
  await assert.rejects(
    session.filterModelRequest({ tools: [] }),
    /Route a user turn/,
  );
});

test("a matched SSE action response is returned even when stream cancellation stalls", async () => {
  const stopped = new AbortController();
  let releaseCancellation!: () => void;
  let actions = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    if (rpc.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (rpc.method === "tools/call") {
      actions++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "Verified read result" }] } })}\n\n`,
            ),
          );
        },
        cancel() {
          return new Promise<void>((resolve) => {
            releaseCancellation = resolve;
          });
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const result =
      rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26" }
        : { tools: [] };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const transport = new McpTransportV2(
    { url: "https://fixture.invalid/mcp", tool_timeout_sec: 0.015 },
    stopped.signal,
    fetcher,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = transport.call("read_data", {}).then(
      (value) => ({ status: "completed", value }),
      (error) => ({ status: "failed", value: error }),
    );
    const outcome = await Promise.race([
      work,
      new Promise<{ status: string; value?: any }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "hung" }), 100);
      }),
    ]);
    assert.equal(
      outcome.status,
      "completed",
      "Matched response must not wait indefinitely on reader.cancel or lose the completed action result",
    );
    assert.equal(outcome.value.content[0].text, "Verified read result");
    assert.equal(actions, 1);
  } finally {
    if (timer) clearTimeout(timer);
    releaseCancellation?.();
    stopped.abort();
  }
});

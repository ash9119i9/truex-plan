import { test } from "node:test";
import assert from "node:assert/strict";
import { toChatRequest, streamChat } from "../src/adapters/chat";
import { ResponsesStream } from "../src/responses";
import { ToolNames } from "../src/tool-names";

test("toChatRequest: instructions, developer text, tools and tool history", () => {
  const { body, tools } = toChatRequest(
    {
      model: "ignored",
      instructions: "Base instructions",
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "request_user_input",
          parameters: { type: "object" },
        },
        {
          type: "namespace",
          name: "mcp__qlik__",
          tools: [{ type: "function", name: "list_apps", description: "Apps" }],
        },
        { type: "web_search", external_web_access: true },
        { type: "custom", name: "apply_patch" },
      ],
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Dev" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
        { type: "reasoning", summary: [], encrypted_content: "x" },
        {
          type: "function_call",
          call_id: "c1",
          name: "list_apps",
          namespace: "mcp__qlik__",
          arguments: '{"q":1}',
        },
        {
          type: "function_call",
          call_id: "c2",
          name: "request_user_input",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "c1", output: "apps" },
        {
          type: "function_call_output",
          call_id: "c2",
          output: [
            { type: "input_text", text: "answer" },
            { type: "input_image", image_url: "data:" },
          ],
        },
        { type: "function_call_output", call_id: "orphan", output: "dropped" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done" }],
        },
      ],
    },
    "provider-model",
  );
  assert.equal(body.model, "provider-model");
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(
    body.tools.map((t: any) => t.function.name),
    ["request_user_input", "mcp__qlik__list_apps"],
  );
  assert.deepEqual(tools.fromProvider("mcp__qlik__list_apps"), {
    name: "list_apps",
    namespace: "mcp__qlik__",
  });
  assert.deepEqual(body.messages, [
    { role: "system", content: "Base instructions\n\nDev" },
    { role: "user", content: "Hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "mcp__qlik__list_apps", arguments: '{"q":1}' },
        },
        {
          id: "c2",
          type: "function",
          function: { name: "request_user_input", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "apps" },
    {
      role: "tool",
      tool_call_id: "c2",
      content: "answer\n[Image not sent: unsupported or invalid inline image.]",
    },
    { role: "assistant", content: "Done" },
  ]);
});

test("toChatRequest: interrupted calls get a placeholder result", () => {
  const { body } = toChatRequest(
    {
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Stop" }],
        },
      ],
    },
    "m",
  );
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "c1");
  assert.equal(body.messages[2].content, "Stop");
});

test("ToolNames: long or invalid names are shortened and restored", () => {
  const names = new ToolNames();
  const long = { name: "x".repeat(80), namespace: "mcp__server__" };
  const flat = names.toProvider(long);
  assert.ok(flat.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(flat));
  assert.deepEqual(names.fromProvider(flat), long);
  const dotted = names.toProvider({ name: "a.b" });
  assert.match(dotted, /^[a-zA-Z0-9_-]+$/);
  assert.deepEqual(names.fromProvider(dotted), { name: "a.b" });
  assert.notEqual(names.toProvider({ name: "a_b" }), dotted);
});

function sse(lines: unknown[]) {
  const text = lines
    .map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`)
    .join("");
  return new Response(text, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

class Capture {
  status = 0;
  chunks: string[] = [];
  ended = false;
  headersSent = false;
  writeHead(status: number) {
    this.status = status;
    this.headersSent = true;
    return this;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string) {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
  }
  events() {
    return this.chunks
      .join("")
      .split("\n\n")
      .filter(Boolean)
      .map((block) =>
        JSON.parse(
          block
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6),
        ),
      );
  }
}

test("streamChat: text deltas and indexed tool call deltas become Responses events", async () => {
  const names = new ToolNames();
  names.toProvider({ name: "list_apps", namespace: "mcp__qlik__" });
  const res = new Capture();
  await streamChat(
    sse([
      { choices: [{ delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  function: { name: "mcp__qlik__list_apps", arguments: '{"q"' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      "[DONE]",
    ]),
    new ResponsesStream(res as any),
    names,
  );
  const events = res.events();
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ],
  );
  assert.deepEqual(events[4].item.content, [
    { type: "output_text", text: "Hello" },
  ]);
  assert.deepEqual(
    { ...events[6].item, id: undefined },
    {
      type: "function_call",
      id: undefined,
      call_id: "call_a",
      name: "list_apps",
      namespace: "mcp__qlik__",
      arguments: '{"q":1}',
    },
  );
  assert.deepEqual(events[7].response.usage, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  });
  assert.equal(res.ended, true);
});

test("streamChat: a stream cut before finish_reason fails instead of completing", async () => {
  const res = new Capture();
  await streamChat(
    sse([{ choices: [{ delta: { content: "partial" } }] }]),
    new ResponsesStream(res as any),
    new ToolNames(),
  );
  const last = res.events().at(-1);
  assert.equal(last.type, "response.failed");
  assert.equal(last.response.error.code, "server_error");
});

test("streamChat: in-stream context errors map to context_length_exceeded", async () => {
  const res = new Capture();
  await streamChat(
    sse([
      {
        error: {
          message: "This model's maximum context length is 8192 tokens",
        },
      },
    ]),
    new ResponsesStream(res as any),
    new ToolNames(),
  );
  assert.equal(
    res.events().at(-1).response.error.code,
    "context_length_exceeded",
  );
});

test("streamChat: a bare newline before a tool call does not become a message", async () => {
  const names = new ToolNames();
  const res = new Capture();
  await streamChat(
    sse([
      { choices: [{ delta: { content: "\n" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: { name: "f", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ]),
    new ResponsesStream(res as any),
    names,
  );
  const types = res.events().map((e) => e.item?.type ?? e.type);
  assert.deepEqual(types, [
    "response.created",
    "function_call",
    "function_call",
    "response.completed",
  ]);
});

test("streamChat: leading whitespace is kept once real text follows", async () => {
  const res = new Capture();
  await streamChat(
    sse([
      { choices: [{ delta: { content: "\n" } }] },
      { choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] },
      "[DONE]",
    ]),
    new ResponsesStream(res as any),
    new ToolNames(),
  );
  const done = res.events().find((e) => e.type === "response.output_item.done");
  assert.deepEqual(done.item.content, [{ type: "output_text", text: "\nHi" }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentMessageText } from "../src/agent-message";
import { toChatRequest } from "../src/adapters/chat";
import { toAnthropicRequest } from "../src/adapters/anthropic";
import { toGeminiRequest } from "../src/adapters/gemini";

// Shapes as Codex multi-agent V2 sends them on the pin: the task a lead gives
// a helper (plain text inside `encrypted_content`) and the helper's answer.
const task = {
  type: "agent_message",
  author: "/root",
  recipient: "/root/deals",
  content: [
    {
      type: "input_text",
      text: "Message Type: NEW_TASK\nTask name: /root/deals\nSender: /root\nPayload:\n",
    },
    { type: "encrypted_content", encrypted_content: "List the three deals." },
  ],
};
const answer = {
  type: "agent_message",
  author: "/root/deals",
  recipient: "/root",
  content: [
    {
      type: "input_text",
      text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/deals\nPayload:\nAcme, Globex.",
    },
  ],
};
const developer = {
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text: "Helper rules" }],
};

test("agentMessageText joins text and the task payload", () => {
  assert.equal(
    agentMessageText(task),
    "Message Type: NEW_TASK\nTask name: /root/deals\nSender: /root\nPayload:\nList the three deals.",
  );
  assert.equal(agentMessageText(answer).endsWith("Acme, Globex."), true);
});

test("agentMessageText ignores malformed items", () => {
  assert.equal(agentMessageText(null), "");
  assert.equal(agentMessageText({ type: "agent_message" }), "");
  assert.equal(agentMessageText({ content: "not an array" }), "");
  assert.equal(
    agentMessageText({
      content: [
        { type: "input_text", text: 7 },
        { type: "encrypted_content", encrypted_content: null },
        { type: "unknown", text: "x" },
        { type: "input_text", text: "  " },
      ],
    }),
    "",
  );
});

test("chat: an agent message is user text, never assistant or system", () => {
  const { body } = toChatRequest(
    { input: [developer, task, { ...task, content: [] }] },
    "m",
  );
  assert.deepEqual(body.messages, [
    { role: "system", content: "Helper rules" },
    { role: "user", content: agentMessageText(task) },
  ]);
});

test("chat: a helper answer after a tool call keeps the call paired", () => {
  const { body } = toChatRequest(
    {
      input: [
        developer,
        { type: "message", role: "user", content: "find deals" },
        {
          type: "function_call",
          call_id: "c1",
          name: "wait_agent",
          namespace: "collaboration",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: "Wait completed.",
        },
        answer,
      ],
    },
    "m",
  );
  const roles = body.messages.map((m: any) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user"]);
  assert.equal(body.messages.at(-1).content, agentMessageText(answer));
});

test("anthropic: an agent message is a user text block", () => {
  const { params } = toAnthropicRequest(
    { input: [developer, task] },
    { modelName: "m", maxOutputTokens: 100 },
  );
  // The system prompt goes out as cache-tagged blocks.
  assert.deepEqual(
    (params.system as Array<{ text: string }>).map((b) => b.text),
    ["Helper rules"],
  );
  assert.deepEqual(params.messages, [
    { role: "user", content: [{ type: "text", text: agentMessageText(task) }] },
  ]);
});

test("anthropic: a helper answer follows the tool result in the user turn", () => {
  const { params } = toAnthropicRequest(
    {
      input: [
        { type: "message", role: "user", content: "find deals" },
        {
          type: "function_call",
          call_id: "c1",
          name: "wait_agent",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: "Wait completed.",
        },
        answer,
      ],
    },
    { modelName: "m", maxOutputTokens: 100 },
  );
  const last = params.messages.at(-1)!;
  assert.equal(last.role, "user");
  const blocks = last.content as Array<{ type: string; text?: string }>;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["tool_result", "text"],
  );
  assert.equal(blocks[1].text, agentMessageText(answer));
});

test("gemini: an agent message is a user part, after any pending results", () => {
  const { body } = toGeminiRequest(
    {
      input: [
        { type: "message", role: "user", content: "find deals" },
        {
          type: "function_call",
          call_id: "c1",
          name: "wait_agent",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: "Wait completed.",
        },
        answer,
      ],
    },
    { modelName: "gemini-2.5-flash" },
  );
  const last = body.contents.at(-1);
  assert.equal(last.role, "user");
  assert.ok(
    last.parts.some((p: any) => p.text === agentMessageText(answer)),
    "the helper answer reaches Gemini",
  );
  assert.ok(
    last.parts.some((p: any) => p.functionResponse),
    "the wait result is still sent",
  );
});

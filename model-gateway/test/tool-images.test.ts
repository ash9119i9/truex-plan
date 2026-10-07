import { test } from "node:test";
import assert from "node:assert/strict";
import { toChatRequest } from "../src/adapters/chat";
import { toGeminiRequest } from "../src/adapters/gemini";
const image = "data:image/png;base64,AAAA";
const calls = [
  {
    type: "function_call",
    call_id: "preview",
    name: "html_preview",
    arguments: "{}",
  },
  { type: "function_call", call_id: "other", name: "f", arguments: "{}" },
];
const output = {
  type: "function_call_output",
  call_id: "preview",
  output: [
    { type: "input_text", text: "height:300" },
    { type: "input_image", image_url: image },
  ],
};
test("Chat preview image follows all paired tool outputs in a user image message", () => {
  const { body } = toChatRequest(
    {
      input: [
        ...calls,
        output,
        { type: "function_call_output", call_id: "other", output: "done" },
      ],
    },
    "m",
  );
  assert.deepEqual(
    body.messages.map((m: any) => m.role),
    ["assistant", "tool", "tool", "user"],
  );
  assert.equal(
    body.messages[3].content[0].text,
    "Images from tool call preview:",
  );
  assert.equal(body.messages[3].content[1].image_url.url, image);
  assert.equal(
    body.messages[1].content,
    "height:300\n[Image supplied after this turn's tool results.]",
  );
});
test("Chat interrupted sibling gets placeholder before image; orphan image is dropped", () => {
  const { body } = toChatRequest(
    { input: [...calls, output, { ...output, call_id: "orphan" }] },
    "m",
  );
  assert.equal(body.messages[2].tool_call_id, "other");
  assert.equal(
    body.messages[3].content.filter((p: any) => p.type === "image_url").length,
    1,
  );
});
test("Gemini images use inlineData beside all functionResponses with call labels", () => {
  const { body } = toGeminiRequest(
    {
      input: [
        ...calls,
        output,
        { type: "function_call_output", call_id: "other", output: "done" },
        { ...output, call_id: "orphan" },
      ],
    },
    { modelName: "gemini-3-pro" },
  );
  const parts = body.contents[1].parts;
  assert.equal(parts[0].functionResponse.name, "html_preview");
  assert.equal(parts[1].functionResponse.name, "f");
  assert.equal(parts[2].text, "Images from tool call preview:");
  assert.deepEqual(parts[3], {
    inlineData: { mimeType: "image/png", data: "AAAA" },
  });
  assert.equal(parts.length, 4);
});

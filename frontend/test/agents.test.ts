import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentBody, handleTaken, modelShort } from "../lib/agents.ts";
import { agentHandle, type AgentSummary } from "../../shared/contracts.ts";

test("modelShort drops the Claude prefix and lowercases", () => {
  assert.equal(modelShort("Claude Opus 5.5"), "opus 5.5");
  assert.equal(modelShort("claude sonnet 5.5"), "sonnet 5.5");
  assert.equal(modelShort("gpt-5"), "gpt-5");
  assert.equal(modelShort("GPT-5 Mini"), "gpt-5 mini");
  assert.equal(modelShort("Claudette"), "claudette");
  assert.equal(modelShort(""), "");
});

test("createAgentBody trims text and sends only the contract keys", () => {
  const body = createAgentBody({
    name: "  Research Scout ",
    description: " Finds sources ",
    systemPrompt: "\n Cite everything \n",
    look: 4,
    tint: "mint",
    modelProfileId: "m1",
    // Extra fields from a wider form object must not leak into the request.
    ...({ handle: "researchscout", model: "opus" } as object),
  } as Parameters<typeof createAgentBody>[0]);
  assert.deepEqual(body, {
    name: "Research Scout",
    description: "Finds sources",
    systemPrompt: "Cite everything",
    look: 4,
    tint: "mint",
    modelProfileId: "m1",
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "description",
    "look",
    "modelProfileId",
    "name",
    "systemPrompt",
    "tint",
  ]);
});

test("createAgentBody keeps an empty purpose empty", () => {
  const body = createAgentBody({
    name: "Scout",
    description: "   ",
    systemPrompt: "",
    look: 2,
    tint: "ice",
    modelProfileId: "m1",
  });
  assert.equal(body.description, "");
});

const agent = (id: string, handle?: string): AgentSummary => ({
  id,
  name: id,
  description: "",
  provider: "anthropic",
  model: "opus",
  sandbox: "workspace-write",
  handle,
  look: 2,
  tint: "ice",
  builtin: false,
} as AgentSummary);

test("handleTaken matches existing handles only", () => {
  const agents = [agent("a1", "researchscout"), agent("a2")];
  assert.equal(handleTaken("researchscout", agents), true);
  assert.equal(handleTaken("writer", agents), false);
  assert.equal(handleTaken("", agents), false);
  assert.equal(handleTaken("researchscout", []), false);
});

test("handles follow the shared agentHandle rule", () => {
  assert.equal(agentHandle("Research Scout"), "researchscout");
  assert.equal(agentHandle("🙂"), "");
  assert.equal(handleTaken(agentHandle("🙂"), [agent("a1", "")]), false);
});

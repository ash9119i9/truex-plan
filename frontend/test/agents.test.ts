import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentBody,
  defaultChatAgentId,
  handleTaken,
  initialChatAgentId,
  modelShort,
} from "../lib/agents.ts";
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

const agent = (id: string, handle?: string): AgentSummary =>
  ({
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
  }) as AgentSummary;

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

test("new chats use the explicit default, never the first specialist or builtin", () => {
  const specialist = { ...agent("specialist"), builtin: true };
  const general = { ...agent("general"), isDefault: true };
  const list = [specialist, general];
  assert.equal(defaultChatAgentId(list), "general");
  assert.equal(initialChatAgentId(list, "", false), "general");
  assert.equal(defaultChatAgentId([specialist]), "");
  assert.equal(defaultChatAgentId([]), "");
});

test("agent loading preserves restored sessions and explicit specialist choices", () => {
  const list = [{ ...agent("general"), isDefault: true }, agent("specialist")];
  assert.equal(initialChatAgentId(list, "specialist", false), "specialist");
  assert.equal(initialChatAgentId(list, "saved-agent", true), "saved-agent");
  assert.equal(initialChatAgentId(list, "", true), "");
});

test("editing loads private user configuration and sends only editable fields plus its version", async (t) => {
  const { fetchAgentConfiguration, updateAgent } =
    await import("../lib/agents.ts");
  const calls: { url: string; options?: RequestInit }[] = [];
  const config = {
    ...agent("id/with space", "scout"),
    systemPrompt: "Saved instructions",
    modelProfileId: "chosen-model",
    version: 3,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(config), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  assert.deepEqual(await fetchAgentConfiguration(config.id), config);
  assert.ok(calls[0].url.endsWith("/api/agents/id%2Fwith%20space"));
  assert.equal(calls[0].options?.method, "GET");
  await updateAgent(
    config.id,
    {
      name: " Renamed ",
      description: " Purpose ",
      systemPrompt: " Instructions ",
      look: 3,
      tint: "ice",
      modelProfileId: "chosen-model",
      ...({ builtin: true, handle: "changed" } as object),
    },
    config.version,
  );
  assert.equal(calls[1].options?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].options?.body)), {
    name: "Renamed",
    description: "Purpose",
    systemPrompt: "Instructions",
    look: 3,
    tint: "ice",
    modelProfileId: "chosen-model",
    version: 3,
  });
});

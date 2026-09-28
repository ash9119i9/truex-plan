import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatInput, suggestCommands } from "../lib/slash-commands.ts";

test("questions containing slashes and paths remain messages", () => {
  for (const text of [
    "How do /goal and /fork work?",
    "/api/orders returns 404",
    "/unknown question",
    "What is 3/4?",
    "Explain:\n/goal finish work",
  ]) {
    assert.deepEqual(parseChatInput(text), { kind: "message", text });
  }
  assert.deepEqual(parseChatInput("//goal explain this command"), {
    kind: "message",
    text: "/goal explain this command",
  });
});

test("picker only captures command names, never goal text or multiline editing", () => {
  assert.equal(suggestCommands("/").length, 11);
  assert.deepEqual(
    suggestCommands("/GO").map((c) => c.name),
    ["/goal"],
  );
  for (const text of [
    "/goal ",
    "/goal write\na report",
    "/goal\n",
    "Question /goal",
    "/api/orders",
    "//goal",
  ]) {
    assert.deepEqual(suggestCommands(text), []);
  }
});

test("goal commands preserve the objective's formatting and distinguish read and clear", () => {
  assert.deepEqual(
    parseChatInput("/GOAL  Write a report\n  with two sections"),
    {
      kind: "command",
      method: "thread/goal/set",
      params: { objective: "Write a report\n  with two sections" },
      success: "Goal updated.",
    },
  );
  for (const value of ["/goal", "/goal ", "/goal show"]) {
    const result = parseChatInput(value);
    assert.equal(result.kind, "command");
    if (result.kind === "command")
      assert.equal(result.method, "thread/goal/get");
  }
  const clear = parseChatInput("/goal CLEAR");
  assert.equal(clear.kind, "command");
  if (clear.kind === "command") assert.equal(clear.method, "thread/goal/clear");
});

test("invalid arguments cannot silently execute conversation actions", () => {
  for (const text of [
    "/archive this question",
    "/fork something",
    "/compact\nwhy?",
    "/help more",
    "/model",
    "/model model and question",
    "/effort",
    "/effort invalid",
  ]) {
    assert.equal(parseChatInput(text).kind, "invalid", text);
  }
});

test("valid actions map to the existing capability APIs", () => {
  const mappings = {
    "/fork": "thread/fork",
    "/compact": "thread/compact/start",
    "/archive": "thread/archive",
    "/unarchive": "thread/unarchive",
  };
  for (const [text, method] of Object.entries(mappings)) {
    const result = parseChatInput(text);
    assert.equal(result.kind, "command");
    if (result.kind === "command") {
      assert.equal(result.method, method);
      assert.deepEqual(result.params, {});
    }
  }
  assert.deepEqual(parseChatInput("/MODEL provider/model"), {
    kind: "command",
    method: "thread/settings/update",
    params: { model: "provider/model" },
    success: "Model changed to provider/model.",
  });
  assert.deepEqual(parseChatInput("/effort HIGH"), {
    kind: "command",
    method: "thread/settings/update",
    params: { effort: "high" },
    success: "Reasoning effort changed to high.",
  });
  assert.deepEqual(parseChatInput("/help"), { kind: "help" });
});

test("panel commands open workspace panels and take no arguments", () => {
  assert.deepEqual(parseChatInput("/mcp"), { kind: "panel", panel: "mcp" });
  assert.deepEqual(parseChatInput("/TOOLS"), { kind: "panel", panel: "tools" });
  assert.equal(parseChatInput("/mcp github").kind, "invalid");
  assert.deepEqual(parseChatInput("/agents"), {
    kind: "panel",
    panel: "agents",
  });
  assert.deepEqual(parseChatInput("/AGENTS"), {
    kind: "panel",
    panel: "agents",
  });
  assert.equal(parseChatInput("/agents stop").kind, "invalid");
  assert.deepEqual(
    suggestCommands("/a").map((c) => c.name),
    ["/archive", "/agents"],
  );
  assert.deepEqual(
    suggestCommands("/m").map((c) => c.name),
    ["/model", "/mcp"],
  );
});

test("goal subcommands pause, resume and budget without becoming objectives", () => {
  assert.deepEqual(parseChatInput("/goal pause"), {
    kind: "command",
    method: "thread/goal/set",
    params: { status: "paused" },
    success: "Goal paused.",
  });
  const resume = parseChatInput("/goal RESUME");
  assert.equal(resume.kind === "command" && resume.params.status, "active");
  for (const [text, tokens] of [
    ["/goal budget 50000", 50000],
    ["/goal budget 50k", 50000],
    ["/goal budget 1,500", 1500],
  ] as const) {
    const result = parseChatInput(text);
    assert.equal(result.kind, "command", text);
    if (result.kind === "command")
      assert.deepEqual(result.params, { tokenBudget: tokens });
  }
  for (const text of ["/goal budget", "/goal budget 0", "/goal budget lots"])
    assert.equal(parseChatInput(text).kind, "invalid", text);
  const objective = parseChatInput("/goal pause the rollout and report");
  assert.equal(
    objective.kind === "command" && objective.params.objective,
    "pause the rollout and report",
  );
});

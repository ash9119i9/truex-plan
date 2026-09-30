import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_KINDS, TILTS, boardMeta, filterAgents, inkOn, pad2, showNewCard } from "../lib/agent-board.ts";
import { TINTS } from "../lib/agent-look.ts";

const agent = (id: string, name: string, description: string, builtin: boolean, handle?: string) =>
  ({ id, name, description, builtin, handle });
const AGENTS = [
  agent("qlik", "Qlik Analyst", "Dashboards, metrics, BI queries", true, "qlik"),
  agent("research", "Researcher", "Web research with citations", true),
  agent("agent-1", "Designer", "UI reviews, specs, copy tweaks", false, "designer"),
  agent("agent-2", "Support", "Triage inbox, draft replies", false, "helpdesk"),
];
const ids = (list: { id: string }[]) => list.map((a) => a.id);

test("TILTS and BOARD_KINDS match the spec", () => {
  assert.deepEqual(TILTS, [-4, 3, -2.5, 4.5, -3.5, 2, -1.5, 3.5]);
  assert.deepEqual(BOARD_KINDS, [["all", "All"], ["yours", "Yours"], ["builtin", "Built-in"]]);
});

test("inkOn picks white only on the ice frame", () => {
  const byId = Object.fromEntries(TINTS.map((t) => [t.id, inkOn(t.dot)]));
  assert.deepEqual(byId, { ice: "#FFFFFF", mint: "#1F2A30", butter: "#1F2A30", peach: "#1F2A30", lilac: "#1F2A30" });
  assert.equal(inkOn("#3691CD"), "#FFFFFF");
  assert.equal(inkOn("#000000"), "#FFFFFF");
  assert.equal(inkOn("#FFFFFF"), "#1F2A30");
});

test("pad2 pads to two digits", () => {
  assert.equal(pad2(0), "00");
  assert.equal(pad2(4), "04");
  assert.equal(pad2(12), "12");
  assert.equal(pad2(123), "123");
});

test("filterAgents by kind", () => {
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "")), ["qlik", "research", "agent-1", "agent-2"]);
  assert.deepEqual(ids(filterAgents(AGENTS, "builtin", "")), ["qlik", "research"]);
  assert.deepEqual(ids(filterAgents(AGENTS, "yours", "")), ["agent-1", "agent-2"]);
});

test("filterAgents matches name, handle, id fallback and description", () => {
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "analyst")), ["qlik"]);
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "helpdesk")), ["agent-2"]);
  // No handle: the id stands in.
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "research")), ["research"]);
  // A handle replaces the id in the haystack.
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "agent-1")), []);
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "citations")), ["research"]);
});

test("filterAgents trims, ignores case and combines with kind", () => {
  assert.deepEqual(ids(filterAgents(AGENTS, "all", "  DESIGNER  ")), ["agent-1"]);
  assert.equal(filterAgents(AGENTS, "all", "   ").length, 4);
  assert.deepEqual(ids(filterAgents(AGENTS, "builtin", "designer")), []);
  assert.deepEqual(ids(filterAgents(AGENTS, "yours", "re")), ["agent-1", "agent-2"]);
  assert.deepEqual(filterAgents(AGENTS, "all", "zzz"), []);
});

test("showNewCard hides on Built-in or an active search", () => {
  assert.equal(showNewCard("all", ""), true);
  assert.equal(showNewCard("yours", "  "), true);
  assert.equal(showNewCard("builtin", ""), false);
  assert.equal(showNewCard("all", "qlik"), false);
  assert.equal(showNewCard("yours", " x "), false);
});

test("boardMeta shortens the model and lowercases reasoning", () => {
  assert.equal(boardMeta("Claude Opus 5.5", "High"), "opus 5.5 · high");
  assert.equal(boardMeta("claude sonnet 5.5", "Medium"), "sonnet 5.5 · medium");
  assert.equal(boardMeta("gpt-5"), "gpt-5 · default");
  assert.equal(boardMeta("Claude Haiku 4.5", "Low"), "haiku 4.5 · low");
});

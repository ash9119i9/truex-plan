import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { Hero, greetingFor } = component("v2/hero.tsx");
const { ChatComposer } = component("tenant/chat-composer.tsx");
const { AgentPick, agentMenu, dockAgentMenu } = component(
  "tenant/agent-picker.tsx",
);

const frontend = new URL("..", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, frontend), "utf8");

const composer = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ChatComposer, {
      value: "",
      onChange() {},
      onSend() {},
      onStop() {},
      agentName: "Analyst",
      busy: false,
      sending: false,
      ending: null,
      disabled: false,
      failure: null,
      stopError: "",
      focusKey: "k",
      ...props,
    }),
  );

const agent = (id: string, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  description: `Does ${id}`,
  available: true,
  ...extra,
});

test("the greeting follows the local hour, with its glyph (spec 11.4)", () => {
  assert.deepEqual(greetingFor(3), { text: "Working late", icon: "moon" });
  assert.deepEqual(greetingFor(9), { text: "Good morning", icon: "sunrise" });
  assert.deepEqual(greetingFor(15), { text: "Good afternoon", icon: "sun" });
  assert.deepEqual(greetingFor(20), { text: "Good evening", icon: "sunset" });
  assert.deepEqual(greetingFor(23), { text: "Working late", icon: "moon" });
});

test("the hero is cs-hero with a t-h2 heading and one serif accent", () => {
  const html = renderToStaticMarkup(
    createElement(Hero, { name: "A. Shah" }, "COMPOSER"),
  );
  assert.match(html, /class="cs-hero"/);
  assert.match(html, /class="cs-greet"/);
  assert.match(
    html,
    /<h1 class="cs-hero-h t-h2">What should we <em>work on<\/em> today\?<\/h1>/,
  );
  assert.equal(html.match(/<em>/g)?.length, 1);
  assert.match(html, /class="cs-hero-composer">COMPOSER/);
});

test("the hero composer is the roomy pt-composer with the picker in its bar", () => {
  const html = composer({ hero: true, bar: createElement("i", null, "PICK") });
  assert.match(
    html,
    /class="tx-card pt-composer cs-composer cs-composer-hero"/,
  );
  assert.match(html, /placeholder="Ask anything, or type \/ for commands"/);
  assert.match(html, /<label class="tx-sr"[^>]*>Message Analyst<\/label>/);
  assert.match(html, /class="pt-composer-bar"><i>PICK<\/i>/);
  const send =
    html.match(/<button type="submit"[^>]*>.*?<\/button>/)?.[0] ?? "";
  assert.match(send, /class="tx-btn tx-primary tx-sm"/);
  assert.match(send, /disabled=""/);
  assert.match(send, /Send<kbd class="tx-kbd">↵<\/kbd>/);
});

test("the follow-up composer is slim at rest and its placeholder follows the turn", () => {
  const idle = composer();
  assert.match(idle, /class="tx-card pt-composer cs-composer is-slim"/);
  assert.match(idle, /placeholder="Ask a follow-up or assign a step"/);
  assert.doesNotMatch(idle, />Stop</);

  const live = composer({ busy: true, value: "more" });
  assert.doesNotMatch(live, /is-slim/);
  assert.match(
    live,
    /placeholder="Steer this turn: add a note, or press Stop"/,
  );
  assert.match(
    live,
    /class="tx-btn tx-ghost tx-sm cs-stop"[^>]*>.*Stop<\/button>/,
  );
  assert.match(live, /title="Send. It joins the turn in progress"/);

  const paused = composer({ busy: true, awaitingApproval: true });
  assert.match(
    paused,
    /placeholder="Add a note to this turn, or answer above"/,
  );
  // the card and the step row already say it; the bar doesn't repeat it
  assert.doesNotMatch(paused, /Waiting for your approval/);
  // the card's decision is the one primary; Send steps back
  assert.doesNotMatch(paused, /tx-primary/);
  assert.match(live, /type="submit" class="tx-btn tx-primary/);
});

test("the agent picker is a chip that names the agent and opens a menu", () => {
  const html = renderToStaticMarkup(
    createElement(AgentPick, {
      agents: [agent("a"), agent("b")],
      selectedId: "b",
      onSelect() {},
      onNew() {},
      onBrowse() {},
    }),
  );
  const chip = html.match(/<button[^>]*cs-agent-pick[^>]*>/)?.[0] ?? "";
  assert.match(chip, /class="tx-chip cs-agent-pick"/);
  assert.match(chip, /aria-haspopup="menu"/);
  assert.match(chip, /aria-expanded="false"/);
  assert.match(chip, /aria-label="Agent: Agent b. Change agent"/);
});

test("the agent menu lists usable agents as radios, then new and browse", () => {
  const items = agentMenu(
    [agent("a"), agent("b"), agent("c", { available: false })],
    "a",
  );
  assert.deepEqual(
    items.map((item: any) =>
      item === "separator" ? "-" : `${item.id}:${item.checked ?? ""}`,
    ),
    ["agent:a:true", "agent:b:false", "-", "new:", "browse:"],
  );
  assert.equal(items[0].detail, "Does a");
});

test("the dock's Agent menu lists a few agents, then Browse all and Create agent last", () => {
  const ids = (items: any[]) =>
    items.map((item) => (item === "separator" ? "-" : item.id));
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((id) => agent(id));
  assert.deepEqual(ids(dockAgentMenu(many, null)), [
    "agent:a",
    "agent:b",
    "agent:c",
    "agent:d",
    "agent:e",
    "-",
    "browse",
    "new",
  ]);
  // the selected agent stays in the menu even when it is past the first five
  const picked = dockAgentMenu(many, "g");
  assert.equal(picked.filter((i: any) => i !== "separator").length, 7);
  assert.equal((picked as any[]).find((i) => i.checked)?.id, "agent:g");
  const create = (picked as any[]).at(-1);
  assert.equal(create.label, "Create agent");
  assert.equal(create.icon, "plus");
  // unavailable agents can't start a chat; with none, only the two actions
  assert.deepEqual(
    ids(dockAgentMenu([agent("x", { available: false })], null)),
    ["browse", "new"],
  );
});

test("the old composer and agent-list CSS is gone; the new CSS is tokens only", () => {
  assert.equal(
    existsSync(new URL("styles/v2/tenant-agents.css", frontend)),
    false,
  );
  // v2/chat.css lost its composer rules here and was deleted with Task 17.
  const chat = new URL("styles/v2/chat.css", frontend);
  if (existsSync(chat))
    assert.doesNotMatch(read("styles/v2/chat.css"), /^\.composer\b/m);
  // carryover.css lost these rules here and was deleted with Task 34.
  const carryover = new URL("styles/v2/carryover.css", frontend);
  if (existsSync(carryover))
    assert.doesNotMatch(
      read("styles/v2/carryover.css"),
      /^\.composer\b|^\.hero\b/m,
    );
  assert.match(
    read("test/design-system.test.ts"),
    /"styles\/app\/composer\.css"/,
  );
});

test("an idle composer starts on its first hint; a running turn keeps its own", () => {
  assert.match(composer(), /placeholder="Ask a follow-up or assign a step"/);
  assert.match(
    composer({
      hero: true,
      uploads: { enabled: true, maxFiles: 5, maxFileBytes: 1, extensions: [] },
      onAddFiles() {},
    }),
    /placeholder="Ask anything, or type \/ for commands"/,
  );
  assert.match(
    composer({ busy: true }),
    /placeholder="Steer this turn: add a note, or press Stop"/,
  );
  // the drawn hint shows the same first line, hidden from assistive tech,
  // and goes once there is text
  assert.match(
    composer(),
    /<div class="cs-hint" aria-hidden="true"><span class="cs-hint-line">Ask a follow-up or assign a step<\/span><\/div>/,
  );
  assert.doesNotMatch(composer({ value: "hi" }), /cs-hint/);
});

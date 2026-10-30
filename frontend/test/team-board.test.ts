import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { TeamBoard } = component("tenant/team-board.tsx");

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: "personal",
  name: `Agent ${id}`,
  description: `Owns ${id} work`,
  look: 0,
  tint: "ice",
  model: {
    id: "m",
    displayName: "Claude Sonnet 4.5",
    shortLabel: "Sonnet 4.5",
    family: "claude",
  },
  available: true,
  connectors: [],
  skills: [],
  helpers: false,
  revision: 1,
  createdByMe: true,
  status: "active",
  canEdit: true,
  canArchive: true,
  canPromote: false,
  ...extra,
});
const AGENTS = [
  agent("general", {
    source: "builtin",
    name: "General Agent",
    description: "Helps with anything.",
    canEdit: false,
    createdByMe: false,
  }),
  agent("deals", {
    name: "Deal Desk",
    connectors: [
      {
        slug: "crm",
        displayName: "CRM",
        icon: null,
        available: true,
        access: "read",
      },
    ],
    skills: [
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
    ],
  }),
  agent("notes", { name: "Notes" }),
];
const board = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TeamBoard, {
      agents: AGENTS,
      selectedId: "deals",
      onChat() {},
      onEdit() {},
      onNew() {},
      ...props,
    }),
  );

test("the board's head: one display heading with its accent, the counts, New agent as the one primary", () => {
  const html = board();
  assert.match(
    html,
    /<h1 class="t-display">What the <em>team<\/em> can help with<\/h1>/,
  );
  assert.match(
    html,
    /3 specialists · 2 built by you\. Pin one to the chat, or build your own\./,
  );
  assert.equal((html.match(/tx-primary/g) ?? []).length, 1);
  assert.match(html, /class="tx-btn tx-primary"[^>]*>[\s\S]*New agent/);
});

test("search and a roving All / Yours / Built-in filter, with a count tag", () => {
  const html = board();
  assert.match(html, /placeholder="Search by name, handle or purpose"/);
  assert.match(html, /role="radiogroup" aria-label="Filter agents"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
  assert.match(html, /aria-label="3 of 3 agents shown">03\/03</);
});

test("a card names the agent with its handle, purpose, servers, meta and Chat", () => {
  const html = board();
  const deals = html.slice(html.indexOf("Deal Desk"));
  assert.match(html, /class="tb-caption">Deal Desk</);
  assert.match(html, /class="tb-handle">@dealdesk</);
  assert.match(html, />Owns deals work</);
  assert.match(deals, /class="tb-chip">CRM</);
  assert.match(html, /class="tb-meta num">sonnet 4\.5 · 2 skills</);
  assert.match(html, /No servers connected/);
  assert.match(html, /aria-label="Edit Deal Desk"/);
  // the agent pinned to the chat
  assert.match(deals, /tx-pill-live tx-pill-sm[^>]*>[\s\S]*in chat/);
  assert.match(
    deals,
    /<button[^>]*disabled=""[^>]*>Chatting<|<button[^>]*>Chatting</,
  );
  // built-in agents carry a lock pill on the photo and can't be edited from it
  assert.match(html, /class="tb-lock">[\s\S]*Built-in/);
  assert.doesNotMatch(html, /aria-label="Edit General Agent"/);
});

test("the new-agent slot shows unless filtering to Built-in or searching", () => {
  assert.match(board(), /class="tb-new"/);
  assert.doesNotMatch(board({ initialKind: "builtin" }), /class="tb-new"/);
  assert.doesNotMatch(board({ initialQuery: "deal" }), /class="tb-new"/);
});

test("an empty search says so in curly quotes and offers to clear it", () => {
  const html = board({ initialQuery: "zzz" });
  assert.match(html, /No agents match “zzz”/);
  assert.match(html, />Clear search</);
  assert.match(html, /aria-label="0 of 3 agents shown">00\/03</);
});

test("an agent shared with the workspace says so; a personal one doesn't", () => {
  const html = renderToStaticMarkup(
    createElement(TeamBoard, {
      agents: [
        agent("team", { source: "tenant", name: "Team Bot" }),
        agent("mine", { name: "Mine" }),
      ],
      selectedId: null,
      onChat() {},
      onEdit() {},
      onNew() {},
    }),
  );
  assert.equal(
    (html.match(/class="tb-badge">[\s\S]*?Shared with the workspace/g) ?? [])
      .length,
    1,
  );
});

// The polaroid from system/screens/agents.*: name on the frame, the built-in
// pill printed on the photo, a push-pin, and the details below the frame.
const card = (html: string, name: string) => {
  const at = html.lastIndexOf('<li class="tb-card', html.indexOf(`>${name}<`));
  return html.slice(at, html.indexOf("</li>", at));
};

test("the caption is printed on the frame and the details sit below it", () => {
  const deals = card(board(), "Deal Desk");
  const frame = deals.match(
    /<div class="tb-frame">([\s\S]*?)<\/div><div class="tb-info">/,
  )?.[1];
  assert.ok(frame, deals);
  assert.match(frame, /class="tb-caption">Deal Desk</);
  assert.doesNotMatch(frame, /tb-handle|tb-purpose/);
  const info = deals.slice(deals.indexOf('class="tb-info"'));
  assert.match(info, /class="tb-handle">@dealdesk<[\s\S]*in chat/);
  assert.match(
    info,
    /class="tb-foot-row"[\s\S]*class="tb-meta num"[\s\S]*Chatting/,
  );
});

test("a built-in agent's pill is printed inside its photo", () => {
  const general = card(board(), "General Agent");
  assert.match(
    general,
    /<span class="tb-photo">[\s\S]*?<span class="tb-lock">[\s\S]*?Built-in<\/span>[\s\S]*?<\/span><span class="tb-caption">/,
  );
});

test("every card has a push-pin; only the live card's pin is signal", () => {
  const html = board();
  assert.equal((html.match(/<svg class="tb-pin[ "]/g) ?? []).length, 3);
  assert.match(card(html, "Deal Desk"), /class="tb-pin is-live"/);
  assert.doesNotMatch(card(html, "Notes"), /tb-pin is-live/);
});

test("the new-agent slot is an empty polaroid with a hand-written note", () => {
  const html = board();
  const slot = html.slice(html.indexOf('class="tb-new"'));
  assert.match(
    slot,
    /<button[^>]*class="tb-new-frame"[^>]*><span class="tb-new-photo"><span class="tb-new-plus"[\s\S]*?<\/span><\/span><span class="tb-caption">New agent<\/span><\/button><span class="tb-note"[^>]*>build your own/,
  );
});

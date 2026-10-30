import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { ChatList } = component("tenant/chat-list.tsx");
const { Topbar, SidebarFrame } = component("auth/workspace-frame.tsx");
const { Shell, Panel } = component("v2/shell.tsx");

const day = 86_400_000;
const chat = (id: string, ago: number, extra = {}) => ({
  id,
  title: `Chat ${id}`,
  lastMessageAt: new Date(Date.now() - ago).toISOString(),
  activeRunId: null,
  ...extra,
});
const list = (chats: unknown[], activeId: string | null, extra = {}) =>
  renderToStaticMarkup(
    createElement(ChatList, {
      chats,
      activeId,
      state: "ready",
      error: "",
      hasMore: false,
      loadingMore: false,
      onOpen() {},
      onRetry() {},
      onMore() {},
      ...extra,
    }),
  );

test("the current conversation is the signal row, marked aria-current=page", () => {
  const html = list([chat("a", 60_000), chat("b", 2 * 60_000)], "b");
  const rows = html.match(/<button[^>]*pt-session[^>]*>/g) ?? [];
  assert.equal(rows.length, 2);
  assert.match(rows[1], /aria-current="page"/);
  assert.doesNotMatch(rows[0], /aria-current/);
  assert.match(rows[0], /class="tx-btn tx-ghost pt-session cs-session"/);
});

test("older groups fold behind View all conversations until opened", () => {
  const html = list([chat("a", 60_000), chat("old", 40 * day)], "a");
  const toggle = html.match(/<button[^>]*cs-view-all[^>]*>[^<]*/)?.[0] ?? "";
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /View all conversations/);
  const controls = toggle.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controls);
  assert.match(html, new RegExp(`id="${controls}"[^>]*hidden`));
});

test("an open conversation in an older group keeps its group open", () => {
  const html = list([chat("a", 60_000), chat("old", 40 * day)], "old");
  assert.match(html, /aria-expanded="true"[^>]*>Show less/);
  assert.doesNotMatch(html, /class="cs-older"[^>]*hidden/);
});

test("when only older conversations exist they show without a fold", () => {
  const html = list([chat("old", 40 * day)], null);
  assert.doesNotMatch(html, /cs-view-all/);
  assert.match(html, /Chat old/);
});

test("a running conversation says so in words, not a bare dot", () => {
  const html = list([chat("a", 60_000, { activeRunId: "r1" })], null);
  assert.match(html, /aria-label="Answering"/);
});

test("the topbar shows the agent tag, its state word and the title", () => {
  const html = renderToStaticMarkup(
    createElement(Topbar, {
      title: "Quarter close",
      slim: true,
      agent: { name: "Ledger Bot", state: "working" },
    }),
  );
  assert.match(html, /<header class="cs-topbar is-slim"/);
  assert.match(html, /class="cs-agent-tag" data-state="working"/);
  assert.match(html, /<span class="tx-sr">Working<\/span>/);
  assert.match(html, /class="cs-title"[^>]*>Quarter close</);
});

test("a new conversation's topbar has no agent tag", () => {
  const html = renderToStaticMarkup(
    createElement(Topbar, { title: "New conversation" }),
  );
  assert.doesNotMatch(html, /cs-agent-tag/);
  assert.doesNotMatch(html, /is-slim/);
});

test("the sidebar frame: brand, new conversation, workspace nav, honest Soon item, account", () => {
  const html = renderToStaticMarkup(
    createElement(SidebarFrame, {
      tenantId: "t1",
      user: { name: "Asha Rao", email: "asha@example.com" },
      role: "admin",
      workspace: "Acme",
      current: "tools",
      onNew() {},
      onSignOut() {},
      children: createElement("p", null, "history"),
    }),
  );
  assert.match(html, /<a class="cs-brand"[^>]*href="\/t\/t1\/chat"/);
  assert.match(html, /class="pt-brand-word">truex</);
  assert.match(html, /tx-btn tx-dark cs-new/);
  assert.match(html, /<nav class="cs-side-nav" aria-label="Workspace"/);
  assert.match(
    html,
    /<a [^>]*aria-current="page"[^>]*href="\/t\/t1\/connected-tools"/,
  );
  assert.match(
    html,
    /aria-disabled="true" aria-label="Knowledge base, coming soon"/,
  );
  assert.match(html, /class="cs-avatar"[^>]*>AR</);
  assert.match(html, /Admin · Acme/);
  assert.match(html, /aria-haspopup="menu"/);
});

test("the shell and its panels use the cs- frame classes", () => {
  const html = renderToStaticMarkup(
    createElement(
      Shell,
      {},
      createElement(Panel, { kind: "sidebar", open: false, label: "x" }, "s"),
    ),
  );
  assert.match(html, /<div class="cs-shell">/);
  assert.match(html, /<aside class="panel sidebar cs-sidebar"[^>]*inert/);
});

test("the old shell CSS is gone and the new CSS holds the tokens-only law", () => {
  const root = new URL("..", import.meta.url);
  for (const file of ["styles/v2/shell.css", "styles/v2/tenant-workspace.css"])
    assert.equal(existsSync(new URL(file, root)), false, `${file} remains`);
  const workspace = readFileSync(
    new URL("app/t/[tenantId]/workspace.css", root),
    "utf8",
  );
  assert.match(workspace, /styles\/app\/shell\.css/);
});

test("public pages don't load the workspace CSS", () => {
  const root = new URL("..", import.meta.url);
  const globals = readFileSync(new URL("app/globals.css", root), "utf8");
  for (const surface of ["shell", "composer", "turn", "activity-panel"])
    assert.doesNotMatch(globals, new RegExp(`styles/app/${surface}\\.css`));
});

test("a turn paused on a request says Waiting on the agent tag", () => {
  const html = renderToStaticMarkup(
    createElement(Topbar, {
      title: "Quarter close",
      slim: true,
      agent: { name: "Ledger Bot", state: "waiting" },
    }),
  );
  assert.match(html, /class="cs-agent-tag" data-state="waiting"/);
  assert.match(html, /<span class="tx-sr">Waiting on you<\/span>/);
});

test("a title slot replaces the title, and a note sits under the bar", () => {
  const html = renderToStaticMarkup(
    createElement(Topbar, {
      title: "Quarter close",
      titleSlot: createElement("form", { className: "cs-rename" }, "edit"),
      note: createElement("p", { className: "cs-top-note-x" }, "Saved?"),
    }),
  );
  assert.match(html, /<form class="cs-rename">edit<\/form>/);
  assert.doesNotMatch(html, /class="cs-title"/);
  assert.match(
    html,
    /<\/header><div class="cs-top-note"><p class="cs-top-note-x">Saved\?<\/p><\/div>/,
  );
});

const { ChatTopbar } = component("tenant/chat-topbar.tsx");
const topbar = (extra = {}) =>
  renderToStaticMarkup(
    createElement(ChatTopbar, {
      chat: {
        id: "c1",
        title: "Quarter close",
        status: "active",
        agent: { name: "Ledger Bot" },
      },
      busy: false,
      waiting: false,
      onRename: async () => null,
      onArchive: async () => null,
      ...extra,
    }),
  );

test("the open conversation's topbar carries its title, agent and options", () => {
  const html = topbar({ busy: true });
  assert.match(html, /class="cs-title"[^>]*>Quarter close</);
  assert.match(html, /data-state="working"/);
  assert.match(html, /aria-label="Conversation options"/);
  assert.match(topbar({ busy: true, waiting: true }), /data-state="waiting"/);
});

test("a conversation still being created has no options to act on", () => {
  assert.doesNotMatch(topbar({ creating: true }), /Conversation options/);
});

test("a chat whose reply finished elsewhere is bold until opened", () => {
  const html = list([chat("a", 60_000), chat("b", 2 * 60_000)], "a", {
    unread: new Set(["b"]),
  });
  const rows = html.match(/<button[^>]*pt-session[^>]*>/g) ?? [];
  assert.doesNotMatch(rows[0] ?? "", /data-unread/);
  assert.match(rows[1] ?? "", /data-unread="true"/);
  assert.match(html, /, new reply/);
});

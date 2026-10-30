import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { turnView, statePill } from "../lib/activity.ts";

const at = "2026-10-28T14:41:00.000Z";
const msg = (id: string, extra: Record<string, unknown>) => ({
  id,
  runId: "r1",
  seq: 1,
  createdAt: at,
  state: "complete",
  text: "",
  ...extra,
});
const tool = (id: string, extra: Record<string, unknown> = {}) =>
  msg(id, {
    role: "tool",
    tool: {
      connector: "crm",
      name: "find_deals",
      status: "completed",
      durationMs: 1200,
      errorCode: null,
      ...extra,
    },
  });
const run = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "r1",
  status,
  error: null,
  usage: { input: 100, cached: 0, cacheWrite: 0, output: 50, reasoning: 0 },
  timings: { acceptedAt: at, completedAt: "2026-10-28T14:41:04.000Z" },
  ...extra,
});
const connectors = [{ slug: "crm", displayName: "CRM" }] as never[];

test("a saved turn lists its ask and its steps in order, with past-tense titles", () => {
  const view = turnView(
    {
      runId: "r1",
      run: run("completed"),
      messages: [
        msg("u1", { role: "user", text: "Why did EMEA revenue drop?" }),
        tool("t1"),
        tool("t2", { status: "failed", errorCode: "TIMEOUT" }),
        msg("a1", { role: "assistant", text: "Because Q3." }),
      ],
    } as never,
    null,
    [],
    connectors,
  );
  assert.deepEqual(view.ask, { text: "Why did EMEA revenue drop?", at });
  assert.deepEqual(
    view.steps.map((s) => [s.title, s.status, s.system]),
    [
      ["Used CRM · Find deals", "done", "CRM"],
      ["CRM · Find deals didn’t work", "fail", "CRM"],
    ],
  );
  assert.equal(view.state, "issue");
  assert.equal(view.steps[0].durationMs, 1200);
});

test("live turns are live, or need you while a request waits", () => {
  const live = (approvals: Record<string, unknown>) => ({
    runId: "r1",
    phase: "streaming",
    since: 0,
    items: [
      {
        type: "tool",
        itemId: "i1",
        connector: "crm",
        tool: "create_deal",
        status: "inProgress",
        durationMs: null,
        errorCode: null,
      },
    ],
    helpers: [],
    approvals,
    connectorFailures: [],
    unsaved: [],
    outcome: null,
    saveFailed: false,
  });
  const exchange = { runId: "r1", run: run("running"), messages: [] } as never;
  const working = turnView(exchange, live({}) as never, [], connectors);
  assert.equal(working.state, "live");
  assert.deepEqual(
    working.steps.map((s) => [s.title, s.status]),
    [["Using CRM · Create deal", "run"]],
  );
  const waiting = turnView(
    exchange,
    live({
      a1: { approvalId: "a1", itemId: "i1", status: "pending" },
    }) as never,
    [],
    connectors,
  );
  assert.equal(waiting.state, "needs");
  assert.equal(waiting.steps[0].status, "wait");
});

test("declined and stopped are the person's choices, never faults", () => {
  const declined = turnView(
    {
      runId: "r1",
      run: run("completed"),
      messages: [
        tool("t1", {
          status: "failed",
          errorCode: "REFUSED",
          approval: "deny",
        }),
      ],
    } as never,
    null,
    [],
    connectors,
  );
  assert.equal(declined.state, "declined");
  assert.equal(declined.steps[0].status, "decl");
  assert.equal(declined.steps[0].title, "You declined CRM · Find deals");
  const stopped = turnView(
    {
      runId: "r1",
      run: run("stopped"),
      messages: [tool("t1", { status: "inProgress" })],
    } as never,
    null,
    [],
    connectors,
  );
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.steps[0].status, "stop");
});

test("the state pill is a tone, a glyph and a word", () => {
  assert.deepEqual(statePill("live"), {
    tone: "tx-pill-live",
    glyph: null,
    word: "Working",
  });
  assert.deepEqual(statePill("needs"), {
    tone: "tx-pill-warn",
    glyph: "hand",
    word: "Needs your approval",
  });
  assert.deepEqual(statePill("done"), {
    tone: "tx-pill-ok",
    glyph: "check",
    word: "Done",
  });
  assert.deepEqual(statePill("issue"), {
    tone: "tx-pill-warn",
    glyph: "alert",
    word: "Done, 1 step failed",
  });
  assert.deepEqual(statePill("declined"), {
    tone: "tx-pill-ok",
    glyph: "check",
    word: "Done",
  });
  assert.deepEqual(statePill("stopped"), {
    tone: "tx-pill-line",
    glyph: "stop",
    word: "Stopped by you",
  });
  assert.equal(statePill("issue", 2).word, "Done, 2 steps failed");
});

test("files made by the turn and files it changed are counted apart", () => {
  const view = turnView(
    {
      runId: "r1",
      run: run("completed"),
      messages: [
        msg("c1", {
          role: "tool",
          activity: {
            type: "file_change",
            itemId: "f1",
            files: [
              { path: "report.md", kind: "add" },
              { path: "notes.md", kind: "update" },
            ],
            status: "completed",
            approval: null,
          },
        }),
      ],
    } as never,
    null,
    [
      {
        id: "x",
        runId: "r1",
        path: "report.md",
        name: "report.md",
        version: 1,
        size: 10,
        contentType: "text/markdown",
        createdAt: at,
      },
    ],
    connectors,
  );
  assert.deepEqual(
    view.made.map((f) => f.path),
    ["report.md"],
  );
  assert.deepEqual(view.edited, ["notes.md"]);
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { matchShortcut, ariaKeys } from "../lib/shortcuts.ts";
import { component } from "./next-details-runtime.ts";

const { ActivityPanel, ActivityTab, AgentTab, FilesTab, InsightsTab } =
  component("activity/panel.tsx");

const view = (extra: Record<string, unknown> = {}) => ({
  ...turnView(
    {
      runId: "r1",
      run: run("completed"),
      messages: [
        msg("u1", { role: "user", text: "Why did EMEA revenue drop?" }),
        tool("t1"),
        msg("a1", { role: "assistant", text: "Because Q3." }),
      ],
    } as never,
    null,
    [],
    connectors,
  ),
  ...extra,
});
const agent = {
  name: "Analyst",
  source: "personal",
  model: "Claude Haiku 5.5",
};
const panel = (turns: unknown[], index = 0) =>
  renderToStaticMarkup(
    createElement(ActivityPanel, {
      turns,
      index,
      agent,
      onIndex() {},
      onClose() {},
      onShowInChat() {},
    }),
  );

test("⌘. toggles the panel and is the only chord it advertises", () => {
  assert.equal(
    matchShortcut(
      {
        key: ".",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
      },
      { mac: true, inText: false, modal: "none" },
    ),
    "activity",
  );
  assert.equal(ariaKeys("activity"), "Meta+. Control+.");
  assert.match(panel([view()]), /aria-keyshortcuts="Meta\+\. Control\+\."/);
});

test("the panel frame: scope, previous and next, four tabs in the locked order, a trace foot", () => {
  const html = panel([view(), view({ runId: "r2" })], 1);
  assert.match(html, /^<aside class="ap" aria-label="Activity panel">/);
  assert.match(
    html,
    /<nav class="ap-scope" aria-label="Scope">[\s\S]*aria-current="page">Turn <span class="num">2<\/span> of[\s\S]*<span class="num">2<\/span>/,
  );
  assert.match(html, /aria-label="Previous turn"/);
  assert.match(
    html,
    /<button[^>]*aria-label="Next turn"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-label="Next turn"/,
  );
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(tabs, ["Activity", "Agent", "Files", "Insights"]);
  assert.match(html, /role="tablist" aria-label="Activity panel sections"/);
  assert.match(html, /role="tabpanel"[^>]*tabindex="0"/);
  assert.match(html, /class="ap-k">Trace</);
  assert.match(html, /aria-label="Copy trace ID r2"/);
  // the trace chip shows it copies (study: business-activity.html foot)
  assert.match(
    html,
    /aria-label="Copy trace ID r2">r2<svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button>/,
  );
  assert.match(html, /Export log/);
});

test("the Agent tab is labelled Sub-agents with a count when helpers ran; Files carries the made count", () => {
  const html = panel([
    view({
      helpers: [
        { path: "/root/crm", status: "completed" },
        { path: "/root/mail", status: "running" },
      ],
      made: [
        {
          id: "f",
          runId: "r1",
          path: "a.md",
          name: "a.md",
          version: 1,
          size: 1,
          contentType: "text/markdown",
          createdAt: at,
        },
      ],
    }),
  ]);
  assert.match(html, /role="tab"[^>]*>Sub-agents <span class="num">2<\/span>/);
  assert.match(html, /role="tab"[^>]*>Files <span class="num">1<\/span>/);
});

const FORBIDDEN =
  /\b(approve|decline|deny|allow|retry|try again|stop|steer|edit|rerun|start a (new )?chat)\b/i;
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    `${m[0].match(/aria-label="([^"]*)"/)?.[1] ?? ""} ${m[1].replace(/<[^>]+>/g, "")}`.trim(),
  );

test("no tab holds a control that changes state; the most active verb is Show in chat", () => {
  const states = ["done", "live", "needs", "issue", "declined", "stopped"];
  for (const state of states) {
    const turn = view({ state });
    const tabs = [
      renderToStaticMarkup(
        createElement(ActivityTab, {
          turn,
          agentName: "Analyst",
          onShowInChat() {},
        }),
      ),
      renderToStaticMarkup(createElement(AgentTab, { turn, agent })),
      renderToStaticMarkup(
        createElement(FilesTab, { turn, onOpen() {}, onDownload() {} }),
      ),
      renderToStaticMarkup(
        createElement(InsightsTab, { turn, model: null, onShowInChat() {} }),
      ),
      panel([turn]),
    ];
    for (const html of tabs)
      for (const label of buttons(html))
        assert.doesNotMatch(label, FORBIDDEN, `${state}: "${label}"`);
  }
  const needs = renderToStaticMarkup(
    createElement(ActivityTab, {
      turn: view({ state: "needs" }),
      agentName: "Analyst",
      onShowInChat() {},
    }),
  );
  assert.match(
    needs,
    /role="status"[\s\S]*Waiting for your approval in the chat[\s\S]*Show in chat/,
  );
  assert.match(needs, /Answer, add a note, or stop the turn from the chat\./);
});

test("a run that failed without a failed step says it didn't finish", () => {
  assert.deepEqual(statePill("issue", 0), {
    tone: "tx-pill-warn",
    glyph: "alert",
    word: "Didn’t finish",
  });
});

test("Expand toggles the wide size and is absent when the window has no room", () => {
  const props = {
    turns: [view()],
    index: 0,
    agent,
    onIndex() {},
    onClose() {},
    onShowInChat() {},
  };
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(ActivityPanel, { ...props, ...extra }));
  assert.doesNotMatch(render({}), /Expand panel|Shrink panel/);
  const narrow = render({ onToggleWide() {} });
  assert.match(narrow, /^<aside class="ap" /);
  assert.match(narrow, /aria-label="Expand panel" aria-pressed="false"/);
  const wide = render({ wide: true, onToggleWide() {} });
  assert.match(wide, /^<aside class="ap is-wide" /);
  assert.match(wide, /aria-label="Shrink panel" aria-pressed="true"/);
});

test("a closing panel stays mounted for its slide out but is inert", () => {
  const props = {
    turns: [view()],
    index: 0,
    agent,
    onIndex() {},
    onClose() {},
    onShowInChat() {},
  };
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(ActivityPanel, { ...props, ...extra }));
  assert.doesNotMatch(render({}), /^<aside[^>]*inert/);
  assert.match(render({ closing: true }), /^<aside class="ap is-closing"[^>]*inert=""/);
  assert.match(
    render({ closing: true, wide: true }),
    /^<aside class="ap is-wide is-closing"/,
  );
});

test("the side panels slide, and reduced motion turns the slide off", () => {
  const css = (file: string) =>
    readFileSync(new URL(`../styles/app/${file}`, import.meta.url), "utf8");
  const shell = css("shell.css");
  const panel = css("activity-panel.css");
  assert.match(shell, /--panel-in: [^;]+;\s*--panel-out: [^;]+;/);
  assert.match(shell, /\.cs-sidebar:not\(\.is-open\) \{[^}]*margin-inline-start: calc\(\(var\(--rail\)/);
  assert.match(panel, /@starting-style \{\s*\.ap \{/);
  assert.match(panel, /\.ap\.is-closing \{[^}]*transform: translateX/);
  for (const source of [shell, panel])
    assert.match(source, /:root\[data-eff-motion="reduce"\][^{]*\{\s*transition: none;/);
  // the JS exit delay matches the CSS exit duration
  const chat = readFileSync(
    new URL("../components/tenant/tenant-chat.tsx", import.meta.url),
    "utf8",
  );
  const out = /--panel-out: ([\d.]+)s/.exec(shell)?.[1];
  assert.match(chat, new RegExp(`useExit\\(activityShown, ${Number(out) * 1000}\\)`));
});

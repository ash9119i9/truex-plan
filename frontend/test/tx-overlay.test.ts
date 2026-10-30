import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import { createAnnouncer } from "../lib/announce.ts";
import { createToasts, toastLifetime, TOAST_LIMIT } from "../lib/toast.ts";
import { rovingMove } from "../lib/roving-focus.ts";

const { Menu, MenuPanel } = component("tx/menu.tsx");
const { Tooltip } = component("tx/tooltip.tsx");
const { ToastHost } = component("tx/toast.tsx");
const { Meter } = component("tx/meter.tsx");
const { LiveRegion, Spin, Pulse, Dot, Shimmer } = component("tx/live.tsx");
const render = (type: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(type as never, props as never));

test("two quick announcements are both kept, in order, never merged", () => {
  const live = createAnnouncer();
  live.announce("Stopped.");
  live.announce("Stopped.");
  live.announce("Upload finished.");
  assert.deepEqual(
    live.messages().map((m) => m.text),
    ["Stopped.", "Stopped.", "Upload finished."],
  );
  const ids = live.messages().map((m) => m.id);
  assert.equal(
    new Set(ids).size,
    3,
    "repeats get their own node, so they are read again",
  );
  live.expire(ids[0]);
  assert.deepEqual(
    live.messages().map((m) => m.text),
    ["Stopped.", "Upload finished."],
  );
  live.announce("   ");
  assert.equal(live.messages().length, 2, "blank text is not announced");
});

test("the live region is one polite status paragraph per message list", () => {
  const html = render(LiveRegion, { messages: [{ id: 1, text: "Steered." }] });
  assert.equal(
    html,
    '<div class="tx-sr" role="status" aria-live="polite"><p>Steered.</p></div>',
  );
});

test("toasts live 4.5 s, longer for long copy, and at most three show", () => {
  assert.equal(toastLifetime("Request allowed"), 4500);
  const long = Array.from({ length: 30 }, () => "word").join(" ");
  assert.equal(toastLifetime(long), Math.round((30 / 3.33 + 0.9) * 1000));
  const toasts = createToasts();
  for (const n of [1, 2, 3, 4]) toasts.push({ title: `T${n}` });
  assert.equal(TOAST_LIMIT, 3);
  assert.deepEqual(
    toasts.list().map((t) => t.title),
    ["T2", "T3", "T4"],
  );
  toasts.dismiss(toasts.list()[0].id);
  assert.deepEqual(
    toasts.list().map((t) => t.title),
    ["T3", "T4"],
  );

  const host = render(ToastHost, {
    toasts: [
      { id: 7, title: "Request allowed", body: "Posting once.", tone: "ok" },
    ],
    onDismiss() {},
  });
  assert.match(host, /^<div class="tx-toast-host" aria-live="polite">/);
  assert.match(
    host,
    /<div class="tx-toast"><span class="tx-tile tx-tile-ok" aria-hidden="true">✓<\/span>/,
  );
  assert.match(host, /<h5>Request allowed<\/h5><p>Posting once\.<\/p>/);
  assert.match(
    host,
    /<button type="button" class="tx-toast-x" aria-label="Dismiss: Request allowed"/,
  );
  assert.doesNotMatch(host, /autofocus/i, "a toast never takes focus");
});

test("menus move with up and down only, wrapping", () => {
  const items = [{}, {}, {}];
  assert.equal(rovingMove("ArrowDown", 2, items, "vertical"), 0);
  assert.equal(rovingMove("ArrowUp", 0, items, "vertical"), 2);
  assert.equal(rovingMove("ArrowRight", 0, items, "vertical"), null);
  assert.equal(rovingMove("End", 0, items, "vertical"), 2);
});

test("a menu trigger advertises its popup; the panel lists real menu items", () => {
  const closed = render(Menu, {
    label: "Account",
    trigger: (props: object) =>
      createElement("button", { ...props, className: "tx-btn" }, "Ada"),
    items: [{ id: "out", label: "Sign out" }],
    onSelect() {},
  });
  assert.match(closed, /aria-haspopup="menu"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /role="menu"/);

  const panel = render(MenuPanel, {
    id: "m",
    label: "Account",
    active: 1,
    onKeyDown() {},
    itemRef: () => () => {},
    onSelect() {},
    items: [
      { id: "light", label: "Light", checked: false },
      {
        id: "dark",
        label: "Dark",
        checked: true,
        detail: "Saved on this device",
      },
      "separator",
      { id: "out", label: "Sign out", danger: true, icon: "x", kbd: "⌘Q" },
    ],
  });
  assert.match(
    panel,
    /^<div class="tx-menu" id="m" role="menu" aria-label="Account">/,
  );
  assert.match(
    panel,
    /role="menuitemradio" aria-checked="false" tabindex="-1"/,
  );
  assert.match(panel, /role="menuitemradio" aria-checked="true" tabindex="0"/);
  assert.match(panel, /<small>Saved on this device<\/small>/);
  assert.match(panel, /<div class="tx-menu-sep" role="separator"><\/div>/);
  assert.match(panel, /class="tx-menu-item tx-menu-danger" role="menuitem"/);
  assert.match(panel, /<kbd class="tx-kbd">⌘Q<\/kbd>/);
});

test("a tooltip describes its trigger and is not essential content", () => {
  const html = render(Tooltip, {
    text: "Copies the trace ID",
    children: (props: object) => createElement("button", props, "Copy"),
  });
  const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.match(html, /^<span class="tx-tip">/);
  assert.match(
    html,
    new RegExp(
      `<span class="tx-tip-pop" role="tooltip" id="${id}">Copies the trace ID</span>`,
    ),
  );
  assert.match(
    render(Tooltip, {
      text: "x",
      up: true,
      children: (p: object) => createElement("b", p),
    }),
    /class="tx-tip tx-tip-up"/,
  );
});

test("a meter exposes its value to assistive technology", () => {
  const html = render(Meter, {
    label: "Context used",
    value: 28,
    max: 100,
    tone: "warn",
    valueText: "28%",
  });
  assert.match(html, /^<span class="tx-meter tx-meter-warn" role="meter"/);
  assert.match(html, /aria-label="Context used"/);
  assert.match(
    html,
    /aria-valuemin="0" aria-valuemax="100" aria-valuenow="28" aria-valuetext="28%"/,
  );
  assert.match(html, /style="--tx-p:28"/);
  assert.match(
    render(Meter, { label: "x", value: 150, max: 100 }),
    /--tx-p:100/,
    "clamped",
  );
});

test("live cues are decorative marks; their static twins exist under reduced motion", () => {
  assert.equal(
    render(Spin, {}),
    '<span class="tx-spin" aria-hidden="true"></span>',
  );
  assert.equal(
    render(Pulse, {}),
    '<span class="tx-pulse" aria-hidden="true"></span>',
  );
  assert.equal(
    render(Dot, { tone: "ok" }),
    '<span class="tx-dot tx-dot-ok" aria-hidden="true"></span>',
  );
  assert.equal(
    render(Shimmer, { children: "Thinking…" }),
    '<span class="tx-shimmer">Thinking…</span>',
  );
  const css = readFileSync(
    new URL("../styles/system/primitives.css", import.meta.url),
    "utf8",
  );
  for (const cue of [
    "tx-spin",
    "tx-pulse",
    "tx-shimmer",
    "tx-stripes",
    "tx-caret",
    "tx-skel",
    "tx-toast",
  ])
    assert.match(
      css,
      new RegExp(`:root\\[data-eff-motion="reduce"\\] \\.${cue}\\b`),
      cue,
    );
});

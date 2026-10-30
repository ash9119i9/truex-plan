import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import type { ButtonProps } from "../components/tx/button.tsx";
import type { PillProps } from "../components/tx/pill.tsx";
import type { StateCardProps } from "../components/tx/card.tsx";

const { Button } = component("tx/button.tsx");
const { Keycap, Keys } = component("tx/keycap.tsx");
const { Pill } = component("tx/pill.tsx");
const { Chip, RefChip } = component("tx/chip.tsx");
const { Tile } = component("tx/tile.tsx");
const { Card, StateCard } = component("tx/card.tsx");
const render = (
  type: unknown,
  props: Record<string, unknown>,
  ...children: ReactNode[]
) =>
  renderToStaticMarkup(
    createElement(type as never, props as never, ...children),
  );
const classOf = (html: string) => html.match(/class="([^"]*)"/)?.[1];

test("Button renders the 9.4 variant and size classes", () => {
  assert.equal(classOf(render(Button, {}, "Review")), "tx-btn");
  for (const variant of ["primary", "dark", "ghost", "danger"])
    assert.equal(
      classOf(render(Button, { variant }, "Go")),
      `tx-btn tx-${variant}`,
    );
  for (const size of ["xs", "sm", "lg"])
    assert.equal(classOf(render(Button, { size }, "Go")), `tx-btn tx-${size}`);
  assert.equal(
    classOf(
      render(Button, { variant: "primary", size: "sm", className: "x" }, "Go"),
    ),
    "tx-btn tx-primary tx-sm x",
  );
  const html = render(
    Button,
    { variant: "primary", icon: "run", kbd: "⌘↵" },
    "Approve & run",
  );
  assert.match(html, /^<button type="button"/);
  assert.match(
    html,
    /<svg class="tx-ic tx-ic-sm" viewBox="0 0 24 24" aria-hidden="true"/,
  );
  assert.match(html, /Approve &amp; run<kbd class="tx-kbd">⌘↵<\/kbd>/);

  const icon = render(Button, {
    icon: "x",
    iconOnly: true,
    "aria-label": "Close",
  });
  assert.equal(classOf(icon), "tx-btn tx-icon");
  assert.match(icon, /aria-label="Close"/);

  const working = render(Button, { working: "Sending…" }, "Send");
  assert.match(working, /disabled=""/);
  assert.match(working, /aria-busy="true"/);
  assert.match(
    working,
    /<span class="tx-spin" aria-hidden="true"><\/span>Sending…/,
  );
  assert.doesNotMatch(working, />Send</);
});

test("Keycap, Pill, Chip and Tile render their documented classes", () => {
  assert.equal(render(Keycap, {}, "Esc"), '<kbd class="tx-kbd">Esc</kbd>');
  assert.equal(
    render(Keys, { keys: ["⌘", "K"] }),
    '<span class="tx-keys"><kbd class="tx-kbd">⌘</kbd><kbd class="tx-kbd">K</kbd></span>',
  );
  assert.equal(classOf(render(Pill, {}, "Built-in")), "tx-pill");
  for (const tone of ["ok", "warn", "bad", "live"]) {
    const html = render(Pill, { tone, glyph: "✓" }, "Ready");
    assert.equal(classOf(html), `tx-pill tx-pill-${tone}`);
    assert.match(html, /<span aria-hidden="true">✓<\/span>Ready/);
  }
  assert.equal(
    classOf(render(Pill, { tone: "line", size: "sm" }, "Soon")),
    "tx-pill tx-pill-line tx-pill-sm",
  );

  const chip = render(Chip, { pressed: true }, "Sales");
  assert.match(
    chip,
    /^<button type="button" class="tx-chip" aria-pressed="true">Sales<\/button>$/,
  );
  const ref = render(RefChip, {
    value: "err_7f3a21",
    label: "error reference",
  });
  assert.equal(classOf(ref), "tx-chip tx-chip-ref");
  assert.match(ref, /aria-label="Copy error reference err_7f3a21"/);
  assert.match(ref, />err_7f3a21</);

  assert.equal(
    render(Tile, {}, "!"),
    '<span class="tx-tile" aria-hidden="true">!</span>',
  );
  assert.equal(
    classOf(render(Tile, { tone: "warn", size: "lg" }, "!")),
    "tx-tile tx-tile-warn tx-tile-lg",
  );
});

test("Card and its empty, loading and error states each keep their exit", () => {
  assert.equal(
    classOf(render(Card, { pad: true }, "x")),
    "tx-card tx-card-pad",
  );

  const action = createElement("button", { type: "button" }, "New session");
  const empty = render(StateCard, {
    kind: "empty",
    icon: "search",
    title: "No sessions yet",
    action,
    children: "Start a session to see turns, plans and files here.",
  });
  assert.equal(classOf(empty), "tx-card tx-card-pad tx-state");
  assert.match(empty, /<h4>No sessions yet<\/h4>/);
  assert.match(empty, /<p>Start a session/);
  assert.match(empty, />New session<\/button>/);

  const loading = render(StateCard, {
    kind: "loading",
    title: "Loading activity…",
  });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /class="tx-spin"/);
  assert.doesNotMatch(loading, /<button/);

  const error = render(StateCard, {
    kind: "error",
    title: "Drive search failed",
    reference: "err_7f3a21",
    action: createElement("button", { type: "button" }, "Retry"),
    children: "Token expired.",
  });
  assert.equal(classOf(error), "tx-card tx-card-pad tx-state tx-state-error");
  assert.match(error, /tx-tile tx-tile-bad tx-tile-lg/);
  assert.match(
    error,
    /Token expired\. <button[^>]*class="tx-chip tx-chip-ref"/,
  );
  assert.match(error, />Retry<\/button>/);
});

// Compiled by `npm run typecheck`: each line must fail to type-check.
// @ts-expect-error an icon-only button needs an aria-label
export const unlabelledIconButton: ButtonProps = { iconOnly: true, icon: "x" };
// @ts-expect-error a status pill needs a glyph as well as its word
export const statusPillWithoutGlyph: PillProps = {
  tone: "bad",
  children: "Failed",
};
// @ts-expect-error an empty state needs its one action
export const emptyWithoutAction: StateCardProps = {
  kind: "empty",
  icon: "search",
  title: "None",
  children: "x",
};
// @ts-expect-error a loading title ends in an ellipsis
export const loadingWithoutEllipsis: StateCardProps = {
  kind: "loading",
  title: "Loading",
};
